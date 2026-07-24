import { describe, it, expect } from 'vitest'
import {
  computeEfficiencyFactor,
  buildEfficiencyBaselines,
  buildEfficiencyTierMap,
  scoreWorkoutEfficiency,
  computeEfficiencyScore,
  MIN_BASELINE_RUNS,
  MIN_CADENCE_BASELINE_RUNS,
  SCORE_SCALE_PCT,
  CADENCE_SCALE_PCT,
  CADENCE_MODIFIER_MAX_POINTS,
  type EfficiencyWorkout,
  type TierBaseline,
} from '../efficiencyScore'

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
    activityType: 'running',
    avgPaceSecPerMile: secPerMile,
    avgHeartRate: 150,
    cadenceSPM: null,
    ...rest,
  }
}

function tierBaseline(over: Partial<TierBaseline>): TierBaseline {
  return {
    tier: 'BASELINE',
    avgEfficiencyFactor: 0.045,
    avgCadenceSPM: 170,
    runCount: MIN_BASELINE_RUNS,
    cadenceRunCount: MIN_CADENCE_BASELINE_RUNS,
    ...over,
  }
}

// ─── computeEfficiencyFactor ────────────────────────────────────────────────

describe('computeEfficiencyFactor', () => {
  it('computes speed(mph)/HR — 10:00/mi at 120bpm = 6mph/120 = 0.05', () => {
    // 600 s/mi -> 3600/600 = 6 mph; 6 / 120 = 0.05
    expect(computeEfficiencyFactor(600, 120)).toBeCloseTo(0.05, 6)
  })

  it('rises as pace quickens (higher speed per beat)', () => {
    const slower = computeEfficiencyFactor(600, 150)
    const faster = computeEfficiencyFactor(500, 150)
    expect(faster).toBeGreaterThan(slower)
  })
})

// ─── buildEfficiencyBaselines ───────────────────────────────────────────────

describe('buildEfficiencyBaselines', () => {
  it('returns empty tiers for no workouts', () => {
    const b = buildEfficiencyBaselines([])
    expect(b.BASELINE).toEqual({
      tier: 'BASELINE',
      avgEfficiencyFactor: 0,
      avgCadenceSPM: null,
      runCount: 0,
      cadenceRunCount: 0,
    })
    expect(b.QUALITY.runCount).toBe(0)
    expect(b.RACE.runCount).toBe(0)
  })

  it('buckets consistent easy runs as BASELINE and averages their EF', () => {
    const workouts = [1, 2, 3, 4, 5, 6].map((n) =>
      makeWorkout({
        distanceMiles: 5,
        secPerMile: 540,
        avgHeartRate: 150,
        startDate: daysAgo(n),
      })
    )
    const b = buildEfficiencyBaselines(workouts)
    expect(b.BASELINE.runCount).toBe(6)
    expect(b.QUALITY.runCount).toBe(0)
    expect(b.BASELINE.avgEfficiencyFactor).toBeCloseTo(
      computeEfficiencyFactor(540, 150),
      8
    )
  })

  it('classifies corroborated fast runs as QUALITY, easy runs as BASELINE', () => {
    const easy = [1, 2, 3, 4].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const fast = [5, 6].map((n) =>
      makeWorkout({ distanceMiles: 4, secPerMile: 500, startDate: daysAgo(n) })
    )
    const b = buildEfficiencyBaselines([...easy, ...fast])
    expect(b.QUALITY.runCount).toBe(2)
    expect(b.BASELINE.runCount).toBe(4)
    expect(b.QUALITY.avgEfficiencyFactor).toBeCloseTo(
      computeEfficiencyFactor(500, 150),
      8
    )
  })

  it('averages cadence over non-null runs only and counts them separately', () => {
    const workouts = [
      makeWorkout({ distanceMiles: 5, secPerMile: 540, cadenceSPM: 170, startDate: daysAgo(1) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, cadenceSPM: 180, startDate: daysAgo(2) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, cadenceSPM: null, startDate: daysAgo(3) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, cadenceSPM: null, startDate: daysAgo(4) }),
    ]
    const b = buildEfficiencyBaselines(workouts)
    expect(b.BASELINE.runCount).toBe(4)
    expect(b.BASELINE.cadenceRunCount).toBe(2)
    expect(b.BASELINE.avgCadenceSPM).toBeCloseTo(175, 6) // (170+180)/2
  })

  it('leaves avgCadenceSPM null when no run carries cadence', () => {
    const workouts = [1, 2, 3].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, cadenceSPM: null, startDate: daysAgo(n) })
    )
    const b = buildEfficiencyBaselines(workouts)
    expect(b.BASELINE.avgCadenceSPM).toBeNull()
    expect(b.BASELINE.cadenceRunCount).toBe(0)
  })

  it('excludes runs missing HR from the EF average and runCount', () => {
    const workouts = [
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, startDate: daysAgo(1) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: 150, startDate: daysAgo(2) }),
      makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: null, startDate: daysAgo(3) }),
    ]
    const b = buildEfficiencyBaselines(workouts)
    expect(b.BASELINE.runCount).toBe(2) // the null-HR run contributes no EF
  })
})

