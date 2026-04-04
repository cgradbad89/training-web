import { describe, it, expect } from 'vitest'
import {
  formatPace,
  formatDuration,
  mpsToSecPerMile,
  parsePaceString,
} from '../pace'

describe('formatPace', () => {
  it('returns --:-- for zero', () => {
    expect(formatPace(0)).toBe('--:--')
  })

  it('returns --:-- for negative values', () => {
    expect(formatPace(-100)).toBe('--:--')
  })

  it('returns --:-- for NaN', () => {
    expect(formatPace(NaN)).toBe('--:--')
  })

  it('returns --:-- for Infinity', () => {
    expect(formatPace(Infinity)).toBe('--:--')
  })

  it('formats 600 sec/mi as 10:00', () => {
    expect(formatPace(600)).toBe('10:00')
  })

  it('formats 599.5 sec/mi as 10:00 (rounds correctly, no 10:60)', () => {
    // This is the key regression test — before fix, Math.round(599.5 % 60)
    // would produce 60, resulting in "9:60" instead of "10:00"
    expect(formatPace(599.5)).toBe('10:00')
  })

  it('formats 659.7 sec/mi as 11:00 (rounds up correctly)', () => {
    expect(formatPace(659.7)).toBe('11:00')
  })

  it('formats 480 sec/mi as 8:00', () => {
    expect(formatPace(480)).toBe('8:00')
  })

  it('formats 495 sec/mi as 8:15', () => {
    expect(formatPace(495)).toBe('8:15')
  })
})

describe('formatDuration', () => {
  it('returns 0:00 for zero', () => {
    expect(formatDuration(0)).toBe('0:00')
  })

  it('returns 0:00 for NaN', () => {
    expect(formatDuration(NaN)).toBe('0:00')
  })

  it('returns 0:00 for negative', () => {
    expect(formatDuration(-100)).toBe('0:00')
  })

  it('returns 0:00 for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('0:00')
  })

  it('formats 3661 as 1:01:01', () => {
    expect(formatDuration(3661)).toBe('1:01:01')
  })

  it('formats 59.6 without producing :60 (rounds correctly)', () => {
    // 59.6 rounds to 60 total seconds = 1:00
    expect(formatDuration(59.6)).toBe('1:00')
  })

  it('formats 3599.7 without producing 59:60', () => {
    // 3599.7 rounds to 3600 = 1:00:00
    expect(formatDuration(3599.7)).toBe('1:00:00')
  })
})

describe('mpsToSecPerMile', () => {
  it('returns 0 for zero speed', () => {
    expect(mpsToSecPerMile(0)).toBe(0)
  })

  it('returns 0 for negative speed', () => {
    expect(mpsToSecPerMile(-1)).toBe(0)
  })

  it('converts 3.5 m/s correctly', () => {
    const result = mpsToSecPerMile(3.5)
    expect(result).toBeCloseTo(459.8, 0)
  })
})

describe('parsePaceString', () => {
  it('parses "10:30" as 630 seconds', () => {
    expect(parsePaceString('10:30')).toBe(630)
  })

  it('returns null for invalid format', () => {
    expect(parsePaceString('abc')).toBeNull()
    expect(parsePaceString('10:60')).toBeNull()
    expect(parsePaceString('')).toBeNull()
  })

  it('returns null for 0:00', () => {
    expect(parsePaceString('0:00')).toBeNull()
  })
})
