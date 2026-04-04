import { describe, it, expect } from 'vitest'
import {
  efficiencyDisplayScore,
  driftLevel,
  cadenceLevel,
  trainingLoadLevel,
  distanceBucket,
} from '../metrics'

describe('efficiencyDisplayScore', () => {
  it('returns 0 for zero speed', () => {
    expect(efficiencyDisplayScore(0, 150)).toBe(0)
  })

  it('returns 0 for zero HR', () => {
    expect(efficiencyDisplayScore(3.5, 0)).toBe(0)
  })

  it('returns 0 for both zero (no NaN)', () => {
    // 0/0 would be NaN — function should return 0 instead
    expect(efficiencyDisplayScore(0, 0)).toBe(0)
  })

  it('clamps to range [1, 10] for valid inputs', () => {
    // Very slow runner with high HR
    const low = efficiencyDisplayScore(1.5, 180)
    expect(low).toBeGreaterThanOrEqual(1)
    expect(low).toBeLessThanOrEqual(10)

    // Very fast runner with low HR
    const high = efficiencyDisplayScore(5.0, 120)
    expect(high).toBeGreaterThanOrEqual(1)
    expect(high).toBeLessThanOrEqual(10)
  })

  it('returns a finite number', () => {
    expect(isFinite(efficiencyDisplayScore(3.5, 150))).toBe(true)
  })
})

describe('distanceBucket', () => {
  it('classifies short runs', () => {
    expect(distanceBucket(1)).toBe('short')
    expect(distanceBucket(2.9)).toBe('short')
  })

  it('classifies medium runs', () => {
    expect(distanceBucket(3)).toBe('medium')
    expect(distanceBucket(5.9)).toBe('medium')
  })

  it('classifies long runs', () => {
    expect(distanceBucket(6)).toBe('long')
    expect(distanceBucket(13)).toBe('long')
  })
})

describe('driftLevel', () => {
  it('handles short run thresholds', () => {
    expect(driftLevel(3, 'short')).toBe('good')
    expect(driftLevel(7, 'short')).toBe('ok')
    expect(driftLevel(15, 'short')).toBe('high')
  })
})

describe('trainingLoadLevel', () => {
  it('classifies deload', () => {
    expect(trainingLoadLevel(0.5)).toBe('deload')
  })

  it('classifies stable', () => {
    expect(trainingLoadLevel(1.0)).toBe('stable')
  })

  it('classifies building', () => {
    expect(trainingLoadLevel(1.2)).toBe('building')
  })

  it('classifies aggressive', () => {
    expect(trainingLoadLevel(1.5)).toBe('aggressive')
  })
})
