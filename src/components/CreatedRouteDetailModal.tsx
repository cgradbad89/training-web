"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import type { CreatedRoute, CreatedRouteWaypoint } from "@/types/createdRoute";
import { GoogleMap, Polyline, Marker } from "@react-google-maps/api";
import { useGoogleMaps } from "@/components/GoogleMapsProvider";
import { useAuth } from "@/hooks/useAuth";
import { updateCreatedRoute } from "@/services/createdRoutes";
import { haversineMeters } from "@/utils/routeCache";

interface Props {
  route: CreatedRoute | null;
  onClose: () => void;
  /**
   * Called after a legacy route is re-snapped and the snapped path
   * is persisted back to Firestore. Lets the parent refresh its
   * in-memory copy so the same route opens instantly next time.
   */
  onRouteUpdated?: (
    routeId: string,
    snappedPath: CreatedRouteWaypoint[],
    distanceMiles: number
  ) => void;
  /**
   * Called when the user clicks "Edit Route". The parent is responsible
   * for closing this modal and opening the RouteDrawModal in edit mode.
   */
  onEditRoute?: (route: CreatedRoute) => void;
}

type LatLng = CreatedRouteWaypoint;

// Fetch road-snapped walking path between two waypoints.
async function fetchSegment(
  service: google.maps.DirectionsService,
  from: LatLng,
  to: LatLng
): Promise<{ path: LatLng[]; ok: boolean }> {
  try {
    const result = await service.route({
      origin: from,
      destination: to,
      travelMode: google.maps.TravelMode.WALKING,
    });
    const overview = result.routes?.[0]?.overview_path;
    if (!overview || overview.length === 0) throw new Error("No route");
    return {
      path: overview.map((p) => ({ lat: p.lat(), lng: p.lng() })),
      ok: true,
    };
  } catch {
    // Straight-line fallback for this segment
    return { path: [from, to], ok: false };
  }
}

// Fetch all segments sequentially, combine into a single flat polyline.
async function fetchAndSaveSnappedPath(
  route: CreatedRoute,
  directionsService: google.maps.DirectionsService
): Promise<{ snappedPath: LatLng[]; distanceMiles: number; failures: number }> {
  const wps = route.waypoints;
  if (wps.length < 2) {
    return { snappedPath: [], distanceMiles: 0, failures: 0 };
  }

  const segments: LatLng[][] = [];
  let failures = 0;
  for (let i = 1; i < wps.length; i++) {
    const { path, ok } = await fetchSegment(
      directionsService,
      wps[i - 1],
      wps[i]
    );
    if (!ok) {
      failures += 1;
      console.warn(
        `[CreatedRouteDetailModal] Directions failed for segment ${
          i - 1
        }→${i} of route ${route.id}; falling back to straight line.`
      );
    }
    segments.push(path);
  }

  // Flatten (skip first point of every segment after the first to dedupe joins)
  const snappedPath: LatLng[] = [];
  segments.forEach((seg, i) => {
    const startIdx = i === 0 ? 0 : 1;
    for (let j = startIdx; j < seg.length; j++) snappedPath.push(seg[j]);
  });

  // Recalculate distance from the snapped path
  let meters = 0;
  for (let i = 1; i < snappedPath.length; i++) {
    meters += haversineMeters(
      snappedPath[i - 1].lat,
      snappedPath[i - 1].lng,
      snappedPath[i].lat,
      snappedPath[i].lng
    );
  }
  const distanceMiles = meters / 1609.344;

  return { snappedPath, distanceMiles, failures };
}

