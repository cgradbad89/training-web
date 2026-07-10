import { describe, it, expect } from 'vitest'
import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
  formatRaceTime,
  formatRacePace,
} from '../riegelFit'

describe('buildQualifyingEfforts', () => {
  it('returns empty array for empty workouts', () => {
    expect(buildQualifyingEfforts([], 56)).toEqual([])
  })

  it('filters out workouts with zero distance', () => {
    const workouts = [
      {
        workoutId: '1',
        distanceMiles: 0,
        durationSeconds: 600,
        startDate: new Date(),
        activityType: 'running',
      },
    ]
    expect(buildQualifyingEfforts(workouts, 56)).toEqual([])
  })

  it('filters out workouts with invalid dates (NaN)', () => {
    const workouts = [
      {
        workoutId: '1',
        distanceMiles: 5,
        durationSeconds: 2400,
        startDate: 'not-a-date',
        activityType: 'running',
      },
    ]
    // NaN date should be filtered out by isFinite check
    expect(buildQualifyingEfforts(workouts, 56)).toEqual([])
  })

  it('filters out workouts with unrealistic pace (<3:00/mi or >20:00/mi)', () => {
    const now = new Date()
    const workouts = [
      {
        workoutId: '1',
        distanceMiles: 5,
        durationSeconds: 100, // 0:20/mi - too fast
        startDate: now,
        activityType: 'running',
      },
      {
        workoutId: '2',
        distanceMiles: 1,
        durationSeconds: 1500, // 25:00/mi - too slow
        startDate: now,
        activityType: 'running',
      },
    ]
    expect(buildQualifyingEfforts(workouts, 56)).toEqual([])
  })

  it('accepts workouts with valid pace and recent date', () => {
    const now = new Date()
    const workouts = [
      {
        workoutId: '1',
        distanceMiles: 5.0,
        durationSeconds: 2400, // 8:00/mi
        startDate: now,
        activityType: 'running',
      },
    ]
    const result = buildQualifyingEfforts(workouts, 56)
    expect(result).toHaveLength(1)
    expect(result[0].distanceMiles).toBe(5.0)
    expect(result[0].timeSeconds).toBe(2400)
  })
})

