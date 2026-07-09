// Riegel-based race time prediction
// Ported from InsightsView.swift (iOS app)

import type { PlannedRunEntry } from '@/types/plan'
import { parsePaceString } from '@/utils/pace'

/**
 * Effort classification tiers, in descending trust:
 *   - RACE            — a real ±1-day/±1-mi race-matched run (×3 weight, 120d memory)
 *   - QUALITY         — a real corroborated fast training effort (×1.75 weight)
 *   - BASELINE        — an ordinary real training run (×1 weight)
 *   - PLANNED         — a SYNTHETIC effort derived from a future PlannedRunEntry
 *                       (distance + target pace). NOT a real effort — it carries no
 *                       HR/GPS/ID and gets NO weight boost (×1, same as BASELINE).
 *                       Used only by the plan-completion projection to contribute
 *                       planned volume while real quality efforts decay naturally.
 *                       See planEntryToSyntheticEffort + buildPredictionProjection.
 *   - PLANNED_QUALITY — a SYNTHETIC effort (same as PLANNED) whose target pace beats
 *                       the plan's own easy-pace baseline by ≥PLANNED_QUALITY_PACE_
 *                       THRESHOLD_SEC_PER_MILE — a scheduled tempo/interval/race-pace
 *                       session. Weighted like real QUALITY (×1.75) so scheduled
 *                       quality work isn't invisible to the projection just because
 *                       `workoutType` isn't populated on live plan entries. See
 *                       computePlanEasyPaceBaseline.
 */
export type EffortTier = 'RACE' | 'QUALITY' | 'BASELINE' | 'PLANNED' | 'PLANNED_QUALITY'

export interface EffortPoint {
  distanceMiles: number
  timeSeconds: number   // total time = pace * distance
  ageDays: number       // how many days ago
  isTreadmill: boolean
  tier: EffortTier
  /** Optional extra weight multiplier applied on top of the tier/recency/etc.
   *  weights (default 1 = no change). Used to give HR-gated, race-effort-projected
   *  best-effort segments enough weight to act as the fit's primary signal while
   *  the ordinary training runs remain corroboration. See bestEffortExtraction.ts. */
  weightMultiplier?: number
}

export interface RiegelFit {
  a: number    // ln-space intercept
  k: number    // endurance exponent
  r2: number   // goodness of fit
  n: number    // number of efforts used
  minMiles: number
  maxMiles: number
}

export interface RaceMatchInput {
  raceDate: Date | string   // ISO string or Date
  distanceMiles: number     // expected race distance
}

export interface BuildEffortsOptions {
  races?: RaceMatchInput[]
  /** How far back ordinary (non-race) efforts are eligible. Default 56. */
  daysBack?: number
  /** How far back race-matched efforts remain eligible. Default 120. */
  raceDaysBack?: number
  /**
   * Reference "now" for the lookback windows AND the per-effort `ageDays`
   * (which drives recency decay). Defaults to the wall-clock now. Pass a past
   * date to recompute a prediction "as of" that date — runs AFTER it are
   * excluded and all decay/memory math is measured relative to it. The MODEL
   * (weights, clamps, decay formula) is unchanged; only the reference moves.
   */
  asOf?: Date | number
}

export function predictSeconds(fit: RiegelFit, miles: number): number {
  return Math.exp(fit.a) * Math.pow(miles, fit.k)
}

export function formatRaceTime(seconds: number | null | undefined): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${m}:${String(s).padStart(2,'0')}`
}

export function formatRacePace(totalSeconds: number | null | undefined, distanceMiles: number): string {
  if (!totalSeconds || !isFinite(totalSeconds) || totalSeconds <= 0 || distanceMiles <= 0) return '—'
  const paceSeconds = totalSeconds / distanceMiles
  const total = Math.round(paceSeconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2,'0')} /mi`
}

// ─── Weighting ─────────────────────────────────────────────────────────────────

/**
 * Continuous 5-week half-life recency decay.
 *   weight = 0.5^(ageDays/35)
 * Standardized across the fit — replaces the prior stepped recency function.
 */
function recencyWeight(ageDays: number): number {
  if (!isFinite(ageDays) || ageDays < 0) return 1.0
  return Math.pow(0.5, ageDays / 35)
}

