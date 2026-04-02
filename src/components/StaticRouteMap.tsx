"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { getRoutePoints, isRouteCached } from "@/utils/routeCache";

// ── Tile math helpers ──────────────────────────────────────────────────────

function latLngToTileXY(lat: number, lng: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2) *
    n;
  return { x, y };
}

function getBestZoom(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  canvasW: number,
  canvasH: number
): number {
  for (let z = 17; z >= 10; z--) {
    const topLeft = latLngToTileXY(maxLat, minLng, z);
    const bottomRight = latLngToTileXY(minLat, maxLng, z);
    const tileW = (bottomRight.x - topLeft.x) * 256;
    const tileH = (bottomRight.y - topLeft.y) * 256;
    if (tileW <= canvasW * 1.5 && tileH <= canvasH * 1.5) return z;
  }
  return 13;
}

// ── Main component ────────────────────────────────────────────────────────

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(() => isRouteCached(workoutId));
  const [status, setStatus] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");

  // IntersectionObserver
  useEffect(() => {
    if (visible) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) setVisible(true);
      },
      { threshold: 0.1 }
    );
    if (wrapperRef.current) obs.observe(wrapperRef.current);
    return () => obs.disconnect();
  }, [visible]);

  // Fetch + draw when visible
  useEffect(() => {
    if (!visible || status !== "idle") return;
    let cancelled = false;
    setStatus("loading");

    async function draw() {
      try {
        const points = await getRoutePoints(uid, workoutId);
        if (cancelled) return;
        if (points.length < 2) {
          setStatus("error");
          return;
        }

        const canvas = canvasRef.current;
        if (cancelled) return;
        if (!canvas) { setStatus("error"); return; }
        const ctx = canvas.getContext("2d");
        if (!ctx) { setStatus("error"); return; }

        const W = canvas.width;
        const H = canvas.height;

        const lats = points.map((p) => p.lat);
        const lngs = points.map((p) => p.lng);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);

        // Add padding to bounding box (15%)
        const latPad = (maxLat - minLat) * 0.15 || 0.002;
        const lngPad = (maxLng - minLng) * 0.15 || 0.002;
        const pMinLat = minLat - latPad;
        const pMaxLat = maxLat + latPad;
        const pMinLng = minLng - lngPad;
        const pMaxLng = maxLng + lngPad;

        const zoom = getBestZoom(pMinLat, pMaxLat, pMinLng, pMaxLng, W, H);

        // Tile grid covering padded bounding box
        const tl = latLngToTileXY(pMaxLat, pMinLng, zoom);
        const br = latLngToTileXY(pMinLat, pMaxLng, zoom);

        const tileX0 = Math.floor(tl.x);
        const tileY0 = Math.floor(tl.y);
        const tileX1 = Math.ceil(br.x);
        const tileY1 = Math.ceil(br.y);

        // Total tile grid dimensions in pixels
        const gridW = (tileX1 - tileX0) * 256;
        const gridH = (tileY1 - tileY0) * 256;

        // Scale to fit canvas
        const scale = Math.min(W / gridW, H / gridH);
        const drawW = gridW * scale;
        const drawH = gridH * scale;
        const offsetX = (W - drawW) / 2;
        const offsetY = (H - drawH) / 2;

        // Fill background
        ctx.fillStyle = "#e8ecf0";
        ctx.fillRect(0, 0, W, H);

        // Draw tiles
        const tilePromises: Promise<void>[] = [];
        for (let tx = tileX0; tx < tileX1; tx++) {
          for (let ty = tileY0; ty < tileY1; ty++) {
            const p = new Promise<void>((res) => {
              const img = new Image();
              img.crossOrigin = "anonymous";
              img.onload = () => {
                if (cancelled) {
                  res();
                  return;
                }
                const dx = offsetX + (tx - tileX0) * 256 * scale;
                const dy = offsetY + (ty - tileY0) * 256 * scale;
                ctx.drawImage(img, dx, dy, 256 * scale, 256 * scale);
                res();
              };
              img.onerror = () => res();
              const sub = ["a", "b", "c"][(tx + ty) % 3];
              img.src = `https://${sub}.tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
            });
            tilePromises.push(p);
          }
        }

        await Promise.all(tilePromises);
        if (cancelled) return;

        // Helper: lat/lng → canvas pixel
        function toCanvasPx(lat: number, lng: number) {
          const tilePos = latLngToTileXY(lat, lng, zoom);
          const px = offsetX + (tilePos.x - tileX0) * 256 * scale;
          const py = offsetY + (tilePos.y - tileY0) * 256 * scale;
          return { px, py };
        }

        // Downsample for drawing
        const step = Math.max(1, Math.floor(points.length / 500));
        const sampled = points.filter((_, i) => i % step === 0);

        // Draw route shadow
        ctx.beginPath();
        sampled.forEach((pt, i) => {
          const { px, py } = toCanvasPx(pt.lat, pt.lng);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.strokeStyle = "rgba(0,122,255,0.25)";
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();

        // Draw route line
        ctx.beginPath();
        sampled.forEach((pt, i) => {
          const { px, py } = toCanvasPx(pt.lat, pt.lng);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.strokeStyle = "#007AFF";
        ctx.lineWidth = 3.5;
        ctx.stroke();

        // Start dot — green
        const { px: sx, py: sy } = toCanvasPx(
          points[0].lat,
          points[0].lng
        );
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#34C759";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // End dot — red
        const last = points[points.length - 1];
        const { px: ex, py: ey } = toCanvasPx(last.lat, last.lng);
        ctx.beginPath();
        ctx.arc(ex, ey, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#FF3B30";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        if (cancelled) return;
        setStatus("done");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    draw();
    return () => {
      cancelled = true;
    };
  }, [visible, uid, workoutId, status]);

  return (
    <div
      ref={wrapperRef}
      onClick={onClick}
      className={`relative overflow-hidden cursor-pointer ${className ?? ""}`}
      style={{ backgroundColor: "#e8ecf0" }}
    >
      <canvas
        ref={canvasRef}
        width={400}
        height={300}
        className="w-full h-full"
        style={{ display: "block" }}
      />

      {/* Loading overlay */}
      {(status === "idle" || status === "loading") && visible && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/60 backdrop-blur-[1px]">
          <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <span className="text-xs text-gray-400">No route data</span>
        </div>
      )}
    </div>
  );
}

export const StaticRouteMap = dynamic(
  () => Promise.resolve(StaticRouteMapInner),
  { ssr: false }
);
