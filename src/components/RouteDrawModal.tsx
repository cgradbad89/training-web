"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Marker, Polyline, Autocomplete } from "@react-google-maps/api";
import { Undo2, Trash2, X, Pencil, Hand } from "lucide-react";
import { haversineMeters } from "@/utils/routeCache";
import { useGoogleMaps } from "@/components/GoogleMapsProvider";
import type { CreatedRouteWaypoint } from "@/types/createdRoute";

interface RouteDrawModalProps {
  onSave: (data: {
    name: string;
    waypoints: CreatedRouteWaypoint[];
    distanceMiles: number;
  }) => void;
  onClose: () => void;
  /** If provided, pre-populate for editing */
  initial?: {
    name: string;
    waypoints: CreatedRouteWaypoint[];
  };
}

type LatLng = { lat: number; lng: number };

const FALLBACK_CENTER: LatLng = { lat: 38.9072, lng: -77.0369 }; // DC

function computeDistanceMilesFromPoints(pts: LatLng[]): number {
  if (pts.length < 2) return 0;
  let totalMeters = 0;
  for (let i = 1; i < pts.length; i++) {
    totalMeters += haversineMeters(
      pts[i - 1].lat,
      pts[i - 1].lng,
      pts[i].lat,
      pts[i].lng
    );
  }
  return totalMeters / 1609.344;
}

// Fetch road-snapped path between two points via Google Directions API
async function fetchRoutedPath(
  service: google.maps.DirectionsService,
  from: LatLng,
  to: LatLng
): Promise<LatLng[]> {
  try {
    const result = await service.route({
      origin: from,
      destination: to,
      travelMode: google.maps.TravelMode.WALKING,
    });
    const overview = result.routes?.[0]?.overview_path;
    if (!overview || overview.length === 0) throw new Error("No route");
    return overview.map((p) => ({ lat: p.lat(), lng: p.lng() }));
  } catch {
    return [from, to];
  }
}

