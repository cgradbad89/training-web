import { describe, it, expect } from 'vitest'
import {
  driftLevel,
  trainingLoadLevel,
  distanceBucket,
} from '../metrics'

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
