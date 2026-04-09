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
    snappedPath: CreatedRouteWaypoint[];
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
  const shiftPressedRef = useRef(false);
  const polylineDragStartRef = useRef<LatLng | null>(null);

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
  const [shiftHeld, setShiftHeld] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

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

  // Track Shift key (for "force straight line" drag mode)
  useEffect(() => {
    const updateShift = (e: KeyboardEvent) => {
      const next = e.shiftKey;
      shiftPressedRef.current = next;
      setShiftHeld(next);
    };
    const clearShift = () => {
      shiftPressedRef.current = false;
      setShiftHeld(false);
    };
    window.addEventListener("keydown", updateShift);
    window.addEventListener("keyup", updateShift);
    window.addEventListener("blur", clearShift);
    return () => {
      window.removeEventListener("keydown", updateShift);
      window.removeEventListener("keyup", updateShift);
      window.removeEventListener("blur", clearShift);
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

  // Compute one segment between two waypoints — Directions API or straight line
  const computeSegment = useCallback(
    async (from: LatLng, to: LatLng, useStraight: boolean): Promise<LatLng[]> => {
      if (useStraight || !directionsServiceRef.current) return [from, to];
      return fetchRoutedPath(directionsServiceRef.current, from, to);
    },
    []
  );

  // Marker drag end — update waypoint position, re-fetch adjacent segment(s)
  const handleMarkerDragEnd = useCallback(
    async (index: number, e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const newPos: LatLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      const useStraight = shiftPressedRef.current;

      const current = waypointsRef.current;
      if (current.length === 0) return;
      const updatedWaypoints = current.map((wp, i) =>
        i === index ? newPos : wp
      );
      waypointsRef.current = updatedWaypoints;
      setWaypoints(updatedWaypoints);

      if (updatedWaypoints.length < 2) return;

      // Optimistic straight-line segments while we fetch routed paths
      const segs = [...routedSegmentsRef.current];
      const isFirst = index === 0;
      const isLast = index === updatedWaypoints.length - 1;

      if (isFirst) {
        segs[0] = [updatedWaypoints[0], updatedWaypoints[1]];
      } else if (isLast) {
        segs[segs.length - 1] = [
          updatedWaypoints[index - 1],
          updatedWaypoints[index],
        ];
      } else {
        segs[index - 1] = [
          updatedWaypoints[index - 1],
          updatedWaypoints[index],
        ];
        segs[index] = [
          updatedWaypoints[index],
          updatedWaypoints[index + 1],
        ];
      }
      routedSegmentsRef.current = segs;
      setRoutedSegments(segs);

      // Real fetch
      setRecomputing(true);
      try {
        const next = [...routedSegmentsRef.current];
        if (isFirst) {
          next[0] = await computeSegment(
            updatedWaypoints[0],
            updatedWaypoints[1],
            useStraight
          );
        } else if (isLast) {
          next[next.length - 1] = await computeSegment(
            updatedWaypoints[index - 1],
            updatedWaypoints[index],
            useStraight
          );
        } else {
          const before = await computeSegment(
            updatedWaypoints[index - 1],
            updatedWaypoints[index],
            useStraight
          );
          const after = await computeSegment(
            updatedWaypoints[index],
            updatedWaypoints[index + 1],
            useStraight
          );
          next[index - 1] = before;
          next[index] = after;
        }
        routedSegmentsRef.current = next;
        setRoutedSegments(next);
      } finally {
        setRecomputing(false);
      }
    },
    [computeSegment]
  );

  // Insert a new waypoint into the segment nearest to `referencePoint`
  const insertWaypointOnSegment = useCallback(
    async (referencePoint: LatLng, newWaypoint: LatLng) => {
      const useStraight = shiftPressedRef.current;
      const segs = routedSegmentsRef.current;
      const wps = waypointsRef.current;
      if (wps.length < 2 || segs.length === 0) return;

      // Find which segment was grabbed: closest segment vertex to reference point
      let bestSegIdx = 0;
      let bestDist = Infinity;
      for (let s = 0; s < segs.length; s++) {
        for (const pt of segs[s]) {
          const d = haversineMeters(
            pt.lat,
            pt.lng,
            referencePoint.lat,
            referencePoint.lng
          );
          if (d < bestDist) {
            bestDist = d;
            bestSegIdx = s;
          }
        }
      }

      const insertIdx = bestSegIdx + 1;
      const newWaypoints = [
        ...wps.slice(0, insertIdx),
        newWaypoint,
        ...wps.slice(insertIdx),
      ];
      waypointsRef.current = newWaypoints;
      setWaypoints(newWaypoints);

      // Optimistic straight-line segments
      const optimisticBefore: LatLng[] = [
        newWaypoints[insertIdx - 1],
        newWaypoint,
      ];
      const optimisticAfter: LatLng[] = [
        newWaypoint,
        newWaypoints[insertIdx + 1],
      ];
      const optimisticSegs = [
        ...segs.slice(0, bestSegIdx),
        optimisticBefore,
        optimisticAfter,
        ...segs.slice(bestSegIdx + 1),
      ];
      routedSegmentsRef.current = optimisticSegs;
      setRoutedSegments(optimisticSegs);

      // Real fetch
      setRecomputing(true);
      try {
        const before = await computeSegment(
          newWaypoints[insertIdx - 1],
          newWaypoint,
          useStraight
        );
        const after = await computeSegment(
          newWaypoint,
          newWaypoints[insertIdx + 1],
          useStraight
        );
        const currentSegs = routedSegmentsRef.current;
        const finalSegs = [
          ...currentSegs.slice(0, bestSegIdx),
          before,
          after,
          ...currentSegs.slice(bestSegIdx + 1),
        ];
        routedSegmentsRef.current = finalSegs;
        setRoutedSegments(finalSegs);
      } finally {
        setRecomputing(false);
      }
    },
    [computeSegment]
  );

  // Polyline drag handlers — drag a point on the route to insert a waypoint
  const handlePolylineDragStart = useCallback(
    (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      polylineDragStartRef.current = {
        lat: e.latLng.lat(),
        lng: e.latLng.lng(),
      };
    },
    []
  );

  const handlePolylineDragEnd = useCallback(
    async (e: google.maps.MapMouseEvent) => {
      const start = polylineDragStartRef.current;
      polylineDragStartRef.current = null;
      if (!e.latLng || !start) return;
      const drop: LatLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      await insertWaypointOnSegment(start, drop);
    },
    [insertWaypointOnSegment]
  );

  // Click on the polyline — same as click-on-line insertion (no movement)
  const handlePolylineClick = useCallback(
    async (e: google.maps.MapMouseEvent) => {
      if (!drawModeRef.current) return;
      if (!e.latLng) return;
      const pt: LatLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      await insertWaypointOnSegment(pt, pt);
    },
    [insertWaypointOnSegment]
  );

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
        snappedPath: polylinePath,
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
              {/* Routed polyline (visible) */}
              {polylinePath.length >= 2 && (
                <Polyline
                  path={polylinePath}
                  options={{
                    strokeColor: "#2563eb",
                    strokeWeight: 4,
                    strokeOpacity: 0.9,
                    clickable: false,
                    zIndex: 1,
                  }}
                />
              )}

              {/* Invisible wide polyline — hit-target for click/drag to insert */}
              {polylinePath.length >= 2 && (
                <Polyline
                  path={polylinePath}
                  options={{
                    strokeColor: "#000000",
                    strokeOpacity: 0,
                    strokeWeight: 20,
                    draggable: true,
                    clickable: true,
                    zIndex: 2,
                  }}
                  onClick={handlePolylineClick}
                  onDragStart={handlePolylineDragStart}
                  onDragEnd={handlePolylineDragEnd}
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
                    key={`wp-${i}`}
                    position={wp}
                    draggable
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale,
                      fillColor,
                      fillOpacity: 1,
                      strokeColor: "#ffffff",
                      strokeWeight: 2,
                    }}
                    onClick={() => deleteWaypoint(i)}
                    onDragEnd={(e) => handleMarkerDragEnd(i, e)}
                    cursor="pointer"
                    zIndex={isFirst || isLast ? 4 : 3}
                  />
                );
              })}
            </GoogleMap>
          )}

          {/* Shift-held indicator */}
          {shiftHeld && mapReady && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[999] bg-amber-500/95 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
              Straight-line mode (Shift)
            </div>
          )}

          {/* Recomputing indicator */}
          {recomputing && mapReady && (
            <div className="absolute top-3 right-3 z-[999] bg-card/90 backdrop-blur-sm border border-border rounded-full px-3 py-1.5 shadow-lg pointer-events-none flex items-center gap-2">
              <div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              <span className="text-xs text-textPrimary font-medium">
                Updating route…
              </span>
            </div>
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
