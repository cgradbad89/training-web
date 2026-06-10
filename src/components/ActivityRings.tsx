"use client";

import type { RingMetric } from "@/types/healthGoal";

export interface RingDatum {
  metric: RingMetric;
  label: string;
  /** Uncapped progress — 1.0 = ring closed, 1.42 wraps 42% past the top. */
  progress: number;
  /** Resolved CSS color (e.g. from the Health page's getColor() mapping). */
  color: string;
  /** e.g. "8,432 / 10,000" */
  valueLabel: string;
}

export interface ActivityRingsProps {
  /** Rendered outer → inner in array order. */
  rings: RingDatum[];
  /** Outer diameter in px. Scales cleanly from ~36 (calendar mini) to ~220 (hero). */
  size: number;
  onRingClick?: (metric: RingMetric) => void;
  showLegend?: boolean;
}

/**
 * Apple-style concentric activity rings, hand-rolled SVG (no chart libs).
 *
 * - Track ring at low opacity; progress arc with rounded caps from 12 o'clock.
 * - Overfill (progress > 1) renders a second arc pass in a slightly darker
 *   shade of the same color so the wrap-around overlap reads like Apple's.
 */
export function ActivityRings({
  rings,
  size,
  onRingClick,
  showLegend = false,
}: ActivityRingsProps) {
  const center = size / 2;
  const strokeW = Math.max(2, size * 0.072);
  const gap = Math.max(0.5, strokeW * 0.22);
  const outerRadius = center - strokeW / 2 - 1;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={rings
          .map((r) => `${r.label} ${Math.round(r.progress * 100)}%`)
          .join(", ")}
      >
        {rings.map((ring, i) => {
          const r = outerRadius - i * (strokeW + gap);
          if (r <= strokeW / 2) return null; // too many rings for this size
          const circumference = 2 * Math.PI * r;
          const progress = Number.isFinite(ring.progress)
            ? Math.max(ring.progress, 0)
            : 0;
          const baseFrac = Math.min(progress, 1);
          const overFrac = Math.min(Math.max(progress - 1, 0), 1);
          const clickable = !!onRingClick;

          return (
            <g
              key={ring.metric}
              transform={`rotate(-90 ${center} ${center})`}
              onClick={clickable ? () => onRingClick(ring.metric) : undefined}
              style={clickable ? { cursor: "pointer" } : undefined}
              aria-hidden
            >
              <title>{`${ring.label}: ${ring.valueLabel}`}</title>
              {/* Track */}
              <circle
                cx={center}
                cy={center}
                r={r}
                fill="none"
                stroke={ring.color}
                strokeOpacity={0.16}
                strokeWidth={strokeW}
              />
              {/* Progress arc (first revolution) */}
              {baseFrac > 0 && (
                <circle
                  cx={center}
                  cy={center}
                  r={r}
                  fill="none"
                  stroke={ring.color}
                  strokeWidth={strokeW}
                  strokeLinecap="round"
                  strokeDasharray={`${baseFrac * circumference} ${circumference}`}
                />
              )}
              {/* Overfill arc (second revolution) — darker shade on top */}
              {overFrac > 0 && (
                <circle
                  cx={center}
                  cy={center}
                  r={r}
                  fill="none"
                  stroke={`color-mix(in srgb, ${ring.color} 72%, black)`}
                  strokeWidth={strokeW}
                  strokeLinecap="round"
                  strokeDasharray={`${overFrac * circumference} ${circumference}`}
                />
              )}
            </g>
          );
        })}
      </svg>

      {showLegend && (
        <div className="flex flex-col gap-1 w-full max-w-xs">
          {rings.map((ring) => {
            const clickable = !!onRingClick;
            const row = (
              <>
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: ring.color }}
                />
                <span className="text-xs text-textPrimary flex-1 text-left">
                  {ring.label}
                </span>
                <span className="text-xs text-textSecondary tabular-nums">
                  {ring.valueLabel}
                </span>
                <span className="text-xs font-semibold tabular-nums w-12 text-right" style={{ color: ring.color }}>
                  {Math.round(ring.progress * 100)}%
                </span>
              </>
            );
            return clickable ? (
              <button
                key={ring.metric}
                type="button"
                onClick={() => onRingClick?.(ring.metric)}
                className="flex items-center gap-2 py-1 px-1.5 rounded-lg hover:bg-surface transition-colors"
              >
                {row}
              </button>
            ) : (
              <div key={ring.metric} className="flex items-center gap-2 py-1 px-1.5">
                {row}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
