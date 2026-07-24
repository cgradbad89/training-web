// Per-run efficiency score — pace-relative-to-heart-rate effort scored against
// the runner's OWN rolling baseline, with a continuous %HR-reserve effort
// adjustment.
//
// Pure client-side computation only. This module performs NO Firestore reads or
// writes: callers pass an already-fetched, single-uid-scoped workouts array in.
//
// TWO product decisions implemented here (replacing the prior tier-split model):
//  (a) EFFORT ADJUSTMENT — instead of bucketing runs into BASELINE/QUALITY tiers
//      (a derived, unreliable label) and keeping a separate baseline per tier, a
//      single baseline is fitted as a linear regression of Efficiency Factor on
//      %HR-reserve (Karvonen). A run is then scored against the EF *expected at
//      its own effort level*, so a hard run and an easy run are compared fairly
//      without needing a discrete tier. Below a minimum %HRR spread (or run
//      count) the regression is untrustworthy and we fall back to the flat
//      average EF baseline.
//  (b) DATE ANCHORING — every baseline is anchored to the SCORED RUN'S OWN date
//      (a trailing window ending strictly before that run), never Date.now().
//      Previously the window was anchored to "today", so a run's historical
//      score silently drifted every time a newer run was added. scoreWorkouts-
//      Efficiency builds a per-run, self-excluding baseline to fix this.

import { weekStart } from '@/utils/dates'
import { computeHRReserve } from '@/utils/hrReserve'

// ─── Tuning constants ────────────────────────────────────────────────────────
// NOTE (product-owner confirmation needed): every value below is a tuning
// default, not a derived quantity.

/** Below this many EF-backed runs, the baseline is not usable for scoring. */
export const MIN_BASELINE_RUNS = 5
/** Below this many cadence-bearing runs, the cadence modifier is skipped. */
export const MIN_CADENCE_BASELINE_RUNS = 3
/** A ±SCORE_SCALE_PCT EF delta maps to the full ±50-point swing around neutral 50. */
export const SCORE_SCALE_PCT = 0.15
/** Max points the cadence modifier can add or subtract. */
export const CADENCE_MODIFIER_MAX_POINTS = 5
/** A ±CADENCE_SCALE_PCT cadence delta maps to the full ±CADENCE_MODIFIER_MAX_POINTS swing. */
export const CADENCE_SCALE_PCT = 0.05

/** Default trailing window (days) over which a baseline is built. */
export const DEFAULT_WINDOW_DAYS = 60

/**
 * Minimum %HRR spread (hrrMax − hrrMin, on the 0–1 Karvonen scale) required
 * before a fitted EF-on-%HRR regression is trusted. Below this the effort levels
 * cluster too tightly to fit a meaningful slope, so we fall back to the flat
 * average-EF baseline. 0.08 = 8 percentage points of %HRR. TUNING VALUE — this
 * account's real 60–90 day %HRR range is ~39 points, well above this floor, so
 * the regression path is the common case here.
 */
export const MIN_HRR_RANGE_FOR_REGRESSION = 0.08

/** Trailing window for the weekly efficiency trend (16 weeks). Tuning value. */
export const EFFICIENCY_TREND_WINDOW_DAYS = 112
/** Trailing window for the distance-bucket breakdown. Tuning value. */
export const EFFICIENCY_BUCKET_WINDOW_DAYS = 90

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EfficiencyBaseline {
  avgEfficiencyFactor: number
  avgCadenceSPM: number | null
  runCount: number
  cadenceRunCount: number
  /** Min/max %HRR (0–1) across the baseline runs — the regression's valid domain. */
  hrrMin: number
  hrrMax: number
  /** OLS fit of EF on %HRR (0–1). null when spread/count is below threshold. */
  regression: { slope: number; intercept: number } | null
}

export interface EfficiencyScoreInputs {
  avgPaceSecPerMile: number
  avgHeartRate: number
  cadenceSPM: number | null
  restingHr: number
  maxHr: number
  baseline: EfficiencyBaseline
}

