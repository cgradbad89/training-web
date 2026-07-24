import { describe, it, expect } from 'vitest'
import {
  computeEfficiencyFactor,
  buildEfficiencyBaseline,
  computeEfficiencyScore,
  scoreWorkoutsEfficiency,
  buildEfficiencyTrend,
  buildDistanceBucketSummary,
  MIN_BASELINE_RUNS,
  MIN_CADENCE_BASELINE_RUNS,
  MIN_HRR_RANGE_FOR_REGRESSION,
  SCORE_SCALE_PCT,
  CADENCE_SCALE_PCT,
  CADENCE_MODIFIER_MAX_POINTS,
  type EfficiencyWorkout,
  type EfficiencyBaseline,
} from '../efficiencyScore'
import { computeHRReserve } from '../hrReserve'
import { weekStart } from '@/utils/dates'

// Live-account anchors used across the suite (reserve = 110 bpm).
const REST = 65
const MAX = 175

/** Local replica of the module's private isoDate for computing expected keys. */
function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─── Test helpers ──────────────────────────────────────────────────────────

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000)

let idCounter = 0
function makeWorkout(
  overrides: Partial<EfficiencyWorkout> & {
    distanceMiles: number
    secPerMile: number
  }
): EfficiencyWorkout {
  const { distanceMiles, secPerMile, ...rest } = overrides
  return {
    workoutId: `w${idCounter++}`,
    distanceMiles,
    durationSeconds: distanceMiles * secPerMile,
    startDate: daysAgo(1),
    avgPaceSecPerMile: secPerMile,
    avgHeartRate: 150,
    cadenceSPM: null,
    ...rest,
  }
}

/** N identical easy runs on consecutive days, oldest = firstDayAgo + N - 1. */
function series(
  count: number,
  firstDayAgo: number,
  over: Partial<EfficiencyWorkout> = {}
): EfficiencyWorkout[] {
  return Array.from({ length: count }, (_, i) => {
    const base = makeWorkout({
      distanceMiles: over.distanceMiles ?? 5,
      secPerMile: 540,
      avgHeartRate: 150,
      startDate: daysAgo(firstDayAgo + i),
    })
    return { ...base, ...over }
  })
}

/** A ready-made scored baseline with the given fields, regression optional. */
function baselineOf(over: Partial<EfficiencyBaseline>): EfficiencyBaseline {
  return {
    avgEfficiencyFactor: computeEfficiencyFactor(540, 150),
    avgCadenceSPM: null,
    runCount: MIN_BASELINE_RUNS,
    cadenceRunCount: 0,
    hrrMin: 0.5,
    hrrMax: 0.9,
    regression: null,
    ...over,
  }
}

// ─── computeEfficiencyFactor (unchanged math) ───────────────────────────────

describe('computeEfficiencyFactor', () => {
  it('computes speed(mph)/HR — 10:00/mi at 120bpm = 6mph/120 = 0.05', () => {
    expect(computeEfficiencyFactor(600, 120)).toBeCloseTo(0.05, 6)
  })

  it('rises as pace quickens (higher speed per beat)', () => {
    expect(computeEfficiencyFactor(500, 150)).toBeGreaterThan(
      computeEfficiencyFactor(600, 150)
    )
  })
})

// ─── buildEfficiencyBaseline ────────────────────────────────────────────────