function distanceWeight(miles: number, targetMiles: number): number {
  if (targetMiles >= 13.109) {
    if (miles < 2)  return 0.45
    if (miles < 4)  return 0.7
    if (miles < 6)  return 0.95
    if (miles < 8)  return 1.15
    if (miles < 10) return 1.3
    return 1.45
  }
  // For shorter targets (5K)
  if (miles < 1) return 0.55
  if (miles < 2) return 0.8
  if (miles < 4) return 1.0
  if (miles < 6) return 1.1
  return 1.15
}

function treadmillWeight(isTreadmill: boolean): number {
  return isTreadmill ? 0.85 : 1.0
}

export function tierWeight(tier: EffortTier): number {
  switch (tier) {
    case 'RACE':     return 3.0
    case 'QUALITY':  return 1.75
    case 'BASELINE': return 1.0
    // PLANNED (synthetic future runs) get no boost — planned volume, not a real
    // effort. Same base weight as BASELINE; recency decay still applies.
    case 'PLANNED':  return 1.0
    // PLANNED_QUALITY — a planned entry detected as tempo/quality by pace (see
    // computePlanEasyPaceBaseline). Weighted like real QUALITY, per product decision.
    case 'PLANNED_QUALITY': return 1.75
  }
}

function longRunSupportMultiplier(
  effort: EffortPoint,
  allEfforts: EffortPoint[],
  targetMiles: number
): number {
  if (targetMiles < 13.109 || effort.distanceMiles < 6) return 1.0

  const recentLongest = Math.max(
    0,
    ...allEfforts
      .filter(e => e.distanceMiles >= 6 && e.ageDays <= 35)
      .map(e => e.distanceMiles)
  )

  // Recent vs prior long run progression
  const recentMax = Math.max(
    0,
    ...allEfforts
      .filter(e => e.distanceMiles >= 6 && e.ageDays <= 21)
      .map(e => e.distanceMiles)
  )
  const priorMax = Math.max(
    0,
    ...allEfforts
      .filter(e => e.distanceMiles >= 6 && e.ageDays > 21 && e.ageDays <= 42)
      .map(e => e.distanceMiles)
  )
  const progressionMiles = (recentMax > 0 || priorMax > 0) ? recentMax - priorMax : 0

  let multiplier = 1.0
  if (recentLongest >= 9)      multiplier += 0.1
  else if (recentLongest >= 7) multiplier += 0.05
  else if (recentLongest < 6)  multiplier -= 0.1

  if (progressionMiles >= 1.0)      multiplier += 0.05
  else if (progressionMiles <= -1.0) multiplier -= 0.05

  return Math.min(Math.max(multiplier, 0.85), 1.15)
}

/**
 * True when at least one RACE-tier effort in the array covers `targetMiles`.
 *
 * A recent race effort is the strongest possible long-run anchor: it is both
 * a real long run AND a real time trial for the prediction. When present, it
 * makes the "you need recent training-volume long runs" gate unnecessary for
 * any target at or below the race's own distance — so a runner in post-race
 * recovery (only short runs in the last 35 days) still gets a valid Riegel
 * fit for the distance they just raced and anything shorter.
 *
 * The 120-day ceiling is also enforced upstream by buildQualifyingEfforts'
 * raceDaysBack; the redundant check here keeps the helper self-contained for
 * any caller that passes a raw efforts array.
 */
export function hasRaceAnchor(
  efforts: EffortPoint[],
  targetMiles: number
): boolean {
  return efforts.some(
    e =>
      e.tier === 'RACE' &&
      e.distanceMiles >= targetMiles &&
      e.ageDays <= 120
  )
}

