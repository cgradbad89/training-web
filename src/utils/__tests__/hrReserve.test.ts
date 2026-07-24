import { describe, it, expect } from 'vitest'
import { computeHRReserve } from '../hrReserve'

describe('computeHRReserve', () => {
  it('computes Karvonen %HRR in the normal range', () => {
    // (143 - 65) / (175 - 65) = 78/110 = 0.709...
    expect(computeHRReserve(143, 65, 175)).toBeCloseTo(78 / 110, 8)
  })

  it('clamps to 0 when avgHR is at or below resting', () => {
    expect(computeHRReserve(65, 65, 175)).toBe(0)
    expect(computeHRReserve(50, 65, 175)).toBe(0)
  })

  it('clamps to 1 when avgHR is at or above max', () => {
    expect(computeHRReserve(175, 65, 175)).toBe(1)
    expect(computeHRReserve(200, 65, 175)).toBe(1)
  })

  it('returns 0.5 at the midpoint of the reserve', () => {
    // reserve 110, midpoint 65 + 55 = 120
    expect(computeHRReserve(120, 65, 175)).toBeCloseTo(0.5, 8)
  })

  it('mirrors trainingLoad V2 defaults (185/60)', () => {
    expect(computeHRReserve(147.5, 60, 185)).toBeCloseTo(0.7, 8)
  })
})
