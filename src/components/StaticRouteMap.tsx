"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { getRoutePoints, isRouteCached } from "@/utils/routeCache";
import { type RoutePoint } from "@/services/routes";

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
  const [visible, setVisible] = useState(() => isRouteCached(workoutId));
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [loading, setLoading] = useState(true);

  // IntersectionObserver — lazy load when scrolled into view
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

  // Fetch route points when visible
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getRoutePoints(uid, workoutId)
      .then((pts) => {
        if (!cancelled) {
          setPoints(pts);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, uid, workoutId]);

  // Build SVG polyline from points
  function buildSVG(pts: RoutePoint[]) {
    if (pts.length < 2) return null;

    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    const W = 400;
    const H = 300;
    const PAD = 24;

    const scaleX = (lng: number) =>
      PAD + ((lng - minLng) / (maxLng - minLng || 1)) * (W - PAD * 2);
    const scaleY = (lat: number) =>
      PAD +
      (1 - (lat - minLat) / (maxLat - minLat || 1)) * (H - PAD * 2);

    // Downsample to max 300 points
    const step = Math.max(1, Math.floor(pts.length / 300));
    const sampled = pts.filter((_, i) => i % step === 0);

    const polyline = sampled
      .map(
        (p) =>
          `${scaleX(p.lng).toFixed(1)},${scaleY(p.lat).toFixed(1)}`
      )
      .join(" ");

    const start = sampled[0];
    const end = sampled[sampled.length - 1];

    return { W, H, polyline, start, end, scaleX, scaleY };
  }

  const svg = !loading && points.length >= 2 ? buildSVG(points) : null;

  return (
    <div
      ref={wrapperRef}
      onClick={onClick}
      className={`relative overflow-hidden cursor-pointer ${className ?? ""}`}
      style={{ backgroundColor: "#f0f4f8" }}
    >
      {/* Loading state */}
      {loading && visible && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 animate-pulse" />
      )}

      {/* Not yet visible placeholder */}
      {!visible && (
        <div
          className="absolute inset-0"
          style={{ backgroundColor: "#f0f4f8" }}
        />
      )}

      {/* No route data */}
      {!loading && points.length < 2 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-gray-400">No route data</span>
        </div>
      )}

      {/* SVG route */}
      {svg && (
        <svg
          viewBox={`0 0 ${svg.W} ${svg.H}`}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block" }}
        >
          <rect
            x="0"
            y="0"
            width={svg.W}
            height={svg.H}
            fill="#f0f4f8"
          />

          {/* Subtle grid */}
          {[1, 2, 3, 4].map((i) => (
            <line
              key={`h${i}`}
              x1="0"
              y1={(svg.H * i) / 5}
              x2={svg.W}
              y2={(svg.H * i) / 5}
              stroke="#dde3ea"
              strokeWidth="0.8"
            />
          ))}
          {[1, 2, 3, 4].map((i) => (
            <line
              key={`v${i}`}
              x1={(svg.W * i) / 5}
              y1="0"
              x2={(svg.W * i) / 5}
              y2={svg.H}
              stroke="#dde3ea"
              strokeWidth="0.8"
            />
          ))}

          {/* Route shadow for depth */}
          <polyline
            points={svg.polyline}
            fill="none"
            stroke="#007AFF"
            strokeOpacity="0.2"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Main route line */}
          <polyline
            points={svg.polyline}
            fill="none"
            stroke="#007AFF"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Start dot — green */}
          <circle
            cx={svg.scaleX(svg.start.lng)}
            cy={svg.scaleY(svg.start.lat)}
            r="7"
            fill="#34C759"
            stroke="white"
            strokeWidth="2.5"
          />

          {/* End dot — red */}
          <circle
            cx={svg.scaleX(svg.end.lng)}
            cy={svg.scaleY(svg.end.lat)}
            r="7"
            fill="#FF3B30"
            stroke="white"
            strokeWidth="2.5"
          />
        </svg>
      )}
    </div>
  );
}

export const StaticRouteMap = dynamic(
  () => Promise.resolve(StaticRouteMapInner),
  { ssr: false }
);
