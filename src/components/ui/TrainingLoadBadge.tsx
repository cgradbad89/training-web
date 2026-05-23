"use client";

import { useRef, useState } from "react";
import {
  HR_ZONES,
  MAX_HR,
  computeTrainingLoad,
  getHRZone,
  trainingLoadStatus,
  zoneBoundsBpm,
  TRAINING_LOAD_STATUS_LABEL,
  type TrainingLoadStatus,
} from "@/utils/trainingLoad";

interface TrainingLoadBadgeProps {
  durationSeconds: number;
  avgHeartRate: number | null | undefined;
  /** "compact" = list/dashboard sizing, "large" = run detail page. */
  size?: "compact" | "large";
}

const STATUS_CLASSES: Record<TrainingLoadStatus, string> = {
  low: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  moderate: "bg-green-500/10 text-green-500 border-green-500/20",
  hard: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  "very-hard": "bg-red-500/10 text-red-500 border-red-500/20",
};

const NEUTRAL_CLASSES =
  "bg-surface text-textSecondary border-border";

/**
 * Compact Training Load badge with a fixed-positioned tooltip on hover.
 * Tooltip lists every HR zone (boundaries + multiplier) and highlights
 * the zone this specific run lands in.
 *
 * Fixed positioning is used so the tooltip can escape any parent
 * `overflow-hidden` clipping (same pattern as the old EfficiencyTooltip).
 */
export function TrainingLoadBadge({
  durationSeconds,
  avgHeartRate,
  size = "compact",
}: TrainingLoadBadgeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const score = computeTrainingLoad(durationSeconds, avgHeartRate);
  const hasScore = score != null;
  const status = hasScore ? trainingLoadStatus(score!) : null;
  const runZone =
    hasScore && avgHeartRate && avgHeartRate > 0 ? getHRZone(avgHeartRate) : null;

  const colorClasses = status ? STATUS_CLASSES[status] : NEUTRAL_CLASSES;

  const sizeClasses =
    size === "large"
      ? "px-3 py-1.5 [&_.tl-label]:text-[11px] [&_.tl-value]:text-xl"
      : "px-2 py-1 [&_.tl-label]:text-[9px] [&_.tl-value]:text-sm";

  function computePos() {
    if (!ref.current) return null;
    const r = ref.current.getBoundingClientRect();
    return { top: r.top - 8, left: r.left + r.width / 2 };
  }

  return (
    <div className="relative inline-block">
      <div
        ref={ref}
        onMouseEnter={() => setPos(computePos())}
        onMouseLeave={() => setPos(null)}
        className={`flex flex-col items-center rounded-lg border cursor-help select-none ${sizeClasses} ${colorClasses}`}
        aria-label="Training Load score"
      >
        <span className="tl-label font-medium leading-none">Load</span>
        <span className="tl-value font-bold leading-none mt-0.5 tabular-nums">
          {hasScore ? score : "—"}
        </span>
      </div>

      {pos && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            transform: "translate(-50%, -100%)",
            zIndex: 9999,
          }}
          className="w-60 bg-card border border-border rounded-lg p-3 shadow-lg pointer-events-none"
        >
          <p className="font-medium text-textPrimary mb-1 text-xs">Training Load</p>
          <p className="text-textSecondary mb-2 text-[11px]">
            How hard you worked, combining duration and heart rate intensity.
          </p>
          <div className="space-y-1 text-[11px] mb-2">
            {HR_ZONES.map((z) => {
              const isYour = runZone?.zone === z.zone;
              const { min, maxLabel } = zoneBoundsBpm(z);
              const bpmRange =
                z.zone === HR_ZONES.length
                  ? `${maxLabel} bpm`
                  : `${min}–${maxLabel}`;
              return (
                <div
                  key={z.zone}
                  className={`flex justify-between gap-2 ${
                    isYour ? "font-semibold text-textPrimary" : "text-textSecondary"
                  }`}
                >
                  <span>
                    Z{z.zone} {z.label}
                  </span>
                  <span className="tabular-nums">
                    {bpmRange} ×{z.multiplier}
                  </span>
                </div>
              );
            })}
          </div>
          {hasScore && runZone && status && (
            <>
              <p className="text-[11px] text-textPrimary mb-0.5">
                Your zone: Zone {runZone.zone} — {runZone.label}
              </p>
              <p className="text-[11px] text-textPrimary mb-1.5">
                Your score: {score} ({TRAINING_LOAD_STATUS_LABEL[status]})
              </p>
            </>
          )}
          <p className="text-[10px] text-textSecondary italic">
            Higher score = harder effort. A half marathon scores 3–5× an easy run.
            Max HR {MAX_HR} bpm.
          </p>
        </div>
      )}
    </div>
  );
}