export interface EfficiencyScoreResult {
  /** 0-100, null when status is 'building_baseline'. */
  score: number | null
  /** e.g. 0.12 for +12% more efficient than the effort-adjusted baseline. */
  percentDeltaVsBaseline: number | null
  /** null if cadence unavailable on the run or the baseline. */
  cadenceDeltaVsBaseline: number | null
  /** This run's %HR-reserve as an integer percent (0–100). null when not scored. */
  hrrPct: number | null
  /** True when the effort-adjusted (regression) baseline was used; false for the flat fallback. */
  usedRegression: boolean
  status: 'scored' | 'building_baseline'
}

/**
 * The minimal healthWorkouts shape efficiency scoring reads. Structurally a
 * subset of HealthWorkout, so callers pass their fetched runs directly. All
 * measurement fields are nullable because HR/pace/cadence coverage is high but
 * not universal.
 */
export interface EfficiencyWorkout {
  workoutId: string
  startDate: Date | string | { toDate?: () => Date } | null | undefined
  distanceMiles?: number | null
  durationSeconds: number
  avgPaceSecPerMile?: number | null
  avgHeartRate?: number | null
  cadenceSPM?: number | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

function isPositiveFinite(v: number | null | undefined): v is number {
  return v != null && isFinite(v) && v > 0
}

/** Parse a workout startDate into epoch ms. */
function parseStartMs(sd: EfficiencyWorkout['startDate']): number {
  if (sd && typeof sd === 'object' && typeof (sd as { toDate?: () => Date }).toDate === 'function') {
    return (sd as { toDate: () => Date }).toDate().getTime()
  }
  if (sd instanceof Date) return sd.getTime()
  if (typeof sd === 'string') return new Date(sd).getTime()
  return NaN
}

// ─── Efficiency factor ───────────────────────────────────────────────────────

/**
 * Efficiency Factor = speed (mph) / average heart rate (bpm).
 * Higher EF = more speed per heartbeat = more aerobically efficient.
 */
export function computeEfficiencyFactor(
  avgPaceSecPerMile: number,
  avgHeartRate: number
): number {
  const speedMph = 3600 / avgPaceSecPerMile
  return speedMph / avgHeartRate
}

/**
 * Ordinary least-squares fit of y on x. Returns null when the x-variance is
 * ~zero (degenerate — no meaningful slope), so callers fall back to a flat mean.
 */
function fitLinearRegression(
  xs: number[],
  ys: number[]
): { slope: number; intercept: number } | null {
  const n = xs.length
  if (n < 2) return null
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]
    sumY += ys[i]
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX
    sxx += dx * dx
    sxy += dx * (ys[i] - meanY)
  }
  if (!(sxx > 0) || !isFinite(sxx)) return null
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX
  if (!isFinite(slope) || !isFinite(intercept)) return null
  return { slope, intercept }
}

// ─── Baseline builder ────────────────────────────────────────────────────────

const EMPTY_BASELINE: EfficiencyBaseline = {
  avgEfficiencyFactor: 0,
  avgCadenceSPM: null,
  runCount: 0,
  cadenceRunCount: 0,
  hrrMin: 0,
  hrrMax: 0,
  regression: null,
}

/**
 * Build the efficiency baseline from the runs falling in the trailing window
 * ending strictly before `asOfDate`:  (asOfDate − windowDays) ≤ date < asOfDate.
 *
 * A run contributes to the EF baseline only when it has a valid avgPaceSecPerMile
 * AND avgHeartRate (both needed for EF and %HRR). Cadence stats are accumulated
 * independently over runs that carry a positive cadenceSPM, so cadence coverage
 * is unaffected by whether the regression or flat path is used.
 *
 * When runCount ≥ MIN_BASELINE_RUNS and the %HRR spread ≥ MIN_HRR_RANGE_FOR_
 * REGRESSION, an OLS regression of EF on %HRR is fitted (the effort adjustment);
 * otherwise `regression` is null and callers use the flat avgEfficiencyFactor.
 */
