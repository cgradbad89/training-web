"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Undo2, Trash2, X, Pencil, Hand } from "lucide-react";
import { haversineMeters } from "@/utils/routeCache";
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

function computeDistanceMilesFromPoints(
  pts: { lat: number; lng: number }[]
): number {
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

// Fetch road-snapped path between two points via OSRM
async function fetchRoutedPath(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<{ lat: number; lng: number }[]> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/foot/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("OSRM error");
    const data = await res.json();
    if (!data.routes?.[0]?.geometry?.coordinates)
      throw new Error("No route");
    return data.routes[0].geometry.coordinates.map(
      ([lng, lat]: [number, number]) => ({ lat, lng })
    );
  } catch {
    return [from, to];
  }
}

function rebuildPolyline(
  segments: { lat: number; lng: number }[][],
  map: L.Map,
  polylineRef: React.MutableRefObject<L.Polyline | null>
) {
  if (polylineRef.current) {
    polylineRef.current.remove();
    polylineRef.current = null;
  }
  if (segments.length === 0) return;

  const allPoints: L.LatLngTuple[] = [];
  segments.forEach((seg, i) => {
    const startIdx = i === 0 ? 0 : 1;
    seg.slice(startIdx).forEach((p) => allPoints.push([p.lat, p.lng]));
  });

  if (allPoints.length < 2) return;

  polylineRef.current = L.polyline(allPoints, {
    color: "#2563eb",
    weight: 3.5,
    opacity: 0.9,
  }).addTo(map);
}

