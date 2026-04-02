"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { getRoutePoints, isRouteCached } from "@/utils/routeCache";

interface StaticRouteMapProps {
  uid: string;
  workoutId: string;
  className?: string;
  onClick?: () => void;
}

function StaticRouteMapInner({
  uid,
  workoutId,
  className,
  onClick,
}: StaticRouteMapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  const [visible, setVisible] = useState(() => isRouteCached(workoutId));
  const [status, setStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");

  // IntersectionObserver on outer wrapper
  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { threshold: 0.1 }
    );
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [visible]);

  // Initialize Leaflet when visible
  useEffect(() => {
    if (!visible || status !== "idle") return;
    if (!mapDivRef.current) return;

    setStatus("loading");
    let cancelled = false;

    async function init() {
      try {
        const points = await getRoutePoints(uid, workoutId);
        if (cancelled || !mapDivRef.current) return;

        if (points.length < 2) {
          setStatus("error");
          return;
        }

        // Wait for browser paint so mapDivRef has real dimensions
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        if (cancelled || !mapDivRef.current) return;

        // Destroy previous map instance if any
        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }

        const L = (await import("leaflet")).default;
        if (cancelled || !mapDivRef.current) return;

        const latlngs: [number, number][] = points.map((p) => [p.lat, p.lng]);

        const map = L.map(mapDivRef.current, {
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
          { maxZoom: 18, crossOrigin: true }
        ).addTo(map);

        const polyline = L.polyline(latlngs, {
          color: "#007AFF",
          weight: 3,
          opacity: 0.9,
        }).addTo(map);

        L.circleMarker(latlngs[0], {
          radius: 5,
          fillColor: "#34C759",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);

        L.circleMarker(latlngs[latlngs.length - 1], {
          radius: 5,
          fillColor: "#FF3B30",
          color: "#fff",
          weight: 2,
          fillOpacity: 1,
        }).addTo(map);

        map.fitBounds(polyline.getBounds(), { padding: [12, 12] });

        // Force Leaflet to recalculate size
        setTimeout(() => {
          if (mapRef.current && !cancelled) {
            mapRef.current.invalidateSize();
          }
        }, 100);

        setStatus("loaded");
      } catch (err) {
        console.error("[StaticRouteMap] init error:", err);
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
      ref={wrapperRef}
      onClick={onClick}
      className={`relative overflow-hidden cursor-pointer ${className ?? ""}`}
    >
      {/* Dedicated Leaflet mount target */}
      <div
        ref={mapDivRef}
        className="absolute inset-0"
        style={{ zIndex: 0 }}
      />

      {/* Loading overlay */}
      {(status === "idle" || status === "loading") && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 z-10 pointer-events-none">
          {status === "loading" && (
            <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          )}
        </div>
      )}

      {/* Error state */}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 z-10 pointer-events-none">
          <span className="text-xs text-gray-400">No route data</span>
        </div>
      )}
    </div>
  );
}

// Re-export as dynamic component with SSR disabled.
// Leaflet requires window/document and causes silent hangs during SSR.
export const StaticRouteMap = dynamic(
  () => Promise.resolve(StaticRouteMapInner),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-gray-100">
        <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    ),
  }
);
