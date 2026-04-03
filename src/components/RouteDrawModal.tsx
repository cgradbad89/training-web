"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Undo2, Trash2, X } from "lucide-react";
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

function computeDistanceMiles(waypoints: CreatedRouteWaypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    total += haversineMeters(
      waypoints[i - 1].lat,
      waypoints[i - 1].lng,
      waypoints[i].lat,
      waypoints[i].lng
    );
  }
  return total / 1609.344;
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

  const [waypoints, setWaypoints] = useState<CreatedRouteWaypoint[]>(
    initial?.waypoints ?? []
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [saving, setSaving] = useState(false);

  const distanceMiles = computeDistanceMiles(waypoints);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Sync polyline + markers when waypoints change
  const syncMapOverlays = useCallback(
    (map: L.Map, pts: CreatedRouteWaypoint[]) => {
      // Clear existing markers
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      const latLngs: L.LatLngTuple[] = pts.map((p) => [p.lat, p.lng]);

      if (polylineRef.current) {
        polylineRef.current.setLatLngs(latLngs);
      } else {
        polylineRef.current = L.polyline(latLngs, {
          color: "#007AFF",
          weight: 4,
          opacity: 0.9,
        }).addTo(map);
      }

      pts.forEach((p, i) => {
        const isFirst = i === 0;
        const isLast = i === pts.length - 1 && pts.length > 1;
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: isFirst || isLast ? 8 : 5,
          fillColor: isFirst ? "#34C759" : isLast ? "#FF3B30" : "#007AFF",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);
        markersRef.current.push(marker);
      });
    },
    []
  );

  // Init map
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) return;

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

    const map = L.map(containerRef.current, {
      scrollWheelZoom: true,
      zoomControl: true,
      center: [42.35, -71.06], // default: Boston
      zoom: 13,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    mapRef.current = map;

    // If editing, fit to existing waypoints
    if (initial?.waypoints && initial.waypoints.length > 0) {
      const latLngs: L.LatLngTuple[] = initial.waypoints.map((p) => [
        p.lat,
        p.lng,
      ]);
      map.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });
      syncMapOverlays(map, initial.waypoints);
    }

    return () => {
      map.remove();
      mapRef.current = null;
      polylineRef.current = null;
      markersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click handler — add waypoint
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handler = (e: L.LeafletMouseEvent) => {
      setWaypoints((prev) => [...prev, { lat: e.latlng.lat, lng: e.latlng.lng }]);
    };

    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, []);

  // Redraw overlays when waypoints change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncMapOverlays(map, waypoints);
  }, [waypoints, syncMapOverlays]);

  const handleUndo = () => {
    setWaypoints((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setWaypoints([]);
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

        {/* Map */}
        <div ref={containerRef} className="flex-1 min-h-[50vh]" />

        {/* Toolbar */}
        <div className="flex items-center gap-3 p-4 border-t border-border">
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