describe('buildEfficiencyBaseline', () => {
  it('returns an empty baseline for no workouts', () => {
    const b = buildEfficiencyBaseline([], daysAgo(0), REST, MAX)
    expect(b).toEqual({
      avgEfficiencyFactor: 0,
      avgCadenceSPM: null,
      runCount: 0,
      cadenceRunCount: 0,
      hrrMin: 0,
      hrrMax: 0,
      regression: null,
    })
  })

  it('fits a regression when runCount >= MIN and %HRR spread >= threshold', () => {
    // 6 runs with HR 130..155 → %HRR spread (155-130)/110 ≈ 0.227 > 0.08.
    const hrs = [130, 135, 140, 145, 150, 155]
    const workouts = hrs.map((hr, i) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: hr, startDate: daysAgo(i + 2) })
    )
    const b = buildEfficiencyBaseline(workouts, daysAgo(0), REST, MAX)
    expect(b.runCount).toBe(6)
    expect(b.regression).not.toBeNull()
    expect(b.hrrMin).toBeCloseTo(computeHRReserve(130, REST, MAX), 8)
    expect(b.hrrMax).toBeCloseTo(computeHRReserve(155, REST, MAX), 8)
    // Slope is finite; intercept + slope*hrr reproduces a sane EF magnitude.
    expect(Number.isFinite(b.regression!.slope)).toBe(true)
    expect(Number.isFinite(b.regression!.intercept)).toBe(true)
  })

  it('falls back to a flat baseline (regression null) when %HRR spread < threshold', () => {
    // 6 runs all at HR 150 → spread 0 < MIN_HRR_RANGE_FOR_REGRESSION.
    const workouts = series(6, 2)
    const b = buildEfficiencyBaseline(workouts, daysAgo(0), REST, MAX)
    expect(b.runCount).toBe(6)
    expect(b.hrrMax - b.hrrMin).toBeLessThan(MIN_HRR_RANGE_FOR_REGRESSION)
    expect(b.regression).toBeNull()
    expect(b.avgEfficiencyFactor).toBeCloseTo(computeEfficiencyFactor(540, 150), 8)
  })

  it('leaves regression null below MIN_BASELINE_RUNS even with wide %HRR spread', () => {
    const hrs = [130, 145, 160, 150] // 4 runs, wide spread
    const workouts = hrs.map((hr, i) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: hr, startDate: daysAgo(i + 2) })
    )
    const b = buildEfficiencyBaseline(workouts, daysAgo(0), REST, MAX)
    expect(b.runCount).toBe(4)
    expect(b.hrrMax - b.hrrMin).toBeGreaterThan(MIN_HRR_RANGE_FOR_REGRESSION)
    expect(b.regression).toBeNull()
  })

  it('honors the date window: [asOf - windowDays, asOf) inclusive-exclusive', () => {
    const T = Date.now()
    const asOf = new Date(T)
    const mk = (ms: number) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: new Date(ms) })
    const workouts = [
      mk(T - 10 * 86400000), // in window
      mk(T - 20 * 86400000), // in window
      mk(T - 30 * 86400000), // in window
      mk(T - 40 * 86400000), // in window
      mk(T - 60 * 86400000), // exactly at cutoff → included (>= cutoff)
      mk(T - 60 * 86400000 - 1), // just before cutoff → excluded
      mk(T), // exactly at asOf → excluded (>= asOf, strict)
      mk(T + 86400000), // after asOf → excluded
    ]
    const b = buildEfficiencyBaseline(workouts, asOf, REST, MAX, 60)
    expect(b.runCount).toBe(5)
  })

  it('accumulates cadence stats independently of the EF/regression path', () => {
    // Wide-spread set (regression path) with mixed cadence coverage.
    const workouts = [
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 130, cadenceSPM: 170, startDate: daysAgo(2) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 140, cadenceSPM: 180, startDate: daysAgo(3) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, cadenceSPM: null, startDate: daysAgo(4) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 155, cadenceSPM: null, startDate: daysAgo(5) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 160, cadenceSPM: null, startDate: daysAgo(6) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 145, cadenceSPM: null, startDate: daysAgo(7) }),
    ]
    const b = buildEfficiencyBaseline(workouts, daysAgo(0), REST, MAX)
    expect(b.regression).not.toBeNull() // regression path active
    expect(b.cadenceRunCount).toBe(2)
    expect(b.avgCadenceSPM).toBeCloseTo(175, 6) // (170+180)/2 — unaffected by path

    // Same cadence outcome on the flat path (all HR equal → regression null).
    const flat = [
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, cadenceSPM: 170, startDate: daysAgo(2) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, cadenceSPM: 180, startDate: daysAgo(3) }),
      ...series(4, 4),
    ]
    const bf = buildEfficiencyBaseline(flat, daysAgo(0), REST, MAX)
    expect(bf.regression).toBeNull()
    expect(bf.cadenceRunCount).toBe(2)
    expect(bf.avgCadenceSPM).toBeCloseTo(175, 6)
  })

  it('excludes runs missing HR or pace from the EF baseline', () => {
    const workouts = [
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, startDate: daysAgo(2) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: null, startDate: daysAgo(3) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgPaceSecPerMile: null, startDate: daysAgo(4) }),
    ]
    const b = buildEfficiencyBaseline(workouts, daysAgo(0), REST, MAX)
    expect(b.runCount).toBe(1)
  })
})