// ─── buildEfficiencyTierMap ─────────────────────────────────────────────────

describe('buildEfficiencyTierMap', () => {
  it('maps each in-window run id to its classified tier', () => {
    const easy = [1, 2, 3, 4].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const fast = [5, 6].map((n) =>
      makeWorkout({ distanceMiles: 4, secPerMile: 500, startDate: daysAgo(n) })
    )
    const map = buildEfficiencyTierMap([...easy, ...fast])
    expect(map.get(easy[0].workoutId)).toBe('BASELINE')
    expect(map.get(fast[0].workoutId)).toBe('QUALITY')
    expect(map.get(fast[1].workoutId)).toBe('QUALITY')
  })

  it('omits out-of-window runs from the map', () => {
    const recent = [1, 2].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const old = makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(400) })
    const map = buildEfficiencyTierMap([...recent, old])
    expect(map.has(recent[0].workoutId)).toBe(true)
    expect(map.has(old.workoutId)).toBe(false)
  })
})

// ─── scoreWorkoutEfficiency ─────────────────────────────────────────────────

describe('scoreWorkoutEfficiency', () => {
  it('resolves tier, baseline, and score for a run in the map', () => {
    const runs = [1, 2, 3, 4, 5, 6].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const baselines = buildEfficiencyBaselines(runs)
    const tierMap = buildEfficiencyTierMap(runs)
    const out = scoreWorkoutEfficiency(runs[0], baselines, tierMap)
    expect(out.tier).toBe('BASELINE')
    expect(out.baselineRunCount).toBe(6)
    expect(out.result.status).toBe('scored')
    expect(out.result.score).toBeCloseTo(50, 6) // run EF == baseline EF
  })

  it('falls back to BASELINE tier for a run absent from the map', () => {
    const runs = [1, 2].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const baselines = buildEfficiencyBaselines(runs)
    const tierMap = buildEfficiencyTierMap(runs)
    const orphan = makeWorkout({ distanceMiles: 6, secPerMile: 520, startDate: daysAgo(500) })
    const out = scoreWorkoutEfficiency(orphan, baselines, tierMap)
    expect(out.tier).toBe('BASELINE')
    // Only 2 baseline runs (< MIN_BASELINE_RUNS) -> building
    expect(out.result.status).toBe('building_baseline')
  })

  it('returns building_baseline when the run lacks HR', () => {
    const runs = [1, 2, 3, 4, 5, 6].map((n) =>
      makeWorkout({ distanceMiles: 5, secPerMile: 540, startDate: daysAgo(n) })
    )
    const baselines = buildEfficiencyBaselines(runs)
    const tierMap = buildEfficiencyTierMap(runs)
    const noHr = makeWorkout({ distanceMiles: 5, secPerMile: 540, avgHeartRate: null, startDate: daysAgo(2) })
    const out = scoreWorkoutEfficiency(noHr, baselines, tierMap)
    expect(out.result.status).toBe('building_baseline')
  })
})

// ─── computeEfficiencyScore ─────────────────────────────────────────────────