export function CreatedRouteDetailModal({
  route,
  onClose,
  onRouteUpdated,
  onEditRoute,
}: Props) {
  const { isLoaded, loadError } = useGoogleMaps();
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(
    null
  );

  // Snapped path currently rendered on the map. Starts null until we
  // decide whether to use route.snappedPath, re-snap, or fall back.
  const [snappedPath, setSnappedPath] = useState<LatLng[] | null>(null);
  const [isLoadingPath, setIsLoadingPath] = useState(false);
  const [displayDistance, setDisplayDistance] = useState<number>(
    route?.distanceMiles ?? 0
  );

  // Waypoints are still needed for markers (start/end/intermediate)
  const waypoints = useMemo<LatLng[]>(
    () => (route ? route.waypoints.map((p) => ({ lat: p.lat, lng: p.lng })) : []),
    [route]
  );

  // When the route prop changes (user opens a different route), reset
  // state and re-derive snappedPath from the prop.
  useEffect(() => {
    if (!route) {
      setSnappedPath(null);
      setIsLoadingPath(false);
      return;
    }
    setDisplayDistance(route.distanceMiles);
    if (route.snappedPath && route.snappedPath.length >= 2) {
      // Fast path: already snapped, just render.
      setSnappedPath(route.snappedPath);
      setIsLoadingPath(false);
    } else {
      // Needs re-snap. Mark as loading; the Directions fetch kicks off
      // once the map has mounted and the service ref is populated.
      setSnappedPath(null);
      setIsLoadingPath(true);
    }
  }, [route]);

  // Run the migration once the map is loaded AND we need to re-snap.
  const runMigration = useCallback(
    async (routeForMigration: CreatedRoute) => {
      const service = directionsServiceRef.current;
      if (!service) return;

      const { snappedPath: fetched, distanceMiles, failures } =
        await fetchAndSaveSnappedPath(routeForMigration, service);

      if (fetched.length === 0) {
        setIsLoadingPath(false);
        return;
      }

      setSnappedPath(fetched);
      setDisplayDistance(distanceMiles);
      setIsLoadingPath(false);

      // Persist migration to Firestore (best-effort).
      if (uid) {
        try {
          await updateCreatedRoute(uid, routeForMigration.id, {
            snappedPath: fetched,
            distanceMiles,
          });
          onRouteUpdated?.(routeForMigration.id, fetched, distanceMiles);
          if (failures > 0) {
            console.warn(
              `[CreatedRouteDetailModal] Migrated route ${routeForMigration.id} with ${failures} straight-line fallback segment(s).`
            );
          }
        } catch (e) {
          console.error(
            "[CreatedRouteDetailModal] Failed to persist snappedPath migration:",
            e
          );
        }
      }
    },
    [uid, onRouteUpdated]
  );

  const onMapLoad = useCallback(
    (map: google.maps.Map) => {
      // Initialize Directions service for legacy migrations
      if (!directionsServiceRef.current) {
        directionsServiceRef.current = new google.maps.DirectionsService();
      }

      if (waypoints.length === 0) return;

      const bounds = new google.maps.LatLngBounds();
      waypoints.forEach((p) => bounds.extend(p));
      google.maps.event.addListenerOnce(map, "idle", () => {
        map.fitBounds(bounds, 24);
      });

      // If we need to migrate this route, fire the Directions requests now.
      if (
        route &&
        (!route.snappedPath || route.snappedPath.length < 2) &&
        route.waypoints.length >= 2
      ) {
        runMigration(route);
      }
    },
    [waypoints, route, runMigration]
  );

  const initialCenter = waypoints[0] ?? { lat: 0, lng: 0 };

  // Body scroll lock
  useEffect(() => {
    if (route) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [route]);

  if (!route) return null;

  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  const intermediate = waypoints.slice(1, -1);

  // Use the snapped path for the polyline once it's available; fall
  // back to straight-line waypoints during the brief loading window.
  const polylinePath: LatLng[] =
    snappedPath && snappedPath.length >= 2 ? snappedPath : waypoints;

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-card rounded-2xl border border-border shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden"
          style={{ maxHeight: "85vh" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
            <div>
              <h2 className="text-lg font-bold text-textPrimary">
                {route.name}
              </h2>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-sm text-textSecondary">
                  {displayDistance.toFixed(2)} mi
                </span>
                <span className="text-sm text-textSecondary">&middot;</span>
                <span className="text-sm text-textSecondary">
                  {route.waypoints.length} waypoints
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-surface text-textSecondary"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Map */}
          <div className="relative w-full h-[60vh] max-h-[520px] shrink-0">
            {loadError ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-100 text-sm text-gray-500">
                Failed to load map
              </div>
            ) : !isLoaded ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-100">
                <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
              </div>
            ) : (
              <GoogleMap
                mapContainerStyle={{ width: "100%", height: "100%" }}
                center={initialCenter}
                zoom={13}
                onLoad={onMapLoad}
                options={{
                  streetViewControl: false,
                  mapTypeControl: false,
                  fullscreenControl: false,
                }}
              >
                {/* Dashed planned-route polyline */}
                {polylinePath.length >= 2 && (
                  <Polyline
                    path={polylinePath}
                    options={{
                      strokeColor: "#2563eb",
                      strokeOpacity: 0,
                      strokeWeight: 4,
                      icons: [
                        {
                          icon: {
                            path: "M 0,-1 0,1",
                            strokeColor: "#2563eb",
                            strokeOpacity: 0.9,
                            strokeWeight: 4,
                            scale: 2,
                          },
                          offset: "0",
                          repeat: "12px",
                        },
                      ],
                    }}
                  />
                )}

                {/* Intermediate waypoint dots */}
                {intermediate.map((p, i) => (
                  <Marker
                    key={`wp-${i}`}
                    position={p}
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale: 4,
                      fillColor: "#2563eb",
                      fillOpacity: 0.8,
                      strokeColor: "#ffffff",
                      strokeWeight: 1.5,
                    }}
                    zIndex={1}
                  />
                ))}

                {/* Start marker — green */}
                {start && (
                  <Marker
                    position={start}
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale: 8,
                      fillColor: "#34C759",
                      fillOpacity: 1,
                      strokeColor: "#ffffff",
                      strokeWeight: 2.5,
                    }}
                    zIndex={2}
                  />
                )}

                {/* End marker — red */}
                {end && (
                  <Marker
                    position={end}
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale: 8,
                      fillColor: "#FF3B30",
                      fillOpacity: 1,
                      strokeColor: "#ffffff",
                      strokeWeight: 2.5,
                    }}
                    zIndex={2}
                  />
                )}
              </GoogleMap>
            )}

            {/* Loading overlay — shown while re-snapping a legacy route */}
            {isLoadingPath && !loadError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[1px] pointer-events-none z-[999]">
                <div className="bg-card/95 border border-border rounded-2xl px-4 py-3 shadow-lg flex items-center gap-2.5">
                  <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  <span className="text-sm font-medium text-textPrimary">
                    Loading route…
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-border shrink-0 flex items-center justify-between gap-3">
            <p className="text-xs text-textSecondary">
              Created{" "}
              {new Date(route.createdAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              {" · "}
              <span className="italic">Planned route</span>
            </p>
            {onEditRoute && (
              <button
                onClick={() => onEditRoute(route)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-colors shrink-0"
              >
                <Pencil size={14} />
                Edit Route
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