export default function RouteDrawModal({
  onSave,
  onClose,
  initial,
}: RouteDrawModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const polylineRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef<L.CircleMarker[]>([]);
  const waypointsRef = useRef<{ lat: number; lng: number }[]>(
    initial?.waypoints ?? []
  );
  const drawModeRef = useRef(true);

  const [waypoints, setWaypoints] = useState<CreatedRouteWaypoint[]>(
    initial?.waypoints ?? []
  );
  const [routedSegments, setRoutedSegments] = useState<
    { lat: number; lng: number }[][]
  >([]);
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    waypointsRef.current = waypoints;
  }, [waypoints]);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

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

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Toggle dragging based on drawMode
  useEffect(() => {
    if (!mapRef.current) return;
    if (drawMode) {
      mapRef.current.dragging.disable();
      mapRef.current.getContainer().style.cursor = "crosshair";
    } else {
      mapRef.current.dragging.enable();
      mapRef.current.getContainer().style.cursor = "grab";
    }
  }, [drawMode, mapReady]);

  // Init map
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

    let cancelled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
      iconUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
      shadowUrl:
        "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
    });

    async function initMap() {
      const fallback = { lat: 38.9072, lng: -77.0369 };

      const getCenter = (): Promise<{ lat: number; lng: number }> =>
        new Promise((resolve) => {
          if (!navigator.geolocation) {
            resolve(fallback);
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) =>
              resolve({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
              }),
            () => resolve(fallback),
            { timeout: 4000 }
          );
        });

      const center =
        initial?.waypoints && initial.waypoints.length > 0
          ? null
          : await getCenter();

      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: true,
        doubleClickZoom: false,
        center: center
          ? [center.lat, center.lng]
          : [fallback.lat, fallback.lng],
        zoom: 14,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      map.getContainer().style.cursor = "crosshair";
      mapRef.current = map;
      setMapReady(true);

      // If editing, fit to existing waypoints and draw markers + segments
      if (initial?.waypoints && initial.waypoints.length > 0) {
        const latLngs: L.LatLngTuple[] = initial.waypoints.map((p) => [
          p.lat,
          p.lng,
        ]);
        map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });

        // Draw markers for existing waypoints
        initial.waypoints.forEach((p, i) => {
          const isFirst = i === 0;
          const marker = L.circleMarker([p.lat, p.lng], {
            radius: isFirst ? 7 : 5,
            fillColor: isFirst ? "#34C759" : "#2563eb",
            color: "#fff",
            weight: 2,
            fillOpacity: 1,
          }).addTo(map);
          markersRef.current.push(marker);
        });

        // Fetch routed segments for existing waypoints
        const segments: { lat: number; lng: number }[][] = [];
        for (let i = 1; i < initial.waypoints.length; i++) {
          const routed = await fetchRoutedPath(
            initial.waypoints[i - 1],
            initial.waypoints[i]
          );
          segments.push(routed);
        }
        if (!cancelled) {
          setRoutedSegments(segments);
          rebuildPolyline(segments, map, polylineRef);
        }
      }

      // Click handler — add waypoint with OSRM snapping
      map.on("click", async (e: L.LeafletMouseEvent) => {
        if (!drawModeRef.current) return;
        const { lat, lng } = e.latlng;

        const isFirst = waypointsRef.current.length === 0;
        const markerColor = isFirst ? "#34C759" : "#2563eb";
        const marker = L.circleMarker([lat, lng], {
          radius: isFirst ? 7 : 5,
          fillColor: markerColor,
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);
        markersRef.current.push(marker);

        const prevWaypoints = waypointsRef.current;
        const newWaypoint = { lat, lng };

        const updatedWaypoints = [...prevWaypoints, newWaypoint];
        waypointsRef.current = updatedWaypoints;
        setWaypoints(updatedWaypoints);

        if (prevWaypoints.length >= 1) {
          const prev = prevWaypoints[prevWaypoints.length - 1];
          const routedPath = await fetchRoutedPath(prev, newWaypoint);

          setRoutedSegments((segs) => {
            const updated = [...segs, routedPath];
            rebuildPolyline(updated, map, polylineRef);
            return updated;
          });
        }
      });
    }

    initMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      polylineRef.current = null;
      markersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUndo = () => {
    if (waypoints.length === 0) return;

    const lastMarker = markersRef.current.pop();
    if (lastMarker && mapRef.current) lastMarker.remove();

    setRoutedSegments((segs) => {
      const updated = segs.slice(0, -1);
      if (mapRef.current) {
        rebuildPolyline(updated, mapRef.current, polylineRef);
      }
      return updated;
    });

    setWaypoints((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
    setWaypoints([]);
    setRoutedSegments([]);
    waypointsRef.current = [];
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !mapRef.current) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?` +
          `q=${encodeURIComponent(searchQuery)}&format=json&limit=1&countrycodes=us`,
        { headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      if (data.length === 0) {
        setSearchError("Location not found. Try a city name or zip code.");
        return;
      }
      const { lat, lon } = data[0];
      mapRef.current.setView([parseFloat(lat), parseFloat(lon)], 14);
    } catch {
      setSearchError("Search failed. Check your connection.");
    } finally {
      setSearching(false);
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

        {/* Location search */}
        <div className="px-4 py-2 border-b border-border shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search by city or zip code (e.g. 20001 or Washington DC)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1 text-sm border border-border rounded-xl px-3 py-1.5 bg-surface text-textPrimary placeholder:text-textSecondary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="px-3 py-1.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors shrink-0"
            >
              {searching ? "…" : "Go"}
            </button>
          </div>
          {searchError && (
            <p className="text-xs text-danger mt-1">{searchError}</p>
          )}
        </div>

        {/* Map */}
        <div className="relative flex-1 min-h-[50vh]">
          <div ref={containerRef} className="absolute inset-0" />

          {/* Instruction overlay */}
          {waypoints.length === 0 && mapReady && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[999]">
              <div className="bg-card/90 backdrop-blur-sm border border-border rounded-2xl px-5 py-4 text-center shadow-lg">
                <Pencil className="w-8 h-8 text-primary mx-auto mb-2" />
                <p className="text-sm font-semibold text-textPrimary">
                  Draw mode is active
                </p>
                <p className="text-xs text-textSecondary mt-1">
                  Click the map to add waypoints along your route.
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
