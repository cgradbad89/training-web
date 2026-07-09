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
 * PLANNED tier (weight ×1, or PLANNED_QUALITY ×1.75 for entries whose pace beats
 * the plan's easy baseline — see computePlanEasyPaceBaseline) and predictRaceTime's
 * `extraEfforts` hook are used.
 *
 * No storage — everything is recomputed in-memory, same as the historical trend.
 *
 * ⚠️ The raw `buildPredictionProjection` is a SIGNAL generator, not the displayed
 * series. On its own it trends monotonically slower toward race day: synthetic
 * PLANNED efforts stay perpetually fresh (aged relative to each future week) and
 * accumulate week over week, while the one strong real signal (the RACE anchor)
 * decays away — so easy planned volume dominates the fit and drags its intercept
 * toward easy pace. `buildAnchoredPredictionProjection` is what the chart renders:
 * it anchors to TODAY'S live prediction and lets the raw signal apply only a
 * bounded ±`MAX_PROJECTION_ADJUSTMENT_PCT` nudge.
 */

import {
  planEntryToSyntheticEffort,
  computePlanEasyPaceBaseline,
} from "@/utils/riegelFit";
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

  // Stable across the whole projection (not recomputed per-week) — derived from
  // every entry in the plan, elapsed and future alike, already in scope here.
  const planEasyPaceSecPerMile = computePlanEasyPaceBaseline(
    plan.weeks.flatMap((w) => w.entries)
  );

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
      if (planEntryToSyntheticEffort(entry, date, date, planEasyPaceSecPerMile) == null) continue;
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
      .map((r) => planEntryToSyntheticEffort(r.entry, r.date, asOf, planEasyPaceSecPerMile))
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

// ─── Anchored projection (what the chart renders) ───────────────────────────────

/**
 * Caps how far the plan is allowed to move the projected finish away from
 * today's live prediction — ±4% of the live baseline, regardless of how many
 * weeks out the projection runs.
 *
 * JUDGMENT CALL, not a derived value: too tight and the dashed line looks flat
 * and uninformative; too loose and the raw signal's "everything trends slower"
 * shape (see the module note above) creeps back in. 4% ≈ ±5:15 on a 2:11 half —
 * enough to show a training block trending down or a taper nudging up, without
 * letting easy planned volume swing the number wildly. Tune from production QA.
 */
export const MAX_PROJECTION_ADJUSTMENT_PCT = 0.04;

export interface BuildAnchoredPredictionProjectionInput
  extends BuildPredictionProjectionInput {
  /**
   * The exact predicted-finish seconds shown on the live prediction card
   * (`predictRaceTime(...).predictedSeconds`, asOf = now, best-effort segments
   * included). Null when the card itself has no prediction (insufficient data) —
   * in that case the projection is empty and the chart shows its normal
   * "not enough data" state.
   */
  liveBaselineSeconds: number | null;
}

/**
 * The DISPLAYED projection series. Re-anchors the raw `buildPredictionProjection`
 * signal to the live prediction card's number so the dashed line can never drift
 * further than ±`MAX_PROJECTION_ADJUSTMENT_PCT` from today's actual fitness:
 *
 *   projectedSeconds = liveBaselineSeconds × (1 + clamp(rawDeltaPct, ±MAX))
 *
 * where `rawDeltaPct` is the raw signal's proportional move from its own week-0
 * (today) value. This keeps the plan's DIRECTION and MAGNITUDE as a real signal
 * (a quality-heavy block still nudges down; a taper still nudges up) while
 * bounding how far it pulls the number. The raw week-0 value is computed the same
 * way the raw trend computes any week — `predictRaceTime` at asOf = today, where
 * no planned entries have occurred yet, so it equals the live baseline by
 * construction (both are the same call); it is used only as the internal
 * reference for measuring direction, never as the displayed number.
 *
 * Returns [] when: the live card has no prediction (`liveBaselineSeconds` null),
 * today's raw fit is insufficient, or the raw signal itself is empty (no active
 * plan / no remaining planned entries) — matching the existing empty-state chart.
 */
export function buildAnchoredPredictionProjection(
  input: BuildAnchoredPredictionProjectionInput
): PredictionProjectionPoint[] {
  const { plan, historicalRuns, params, raceDate, liveBaselineSeconds } = input;
  const today = input.today ?? new Date();

  if (liveBaselineSeconds == null || !isFinite(liveBaselineSeconds)) return [];

  const raw = buildPredictionProjection({
    plan,
    historicalRuns,
    params,
    raceDate,
    today,
  });
  if (raw.length === 0) return [];

  // Raw week-0 (today) reference — the same computation the raw trend does per
  // week, at asOf = today. No planned entries have occurred by today, so this is
  // exactly the live-baseline call; used only to measure the raw signal's drift.
  const rawTodaySeconds = predictRaceTime(historicalRuns, params, today)
    .predictedSeconds;
  if (rawTodaySeconds == null || !isFinite(rawTodaySeconds) || rawTodaySeconds <= 0) {
    return [];
  }

  return raw.map((point) => {
    if (point.predictedSeconds == null) {
      // Raw week couldn't be fit → break the line (no fabricated point).
      return { ...point, predictedSeconds: null };
    }
    const rawDeltaPct =
      (point.predictedSeconds - rawTodaySeconds) / rawTodaySeconds;
    const clampedPct = Math.min(
      Math.max(rawDeltaPct, -MAX_PROJECTION_ADJUSTMENT_PCT),
      MAX_PROJECTION_ADJUSTMENT_PCT
    );
    return {
      ...point,
      predictedSeconds: liveBaselineSeconds * (1 + clampedPct),
    };
  });
}
