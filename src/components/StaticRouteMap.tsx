"use client";

import React, { useEffect, useState, useRef } from "react";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";

interface StaticRouteMapProps {
  uid: string;
  workoutId: string;
  className?: string;
  onClick?: () => void;
}

export function StaticRouteMap({
  uid,
  workoutId,
  className = "",
  onClick,
}: StaticRouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [loading, setLoading] = useState(true);

  // Lazy load: only fetch when card enters viewport
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

  useEffect(() => {
    if (!visible) return;
    fetchRoutePoints(uid, workoutId)
      .then((pts) => {
        setPoints(pts);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [visible, uid, workoutId]);

  if (!visible || loading) {
    return (
      <div
        ref={containerRef}
        className={`bg-surface animate-pulse ${className}`}
      />
    );
  }

  if (points.length < 2) {
    return (
      <div
        ref={containerRef}
        className={`bg-surface flex items-center justify-center ${className}`}
      >
        <span className="text-xs text-textSecondary">No route data</span>
      </div>
    );
  }

  // Project lat/lng to SVG coordinates
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const padding = 20;
  const svgW = 400;
  const svgH = 300;

  const scaleX = (lng: number) =>
    padding +
    ((lng - minLng) / (maxLng - minLng || 1)) * (svgW - padding * 2);

  // Invert Y axis (lat increases upward, SVG y increases downward)
  const scaleY = (lat: number) =>
    padding +
    (1 - (lat - minLat) / (maxLat - minLat || 1)) * (svgH - padding * 2);

  // Downsample for performance — max 200 points for SVG
  const step = Math.max(1, Math.floor(points.length / 200));
  const sampled = points.filter((_, i) => i % step === 0);

  const polyline = sampled
    .map((p) => `${scaleX(p.lng).toFixed(1)},${scaleY(p.lat).toFixed(1)}`)
    .join(" ");

  const startPt = sampled[0];
  const endPt = sampled[sampled.length - 1];

  return (
    <div
      ref={containerRef}
      className={`bg-[#f0f0f0] dark:bg-[#1a1a1a] cursor-pointer hover:opacity-90 transition-opacity ${className}`}
      onClick={onClick}
    >
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <polyline
          points={polyline}
          fill="none"
          stroke="#007AFF"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx={scaleX(startPt.lng)}
          cy={scaleY(startPt.lat)}
          r="6"
          fill="#34C759"
          stroke="white"
          strokeWidth="2"
        />
        <circle
          cx={scaleX(endPt.lng)}
          cy={scaleY(endPt.lat)}
          r="6"
          fill="#FF3B30"
          stroke="white"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}