export default function RouteDrawModal({
  onSave,
  onClose,
  initial,
}: RouteDrawModalProps) {
  const { isLoaded, loadError } = useGoogleMaps();

  const mapRef = useRef<google.maps.Map | null>(null);
  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(
    null
  );
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  const waypointsRef = useRef<LatLng[]>(initial?.waypoints ?? []);
  const routedSegmentsRef = useRef<LatLng[][]>([]);
  const drawModeRef = useRef(true);

  const [waypoints, setWaypoints] = useState<CreatedRouteWaypoint[]>(
    initial?.waypoints ?? []
  );
  const [routedSegments, setRoutedSegments] = useState<LatLng[][]>([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(true);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);

  useEffect(() => {
    routedSegmentsRef.current = routedSegments;
  }, [routedSegments]);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Resolve initial center: editing → first waypoint, else geolocation, else DC
  useEffect(() => {
    let cancelled = false;
    if (initial?.waypoints && initial.waypoints.length > 0) {
      setCenter({
        lat: initial.waypoints[0].lat,
        lng: initial.waypoints[0].lng,
      });
      return;
    }
    if (!navigator.geolocation) {
      setCenter(FALLBACK_CENTER);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        if (!cancelled) setCenter(FALLBACK_CENTER);
      },
      { timeout: 4000 }
    );
    return () => {
      cancelled = true;
    };
  }, [initial]);

  // Flat path from all routed segments (for the visible polyline)
  const polylinePath = useMemo(() => {
    if (routedSegments.length === 0) return [] as LatLng[];
    const out: LatLng[] = [];
    routedSegments.forEach((seg, i) => {
      const startIdx = i === 0 ? 0 : 1;
      for (let j = startIdx; j < seg.length; j++) out.push(seg[j]);
    });
    return out;
  }, [routedSegments]);

  // Live distance — sum routed segments if present, else straight-line waypoints
  const distanceMiles = useMemo(() => {
    if (routedSegments.length > 0) {
      let totalMeters = 0;
      routedSegments.forEach((seg) => {
        for (let i = 1; i < seg.length; i++) {
          totalMeters += haversineMeters(
            seg[i - 1].lat,
            seg[i - 1].lng,
            seg[i].lat,
            seg[i].lng
          );
        }
      });
      return totalMeters / 1609.344;
    }
    return computeDistanceMilesFromPoints(waypoints);
  }, [routedSegments, waypoints]);

  // Map onLoad — store ref, init Directions service, fit bounds if editing
  const handleMapLoad = useCallback(
    async (map: google.maps.Map) => {
      mapRef.current = map;
      directionsServiceRef.current = new google.maps.DirectionsService();
      setMapReady(true);

      if (initial?.waypoints && initial.waypoints.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        initial.waypoints.forEach((p) => bounds.extend(p));
        map.fitBounds(bounds, 40);

        // Re-fetch routed segments for existing waypoints
        const service = directionsServiceRef.current;
        const segments: LatLng[][] = [];
        for (let i = 1; i < initial.waypoints.length; i++) {
          const routed = await fetchRoutedPath(
            service,
            initial.waypoints[i - 1],
            initial.waypoints[i]
          );
          segments.push(routed);
        }
        setRoutedSegments(segments);
        routedSegmentsRef.current = segments;
      }
    },
    [initial]
  );

  const handleMapUnmount = useCallback(() => {
    mapRef.current = null;
    directionsServiceRef.current = null;
  }, []);

  // Click on map — add a waypoint (only in draw mode)
  const handleMapClick = useCallback(
    async (e: google.maps.MapMouseEvent) => {
      if (!drawModeRef.current) return;
      if (!e.latLng) return;
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      const newWaypoint: LatLng = { lat, lng };

      const prevWaypoints = waypointsRef.current;
      const updated = [...prevWaypoints, newWaypoint];
      waypointsRef.current = updated;
      setWaypoints(updated);

      if (prevWaypoints.length >= 1 && directionsServiceRef.current) {
        const prev = prevWaypoints[prevWaypoints.length - 1];
        const routedPath = await fetchRoutedPath(
          directionsServiceRef.current,
          prev,
          newWaypoint
        );
        const segs = [...routedSegmentsRef.current, routedPath];
        routedSegmentsRef.current = segs;
        setRoutedSegments(segs);
      }
    },
    []
  );

  // Click a waypoint marker — delete it and re-stitch
  const deleteWaypoint = useCallback(async (index: number) => {
    const current = waypointsRef.current;
    if (current.length === 0) return;

    const newWaypoints = current.filter((_, i) => i !== index);
    waypointsRef.current = newWaypoints;
    setWaypoints(newWaypoints);

    if (newWaypoints.length < 2) {
      setRoutedSegments([]);
      routedSegmentsRef.current = [];
      return;
    }

    const prev = routedSegmentsRef.current;

    if (index === 0) {
      const newSegments = prev.slice(1);
      routedSegmentsRef.current = newSegments;
      setRoutedSegments(newSegments);
    } else if (index === current.length - 1) {
      const newSegments = prev.slice(0, -1);
      routedSegmentsRef.current = newSegments;
      setRoutedSegments(newSegments);
    } else {
      const prevWp = current[index - 1];
      const nextWp = current[index + 1];
      const service = directionsServiceRef.current;
      const newSegment = service
        ? await fetchRoutedPath(service, prevWp, nextWp)
        : [prevWp, nextWp];

      const updated = [
        ...prev.slice(0, index - 1),
        newSegment,
        ...prev.slice(index + 1),
      ];
      routedSegmentsRef.current = updated;
      setRoutedSegments(updated);
    }
  }, []);

  const handleUndo = () => {
    if (waypoints.length === 0) return;
    setWaypoints((prev) => prev.slice(0, -1));
    setRoutedSegments((segs) => {
      const updated = segs.slice(0, -1);
      routedSegmentsRef.current = updated;
      return updated;
    });
  };

  const handleClear = () => {
    setWaypoints([]);
    setRoutedSegments([]);
    routedSegmentsRef.current = [];
    waypointsRef.current = [];
  };

  // Places Autocomplete handlers
  const handleAutocompleteLoad = (ac: google.maps.places.Autocomplete) => {
    autocompleteRef.current = ac;
    if (mapRef.current) {
      ac.bindTo("bounds", mapRef.current);
    }
  };

  const handlePlaceChanged = () => {
    setSearchError(null);
    const ac = autocompleteRef.current;
    if (!ac || !mapRef.current) return;
    const place = ac.getPlace();
    if (!place.geometry) {
      setSearchError("Location not found. Try a different search.");
      return;
    }
    if (place.geometry.viewport) {
      mapRef.current.fitBounds(place.geometry.viewport);
    } else if (place.geometry.location) {
      mapRef.current.panTo(place.geometry.location);
      mapRef.current.setZoom(14);
    }
  };

  const handleSave = async () => {
    if (waypoints.length < 2) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || "Untitled Route",
        waypoints,
        distanceMiles,
      });
    } finally {
      setSaving(false);
    }
  };

  // Map options computed from drawMode
  const mapOptions: google.maps.MapOptions = useMemo(
    () => ({
      zoomControl: true,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      disableDoubleClickZoom: true,
      clickableIcons: false,
      draggable: !drawMode,
      draggableCursor: drawMode ? "crosshair" : "grab",
      gestureHandling: "greedy",
    }),
    [drawMode]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl border border-border w-full max-w-3xl max-h-[90vh] overflow-hidden shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <button
            onClick={onClose}
            className="text-textSecondary hover:text-textPrimary transition-colors"
          >
            <X size={20} />
          </button>
          <h2 className="text-lg font-bold text-textPrimary flex-1">
            {initial ? "Edit Route" : "Draw a Route"}
          </h2>
          <span className="text-sm text-textSecondary tabular-nums">
            {distanceMiles.toFixed(2)} mi
          </span>
        </div>

        {/* Name input */}
        <div className="px-4 pt-3 pb-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Route name"
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-textPrimary placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Location search (Places Autocomplete) */}
        <div className="px-4 py-2 border-b border-border shrink-0">
          {isLoaded ? (
            <Autocomplete
              onLoad={handleAutocompleteLoad}
              onPlaceChanged={handlePlaceChanged}
              options={{
                fields: ["geometry", "name", "formatted_address"],
              }}
            >
              <input
                type="text"
                placeholder="Search by city, address, or place"
                className="w-full text-sm border border-border rounded-xl px-3 py-1.5 bg-surface text-textPrimary placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </Autocomplete>
          ) : (
            <input
              type="text"
              disabled
              placeholder="Loading map…"
              className="w-full text-sm border border-border rounded-xl px-3 py-1.5 bg-surface text-textSecondary"
            />
          )}
          {searchError && (
            <p className="text-xs text-danger mt-1">{searchError}</p>
          )}
        </div>

        {/* Map */}
        <div className="relative flex-1 min-h-[50vh]">
          {loadError ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-100 text-sm text-gray-500">
              Failed to load map
            </div>
          ) : !isLoaded || !center ? (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
              <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          ) : (
            <GoogleMap
              mapContainerStyle={{ position: "absolute", inset: 0 }}
              center={center}
              zoom={14}
              options={mapOptions}
              onLoad={handleMapLoad}
              onUnmount={handleMapUnmount}
              onClick={handleMapClick}
            >
              {/* Routed polyline */}
              {polylinePath.length >= 2 && (
                <Polyline
                  path={polylinePath}
                  options={{
                    strokeColor: "#2563eb",
                    strokeWeight: 4,
                    strokeOpacity: 0.9,
                    clickable: false,
                  }}
                />
              )}

              {/* Waypoint markers */}
              {waypoints.map((wp, i) => {
                const isFirst = i === 0;
                const isLast = i === waypoints.length - 1;
                const fillColor = isFirst
                  ? "#34C759"
                  : isLast
                  ? "#FF3B30"
                  : "#2563eb";
                const scale = isFirst || isLast ? 7 : 5;
                return (
                  <Marker
                    key={`wp-${i}-${wp.lat}-${wp.lng}`}
                    position={wp}
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale,
                      fillColor,
                      fillOpacity: 1,
                      strokeColor: "#ffffff",
                      strokeWeight: 2,
                    }}
                    onClick={() => deleteWaypoint(i)}
                    cursor="pointer"
                    zIndex={isFirst || isLast ? 3 : 2}
                  />
                );
              })}
            </GoogleMap>
          )}

          {/* Instruction overlay */}
          {waypoints.length === 0 && mapReady && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[999]">
              <div className="bg-card/90 backdrop-blur-sm border border-border rounded-2xl px-5 py-4 text-center shadow-lg">
                <Pencil className="w-8 h-8 text-primary mx-auto mb-2" />
                <p className="text-sm font-semibold text-textPrimary">
                  Draw mode is active
                </p>
                <p className="text-xs text-textSecondary mt-1">
                  Click the map to add waypoints. Click a waypoint to delete
                  it.
                  <br />
                  Toggle to Pan mode to navigate the map.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 p-4 border-t border-border">
          {/* Mode toggle */}
          <button
            onClick={() => setDrawMode((m) => !m)}
            className={`border rounded-xl p-2 shadow text-xs font-semibold transition-colors flex items-center gap-1 ${
              drawMode
                ? "bg-primary text-white border-primary"
                : "bg-card text-textSecondary hover:text-textPrimary border-border"
            }`}
            title={
              drawMode ? "Switch to navigate mode" : "Switch to draw mode"
            }
          >
            {drawMode ? (
              <>
                <Pencil className="w-3.5 h-3.5" />
                <span>Draw</span>
              </>
            ) : (
              <>
                <Hand className="w-3.5 h-3.5" />
                <span>Pan</span>
              </>
            )}
          </button>
          <button
            onClick={handleUndo}
            disabled={waypoints.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium text-textSecondary hover:text-textPrimary disabled:opacity-30 transition-colors"
          >
            <Undo2 size={14} />
            Undo
          </button>
          <button
            onClick={handleClear}
            disabled={waypoints.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium text-danger hover:text-danger/80 disabled:opacity-30 transition-colors"
          >
            <Trash2 size={14} />
            Clear
          </button>
          <span className="flex-1" />
          <span className="text-xs text-textSecondary">
            {waypoints.length} {waypoints.length === 1 ? "point" : "points"}
          </span>
          <button
            onClick={handleSave}
            disabled={waypoints.length < 2 || saving}
            className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors"
          >
            {saving ? "Saving…" : "Save Route"}
          </button>
        </div>
      </div>
    </div>
  );
}