// ─── computeEfficiencyScore ─────────────────────────────────────────────────

describe('computeEfficiencyScore', () => {
  const flatEF = computeEfficiencyFactor(540, 150)

  it('flat-fallback: scores against avgEfficiencyFactor, usedRegression false', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 500,
      avgHeartRate: 150,
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: flatEF, regression: null }),
    })
    const runEF = computeEfficiencyFactor(500, 150)
    const expectedDelta = (runEF - flatEF) / flatEF
    expect(r.status).toBe('scored')
    expect(r.usedRegression).toBe(false)
    expect(r.score).toBeGreaterThan(50)
    expect(r.percentDeltaVsBaseline).toBeCloseTo(expectedDelta, 8)
    expect(r.score).toBeCloseTo(50 + (expectedDelta / SCORE_SCALE_PCT) * 50, 6)
  })

  it('flat-fallback: scores below 50 when less efficient', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 600,
      avgHeartRate: 150,
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: flatEF }),
    })
    expect(r.status).toBe('scored')
    expect(r.score!).toBeLessThan(50)
  })

  it('regression: scores against expected EF at the run’s own effort level', () => {
    const regression = { slope: 0.01, intercept: 0.04 }
    const baseline = baselineOf({ regression, hrrMin: 0.5, hrrMax: 0.9 })
    const avgHeartRate = 143 // HRR = 78/110 ≈ 0.709, inside [0.5, 0.9]
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 520,
      avgHeartRate,
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline,
    })
    const runHrr = computeHRReserve(avgHeartRate, REST, MAX)
    const expectedEF = regression.intercept + regression.slope * runHrr
    const runEF = computeEfficiencyFactor(520, avgHeartRate)
    expect(r.status).toBe('scored')
    expect(r.usedRegression).toBe(true)
    expect(r.percentDeltaVsBaseline).toBeCloseTo((runEF - expectedEF) / expectedEF, 8)
    expect(r.hrrPct).toBe(Math.round(runHrr * 100))
  })

  it('regression: clamps the run’s %HRR to [hrrMin, hrrMax] for the expected EF', () => {
    const regression = { slope: 0.01, intercept: 0.04 }
    const baseline = baselineOf({ regression, hrrMin: 0.5, hrrMax: 0.9 })
    const avgHeartRate = 170 // HRR = 105/110 ≈ 0.9545 → clamps to 0.9
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 520,
      avgHeartRate,
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline,
    })
    const expectedEF = regression.intercept + regression.slope * 0.9 // clamped
    const runEF = computeEfficiencyFactor(520, avgHeartRate)
    expect(r.percentDeltaVsBaseline).toBeCloseTo((runEF - expectedEF) / expectedEF, 8)
  })

  it('populates hrrPct as an integer percent whenever scored', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 120, // HRR = 55/110 = 0.5 → 50%
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: computeEfficiencyFactor(540, 120) }),
    })
    expect(r.status).toBe('scored')
    expect(r.hrrPct).toBe(50)
  })

  it('returns building_baseline below MIN_BASELINE_RUNS', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: null,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ runCount: MIN_BASELINE_RUNS - 1 }),
    })
    expect(r.status).toBe('building_baseline')
    expect(r.score).toBeNull()
    expect(r.percentDeltaVsBaseline).toBeNull()
    expect(r.hrrPct).toBeNull()
    expect(r.usedRegression).toBe(false)
  })

  it('returns building_baseline when the run lacks HR or pace', () => {
    const base = baselineOf({ avgEfficiencyFactor: flatEF })
    expect(
      computeEfficiencyScore({ avgPaceSecPerMile: 540, avgHeartRate: 0, cadenceSPM: null, restingHr: REST, maxHr: MAX, baseline: base }).status
    ).toBe('building_baseline')
    expect(
      computeEfficiencyScore({ avgPaceSecPerMile: 0, avgHeartRate: 150, cadenceSPM: null, restingHr: REST, maxHr: MAX, baseline: base }).status
    ).toBe('building_baseline')
  })

  it('applies a partial cadence modifier within the cap (flat path)', () => {
    const cadenceSPM = 170 * 1.02 // +2% < ±5% cap
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: flatEF, avgCadenceSPM: 170, cadenceRunCount: 5 }),
    })
    const cadenceDelta = (cadenceSPM - 170) / 170
    const modifier = (cadenceDelta / CADENCE_SCALE_PCT) * CADENCE_MODIFIER_MAX_POINTS
    expect(r.cadenceDeltaVsBaseline).toBeCloseTo(cadenceDelta, 8)
    expect(r.score).toBeCloseTo(50 + modifier, 6) // rawScore 50 (neutral EF)
    expect(Math.abs(modifier)).toBeLessThan(CADENCE_MODIFIER_MAX_POINTS)
  })

  it('applies the cadence modifier on the regression path too', () => {
    const regression = { slope: 0, intercept: computeEfficiencyFactor(540, 143) }
    const cadenceSPM = 170 * 1.2 // beyond cap → full +5
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 143,
      cadenceSPM,
      restingHr: REST,
      maxHr: MAX,
      baseline: baselineOf({ regression, avgCadenceSPM: 170, cadenceRunCount: 5 }),
    })
    // slope 0 → expectedEF == run EF → rawScore 50; cadence adds full +5.
    expect(r.usedRegression).toBe(true)
    expect(r.score).toBeCloseTo(50 + CADENCE_MODIFIER_MAX_POINTS, 6)
  })

  it('skips the cadence modifier when run cadence is null or baseline too thin', () => {
    const withNull = computeEfficiencyScore({
      avgPaceSecPerMile: 540, avgHeartRate: 150, cadenceSPM: null,
      restingHr: REST, maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: flatEF, avgCadenceSPM: 170, cadenceRunCount: 5 }),
    })
    expect(withNull.cadenceDeltaVsBaseline).toBeNull()
    expect(withNull.score).toBeCloseTo(50, 6)

    const thin = computeEfficiencyScore({
      avgPaceSecPerMile: 540, avgHeartRate: 150, cadenceSPM: 180,
      restingHr: REST, maxHr: MAX,
      baseline: baselineOf({ avgEfficiencyFactor: flatEF, avgCadenceSPM: 170, cadenceRunCount: MIN_CADENCE_BASELINE_RUNS - 1 }),
    })
    expect(thin.cadenceDeltaVsBaseline).toBeNull()
    expect(thin.score).toBeCloseTo(50, 6)
  })

  it('clamps the score to [0, 100]', () => {
    const high = computeEfficiencyScore({
      avgPaceSecPerMile: 300, avgHeartRate: 150, cadenceSPM: null,
      restingHr: REST, maxHr: MAX, baseline: baselineOf({ avgEfficiencyFactor: flatEF }),
    })
    const low = computeEfficiencyScore({
      avgPaceSecPerMile: 900, avgHeartRate: 170, cadenceSPM: null,
      restingHr: REST, maxHr: MAX, baseline: baselineOf({ avgEfficiencyFactor: flatEF }),
    })
    expect(high.score).toBe(100)
    expect(low.score).toBe(0)
  })
})