export function fitRiegel(
  efforts: EffortPoint[],
  targetMiles: number,
  minMilesForFit = 0,
  clampK?: { min: number; max: number }
): RiegelFit | null {
  const filtered = efforts.filter(e => e.distanceMiles >= minMilesForFit)
  if (filtered.length < 4) return null

  // For half/marathon: require 2+ medium-long runs in last 35 days AND longest ≥ 6
  // BYPASS: a RACE-tier anchor at or above targetMiles satisfies this gate
  // on its own — the race effort is itself a recent long run AND a real time
  // trial, which is stronger evidence than training-volume long runs.
  if (targetMiles >= 13.109 && !hasRaceAnchor(filtered, targetMiles)) {
    const recentMediumLong = filtered.filter(
      e => e.distanceMiles >= 4.0 && e.ageDays <= 35
    ).length
    const recentLongest = Math.max(
      0,
      ...filtered.filter(e => e.ageDays <= 35).map(e => e.distanceMiles)
    )
    if (recentMediumLong < 2 || recentLongest < 6.0) return null
  }

  const xs = filtered.map(e => Math.log(e.distanceMiles))
  const ys = filtered.map(e => Math.log(e.timeSeconds))

  let ws = filtered.map(e =>
    recencyWeight(e.ageDays) *
    distanceWeight(e.distanceMiles, targetMiles) *
    treadmillWeight(e.isTreadmill) *
    tierWeight(e.tier) *
    longRunSupportMultiplier(e, filtered, targetMiles) *
    (e.weightMultiplier ?? 1)
  )

  // Normalize weights so average ~ 1.0
  const wMean = ws.reduce((a, b) => a + b, 0) / ws.length
  if (wMean > 0) ws = ws.map(w => w / wMean)

  // Cap weights to prevent single outlier dominance
  const wCap = 5.0
  ws = ws.map(w => Math.min(w, wCap))

  const wSum = ws.reduce((a, b) => a + b, 0)
  if (wSum === 0) return null

  // Weighted means
  const meanX = xs.reduce((acc, x, i) => acc + x * ws[i], 0) / wSum
  const meanY = ys.reduce((acc, y, i) => acc + y * ws[i], 0) / wSum

  // Weighted slope (k) and intercept (a)
  let sxx = 0, sxy = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - meanX
    sxx += ws[i] * dx * dx
    sxy += ws[i] * dx * (ys[i] - meanY)
  }
  if (sxx === 0) return null

  const kRaw = sxy / sxx
  const k = clampK ? Math.min(Math.max(kRaw, clampK.min), clampK.max) : kRaw
  const a = meanY - k * meanX

  // Weighted R²
  let ssTot = 0, ssRes = 0
  for (let i = 0; i < xs.length; i++) {
    const yHat = a + k * xs[i]
    ssTot += ws[i] * Math.pow(ys[i] - meanY, 2)
    ssRes += ws[i] * Math.pow(ys[i] - yHat, 2)
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  const miles = filtered.map(e => e.distanceMiles)
  return {
    a, k, r2, n: filtered.length,
    minMiles: Math.min(...miles),
    maxMiles: Math.max(...miles)
  }
}

export function riegelConfidenceLabel(fit: RiegelFit): 'High' | 'Medium' | 'Low' {
  if (fit.n >= 6 && fit.r2 >= 0.6) return 'High'
  if (fit.n >= 4 && fit.r2 >= 0.45) return 'Medium'
  return 'Low'
}

// ─── Race matching helpers ─────────────────────────────────────────────────────

function toMillis(d: Date | string | undefined | null): number {
  if (!d) return NaN
  if (d instanceof Date) return d.getTime()
  // Treat bare YYYY-MM-DD as local midnight so a Date(YYYY-MM-DD) UTC offset
  // doesn't accidentally bump us across the ±1 day match window.
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number)
    return new Date(y, m - 1, day).getTime()
  }
  return new Date(d).getTime()
}

interface RaceMatchInternal {
  dateMs: number
  distanceMiles: number
}

function normalizeRaces(races: RaceMatchInput[] | undefined): RaceMatchInternal[] {
  if (!races || races.length === 0) return []
  const out: RaceMatchInternal[] = []
  for (const r of races) {
    const ms = toMillis(r.raceDate)
    if (!isFinite(ms)) continue
    if (!isFinite(r.distanceMiles) || r.distanceMiles <= 0) continue
    out.push({ dateMs: ms, distanceMiles: r.distanceMiles })
  }
  return out
}

/**
 * A run is a RACE effort if it falls within ±1 day of a Race document's
 * raceDate AND |run.distanceMiles − raceDistanceMiles| ≤ 1.0.
 */
