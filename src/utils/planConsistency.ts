/**
 * Consistency credit for the Plan Insights forward projection.
 *
 * A separate, bounded, POST-HOC adjustment layered on top of
 * `buildAnchoredPredictionProjection`'s output — deliberately NOT folded into
 * the Riegel fit itself (unlike the fast-finish best-effort mechanism, whose
 * in-fit blending produced a far larger effect than intended when it was
 * tried — see PRD.md §6 #28's "Follow-up #3", reverted). This module never
 * touches `predictRaceTime`, `fitRiegel`, `buildPredictionProjection`, or
 * `buildAnchoredPredictionProjection` — it only transforms their output.
 *
 * Signal: a 50/50 blend of two ALREADY-COMPUTED app signals — no new fitness
 * model is invented here:
 *   (1) weekly adherence % — `buildPlanAdherence`'s `weeksHitTarget` /
 *       `weeksWithPlan` (the same 85% completion rule from commit `877cdce`,
 *       already shown on the Plan Insights page's Adherence card).
 *   (2) CTL ramp-trend health — `trainingLoadSeries.ts`'s `trendVsPast`,
 *       comparing today's CTL to 4 weeks ago (the same lookback Personal
 *       Insights already uses for its own CTL trend arrows).
 *
 * Bound: at most `CONSISTENCY_ADJUSTMENT_MAX_PCT` (2%), entirely separate
 * from `predictionTrend.ts`'s `MAX_PROJECTION_ADJUSTMENT_PCT` (4% anchor
 * clamp) — the two budgets are never combined. ONE-DIRECTIONAL: this can
 * only reduce the projected time (credit for training well), never increase
 * it. Weak or insufficient data yields exactly 0% adjustment — never an
 * error, never a penalty.
 */

import { type Trend } from "@/utils/trainingLoadSeries";
import { type PredictionProjectionPoint } from "@/utils/predictionTrend";

/**
 * Max credit the consistency layer can apply to the Plan Insights forward
 * projection — a SEPARATE budget from `MAX_PROJECTION_ADJUSTMENT_PCT`
 * (predictionTrend.ts, 4%, the anchor clamp). Kept intentionally small: this
 * is a soft nudge on top of an already-bounded projection, not a second full
 * clamp. JUDGMENT CALL, not derived — tune from production QA.
 */
export const CONSISTENCY_ADJUSTMENT_MAX_PCT = 0.02;

/**
 * Minimum elapsed plan weeks (`weeksWithPlan`) before the adherence signal is
 * trusted. Below this, `buildPlanAdherence`'s `weeksHitTarget` ratio is too
 * noisy (e.g. 1/1 or 0/1) to inform a credit — the whole consistencyScore
 * returns 0 instead (no credit, not an error). JUDGMENT CALL, not derived.
 */
export const MIN_WEEKS_FOR_ADHERENCE_SIGNAL = 2;

/**
 * CTL growth (%, from `Trend.pct`) over the trailing 4 weeks that earns FULL
 * ramp-trend credit; scaled linearly below this threshold. A half-marathon
 * build that grows chronic load ~20% over a month is a strong, well-executed
 * ramp. JUDGMENT CALL, not derived — tune from production QA.
 */
export const RAMP_TREND_FULL_CREDIT_PCT = 20;

export interface ConsistencyScoreInput {
  /** From `buildPlanAdherence` (throughDate = elapsed weeks only — the SAME
   *  cutoff the page's existing Adherence card uses). */
  weeksHitTarget: number;
  weeksWithPlan: number;
  /** `trendVsPast(currentCTL, ctl4WeeksAgo)` — null when there isn't enough
   *  load history to establish a baseline (trendVsPast's own null case, or
   *  the caller has no CTL series at all yet). */
  ctlTrend: Trend | null;
}

/**
 * Blend weekly adherence % with CTL ramp-trend health into a single 0–1
 * `consistencyScore`.
 *
 * Adherence fraction = `weeksHitTarget / weeksWithPlan`, clamped to [0, 1].
 * Returns 0 OUTRIGHT (skipping the ramp blend entirely) when `weeksWithPlan`
 * is below `MIN_WEEKS_FOR_ADHERENCE_SIGNAL` — too early in a plan for any
 * consistency claim to be meaningful.
 *
 * Ramp fraction, from `ctlTrend.direction`:
 *   "down" → 0    (a declining ramp earns no credit — this is a credit-ONLY
 *                   layer, so "no credit" is the correct floor here, not a
 *                   penalty on top of the projection)
 *   "flat" → 0.5  (maintaining fitness during a build is fine — partial
 *                   credit, not full)
 *   "up"   → `clamp(ctlTrend.pct / RAMP_TREND_FULL_CREDIT_PCT, 0, 1)`
 *   null   → 0    (insufficient load history to compute a trend at all)
 *
 * `consistencyScore = (adherenceFraction + rampFraction) / 2` — a simple,
 * equally-weighted average. JUDGMENT CALL: adherence is plan-specific
 * evidence while ramp trend is a general fitness signal, so a case could be
 * made to weight adherence higher — an equal blend is the simplest
 * defensible starting point; tune from production QA.
 */
export function computeConsistencyScore(input: ConsistencyScoreInput): number {
  const { weeksHitTarget, weeksWithPlan, ctlTrend } = input;

  if (weeksWithPlan < MIN_WEEKS_FOR_ADHERENCE_SIGNAL) return 0;

  const adherenceFraction = Math.max(
    0,
    Math.min(1, weeksHitTarget / weeksWithPlan)
  );

  let rampFraction: number;
  if (ctlTrend == null || ctlTrend.direction === "down") {
    rampFraction = 0;
  } else if (ctlTrend.direction === "flat") {
    rampFraction = 0.5;
  } else {
    rampFraction = Math.max(
      0,
      Math.min(1, ctlTrend.pct / RAMP_TREND_FULL_CREDIT_PCT)
    );
  }

  return (adherenceFraction + rampFraction) / 2;
}

/**
 * Map a 0–1 `consistencyScore` to a bounded, ONE-DIRECTIONAL adjustment
 * percentage:
 *
 *   consistencyAdjustmentPct = -(consistencyScore * CONSISTENCY_ADJUSTMENT_MAX_PCT)
 *
 * clamped to `[-CONSISTENCY_ADJUSTMENT_MAX_PCT, 0]` — NEVER positive. A
 * low/zero score yields 0% (no credit); nothing here can ever increase the
 * projected time.
 */
export function computeConsistencyAdjustmentPct(consistencyScore: number): number {
  const clampedScore = Math.max(0, Math.min(1, consistencyScore));
  if (clampedScore === 0) return 0; // avoid a -0 artifact from -(0 * MAX)
  const raw = -(clampedScore * CONSISTENCY_ADJUSTMENT_MAX_PCT);
  return Math.max(-CONSISTENCY_ADJUSTMENT_MAX_PCT, Math.min(0, raw));
}

/**
 * Apply a single, already-computed `adjustmentPct` UNIFORMLY across every
 * point in a `buildAnchoredPredictionProjection()` result — a pure wrapping
 * step that never touches `buildAnchoredPredictionProjection` itself.
 * Null-valued points (weeks that couldn't be fit) pass through unchanged so
 * the chart's existing line-break behavior is preserved.
 */
export function applyConsistencyAdjustment(
  projection: PredictionProjectionPoint[],
  adjustmentPct: number
): PredictionProjectionPoint[] {
  return projection.map((point) =>
    point.predictedSeconds == null
      ? point
      : { ...point, predictedSeconds: point.predictedSeconds * (1 + adjustmentPct) }
  );
}
