"use client";

import { useEffect, useRef, useState } from "react";
import { getRoutePoints, isRouteCached } from "@/utils/routeCache";

interface StaticRouteMapProps {
  uid: string;
  workoutId: string;
  className?: string;
  onClick?: () => void;
}

export function StaticRouteMap({
  uid,
  workoutId,
  className,
  onClick,
}: StaticRouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  const [visible, setVisible] = useState(() => isRouteCached(workoutId));
  const [status, setStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");

  // IntersectionObserver — only load when scrolled into view
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { threshold: 0.1 }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Fetch route and initialize Leaflet when visible
  useEffect(() => {
    if (!visible || status !== "idle") return;
    setStatus("loading");

    let cancelled = false;

    async function init() {
      try {
        const points = await getRoutePoints(uid, workoutId);
        if (cancelled) return;

        if (points.length < 2) {
          setStatus("error");
          return;
        }

        // Dynamic import — SSR safe
        const L = (await import("leaflet")).default;
        await import("leaflet/dist/leaflet.css");

        if (cancelled || !containerRef.current) return;

        // Destroy existing map if any
        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }

        const latlngs = points.map(
          (p) => [p.lat, p.lng] as [number, number]
        );

        const map = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          touchZoom: false,
          keyboard: false,
          boxZoom: false,
        });

        mapRef.current = map;

        L.tileLayer(
          "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          { maxZoom: 18 }
        ).addTo(map);

        const polyline = L.polyline(latlngs, {
          color: "#007AFF",
          weight: 3,
          opacity: 0.9,
        }).addTo(map);

        // Start dot — green
        L.circleMarker(latlngs[0], {
          radius: 5,
          fillColor: "#34C759",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);

        // End dot — red
        L.circleMarker(latlngs[latlngs.length - 1], {
          radius: 5,
          fillColor: "#FF3B30",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);

        map.fitBounds(polyline.getBounds(), { padding: [12, 12] });

        setStatus("loaded");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [visible, uid, workoutId, status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      className={`relative overflow-hidden cursor-pointer ${className ?? ""}`}
      style={{ background: "#e8e8e8" }}
    >
      {/* Loading skeleton */}
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface animate-pulse z-10 pointer-events-none">
          <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      )}

      {/* No route data */}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface z-10 pointer-events-none">
          <span className="text-xs text-textSecondary">No route data</span>
        </div>
      )}
    </div>
  );
}
