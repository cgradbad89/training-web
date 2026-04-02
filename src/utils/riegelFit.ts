// Riegel-based race time prediction
// Ported from InsightsView.swift (iOS app)

export interface EffortPoint {
  distanceMiles: number
  timeSeconds: number   // total time = pace * distance
  ageDays: number       // how many days ago
  isTreadmill: boolean
}

export interface RiegelFit {
  a: number    // ln-space intercept
  k: number    // endurance exponent
  r2: number   // goodness of fit
  n: number    // number of efforts used
  minMiles: number
  maxMiles: number
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

function recencyWeight(ageDays: number): number {
  if (ageDays < 14) return 1.0
  if (ageDays < 35) return 0.7
  if (ageDays < 56) return 0.4
  return 0.15
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

export function fitRiegel(
  efforts: EffortPoint[],
  targetMiles: number,
  minMilesForFit = 0,
  clampK?: { min: number; max: number }
): RiegelFit | null {
  const filtered = efforts.filter(e => e.distanceMiles >= minMilesForFit)
  if (filtered.length < 4) return null

  // For half/marathon: require 2+ medium-long runs in last 35 days AND longest ≥ 6
  if (targetMiles >= 13.109) {
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
    longRunSupportMultiplier(e, filtered, targetMiles)
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

/**
 * Build qualifying efforts from Firestore HealthWorkout records.
 * Mirrors InsightsView.qualifyingEfforts(daysBack: 56)
 */
export function buildQualifyingEfforts(
  workouts: Array<{
    workoutId: string
    distanceMiles?: number | null
    durationSeconds: number
    startDate: any
    activityType: string
    sourceName?: string
  }>,
  daysBack = 56
): EffortPoint[] {
  const now = Date.now()
  const cutoff = now - daysBack * 86400 * 1000

  return workouts.flatMap(w => {
    const miles = w.distanceMiles ?? 0
    if (miles <= 0) return []

    const startMs = w.startDate?.toDate
      ? w.startDate.toDate().getTime()
      : new Date(w.startDate).getTime()

    if (startMs < cutoff) return []

    const totalSeconds = w.durationSeconds
    if (totalSeconds <= 0 || miles <= 0) return []
    const secPerMile = totalSeconds / miles
    if (secPerMile < 180 || secPerMile > 1200) return [] // 3:00-20:00/mi
    if (totalSeconds < 300) return [] // under 5 min total

    const ageDays = (now - startMs) / 86400000
    const isTreadmill =
      w.activityType === 'treadmill_running' ||
      (w.sourceName ?? '').toLowerCase().includes('treadmill')

    return [{
      distanceMiles: miles,
      timeSeconds: totalSeconds,
      ageDays,
      isTreadmill
    }]
  })
}