describe('computeEfficiencyScore', () => {
  const baseEF = computeEfficiencyFactor(540, 150)

  it('scores above 50 when the run is more efficient than baseline', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 500,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6 }),
    })
    const runEF = computeEfficiencyFactor(500, 150)
    const expectedDelta = (runEF - baseEF) / baseEF
    expect(r.status).toBe('scored')
    expect(r.score).toBeGreaterThan(50)
    expect(r.percentDeltaVsBaseline).toBeCloseTo(expectedDelta, 8)
    expect(r.score).toBeCloseTo(50 + (expectedDelta / SCORE_SCALE_PCT) * 50, 6)
    expect(r.cadenceDeltaVsBaseline).toBeNull()
  })

  it('scores below 50 when the run is less efficient than baseline', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 600,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6 }),
    })
    expect(r.status).toBe('scored')
    expect(r.score!).toBeLessThan(50)
  })

  it('scores when runCount is exactly MIN_BASELINE_RUNS', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ avgEfficiencyFactor: baseEF, runCount: MIN_BASELINE_RUNS }),
    })
    expect(r.status).toBe('scored')
    expect(r.score).toBeCloseTo(50, 6) // run EF == baseline EF -> neutral 50
  })

  it('returns building_baseline just below MIN_BASELINE_RUNS with no fallback', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ runCount: MIN_BASELINE_RUNS - 1 }),
    })
    expect(r.status).toBe('building_baseline')
    expect(r.score).toBeNull()
    expect(r.percentDeltaVsBaseline).toBeNull()
    expect(r.cadenceDeltaVsBaseline).toBeNull()
  })

  it('falls back to the QUALITY baseline for a RACE run with a thin RACE baseline', () => {
    const qEF = computeEfficiencyFactor(520, 150)
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 500,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'RACE',
      baseline: tierBaseline({ tier: 'RACE', runCount: 2 }),
      qualityBaseline: tierBaseline({ tier: 'QUALITY', avgEfficiencyFactor: qEF, runCount: MIN_BASELINE_RUNS }),
    })
    expect(r.status).toBe('scored')
    const runEF = computeEfficiencyFactor(500, 150)
    expect(r.percentDeltaVsBaseline).toBeCloseTo((runEF - qEF) / qEF, 8)
  })

  it('builds baseline for a RACE run when the QUALITY fallback is also thin', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 500,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'RACE',
      baseline: tierBaseline({ tier: 'RACE', runCount: 2 }),
      qualityBaseline: tierBaseline({ tier: 'QUALITY', runCount: MIN_BASELINE_RUNS - 1 }),
    })
    expect(r.status).toBe('building_baseline')
    expect(r.score).toBeNull()
  })

  it('builds baseline for a thin RACE run when no QUALITY fallback is supplied', () => {
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 500,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'RACE',
      baseline: tierBaseline({ tier: 'RACE', runCount: 2 }),
    })
    expect(r.status).toBe('building_baseline')
  })

  it('applies a partial cadence modifier within the cap', () => {
    const baseline = tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6, avgCadenceSPM: 170, cadenceRunCount: 5 })
    const cadenceSPM = 170 * 1.02 // +2% -> below the ±5% cap
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM,
      tier: 'BASELINE',
      baseline,
    })
    const cadenceDelta = (cadenceSPM - 170) / 170
    const modifier = (cadenceDelta / CADENCE_SCALE_PCT) * CADENCE_MODIFIER_MAX_POINTS
    expect(r.cadenceDeltaVsBaseline).toBeCloseTo(cadenceDelta, 8)
    expect(r.score).toBeCloseTo(50 + modifier, 6) // rawScore is 50 (neutral EF)
    expect(Math.abs(modifier)).toBeLessThan(CADENCE_MODIFIER_MAX_POINTS)
  })

  it('caps the cadence modifier at CADENCE_MODIFIER_MAX_POINTS', () => {
    const baseline = tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6, avgCadenceSPM: 170, cadenceRunCount: 5 })
    const cadenceSPM = 170 * 1.20 // +20% -> well beyond the ±5% cap
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM,
      tier: 'BASELINE',
      baseline,
    })
    expect(r.cadenceDeltaVsBaseline).toBeCloseTo(0.2, 8)
    expect(r.score).toBeCloseTo(50 + CADENCE_MODIFIER_MAX_POINTS, 6) // full +5
  })

  it('skips the cadence modifier when the run has no cadence', () => {
    const baseline = tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6, avgCadenceSPM: 170, cadenceRunCount: 5 })
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline,
    })
    expect(r.cadenceDeltaVsBaseline).toBeNull()
    expect(r.score).toBeCloseTo(50, 6)
  })

  it('skips the cadence modifier when the cadence baseline is too thin', () => {
    const baseline = tierBaseline({
      avgEfficiencyFactor: baseEF,
      runCount: 6,
      avgCadenceSPM: 170,
      cadenceRunCount: MIN_CADENCE_BASELINE_RUNS - 1,
    })
    const r = computeEfficiencyScore({
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: 180,
      tier: 'BASELINE',
      baseline,
    })
    expect(r.cadenceDeltaVsBaseline).toBeNull()
    expect(r.score).toBeCloseTo(50, 6)
  })

  it('clamps the score to [0, 100]', () => {
    const high = computeEfficiencyScore({
      avgPaceSecPerMile: 300, // very fast -> huge positive delta
      avgHeartRate: 150,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6 }),
    })
    const low = computeEfficiencyScore({
      avgPaceSecPerMile: 900, // very slow -> huge negative delta
      avgHeartRate: 200,
      cadenceSPM: null,
      tier: 'BASELINE',
      baseline: tierBaseline({ avgEfficiencyFactor: baseEF, runCount: 6 }),
    })
    expect(high.score).toBe(100)
    expect(low.score).toBe(0)
  })
})