export function buildEfficiencyBaseline(
  workouts: EfficiencyWorkout[],
  asOfDate: Date,
  restingHr: number,
  maxHr: number,
  windowDays: number = DEFAULT_WINDOW_DAYS
): EfficiencyBaseline {
  const asOfMs = asOfDate.getTime()
  if (!isFinite(asOfMs)) return EMPTY_BASELINE
  const cutoffMs = asOfMs - windowDays * 86400000

  const efValues: number[] = []
  const hrrValues: number[] = []
  let cadenceSum = 0
  let cadenceRunCount = 0

  for (const w of workouts) {
    const startMs = parseStartMs(w.startDate)
    if (!isFinite(startMs) || startMs < cutoffMs || startMs >= asOfMs) continue

    if (isPositiveFinite(w.avgPaceSecPerMile) && isPositiveFinite(w.avgHeartRate)) {
      efValues.push(computeEfficiencyFactor(w.avgPaceSecPerMile, w.avgHeartRate))
      hrrValues.push(computeHRReserve(w.avgHeartRate, restingHr, maxHr))
    }
    // cadenceSPM is number | null — nulls (and non-finite/≤0) are excluded.
    if (isPositiveFinite(w.cadenceSPM)) {
      cadenceSum += w.cadenceSPM
      cadenceRunCount++
    }
  }

  const runCount = efValues.length
  if (runCount === 0) {
    // Preserve any cadence-only stats even when no EF-backed run exists.
    return {
      ...EMPTY_BASELINE,
      avgCadenceSPM: cadenceRunCount > 0 ? cadenceSum / cadenceRunCount : null,
      cadenceRunCount,
    }
  }

  const avgEfficiencyFactor = efValues.reduce((a, b) => a + b, 0) / runCount
  const hrrMin = Math.min(...hrrValues)
  const hrrMax = Math.max(...hrrValues)

  let regression: { slope: number; intercept: number } | null = null
  if (
    runCount >= MIN_BASELINE_RUNS &&
    hrrMax - hrrMin >= MIN_HRR_RANGE_FOR_REGRESSION
  ) {
    regression = fitLinearRegression(hrrValues, efValues)
  }

  return {
    avgEfficiencyFactor,
    avgCadenceSPM: cadenceRunCount > 0 ? cadenceSum / cadenceRunCount : null,
    runCount,
    cadenceRunCount,
    hrrMin,
    hrrMax,
    regression,
  }
}

// ─── Score ───────────────────────────────────────────────────────────────────

const BUILDING: EfficiencyScoreResult = {
  score: null,
  percentDeltaVsBaseline: null,
  cadenceDeltaVsBaseline: null,
  hrrPct: null,
  usedRegression: false,
  status: 'building_baseline',
}

/**
 * Score one run's efficiency against its effort-adjusted baseline, 0-100
 * (50 = neutral, matching the baseline). Returns status 'building_baseline'
 * with null score when no usable baseline exists yet.
 */