// ─── scoreWorkoutsEfficiency (date-anchored, self-excluding) ─────────────────

describe('scoreWorkoutsEfficiency', () => {
  it('keys results by workoutId and scores runs with enough priors', () => {
    // 7 identical consecutive daily runs → runs with >= MIN priors score 50.
    const runs = series(7, 1)
    const scores = scoreWorkoutsEfficiency(runs, REST, MAX)
    expect(scores.size).toBe(7)
    // Newest run (daysAgo 1) has 6 older priors → scored, neutral 50.
    const newest = scores.get(runs[0].workoutId)!
    expect(newest.status).toBe('scored')
    expect(newest.score).toBeCloseTo(50, 6)
    // Oldest run (daysAgo 7) has 0 priors → building.
    expect(scores.get(runs[6].workoutId)!.status).toBe('building_baseline')
  })

  it('omits workouts with an unparseable date', () => {
    const good = series(6, 1)
    const bad = makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: 'not-a-date' })
    const scores = scoreWorkoutsEfficiency([...good, bad], REST, MAX)
    expect(scores.has(bad.workoutId)).toBe(false)
    expect(scores.size).toBe(6)
  })

  // KEY REGRESSION TEST for the date-anchoring bug fix.
  it('does NOT change a run’s score when a later-dated run is added', () => {
    // Target run T with 6 identical priors before it → scores neutral 50 against
    // a baseline of ONLY those priors.
    const priors = series(6, 6) // daysAgo 6..11, all HR 150 / 540 pace
    const target = makeWorkout({
      distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, startDate: daysAgo(5),
    })
    const before = scoreWorkoutsEfficiency([target, ...priors], REST, MAX)
    const scoreBefore = before.get(target.workoutId)!

    // A newer run (daysAgo 1) with a WILDLY different EF. Under the old
    // "anchored to today" baseline (all runs regardless of date), this would
    // have shifted the average EF and changed T's score. Date-anchoring means
    // T's baseline is unaffected (this run is dated after T).
    const later = makeWorkout({
      distanceMiles: 5, secPerMile: 300, avgHeartRate: 200, startDate: daysAgo(1),
    })
    const after = scoreWorkoutsEfficiency([later, target, ...priors], REST, MAX)
    const scoreAfter = after.get(target.workoutId)!

    expect(scoreAfter.status).toBe('scored')
    expect(scoreAfter.score).toBeCloseTo(50, 6) // still neutral vs priors-only
    expect(scoreAfter.score).toBeCloseTo(scoreBefore.score as number, 8)
    expect(scoreAfter.percentDeltaVsBaseline).toBeCloseTo(
      scoreBefore.percentDeltaVsBaseline as number,
      8
    )
  })
})

