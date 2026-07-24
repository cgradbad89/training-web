// Per-run efficiency score — pace-relative-to-heart-rate effort scored against
// the runner's OWN rolling, tier-aware baseline.
//
// Pure client-side computation only. This module performs NO Firestore reads or
// writes: callers pass an already-fetched, single-uid-scoped workouts array in.
// (Cross-user / collection-group queries are forbidden for healthWorkouts — see
// CLAUDE.md hygiene note. This module never queries at all.)
//
// Tier classification is REUSED from riegelFit.ts (buildQualifyingEfforts) so
// efficiency baselines bucket runs the same way the race predictor does —
// RACE / QUALITY / BASELINE — rather than inventing a parallel rule.

import {
  buildQualifyingEfforts,
  type EffortPoint,
  type WorkoutLike,
  type RaceMatchInput,
} from '@/utils/riegelFit'

// ─── Tuning constants ────────────────────────────────────────────────────────
// NOTE (product-owner confirmation needed): every value below is a tuning
// default, not a derived quantity. They should be revisited once real scores are
// visible against actual run history (see the Phase-1 output report).

/** Below this many EF-backed runs, a tier's baseline is not usable for scoring. */
export const MIN_BASELINE_RUNS = 5
/** Below this many cadence-bearing runs, the cadence modifier is skipped. */
export const MIN_CADENCE_BASELINE_RUNS = 3
/** A ±SCORE_SCALE_PCT EF delta maps to the full ±50-point swing around neutral 50. */
export const SCORE_SCALE_PCT = 0.15
/** Max points the cadence modifier can add or subtract. */
export const CADENCE_MODIFIER_MAX_POINTS = 5
/** A ±CADENCE_SCALE_PCT cadence delta maps to the full ±CADENCE_MODIFIER_MAX_POINTS swing. */
export const CADENCE_SCALE_PCT = 0.05

/** Default trailing window (days) over which baselines are built. */
export const DEFAULT_WINDOW_DAYS = 60

// ─── Types ───────────────────────────────────────────────────────────────────

export type EfficiencyTier = 'BASELINE' | 'QUALITY' | 'RACE'

export interface TierBaseline {
  tier: EfficiencyTier
  avgEfficiencyFactor: number
  avgCadenceSPM: number | null
  runCount: number
  cadenceRunCount: number
}

export interface EfficiencyScoreInputs {
  avgPaceSecPerMile: number
  avgHeartRate: number
  cadenceSPM: number | null
  tier: EfficiencyTier
  baseline: TierBaseline
  /**
   * The QUALITY-tier baseline, required only to score a RACE-tier run whose own
   * RACE baseline has too few runs (races are run at quality-like effort — see
   * SCORING step 1). Optional because non-RACE runs never consult it.
   *
   * DEVIATION from the Phase-1 prompt's interface: the prompt specified a single
   * `baseline`, but the RACE→QUALITY fallback cannot be resolved inside
   * computeEfficiencyScore without access to the QUALITY baseline. Added as an
   * optional field so the specified fields are otherwise unchanged.
   */
  qualityBaseline?: TierBaseline
}

export interface EfficiencyScoreResult {
  /** 0-100, null when status is 'building_baseline'. */
  score: number | null
  /** e.g. 0.12 for +12% more efficient than baseline; null when not scored. */
  percentDeltaVsBaseline: number | null
  /** null if cadence unavailable on the run or the baseline. */
  cadenceDeltaVsBaseline: number | null
  status: 'scored' | 'building_baseline'
}

/**
 * A healthWorkouts document, extended with the run-level fields efficiency
 * scoring needs. WorkoutLike (reused from riegelFit) supplies the fields the
 * tier classifier reads; the three below are additive and all nullable because
 * cadence coverage is high but not universal and HR/pace can be missing.
 *
 * DEVIATION from the Phase-1 prompt: the prompt's buildEfficiencyBaselines
 * signature named `WorkoutLike[]`, but WorkoutLike carries none of the
 * efficiency fields, so this superset is required to read them.
 */