export function computeEfficiencyScore(
  inputs: EfficiencyScoreInputs
): EfficiencyScoreResult {
  const { avgPaceSecPerMile, avgHeartRate, cadenceSPM, restingHr, maxHr, baseline } =
    inputs

  // Step 1 — usable baseline + valid run inputs, else building.
  if (baseline.runCount < MIN_BASELINE_RUNS) return BUILDING
  if (!isPositiveFinite(avgPaceSecPerMile) || !isPositiveFinite(avgHeartRate)) {
    return BUILDING
  }

  // Step 2 — this run's EF and %HRR.
  const runEF = computeEfficiencyFactor(avgPaceSecPerMile, avgHeartRate)
  const runHrr = computeHRReserve(avgHeartRate, restingHr, maxHr)
  const hrrPct = Math.round(runHrr * 100)

  // Step 3 — expected EF at this run's effort level (regression) or flat mean.
  let expectedEF: number
  let usedRegression: boolean
  if (baseline.regression != null) {
    const clampedHrr = clamp(runHrr, baseline.hrrMin, baseline.hrrMax)
    expectedEF = baseline.regression.intercept + baseline.regression.slope * clampedHrr
    usedRegression = true
  } else {
    expectedEF = baseline.avgEfficiencyFactor
    usedRegression = false
  }
  if (!isPositiveFinite(expectedEF)) return BUILDING

  // Steps 4-5 — EF delta → raw score.
  const percentDelta = (runEF - expectedEF) / expectedEF
  const rawScore = clamp(50 + (percentDelta / SCORE_SCALE_PCT) * 50, 0, 100)

  // Step 6 — optional cadence modifier (unchanged logic).
  let finalScore = rawScore
  let cadenceDeltaVsBaseline: number | null = null
  if (
    isPositiveFinite(cadenceSPM) &&
    isPositiveFinite(baseline.avgCadenceSPM) &&
    baseline.cadenceRunCount >= MIN_CADENCE_BASELINE_RUNS
  ) {
    const cadenceDelta =
      (cadenceSPM - baseline.avgCadenceSPM) / baseline.avgCadenceSPM
    const modifier =
      clamp(cadenceDelta / CADENCE_SCALE_PCT, -1, 1) * CADENCE_MODIFIER_MAX_POINTS
    finalScore = clamp(rawScore + modifier, 0, 100)
    cadenceDeltaVsBaseline = cadenceDelta
  }

  // Step 7.
  return {
    score: finalScore,
    percentDeltaVsBaseline: percentDelta,
    cadenceDeltaVsBaseline,
    hrrPct,
    usedRegression,
    status: 'scored',
  }
}

/**
 * Score every workout against its OWN date-anchored baseline. For each workout
 * with a valid date, its baseline is built from the OTHER workouts over the
 * trailing `windowDays` ending strictly before that run's date, then the run is
 * scored. This is what fixes the "anchored to today" drift bug: a run's score
 * depends only on runs that preceded it, so adding a later-dated run never
 * changes an earlier run's score.
 *
 * Keyed by workoutId. Workouts with an unparseable date are omitted.
 */
export function scoreWorkoutsEfficiency(
  workouts: EfficiencyWorkout[],
  restingHr: number,
  maxHr: number,
  windowDays: number = DEFAULT_WINDOW_DAYS
): Map<string, EfficiencyScoreResult> {
  const out = new Map<string, EfficiencyScoreResult>()
  for (const w of workouts) {
    const startMs = parseStartMs(w.startDate)
    if (!isFinite(startMs)) continue
    // Self-excluding baseline: score a run only against OTHER runs.
    const others = workouts.filter((o) => o !== w)
    const baseline = buildEfficiencyBaseline(
      others,
      new Date(startMs),
      restingHr,
      maxHr,
      windowDays
    )
    const result = computeEfficiencyScore({
      avgPaceSecPerMile: w.avgPaceSecPerMile ?? 0,
      avgHeartRate: w.avgHeartRate ?? 0,
      cadenceSPM: w.cadenceSPM ?? null,
      restingHr,
      maxHr,
      baseline,
    })
    out.set(w.workoutId, result)
  }
  return out
}

// ─── Trend & distance buckets ──────────────────────────────────────────────────

export interface EfficiencyTrendPoint {
  /** ISO date (YYYY-MM-DD), Monday-start week. */
  weekStartDate: string
  /** Mean score across scored runs that week; null when zero scored runs. */
  avgScore: number | null
  scoredRunCount: number
}

export type DistanceBucket = 'short' | 'mid' | 'long'

export interface DistanceBucketSummary {
  bucket: DistanceBucket
  /** Mean percentDeltaVsBaseline across scored runs in the bucket; null if none. */
  avgPercentDeltaVsBaseline: number | null
  scoredRunCount: number
}

/** Format a Date as a local YYYY-MM-DD string (no UTC shift). */
function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Weekly efficiency trend: average each Monday-start week's scored-run scores
 * within the trailing `windowDays`. EVERY week in the window is emitted, in
 * chronological order — weeks with no scored runs get avgScore: null (a gap the
 * chart renders as a break, never interpolated or dropped). Runs whose status is
 * 'building_baseline' are excluded (never counted as 0).
 *
 * Each run is scored via scoreWorkoutsEfficiency, so every run is measured
 * against its OWN date-anchored 60-day baseline — the same anchoring the per-run
 * badge uses, and the same "anchored to today" fix. `windowDays` here only bounds
 * which weeks are displayed, not the per-run baseline window.
 */