// ─── buildEfficiencyTrend ────────────────────────────────────────────────────

describe('buildEfficiencyTrend', () => {
  it('emits null avgScore for weeks with zero scored runs (gap, not dropped)', () => {
    // Two dense clusters far apart; identical effort → every scored run == 50.
    const recent = series(8, 7) // days 7..14
    const older = series(8, 40) // days 40..47
    const trend = buildEfficiencyTrend([...recent, ...older], REST, MAX)

    const scoredTotal = trend.reduce((s, t) => s + t.scoredRunCount, 0)
    expect(scoredTotal).toBeGreaterThan(0)
    expect(trend.some((t) => t.avgScore === null)).toBe(true)
    for (const t of trend) {
      if (t.scoredRunCount > 0) expect(t.avgScore).toBeCloseTo(50, 6)
      else expect(t.avgScore).toBeNull()
    }
  })

  it('buckets scored runs into their Monday-start weeks, chronologically', () => {
    const runs = series(12, 1) // days 1..12
    const trend = buildEfficiencyTrend(runs, REST, MAX)
    const scores = scoreWorkoutsEfficiency(runs, REST, MAX)

    // Expected week → scored-run count, derived from the per-run scores.
    const expected = new Map<string, number>()
    for (const r of runs) {
      if (scores.get(r.workoutId)!.status !== 'scored') continue
      const key = isoDate(weekStart(r.startDate as Date))
      expected.set(key, (expected.get(key) ?? 0) + 1)
    }
    for (const [key, count] of expected) {
      const point = trend.find((t) => t.weekStartDate === key)
      expect(point).toBeDefined()
      expect(point!.scoredRunCount).toBe(count)
      expect(point!.avgScore).toBeCloseTo(50, 6)
    }
    const dates = trend.map((t) => t.weekStartDate)
    expect([...dates].sort()).toEqual(dates)
  })

  it('honors the display windowDays boundary', () => {
    const runs = series(20, 1) // days 1..20
    const wide = buildEfficiencyTrend(runs, REST, MAX, 112)
    const narrow = buildEfficiencyTrend(runs, REST, MAX, 7)
    const wideScored = wide.reduce((s, t) => s + t.scoredRunCount, 0)
    const narrowScored = narrow.reduce((s, t) => s + t.scoredRunCount, 0)
    expect(narrowScored).toBeGreaterThan(0)
    expect(wideScored).toBeGreaterThan(narrowScored) // older weeks only in wide
  })

  it('excludes building_baseline runs (never counts them as 0)', () => {
    const runs = series(10, 1)
    const trend = buildEfficiencyTrend(runs, REST, MAX)
    const scores = scoreWorkoutsEfficiency(runs, REST, MAX)
    const expectedScored = runs.filter(
      (r) => scores.get(r.workoutId)!.status === 'scored'
    ).length
    expect(trend.reduce((s, t) => s + t.scoredRunCount, 0)).toBe(expectedScored)
  })
})