export type EfficiencyWorkout = WorkoutLike & {
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

/** Parse a workout startDate into epoch ms, mirroring buildQualifyingEfforts. */
function parseStartMs(sd: WorkoutLike['startDate']): number {
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

// ─── Baseline builder ────────────────────────────────────────────────────────

const EMPTY_TIER = (tier: EfficiencyTier): TierBaseline => ({
  tier,
  avgEfficiencyFactor: 0,
  avgCadenceSPM: null,
  runCount: 0,
  cadenceRunCount: 0,
})

/**
 * Bucket workouts into RACE / QUALITY / BASELINE tiers (via buildQualifyingEfforts)
 * within the trailing `windowDays`, then compute each tier's average efficiency
 * factor and average cadence.
 *
 * Mapping efforts back to their source workouts: EffortPoint drops the workout's
 * HR/cadence/id, so we re-associate by a composite key of the two effort fields
 * derived verbatim from the workout (distanceMiles, timeSeconds) plus ageDays.
 * A shared `asOf` reference makes ageDays deterministic on both sides, so the key
 * uniquely identifies a run (ageDays encodes startMs); FIFO dequeuing resolves
 * genuine duplicates and keeps in-window efforts from matching out-of-window
 * workouts that happen to share distance+duration.
 *
 * `races` is an optional forward: buildQualifyingEfforts only tags RACE when a
 * race list is supplied, so without it the RACE bucket stays empty. (Additive
 * optional param — see the Phase-1 output report.)
 */
export function buildEfficiencyBaselines(
  workouts: EfficiencyWorkout[],
  windowDays: number = DEFAULT_WINDOW_DAYS,
  races?: RaceMatchInput[]
): Record<EfficiencyTier, TierBaseline> {
  const asOf = Date.now()
  const efforts: EffortPoint[] = buildQualifyingEfforts(workouts, {
    daysBack: windowDays,
    races,
    asOf,
  })

  // Buckets of workouts keyed identically to how an EffortPoint keys, preserving
  // input order so FIFO dequeuing matches buildQualifyingEfforts' stable order.
  const buckets = new Map<string, EfficiencyWorkout[]>()
  const keyOf = (miles: number, seconds: number, ageDays: number): string =>
    `${miles}|${seconds}|${ageDays}`

  for (const w of workouts) {
    const miles = w.distanceMiles ?? 0
    const startMs = parseStartMs(w.startDate)
    if (!isFinite(startMs)) continue
    const ageDays = (asOf - startMs) / 86400000
    const key = keyOf(miles, w.durationSeconds, ageDays)
    const arr = buckets.get(key)
    if (arr) arr.push(w)
    else buckets.set(key, [w])
  }

  const tierWorkouts: Record<EfficiencyTier, EfficiencyWorkout[]> = {
    BASELINE: [],
    QUALITY: [],
    RACE: [],
  }

  for (const e of efforts) {
    if (e.tier !== 'RACE' && e.tier !== 'QUALITY' && e.tier !== 'BASELINE') continue
    const key = keyOf(e.distanceMiles, e.timeSeconds, e.ageDays)
    const w = buckets.get(key)?.shift()
    if (!w) continue
    tierWorkouts[e.tier].push(w)
  }

  const result = {} as Record<EfficiencyTier, TierBaseline>
  for (const tier of ['BASELINE', 'QUALITY', 'RACE'] as const) {
    result[tier] = summarizeTier(tier, tierWorkouts[tier])
  }
  return result
}

function summarizeTier(
  tier: EfficiencyTier,
  workouts: EfficiencyWorkout[]
): TierBaseline {
  if (workouts.length === 0) return EMPTY_TIER(tier)

  let efSum = 0
  let runCount = 0
  let cadenceSum = 0
  let cadenceRunCount = 0

  for (const w of workouts) {
    if (isPositiveFinite(w.avgPaceSecPerMile) && isPositiveFinite(w.avgHeartRate)) {
      efSum += computeEfficiencyFactor(w.avgPaceSecPerMile, w.avgHeartRate)
      runCount++
    }
    // cadenceSPM is number | null — nulls (and non-finite/≤0) are excluded.
    if (isPositiveFinite(w.cadenceSPM)) {
      cadenceSum += w.cadenceSPM
      cadenceRunCount++
    }
  }

  return {
    tier,
    avgEfficiencyFactor: runCount > 0 ? efSum / runCount : 0,
    avgCadenceSPM: cadenceRunCount > 0 ? cadenceSum / cadenceRunCount : null,
    runCount,
    cadenceRunCount,
  }
}

// ─── Score ───────────────────────────────────────────────────────────────────

const BUILDING: EfficiencyScoreResult = {
  score: null,
  percentDeltaVsBaseline: null,
  cadenceDeltaVsBaseline: null,
  status: 'building_baseline',
}

/**
 * Score one run's efficiency against its tier baseline, 0-100 (50 = neutral,
 * matching the baseline). Returns status 'building_baseline' with null score
 * when no usable baseline exists yet.
 */
export function computeEfficiencyScore(
  inputs: EfficiencyScoreInputs
): EfficiencyScoreResult {
  const { avgPaceSecPerMile, avgHeartRate, cadenceSPM, tier, baseline } = inputs

  // Step 1 — resolve a usable baseline (with the RACE→QUALITY fallback).
  let effective = baseline
  if (baseline.runCount < MIN_BASELINE_RUNS) {
    const q = inputs.qualityBaseline
    if (tier === 'RACE' && q != null && q.runCount >= MIN_BASELINE_RUNS) {
      effective = q
    } else {
      return BUILDING
    }
  }

  // Guard: the baseline / run inputs must be usable to compute an EF ratio.
  if (!isPositiveFinite(effective.avgEfficiencyFactor)) return BUILDING
  if (!isPositiveFinite(avgPaceSecPerMile) || !isPositiveFinite(avgHeartRate)) {
    return BUILDING
  }

  // Steps 2-4 — EF delta → raw score.
  const runEF = computeEfficiencyFactor(avgPaceSecPerMile, avgHeartRate)
  const percentDelta =
    (runEF - effective.avgEfficiencyFactor) / effective.avgEfficiencyFactor
  const rawScore = clamp(50 + (percentDelta / SCORE_SCALE_PCT) * 50, 0, 100)

  // Step 5 — optional cadence modifier.
  let finalScore = rawScore
  let cadenceDeltaVsBaseline: number | null = null
  if (
    isPositiveFinite(cadenceSPM) &&
    isPositiveFinite(effective.avgCadenceSPM) &&
    effective.cadenceRunCount >= MIN_CADENCE_BASELINE_RUNS
  ) {
    const cadenceDelta =
      (cadenceSPM - effective.avgCadenceSPM) / effective.avgCadenceSPM
    const modifier =
      clamp(cadenceDelta / CADENCE_SCALE_PCT, -1, 1) * CADENCE_MODIFIER_MAX_POINTS
    finalScore = clamp(rawScore + modifier, 0, 100)
    cadenceDeltaVsBaseline = cadenceDelta
  }

  // Step 6.
  return {
    score: finalScore,
    percentDeltaVsBaseline: percentDelta,
    cadenceDeltaVsBaseline,
    status: 'scored',
  }
}
