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
      { distanceMiles: 3, timeSeconds: 1500, ageDays: 5, isTreadmill: false },
      { distanceMiles: 5, timeSeconds: 2600, ageDays: 10, isTreadmill: false },
      { distanceMiles: 7, timeSeconds: 3800, ageDays: 15, isTreadmill: false },
    ]
    expect(fitRiegel(efforts, 13.109)).toBeNull()
  })

  it('returns null when all efforts are same distance (zero variance)', () => {
    const efforts = Array.from({ length: 5 }, (_, i) => ({
      distanceMiles: 5,
      timeSeconds: 2500 + i * 10,
      ageDays: i * 5,
      isTreadmill: false,
    }))
    // All same distance means sxx = 0, should return null
    expect(fitRiegel(efforts, 13.109)).toBeNull()
  })

  it('returns a valid fit for diverse efforts', () => {
    const efforts = [
      { distanceMiles: 3.1, timeSeconds: 1500, ageDays: 5, isTreadmill: false },
      { distanceMiles: 5.0, timeSeconds: 2550, ageDays: 10, isTreadmill: false },
      { distanceMiles: 7.0, timeSeconds: 3700, ageDays: 15, isTreadmill: false },
      { distanceMiles: 10.0, timeSeconds: 5500, ageDays: 20, isTreadmill: false },
      { distanceMiles: 6.0, timeSeconds: 3100, ageDays: 25, isTreadmill: false },
    ]
    const fit = fitRiegel(efforts, 5.0, 0)
    expect(fit).not.toBeNull()
    expect(fit!.n).toBe(5)
    expect(fit!.r2).toBeGreaterThan(0)
    expect(isFinite(fit!.k)).toBe(true)
    expect(isFinite(fit!.a)).toBe(true)
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
