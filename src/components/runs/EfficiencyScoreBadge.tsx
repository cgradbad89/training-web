"use client";

import React, { useRef, useState } from "react";
import {
  MIN_BASELINE_RUNS,
  type EfficiencyScoreResult,
  type EfficiencyTier,
} from "@/utils/efficiencyScore";

interface EfficiencyScoreBadgeProps {
  result: EfficiencyScoreResult;
  tier: EfficiencyTier;
  /** inputs.baseline.runCount from the caller — used ONLY for the
   *  "building baseline" tooltip messaging (how far off a usable baseline is). */
  baselineRunCount: number;
}

/**
 * Score → color band. 65+ reads as efficient (green), <35 as inefficient
 * (red), everything between neutral (amber).
 *
 * DEVIATION from the Phase-1/2 prompt (which specified this as a non-exported
 * internal helper): exported so it can be unit-tested directly, per the test
 * requirements. Not part of the component's rendering contract.
 */
export function getScoreBand(score: number): "high" | "mid" | "low" {
  if (score >= 65) return "high";
  if (score < 35) return "low";
  return "mid";
}

// Band → token classes (text + faint tint + border). All three tokens are
// already generated elsewhere in the app, so Tailwind v4 keeps them.
const BAND_CLASSES: Record<"high" | "mid" | "low", string> = {
  high: "text-success bg-success/10 border-success/20",
  mid: "text-warning bg-warning/10 border-warning/20",
  low: "text-danger bg-danger/10 border-danger/20",
};

// Raw enum → human label shown in the tooltip (never the raw enum).
const TIER_LABEL: Record<EfficiencyTier, string> = {
  BASELINE: "easy",
  QUALITY: "quality",
  RACE: "race",
};

/** Round a fraction (0.12) to a signed percent string ("+12%", "-8%", "0%"). */
function signedPct(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/**
 * Compact per-run Efficiency score pill with a fixed-positioned hover tooltip.
 * Mirrors TrainingLoadBadge's tooltip mechanism (JS state + getBoundingClientRect
 * + position:fixed so the tooltip escapes any overflow-hidden parent).
 */
export function EfficiencyScoreBadge({
  result,
  tier,
  baselineRunCount,
}: EfficiencyScoreBadgeProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const isBuilding = result.status === "building_baseline" || result.score == null;
  const band = isBuilding ? null : getScoreBand(result.score as number);

  const colorClasses = band
    ? BAND_CLASSES[band]
    : "text-textSecondary bg-surface border-border";

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
        className={`inline-flex items-center rounded-lg border px-2 py-1 text-sm font-bold tabular-nums cursor-help select-none leading-none ${colorClasses}`}
        aria-label="Efficiency score"
      >
        {isBuilding ? (
          <span className="text-[11px] font-medium">Building baseline</span>
        ) : (
          Math.round(result.score as number)
        )}
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
          <p className="font-medium text-textPrimary mb-0.5 text-xs">
            Efficiency
          </p>
          {isBuilding ? (
            <p className="text-[11px] text-textSecondary">
              Not enough similar-effort runs yet in the last 60 days (
              {baselineRunCount} of {MIN_BASELINE_RUNS}).
            </p>
          ) : (
            <div className="space-y-1 text-[11px] text-textSecondary">
              <div className="flex justify-between gap-2">
                <span>Score</span>
                <span className="tabular-nums text-textPrimary">
                  {Math.round(result.score as number)}
                </span>
              </div>
              {result.percentDeltaVsBaseline != null && (
                <div className="flex justify-between gap-2">
                  <span>vs your 60-day baseline</span>
                  <span className="tabular-nums text-textPrimary">
                    {signedPct(result.percentDeltaVsBaseline)}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span>Effort type</span>
                <span className="text-textPrimary">{TIER_LABEL[tier]}</span>
              </div>
              {result.cadenceDeltaVsBaseline != null && (
                <div className="flex justify-between gap-2">
                  <span>Cadence vs baseline</span>
                  <span className="tabular-nums text-textPrimary">
                    {signedPct(result.cadenceDeltaVsBaseline)}
                  </span>
                </div>
              )}
            </div>
          )}
          <p className="text-[10px] text-textSecondary italic mt-2">
            Speed per heartbeat vs your own recent {TIER_LABEL[tier]}-effort runs.
          </p>
        </div>
      )}
    </div>
  );
}
