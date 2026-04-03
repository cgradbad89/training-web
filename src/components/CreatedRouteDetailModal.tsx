"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { CreatedRoute } from "@/types/createdRoute";
import dynamic from "next/dynamic";

interface Props {
  route: CreatedRoute | null;
  onClose: () => void;
}

function CreatedRouteDetailModalInner({ route, onClose }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leafletMapRef = useRef<any>(null);

  useEffect(() => {
    if (!route || !mapContainerRef.current) return;
    let cancelled = false;

    async function initMap() {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !mapContainerRef.current) return;

      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }

      const sorted = [...route!.waypoints];
      const latlngs: [number, number][] = sorted.map((p) => [p.lat, p.lng]);

      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        attributionControl: true,
        dragging: true,
        scrollWheelZoom: true,
      });

      leafletMapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      // Dashed polyline (planned route visual style)
      const polyline = L.polyline(latlngs, {
        color: "#2563eb",
        weight: 4,
        opacity: 0.9,
        dashArray: "10 6",
      }).addTo(map);

      // Start marker — green
      L.circleMarker(latlngs[0], {
        radius: 8,
        fillColor: "#34C759",
        color: "#fff",
        weight: 2.5,
        fillOpacity: 1,
      }).addTo(map);

      // End marker — red
      L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 8,
        fillColor: "#FF3B30",
        color: "#fff",
        weight: 2.5,
        fillOpacity: 1,
      }).addTo(map);

      // Intermediate waypoint dots — small blue
      latlngs.slice(1, -1).forEach((ll) => {
        L.circleMarker(ll, {
          radius: 4,
          fillColor: "#2563eb",
          color: "#fff",
          weight: 1.5,
          fillOpacity: 0.8,
        }).addTo(map);
      });

      map.fitBounds(polyline.getBounds(), { padding: [24, 24] });
      setTimeout(() => map.invalidateSize(), 100);
    }

    initMap();
    return () => {
      cancelled = true;
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, [route]);

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
          <div
            ref={mapContainerRef}
            className="flex-1"
            style={{ minHeight: "400px" }}
          />

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

export const CreatedRouteDetailModal = dynamic(
  () => Promise.resolve(CreatedRouteDetailModalInner),
  { ssr: false }
);
