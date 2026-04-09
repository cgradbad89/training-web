"use client";

import { useCallback, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import type { CreatedRoute } from "@/types/createdRoute";
import { GoogleMap, Polyline, Marker } from "@react-google-maps/api";
import { useGoogleMaps } from "@/components/GoogleMapsProvider";

interface Props {
  route: CreatedRoute | null;
  onClose: () => void;
}

export function CreatedRouteDetailModal({ route, onClose }: Props) {
  const { isLoaded, loadError } = useGoogleMaps();

  const path = useMemo(
    () => (route ? route.waypoints.map((p) => ({ lat: p.lat, lng: p.lng })) : []),
    [route]
  );

  const onMapLoad = useCallback(
    (map: google.maps.Map) => {
      if (path.length === 0) return;
      const bounds = new google.maps.LatLngBounds();
      path.forEach((p) => bounds.extend(p));
      // Defer fitBounds to the next idle tick so the container has
      // been laid out and the map knows its real viewport dimensions.
      google.maps.event.addListenerOnce(map, "idle", () => {
        map.fitBounds(bounds, 24);
      });
    },
    [path]
  );

  const initialCenter = path[0] ?? { lat: 0, lng: 0 };

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

  const start = path[0];
  const end = path[path.length - 1];
  const intermediate = path.slice(1, -1);

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
                  {route.distanceMiles.toFixed(2)} mi
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
          <div className="w-full h-[60vh] max-h-[520px] shrink-0">
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
                <Polyline
                  path={path}
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
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-border shrink-0">
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
          </div>
        </div>
      </div>
    </>
  );
}