function isRaceMatch(runStartMs: number, runMiles: number, races: RaceMatchInternal[]): boolean {
  const oneDayMs = 86400 * 1000
  for (const r of races) {
    if (Math.abs(runStartMs - r.dateMs) <= oneDayMs &&
        Math.abs(runMiles - r.distanceMiles) <= 1.0) {
      return true
    }
  }
  return false
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// ─── Build qualifying efforts ──────────────────────────────────────────────────

type WorkoutLike = {
  workoutId: string
  distanceMiles?: number | null
  durationSeconds: number
  startDate: Date | string | { toDate?: () => Date } | null | undefined
  activityType: string
  sourceName?: string
}

/**
 * Build qualifying efforts from Firestore HealthWorkout records.
 *
 * Race-anchored: when `options.races` is supplied, runs that fall within ±1 day
 * of a race date AND within 1.0 mile of the race distance are tagged RACE and
 * eligible up to `raceDaysBack` (default 120) — extending memory for real race
 * efforts as they age. Ordinary runs keep the `daysBack` window (default 56).
 *
 * Effort tiering: non-race runs that go ≥30 s/mi faster than the trailing 28d
 * easy-pace median (excluding race-matched runs) and are ≥3.0 mi long are
 * candidates for QUALITY. They are upgraded to QUALITY only if ≥1 OTHER
 * race-or-quality effort in the trailing 28 days has distance ≥ 0.7× theirs;
 * otherwise they remain BASELINE. Races are self-corroborating.
 *
 * The signature accepts a legacy `daysBack: number` as the second argument for
 * backward compatibility with call sites that pre-date races.
 */
export function buildQualifyingEfforts(
  workouts: WorkoutLike[],
  daysBackOrOptions: number | BuildEffortsOptions = 56,
  optionsArg: BuildEffortsOptions = {}
): EffortPoint[] {
  const options: BuildEffortsOptions =
    typeof daysBackOrOptions === 'number'
      ? { daysBack: daysBackOrOptions, ...optionsArg }
      : { ...daysBackOrOptions, ...optionsArg }

  const daysBack = options.daysBack ?? 56
  const raceDaysBack = options.raceDaysBack ?? 120
  const races = normalizeRaces(options.races)

  const now =
    options.asOf == null
      ? Date.now()
      : options.asOf instanceof Date
        ? options.asOf.getTime()
        : options.asOf
  const ordinaryCutoff = now - daysBack * 86400 * 1000
  const raceCutoff = now - raceDaysBack * 86400 * 1000

  interface Intermediate {
    miles: number
    totalSeconds: number
    secPerMile: number
    startMs: number
    ageDays: number
    isTreadmill: boolean
    isRace: boolean
  }

  const intermediates: Intermediate[] = []

  for (const w of workouts) {
    const miles = w.distanceMiles ?? 0
    if (miles <= 0) continue

    let startMs: number
    const sd = w.startDate
    if (sd && typeof sd === 'object' && typeof (sd as { toDate?: () => Date }).toDate === 'function') {
      startMs = (sd as { toDate: () => Date }).toDate().getTime()
    } else if (sd instanceof Date) {
      startMs = sd.getTime()
    } else if (typeof sd === 'string') {
      startMs = new Date(sd).getTime()
    } else {
      continue
    }
    if (!isFinite(startMs)) continue

    // Exclude runs after the reference date — for asOf=now this is a no-op
    // (real runs are in the past); for a past asOf it bounds the data to
    // "what was known by then".
    if (startMs > now) continue

    const totalSeconds = w.durationSeconds
    if (totalSeconds <= 0) continue
    const secPerMile = totalSeconds / miles

    // ── Sanity filters ──
    //   • drop unrealistic paces (faster than 4:30/mi or slower than 15:00/mi)
    //   • drop very short runs (< 0.5 mi) — too noisy for a Riegel fit
    //   • drop sub-5-minute total — fragments / GPS auto-pauses
    if (secPerMile < 270 || secPerMile > 900) continue
    if (miles < 0.5) continue
    if (totalSeconds < 300) continue

    const isRace = isRaceMatch(startMs, miles, races)

    // Apply lookback gate: RACE-matched gets extended memory, others 56d.
    const cutoff = isRace ? raceCutoff : ordinaryCutoff
    if (startMs < cutoff) continue

    const ageDays = (now - startMs) / 86400000
    const isTreadmill =
      w.activityType === 'treadmill_running' ||
      (w.sourceName ?? '').toLowerCase().includes('treadmill')

    intermediates.push({
      miles, totalSeconds, secPerMile, startMs, ageDays, isTreadmill, isRace
    })
  }

  // ── Compute rollingEasyMedian over trailing 28d non-race runs ──
  const easyPaces = intermediates
    .filter(i => !i.isRace && i.ageDays <= 28)
    .map(i => i.secPerMile)
  const rollingEasyMedian = easyPaces.length >= 2 ? median(easyPaces) : null

  // ── Candidate QUALITY: non-race, ≥3.0 mi, ≥30 s/mi faster than median ──
  // If <2 easy runs in the 28d window, classification is skipped and every
  // non-race run is BASELINE.
  function isQualityCandidate(i: Intermediate): boolean {
    if (rollingEasyMedian == null) return false
    if (i.isRace) return false
    if (i.miles < 3.0) return false
    return i.secPerMile <= rollingEasyMedian - 30
  }

  // ── Corroboration: a candidate QUALITY needs ≥1 OTHER race-or-candidate ──
  // ── quality effort in trailing 28d with distance ≥ 0.7 × its distance. ──
  function isCorroborated(target: Intermediate): boolean {
    for (const other of intermediates) {
      if (other === target) continue
      if (other.ageDays > 28) continue
      if (other.miles < target.miles * 0.7) continue
      if (other.isRace || isQualityCandidate(other)) return true
    }
    return false
  }

  return intermediates.map<EffortPoint>(i => {
    let tier: EffortTier
    if (i.isRace) {
      tier = 'RACE'
    } else if (isQualityCandidate(i) && isCorroborated(i)) {
      tier = 'QUALITY'
    } else {
      tier = 'BASELINE'
    }
    return {
      distanceMiles: i.miles,
      timeSeconds: i.totalSeconds,
      ageDays: i.ageDays,
      isTreadmill: i.isTreadmill,
      tier,
    }
  })
}

// ─── Diagnostics ───────────────────────────────────────────────────────────────

/** Summarize effort classification — handy for surfacing counts on insights pages. */
export function summarizeTierCounts(efforts: EffortPoint[]): Record<EffortTier, number> {
  const counts: Record<EffortTier, number> = {
    RACE: 0, QUALITY: 0, BASELINE: 0, PLANNED: 0, PLANNED_QUALITY: 0,
  }
  for (const e of efforts) counts[e.tier]++
  return counts
}

// ─── Synthetic planned efforts (plan-completion projection) ─────────────────────

/**
 * A planned entry is treated as quality (PLANNED_QUALITY tier, ×1.75 weight) if
 * its target pace beats the plan's easy-pace baseline (computePlanEasyPaceBaseline)
 * by at least this many seconds/mile. `workoutType` is undefined on live plan
 * entries today, so tier assignment must be pace-derived rather than type-derived.
 *
 * JUDGMENT CALL, not derived — tune from production QA against real tempo/interval
 * sessions vs. brisk easy days.
 */
export const PLANNED_QUALITY_PACE_THRESHOLD_SEC_PER_MILE = 30

/**
 * Median target pace (sec/mi) across a plan's ordinary (non-rest, non-longRun)
 * entries — the baseline a planned entry's pace is compared against to detect
 * quality work (see PLANNED_QUALITY_PACE_THRESHOLD_SEC_PER_MILE). Long runs are
 * excluded because they're naturally slower than flat-easy pace and would drag
 * the baseline upward, suppressing real quality detection.
 *
 * Returns null when fewer than 3 entries qualify — too little data to establish
 * a baseline; callers should fall back to tagging everything PLANNED (current,
 * regression-safe behavior).
 */
export function computePlanEasyPaceBaseline(entries: PlannedRunEntry[]): number | null {
  const paces = entries
    .filter(e => e.runType !== 'rest' && e.workoutType !== 'rest' && e.runType !== 'longRun')
    .map(e =>
      e.targetPaceSecondsPerMile != null && e.targetPaceSecondsPerMile > 0
        ? e.targetPaceSecondsPerMile
        : e.paceTarget
          ? parsePaceString(e.paceTarget)
          : null
    )
    .filter((p): p is number => p != null && isFinite(p) && p > 0)
  return paces.length >= 3 ? median(paces) : null
}

/**
 * Convert a future PlannedRunEntry into a synthetic EffortPoint tagged PLANNED
 * or PLANNED_QUALITY.
 *
 * This is NOT a real effort: it carries no workout ID, HR, or GPS route — only
 * the planned distance and target pace shaped into the fit's effort type so the
 * projection can add planned VOLUME without a parallel fit path. It bypasses
 * HR-gated best-effort extraction entirely.
 *
 * Two dates are required — deliberately more than the original 2-arg sketch —
 * because decay must be correct for EACH projection week:
 *   - `performedDate`: the calendar date the planned run is scheduled (derived
 *     from the plan's start + the entry's week/day by the caller).
 *   - `asOf`: the projection week's reference date; `ageDays` (which drives the
 *     5-week half-life recency decay) is measured relative to it.
 *
 * `planEasyPaceSecPerMile` (from computePlanEasyPaceBaseline, computed ONCE per
 * plan by the caller — not per-week) determines the tier: an entry whose pace
 * beats the baseline by ≥PLANNED_QUALITY_PACE_THRESHOLD_SEC_PER_MILE is tagged
 * PLANNED_QUALITY (×1.75 weight); everything else (including long runs and, when
 * the baseline is null, every entry) is tagged PLANNED (×1 weight, unchanged).
 *
 * Returns null for entries that can't become a valid effort: rest days,
 * zero/negative distance, no resolvable target pace, an out-of-range pace, or a
 * performedDate AFTER asOf (a future entry has no bearing on an earlier week).
 */
export function planEntryToSyntheticEffort(
  entry: PlannedRunEntry,
  performedDate: Date,
  asOf: Date,
  planEasyPaceSecPerMile: number | null
): EffortPoint | null {
  if (entry.runType === 'rest' || entry.workoutType === 'rest') return null

  const miles = entry.distanceMiles
  if (!isFinite(miles) || miles <= 0) return null

  // Target pace: seconds/mi field first, else parse the "M:SS" string.
  const paceSecPerMile =
    entry.targetPaceSecondsPerMile != null && entry.targetPaceSecondsPerMile > 0
      ? entry.targetPaceSecondsPerMile
      : entry.paceTarget
        ? parsePaceString(entry.paceTarget)
        : null
  if (paceSecPerMile == null || !isFinite(paceSecPerMile) || paceSecPerMile <= 0) {
    return null
  }
  // Same sanity band buildQualifyingEfforts uses for real runs (4:30–15:00/mi).
  if (paceSecPerMile < 270 || paceSecPerMile > 900) return null

  const ageDays = (asOf.getTime() - performedDate.getTime()) / 86400000
  if (!isFinite(ageDays) || ageDays < 0) return null

  const tier: EffortTier =
    planEasyPaceSecPerMile != null &&
    planEasyPaceSecPerMile - paceSecPerMile >= PLANNED_QUALITY_PACE_THRESHOLD_SEC_PER_MILE
      ? 'PLANNED_QUALITY'
      : 'PLANNED'

  return {
    distanceMiles: miles,
    timeSeconds: miles * paceSecPerMile,
    ageDays,
    isTreadmill: entry.runType === 'treadmill',
    tier,
  }
}

/** Compute the trailing 28d easy-pace median (exposed for diagnostics/UI). */
export function rollingEasyPaceMedian(workouts: WorkoutLike[], races?: RaceMatchInput[]): number | null {
  const efforts = buildQualifyingEfforts(workouts, { daysBack: 56, races })
  // Reconstruct paces of non-race runs ≤28d directly from efforts
  const paces = efforts
    .filter(e => e.tier !== 'RACE' && e.ageDays <= 28)
    .map(e => e.timeSeconds / e.distanceMiles)
  return paces.length >= 2 ? median(paces) : null
}
