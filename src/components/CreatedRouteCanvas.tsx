"use client";

import { useEffect, useRef, useState } from "react";
import type { CreatedRouteWaypoint } from "@/types/createdRoute";
import dynamic from "next/dynamic";

interface Props {
  waypoints: CreatedRouteWaypoint[];
  className?: string;
  onClick?: () => void;
}

// ── Tile math (identical to StaticRouteMap) ────────────────────

function latLngToTileXY(lat: number, lng: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
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
    const tl = latLngToTileXY(maxLat, minLng, z);
    const br = latLngToTileXY(minLat, maxLng, z);
    const tileW = (br.x - tl.x) * 256;
    const tileH = (br.y - tl.y) * 256;
    if (tileW <= canvasW * 1.5 && tileH <= canvasH * 1.5) return z;
  }
  return 13;
}

// ── Main component ────────────────────────────────────────────

function CreatedRouteCanvasInner({ waypoints, className, onClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );

  useEffect(() => {
    if (waypoints.length < 2) {
      setStatus("error");
      return;
    }
    let cancelled = false;
    setStatus("loading");

    async function draw() {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const W = canvas.width;
        const H = canvas.height;

        const sorted = [...waypoints];
        const lats = sorted.map((p) => p.lat);
        const lngs = sorted.map((p) => p.lng);
        const minLat = Math.min(...lats),
          maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs),
          maxLng = Math.max(...lngs);

        const latPad = (maxLat - minLat) * 0.15 || 0.002;
        const lngPad = (maxLng - minLng) * 0.15 || 0.002;
        const pMinLat = minLat - latPad,
          pMaxLat = maxLat + latPad;
        const pMinLng = minLng - lngPad,
          pMaxLng = maxLng + lngPad;

        const zoom = getBestZoom(pMinLat, pMaxLat, pMinLng, pMaxLng, W, H);

        const tl = latLngToTileXY(pMaxLat, pMinLng, zoom);
        const br = latLngToTileXY(pMinLat, pMaxLng, zoom);
        const tileX0 = Math.floor(tl.x),
          tileY0 = Math.floor(tl.y);
        const tileX1 = Math.ceil(br.x),
          tileY1 = Math.ceil(br.y);

        const gridW = (tileX1 - tileX0) * 256;
        const gridH = (tileY1 - tileY0) * 256;
        const scale = Math.min(W / gridW, H / gridH);
        const drawW = gridW * scale,
          drawH = gridH * scale;
        const offsetX = (W - drawW) / 2,
          offsetY = (H - drawH) / 2;

        ctx.fillStyle = "#e8ecf0";
        ctx.fillRect(0, 0, W, H);

        // Draw tiles
        const tilePromises: Promise<void>[] = [];
        for (let tx = tileX0; tx < tileX1; tx++) {
          for (let ty = tileY0; ty < tileY1; ty++) {
            tilePromises.push(
              new Promise<void>((res) => {
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
              })
            );
          }
        }
        await Promise.all(tilePromises);
        if (cancelled) return;

        // lat/lng → canvas pixel
        function toPx(lat: number, lng: number) {
          const tp = latLngToTileXY(lat, lng, zoom);
          return {
            px: offsetX + (tp.x - tileX0) * 256 * scale,
            py: offsetY + (tp.y - tileY0) * 256 * scale,
          };
        }

        // Draw route shadow
        ctx.beginPath();
        sorted.forEach((pt, i) => {
          const { px, py } = toPx(pt.lat, pt.lng);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.strokeStyle = "rgba(37,99,235,0.25)";
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();

        // Draw route — dashed to distinguish from recorded runs
        ctx.beginPath();
        sorted.forEach((pt, i) => {
          const { px, py } = toPx(pt.lat, pt.lng);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.setLineDash([8, 4]);
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.setLineDash([]);

        // Start dot — green
        const { px: sx, py: sy } = toPx(sorted[0].lat, sorted[0].lng);
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fillStyle = "#34C759";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // End dot — red
        const last = sorted[sorted.length - 1];
        const { px: ex, py: ey } = toPx(last.lat, last.lng);
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
  }, [waypoints]);

  return (
    <div
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
      {(status === "idle" || status === "loading") && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/60">
          <div
            className="w-5 h-5 rounded-full border-2 border-blue-500
                          border-t-transparent animate-spin"
          />
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
          <span className="text-xs text-gray-400">No route data</span>
        </div>
      )}
    </div>
  );
}

export const CreatedRouteCanvas = dynamic(
  () => Promise.resolve(CreatedRouteCanvasInner),
  { ssr: false }
);