// ─── buildDistanceBucketSummary ──────────────────────────────────────────────

describe('buildDistanceBucketSummary', () => {
  it('always returns short/mid/long in fixed order', () => {
    const summary = buildDistanceBucketSummary([], REST, MAX)
    expect(summary.map((s) => s.bucket)).toEqual(['short', 'mid', 'long'])
  })

  it('places boundary distances 5.0 in mid and 10.0 in long', () => {
    // Recent test runs (days 1..3) + an older base block (days 5..12) so each
    // test run has plenty of priors and scores. Distances chosen at boundaries.
    const boundary5 = makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(1) })
    const mid = makeWorkout({ distanceMiles: 9.9, secPerMile: 540, startDate: daysAgo(2) })
    const boundary10 = makeWorkout({ distanceMiles: 10, secPerMile: 540, startDate: daysAgo(3) })
    const base = series(8, 5) // days 5..12, 5-mile runs (mid bucket)
    const all = [boundary5, mid, boundary10, ...base]

    const summary = buildDistanceBucketSummary(all, REST, MAX)
    const scores = scoreWorkoutsEfficiency(all, REST, MAX)
    const by = Object.fromEntries(summary.map((s) => [s.bucket, s]))

    // The 5.0 and 9.9 runs are scored and in mid; 10.0 is scored and in long.
    expect(scores.get(boundary5.workoutId)!.status).toBe('scored')
    expect(scores.get(boundary10.workoutId)!.status).toBe('scored')
    expect(by.long.scoredRunCount).toBe(1) // only the 10.0 run
    // mid holds the 5.0 + 9.9 test runs plus any scored base runs.
    expect(by.mid.scoredRunCount).toBeGreaterThanOrEqual(2)
    expect(by.short.scoredRunCount).toBe(0) // no run < 5 mi
  })

  it('returns null avgPercentDeltaVsBaseline for an empty bucket', () => {
    const short = series(7, 1, { distanceMiles: 4 }) // all short
    const summary = buildDistanceBucketSummary(short, REST, MAX)
    const by = Object.fromEntries(summary.map((s) => [s.bucket, s]))
    expect(by.mid.avgPercentDeltaVsBaseline).toBeNull()
    expect(by.mid.scoredRunCount).toBe(0)
    expect(by.long.avgPercentDeltaVsBaseline).toBeNull()
  })

  it('averages percentDelta (a fraction, not a 0-100 score) and excludes building runs', () => {
    // Base priors at HR 150; one efficient MID run at lower HR → positive delta.
    const base = series(8, 3, { distanceMiles: 4 }) // days 3..10, short
    const efficientMid = makeWorkout({
      distanceMiles: 6, secPerMile: 540, avgHeartRate: 140, startDate: daysAgo(1),
    })
    const noHr = makeWorkout({
      distanceMiles: 6, secPerMile: 540, avgHeartRate: null, startDate: daysAgo(2),
    })
    const summary = buildDistanceBucketSummary([efficientMid, noHr, ...base], REST, MAX)
    const by = Object.fromEntries(summary.map((s) => [s.bucket, s]))
    expect(by.mid.scoredRunCount).toBe(1) // efficientMid scored; noHr excluded
    const midDelta = by.mid.avgPercentDeltaVsBaseline as number
    expect(midDelta).toBeGreaterThan(0) // lower HR → more efficient
    expect(midDelta).toBeLessThan(1) // it's a fraction, not a raw score
  })
})
