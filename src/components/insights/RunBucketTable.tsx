"use client";

import React, { useMemo } from "react";
import { useRouter } from "next/navigation";

import { formatPaceLabel } from "@/utils/pace";
import {
  toEfficiencyWorkout,
  type RunAnalysisWorkout,
} from "@/lib/runAnalysisTrend";
import { scoreWorkoutsEfficiency } from "@/utils/efficiencyScore";
import { resolveDisplayLoad } from "@/utils/trainingLoad";

/** Every cell falls back to this — never "NaN", "null", or a bare 0. */
const EMPTY = "—";

/** "Jul 13" — matches paceRangeTrend's weekly labelFor format. */
function formatRunDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return EMPTY;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface RunBucketTableProps {
  /** The clicked bucket's runs — the rows actually rendered. */
  runs: RunAnalysisWorkout[];
  /**
   * The FULL workout population the chart was built from. Required (not merely
   * preferable) for efficiency scoring: scoreWorkoutsEfficiency builds each run's
   * baseline from its neighbours over a trailing 60-day window and needs
   * MIN_BASELINE_RUNS (5) of them. A weekly bucket holds ~1–4 runs, so scoring
   * `runs` alone would leave every row 'building_baseline' and render the whole
   * Efficiency column as EMPTY. Passing the full set also makes these scores
   * identical to the chart's efficiencyScore metric.
   */
  allWorkouts: RunAnalysisWorkout[];
  bucketLabel: string;
  runCount: number;
  restingHr: number;
  maxHr: number;
}

export function RunBucketTable({
  runs,
  allWorkouts,
  bucketLabel,
  runCount,
  restingHr,
  maxHr,
}: RunBucketTableProps): React.JSX.Element {
  const router = useRouter();

  // Efficiency is baseline-relative: score the FULL population ONCE (the
  // self-excluding, date-anchored contract in scoreWorkoutsEfficiency), then look
  // up each row by workoutId — the same one-pass-over-everything approach
  // buildRunAnalysisTrend uses for its efficiencyScore metric.
  const effScores = useMemo(
    () =>
      scoreWorkoutsEfficiency(
        allWorkouts.map(toEfficiencyWorkout),
        restingHr,
        maxHr
      ),
    [allWorkouts, restingHr, maxHr]
  );

  return (
    <div className="mt-4">
      <p className="text-xs font-semibold text-textSecondary mb-2">
        {bucketLabel} · {runCount} {runCount === 1 ? "run" : "runs"}
      </p>

      {/* Every one of the 7 columns is the reason this table exists, so none are
          dropped responsively — the table scrolls sideways on narrow viewports
          instead. */}
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          {/* Header */}
          <div className="flex items-center gap-3 px-4 pb-1.5 mb-1 border-b border-border">
            <div className="w-14 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide">
              Date
            </div>
            <div className="w-20 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              Distance
            </div>
            <div className="w-20 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              Pace
            </div>
            <div className="w-16 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              HR
            </div>
            <div className="w-20 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              Cadence
            </div>
            <div className="w-20 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              Efficiency
            </div>
            <div className="w-14 shrink-0 text-[10px] font-semibold text-textSecondary uppercase tracking-wide text-right">
              Load
            </div>
          </div>

          {runs.map((run) => {
            // Raw per-run pace — the chart's [MIN_VALID_PACE, MAX_VALID_PACE]
            // outlier guard bounds the bucket AVERAGE only. A GPS-glitch pace
            // still shows its real value here; only a null renders EMPTY.
            const pace =
              run.avgPaceSecPerMile != null &&
              Number.isFinite(run.avgPaceSecPerMile) &&
              run.avgPaceSecPerMile > 0
                ? `${formatPaceLabel(run.avgPaceSecPerMile)}/mi`
                : EMPTY;

            const hr =
              run.avgHeartRate != null && Number.isFinite(run.avgHeartRate)
                ? `${Math.round(run.avgHeartRate)} bpm`
                : EMPTY;

            const cadence =
              run.cadenceSPM != null && Number.isFinite(run.cadenceSPM)
                ? `${Math.round(run.cadenceSPM)} spm`
                : EMPTY;

            // 'building_baseline' (or a run missing from the map) has no score —
            // shown as EMPTY, never as 0.
            const effResult = effScores.get(run.workoutId);
            const efficiency =
              effResult && effResult.status === "scored" && effResult.score != null
                ? `${Math.round(effResult.score)}`
                : EMPTY;

            const loadValue = resolveDisplayLoad(run, maxHr, restingHr);
            const load =
              loadValue != null && Number.isFinite(loadValue)
                ? `${Math.round(loadValue)}`
                : EMPTY;

            return (
              <div
                key={run.workoutId}
                onClick={() => router.push(`/runs/${run.workoutId}`)}
                className="flex items-center gap-3 py-3 px-4 hover:bg-surface rounded-xl transition-colors group cursor-pointer"
              >
                <div className="w-14 shrink-0 text-sm text-textPrimary">
                  {formatRunDate(run.date)}
                </div>
                <div className="w-20 shrink-0 text-sm font-semibold text-textPrimary tabular-nums text-right">
                  {run.distanceMiles.toFixed(2)} mi
                </div>
                <div className="w-20 shrink-0 text-sm text-textPrimary tabular-nums text-right">
                  {pace}
                </div>
                <div className="w-16 shrink-0 text-sm text-textPrimary tabular-nums text-right">
                  {hr}
                </div>
                <div className="w-20 shrink-0 text-sm text-textPrimary tabular-nums text-right">
                  {cadence}
                </div>
                <div className="w-20 shrink-0 text-sm text-textPrimary tabular-nums text-right">
                  {efficiency}
                </div>
                <div className="w-14 shrink-0 text-sm text-textPrimary tabular-nums text-right">
                  {load}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