describe('fitRiegel', () => {
  it('returns null for empty efforts', () => {
    expect(fitRiegel([], 13.109)).toBeNull()
  })

  it('returns null for fewer than 4 efforts', () => {
    const efforts = [
      { distanceMiles: 3, timeSeconds: 1500, ageDays: 5, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 5, timeSeconds: 2600, ageDays: 10, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 7, timeSeconds: 3800, ageDays: 15, isTreadmill: false, tier: 'BASELINE' as const },
    ]
    expect(fitRiegel(efforts, 13.109)).toBeNull()
  })

  it('returns null when all efforts are same distance (zero variance)', () => {
    const efforts = Array.from({ length: 5 }, (_, i) => ({
      distanceMiles: 5,
      timeSeconds: 2500 + i * 10,
      ageDays: i * 5,
      isTreadmill: false,
      tier: 'BASELINE' as const,
    }))
    // All same distance means sxx = 0, should return null
    expect(fitRiegel(efforts, 13.109)).toBeNull()
  })

  it('returns a valid fit for diverse efforts', () => {
    const efforts = [
      { distanceMiles: 3.1, timeSeconds: 1500, ageDays: 5, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 5.0, timeSeconds: 2550, ageDays: 10, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 7.0, timeSeconds: 3700, ageDays: 15, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 10.0, timeSeconds: 5500, ageDays: 20, isTreadmill: false, tier: 'BASELINE' as const },
      { distanceMiles: 6.0, timeSeconds: 3100, ageDays: 25, isTreadmill: false, tier: 'BASELINE' as const },
    ]
    const fit = fitRiegel(efforts, 5.0, 0)
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(5)
    expect(fit!.r2).toBeGreaterThan(0)
    expect(isFinite(fit!.k)).toBe(true)
    expect(isFinite(fit!.a)).toBe(true)
  })

  // ── isFastFinish / fastFinishMinMiles (5th param) ─────────────────────────
  // Half-marathon-gate-satisfying base: 4 BASELINE efforts ≥3mi (all clear the
  // half+ minMilesForFit=3.0 unconditionally), with a recent ≥4mi pair and a
  // recent ≥6mi run so the half+ "2 medium-long + longest≥6 in 35d" gate passes
  // without needing a RACE anchor.
  const HALF = 13.109
  const halfGateBase = [
    { distanceMiles: 6, timeSeconds: 6 * 570, ageDays: 5, isTreadmill: false, tier: 'BASELINE' as const },
    { distanceMiles: 5, timeSeconds: 5 * 580, ageDays: 10, isTreadmill: false, tier: 'BASELINE' as const },
    { distanceMiles: 4, timeSeconds: 4 * 590, ageDays: 15, isTreadmill: false, tier: 'BASELINE' as const },
    { distanceMiles: 8, timeSeconds: 8 * 600, ageDays: 20, isTreadmill: false, tier: 'BASELINE' as const },
  ]

  it('a fast-finish effort at exactly the 2mi floor survives for a half-marathon target when fastFinishMinMiles is passed (previously excluded by the 3.0mi minMilesForFit)', () => {
    const fastFinish = {
      distanceMiles: 2.0,
      timeSeconds: 2.0 * 559,
      ageDays: 3,
      isTreadmill: false,
      tier: 'QUALITY' as const,
      isFastFinish: true,
    }
    const fit = fitRiegel(
      [...halfGateBase, fastFinish],
      HALF,
      3.0,
      { min: 1.04, max: 1.1 },
      2
    )
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(5) // the 2mi fast-finish point survived the filter
    expect(fit!.minMiles).toBe(2)
  })

  it('a fast-finish effort BELOW its own 2mi floor is still excluded (defensive — should never occur upstream)', () => {
    const tooShortFastFinish = {
      distanceMiles: 1.5,
      timeSeconds: 1.5 * 559,
      ageDays: 3,
      isTreadmill: false,
      tier: 'QUALITY' as const,
      isFastFinish: true,
    }
    const fit = fitRiegel(
      [...halfGateBase, tooShortFastFinish],
      HALF,
      3.0,
      { min: 1.04, max: 1.1 },
      2
    )
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(4) // the 1.5mi point did NOT survive
    expect(fit!.minMiles).toBe(4) // unaffected by the excluded point
  })

  it('a non-fast-finish effort under minMilesForFit is still excluded for half+, unaffected by fastFinishMinMiles', () => {
    const ordinaryEffortUnderFloor = {
      distanceMiles: 2.5, // < minMilesForFit(3.0), and NOT tagged isFastFinish
      timeSeconds: 2.5 * 559,
      ageDays: 3,
      isTreadmill: false,
      tier: 'BASELINE' as const,
    }
    const fit = fitRiegel(
      [...halfGateBase, ordinaryEffortUnderFloor],
      HALF,
      3.0,
      { min: 1.04, max: 1.1 },
      2 // fastFinishMinMiles present, but this effort isn't isFastFinish
    )
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(4) // the 2.5mi ordinary effort did NOT survive
    expect(fit!.minMiles).toBe(4)
  })

  it('omitting fastFinishMinMiles (old 4-arg call) leaves fast-finish efforts subject to minMilesForFit like before (backward compatible)', () => {
    const fastFinish = {
      distanceMiles: 2.0,
      timeSeconds: 2.0 * 559,
      ageDays: 3,
      isTreadmill: false,
      tier: 'QUALITY' as const,
      isFastFinish: true,
    }
    const fit = fitRiegel([...halfGateBase, fastFinish], HALF, 3.0, { min: 1.04, max: 1.1 })
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(4) // no 5th arg → the 2mi fast-finish point is filtered like any other
    expect(fit!.minMiles).toBe(4)
  })
})

describe('predictSeconds', () => {
  it('returns a finite number for valid fit', () => {
    const fit = { a: 6.5, k: 1.08, r2: 0.95, n: 5, minMiles: 3, maxMiles: 10 }
    const predicted = predictSeconds(fit, 13.109)
    expect(isFinite(predicted)).toBe(true)
    expect(predicted).toBeGreaterThan(0)
  })
})

describe('formatRaceTime', () => {
  it('returns dash for null/undefined/0', () => {
    expect(formatRaceTime(null)).toBe('—')
    expect(formatRaceTime(undefined)).toBe('—')
    expect(formatRaceTime(0)).toBe('—')
  })

  it('returns dash for NaN/Infinity', () => {
    expect(formatRaceTime(NaN)).toBe('—')
    expect(formatRaceTime(Infinity)).toBe('—')
    expect(formatRaceTime(-Infinity)).toBe('—')
  })

  it('formats seconds correctly', () => {
    expect(formatRaceTime(6630)).toBe('1:50:30') // 1h 50m 30s
    expect(formatRaceTime(330)).toBe('5:30')     // 5m 30s
  })
})

describe('formatRacePace', () => {
  it('returns dash for null/undefined/zero input', () => {
    expect(formatRacePace(null, 13.109)).toBe('—')
    expect(formatRacePace(undefined, 13.109)).toBe('—')
    expect(formatRacePace(0, 13.109)).toBe('—')
  })

  it('returns dash for zero distance', () => {
    expect(formatRacePace(6000, 0)).toBe('—')
  })

  it('formats pace correctly', () => {
    // 6000 seconds / 13.109 miles ≈ 457.7 sec/mi ≈ 7:38/mi
    expect(formatRacePace(6000, 13.109)).toBe('7:38 /mi')
  })
})
