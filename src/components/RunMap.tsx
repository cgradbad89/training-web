"use client";

import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { type RoutePoint } from "@/services/routes";

interface RunMapProps {
  points: RoutePoint[];
  className?: string;
}

export default function RunMap({ points, className = "" }: RunMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || points.length === 0) return;
    if (mapRef.current) return; // already initialized

    // Fix Leaflet default marker icons broken by webpack
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

    const latLngs: L.LatLngTuple[] = points.map((p) => [p.lat, p.lng]);

    const map = L.map(containerRef.current, {
      scrollWheelZoom: false,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    // Draw route polyline
    const polyline = L.polyline(latLngs, {
      color: "#007AFF",
      weight: 4,
      opacity: 0.9,
    }).addTo(map);

    // Fit bounds to show entire route
    map.fitBounds(polyline.getBounds(), { padding: [30, 30] });

    // Start marker (green)
    const first = latLngs[0];
    L.circleMarker(first, {
      radius: 8,
      fillColor: "#34C759",
      color: "#fff",
      weight: 2,
      fillOpacity: 1,
    }).addTo(map);

    // End marker (red)
    const last = latLngs[latLngs.length - 1];
    L.circleMarker(last, {
      radius: 8,
      fillColor: "#FF3B30",
      color: "#fff",
      weight: 2,
      fillOpacity: 1,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [points]);

  return (
    <div
      ref={containerRef}
      className={`w-full h-64 sm:h-96 ${className}`}
    />
  );
}