export function buildEfficiencyTrend(
  workouts: EfficiencyWorkout[],
  restingHr: number,
  maxHr: number,
  windowDays: number = EFFICIENCY_TREND_WINDOW_DAYS
): EfficiencyTrendPoint[] {
  const now = Date.now()
  const cutoff = now - windowDays * 86400000
  const scores = scoreWorkoutsEfficiency(workouts, restingHr, maxHr)

  const perWeek = new Map<string, { sum: number; count: number }>()
  for (const w of workouts) {
    const startMs = parseStartMs(w.startDate)
    if (!isFinite(startMs) || startMs < cutoff || startMs > now) continue
    const result = scores.get(w.workoutId)
    if (!result || result.status !== 'scored' || result.score == null) continue
    const key = isoDate(weekStart(new Date(startMs)))
    const cell = perWeek.get(key) ?? { sum: 0, count: 0 }
    cell.sum += result.score
    cell.count += 1
    perWeek.set(key, cell)
  }

  // Enumerate every Monday-start week across the window so zero-scored weeks
  // still appear (as null gaps). Stepping by +7 calendar days keeps DST honest.
  const out: EfficiencyTrendPoint[] = []
  const lastMondayMs = weekStart(new Date(now)).getTime()
  for (
    const d = weekStart(new Date(cutoff));
    d.getTime() <= lastMondayMs;
    d.setDate(d.getDate() + 7)
  ) {
    const key = isoDate(d)
    const cell = perWeek.get(key)
    out.push({
      weekStartDate: key,
      avgScore: cell ? cell.sum / cell.count : null,
      scoredRunCount: cell ? cell.count : 0,
    })
  }
  return out
}

/**
 * Average percentDeltaVsBaseline per distance bucket within the trailing
 * `windowDays`. Buckets: short < 5 mi, mid 5 ≤ d < 10, long ≥ 10 (boundaries at
 * exactly 5.0 and 10.0 fall into the higher bucket). Only 'scored' runs count;
 * 'building_baseline' runs are excluded. All three buckets are always returned
 * in fixed order [short, mid, long]; an empty bucket has
 * avgPercentDeltaVsBaseline: null.
 *
 * Each run is scored via scoreWorkoutsEfficiency (date-anchored per-run baseline).
 */
export function buildDistanceBucketSummary(
  workouts: EfficiencyWorkout[],
  restingHr: number,
  maxHr: number,
  windowDays: number = EFFICIENCY_BUCKET_WINDOW_DAYS
): DistanceBucketSummary[] {
  const now = Date.now()
  const cutoff = now - windowDays * 86400000
  const scores = scoreWorkoutsEfficiency(workouts, restingHr, maxHr)

  const acc: Record<DistanceBucket, { sum: number; count: number }> = {
    short: { sum: 0, count: 0 },
    mid: { sum: 0, count: 0 },
    long: { sum: 0, count: 0 },
  }
  for (const w of workouts) {
    const startMs = parseStartMs(w.startDate)
    if (!isFinite(startMs) || startMs < cutoff || startMs > now) continue
    const result = scores.get(w.workoutId)
    if (!result || result.status !== 'scored' || result.percentDeltaVsBaseline == null) {
      continue
    }
    const miles = w.distanceMiles ?? 0
    const bucket: DistanceBucket = miles < 5 ? 'short' : miles < 10 ? 'mid' : 'long'
    acc[bucket].sum += result.percentDeltaVsBaseline
    acc[bucket].count += 1
  }

  return (['short', 'mid', 'long'] as const).map((bucket) => {
    const a = acc[bucket]
    return {
      bucket,
      avgPercentDeltaVsBaseline: a.count > 0 ? a.sum / a.count : null,
      scoredRunCount: a.count,
    }
  })
}
