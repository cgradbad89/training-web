/**
 * Plan-completion projection for the Plan Insights predicted-finish chart.
 *
 * The existing `buildPredictionTrend` (racePrediction.ts) plots the predicted
 * finish recomputed at each ELAPSED plan week from real runs only. This module
 * extends that trend into the FUTURE: for every plan week that hasn't started
 * yet, it re-runs the SAME predictRaceTime pipeline with an `asOf` at that
 * week's end, blending:
 *
 *   (real historical efforts, aged + decayed relative to that week) +
 *   (synthetic PLANNED-tier efforts for every planned run up to that week)
 *
 * The blend is what keeps the projection honest: planned future runs are mostly
 * easy pace, so a plan-only fit would flatten or worsen the trend. Instead the
 * real quality/race efforts already in the historical set keep informing the fit
 * via the model's existing 120-day memory + ~5-week half-life decay (they simply
 * decay as the reference date marches toward race day), while the planned runs
 * contribute volume. No new fit formula, clamp, or decay constant — only the
 * PLANNED tier (weight ×1) and predictRaceTime's `extraEfforts` hook are used.
 *
 * No storage — everything is recomputed in-memory, same as the historical trend.
 */

import { planEntryToSyntheticEffort } from "@/utils/riegelFit";
import {
  predictRaceTime,
  type PredictionRun,
  type RacePredictionParams,
} from "@/utils/racePrediction";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";

export interface PredictionProjectionPoint {
  /** Matches the historical trend's week label ("W{n}") so the chart aligns. */
  weekLabel: string;
  /** ISO date of the week end (Sun EOD), or race day for the final week. */
  weekEndDate: string;
  /** Blended projected finish (seconds); null when the week can't be fit. */
  predictedSeconds: number | null;
  /** Always true here — every point is a future/synthetic projection. */
  isProjected: boolean;
}

export interface BuildPredictionProjectionInput {
  /** The active running plan — provides week boundaries + labels + entries. */
  plan: RunningPlan;
  /** Real historical runs, unchanged (same shape predictRaceTime consumes). */
  historicalRuns: PredictionRun[];
  /** Race-prediction params (distance, race anchors, best-effort segments). */
  params: RacePredictionParams;
  /** The race date — projection never extends past it. */
  raceDate: Date;
  /** Reference "now"; weeks starting after this are the projected future. */
  today?: Date;
}

/** Midday of `plan.startDate` + weekIndex*7 + (weekday-1) — the entry's date. */
function plannedEntryDate(planStart: Date, entry: PlannedRunEntry): Date {
  const d = new Date(planStart);
  d.setDate(d.getDate() + entry.weekIndex * 7 + (entry.weekday - 1));
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Build the dashed projection series: one point per FUTURE plan week (a week
 * whose Monday is after `today`) up to and including race day.
 *
 * Returns an empty array when there is nothing to project — no future weeks, or
 * no remaining planned entries between today and the race date. The chart then
 * renders exactly as it does without a projection (historical line only).
 */
export function buildPredictionProjection(
  input: BuildPredictionProjectionInput
): PredictionProjectionPoint[] {
  const { plan, historicalRuns, params, raceDate } = input;
  const today = input.today ?? new Date();
  const nowMs = today.getTime();
  const raceMs = raceDate.getTime();
  const planStart = new Date(plan.startDate);

  // Planned RUN entries scheduled strictly after today and on/before race day
  // that can actually become a synthetic effort (not rest days / zero-distance /
  // no-pace). These are the only ones that add future volume to the projection.
  // Validity is asOf-independent, so probe with asOf = the entry's own date.
  const remaining: Array<{ entry: PlannedRunEntry; date: Date }> = [];
  for (const week of plan.weeks) {
    for (const entry of week.entries) {
      const date = plannedEntryDate(planStart, entry);
      const ms = date.getTime();
      if (ms <= nowMs || ms > raceMs) continue;
      if (planEntryToSyntheticEffort(entry, date, date) == null) continue;
      remaining.push({ entry, date });
    }
  }
  if (remaining.length === 0) return [];

  const points: PredictionProjectionPoint[] = [];

  for (const week of plan.weeks) {
    // Week date range — identical to buildPlanAdherence / buildPredictionTrend.
    const ws = new Date(planStart);
    ws.setDate(ws.getDate() + (week.weekNumber - 1) * 7);
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    we.setHours(23, 59, 59, 999);

    // Only future weeks are projected; elapsed/in-progress weeks belong to the
    // historical (solid) trend. Weeks entirely past race day are skipped.
    if (ws.getTime() <= nowMs) continue;
    if (ws.getTime() > raceMs) continue;

    // Cap the reference at race day so the terminal point lands on race day,
    // never beyond it.
    const asOf = we.getTime() <= raceMs ? we : raceDate;

    // Synthetic PLANNED efforts for every remaining entry up to and including
    // this week, each aged relative to THIS week's asOf (correct decay).
    const extraEfforts = remaining
      .filter((r) => r.date.getTime() <= asOf.getTime())
      .map((r) => planEntryToSyntheticEffort(r.entry, r.date, asOf))
      .filter((e): e is NonNullable<typeof e> => e != null);

    const { predictedSeconds } = predictRaceTime(
      historicalRuns,
      { ...params, extraEfforts },
      asOf
    );

    points.push({
      weekLabel: `W${week.weekNumber}`,
      weekEndDate: asOf.toISOString(),
      predictedSeconds,
      isProjected: true,
    });
  }

  return points;
}
