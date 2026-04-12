import type { HealthWorkout } from '@/types/healthWorkout'
import type { HealthMetric } from '@/services/healthMetrics'
import type { RunningPlan } from '@/types/plan'
import type { Race, RaceDistance } from '@/types/race'
import {
  formatRaceTime,
  buildQualifyingEfforts, fitRiegel, predictSeconds
} from '@/utils/riegelFit'
import { weekStart as getWeekStart } from '@/utils/dates'
import type { WorkoutOverride } from '@/types/workoutOverride'

const RACE_MILES: Record<Exclude<RaceDistance, 'custom'>, number> = {
  '5K':         3.107,
  '10K':        6.214,
  halfMarathon: 13.109,
  marathon:     26.219,
}

const RACE_LABELS: Record<RaceDistance, string> = {
  '5K':         '5K',
  '10K':        '10K',
  halfMarathon: 'Half Marathon',
  marathon:     'Marathon',
  custom:       'Custom',
}

// Format pace seconds to M:SS string
function formatPaceStr(secPerMile: number | null | undefined): string | null {
  if (!secPerMile || !isFinite(secPerMile) || secPerMile <= 0) return null
  const total = Math.round(secPerMile)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// Format date to readable string
function formatDateStr(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

// Compute days between two dates
function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / 86400000)
}

// Get distance miles for a race
function getRaceDistanceMiles(race: Race): number | null {
  if (race.raceDistance === 'custom') return race.customDistanceMiles ?? null
  return RACE_MILES[race.raceDistance] ?? null
}

export function buildCoachContext(
  allRuns: HealthWorkout[],
  activePlan: RunningPlan | null,
  activeRace: Race | null,
  overrides: Record<string, WorkoutOverride>,
  healthMetrics: HealthMetric[] = []
) {
  const now = Date.now()
  const thirtyDaysAgo = now - 30 * 86400000

  // Filter to last 30 days, exclude excluded
  const recentRuns = allRuns
    .filter(r => {
      const ov = overrides[r.workoutId]
      if (ov?.isExcluded) return false
      const d = new Date(r.startDate)
      return d.getTime() >= thirtyDaysAgo
    })
    .sort((a, b) => {
      return new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
    })

  // Build runs array for prompt
  const runs = recentRuns.map(r => {
    const d = new Date(r.startDate)
    const miles = r.distanceMiles ?? 0
    const pace = miles > 0 ? formatPaceStr(r.durationSeconds / miles) : null
    const eff = r.efficiencyScore != null
      ? r.efficiencyScore / 2  // normalize to 1-10 range
      : null
    return {
      date: formatDateStr(d),
      distance: miles,
      pace,
      avgHR: r.avgHeartRate ?? null,
      efficiencyScore: eff,
      runType: r.displayType ?? null,
    }
  })

  // Compute stats
  const totalMiles = recentRuns.reduce((s, r) => s + (r.distanceMiles ?? 0), 0)
  const totalRuns = recentRuns.length

  // Weekly mileage for avg
  const weeklyMap = new Map<string, number>()
  recentRuns.forEach(r => {
    const d = new Date(r.startDate)
    const ws = getWeekStart(d)
    const key = ws.toISOString().split('T')[0]
    weeklyMap.set(key, (weeklyMap.get(key) ?? 0) + (r.distanceMiles ?? 0))
  })
  const weeklyValues = Array.from(weeklyMap.values())
  const avgWeeklyMiles = weeklyValues.length > 0
    ? weeklyValues.reduce((a, b) => a + b, 0) / weeklyValues.length
    : 0

  // Avg pace (weighted by distance)
  let totalPaceSec = 0, totalPaceMi = 0
  recentRuns.forEach(r => {
    const mi = r.distanceMiles ?? 0
    if (mi > 0 && r.durationSeconds > 0) {
      totalPaceSec += r.durationSeconds
      totalPaceMi += mi
    }
  })
  const avgPace = totalPaceMi > 0
    ? formatPaceStr(totalPaceSec / totalPaceMi)
    : null

  // Avg HR
  const hrValues = recentRuns
    .map(r => r.avgHeartRate)
    .filter((v): v is number => v !== null && v !== undefined && v > 0)
  const avgHR = hrValues.length > 0
    ? hrValues.reduce((a, b) => a + b, 0) / hrValues.length
    : null

  const longestRun = Math.max(0, ...recentRuns.map(r => r.distanceMiles ?? 0))
  const longRunCount = recentRuns.filter(r => (r.distanceMiles ?? 0) >= 6).length
  const mediumRunCount = recentRuns.filter(r => {
    const m = r.distanceMiles ?? 0
    return m >= 3 && m < 6
  }).length
  const shortRunCount = recentRuns.filter(r => (r.distanceMiles ?? 0) < 3).length

  // Active plan context
  let planContext = null
  if (activePlan?.weeks?.length) {
    const today = new Date()
    const planStart = new Date(activePlan.startDate + 'T00:00:00')
    const planWeeks = [...activePlan.weeks].sort(
      (a, b) => a.weekNumber - b.weekNumber
    )

    // Match weeks to actual runs
    const weekSummaries = planWeeks.map((week, idx) => {
      const plannedMiles = week.entries?.reduce(
        (s: number, r) => s + (r.distanceMiles ?? 0), 0
      ) ?? 0

      // Compute week start date from plan start + index
      const ws = new Date(planStart)
      ws.setDate(planStart.getDate() + idx * 7)
      const we = new Date(ws)
      we.setDate(ws.getDate() + 7)

      const actualMiles = allRuns
        .filter(r => {
          const ov = overrides[r.workoutId]
          if (ov?.isExcluded) return false
          const d = new Date(r.startDate)
          return d >= ws && d < we
        })
        .reduce((s, r) => s + (r.distanceMiles ?? 0), 0)

      return {
        weekNumber: week.weekNumber,
        plannedMiles,
        actualMiles,
      }
    })

    // Determine current week by index
    const weekIndex = Math.floor(
      (getWeekStart(today).getTime() - planStart.getTime()) / (7 * 86400000)
    )
    const currentWeekNum = weekIndex >= 0 && weekIndex < planWeeks.length
      ? planWeeks[weekIndex].weekNumber
      : planWeeks.length

    // Adherence — weeks where actual >= 80% of planned
    const completedWeeks = weekSummaries.filter(
      w => w.weekNumber < currentWeekNum
    )
    const weeksHitTarget = completedWeeks.filter(
      w => w.plannedMiles > 0 && w.actualMiles >= w.plannedMiles * 0.8
    ).length
    const adherencePct = completedWeeks.length > 0
      ? Math.round((weeksHitTarget / completedWeeks.length) * 100)
      : 100

    const plannedMilesToDate = completedWeeks.reduce(
      (s, w) => s + w.plannedMiles, 0
    )
    const actualMilesToDate = completedWeeks.reduce(
      (s, w) => s + w.actualMiles, 0
    )

    // This week
    const thisWeek = weekIndex >= 0 && weekIndex < weekSummaries.length
      ? weekSummaries[weekIndex]
      : null

    planContext = {
      name: activePlan.name ?? 'Training Plan',
      currentWeek: currentWeekNum,
      totalWeeks: planWeeks.length,
      adherencePct,
      weeksHitTarget,
      weeksCompleted: completedWeeks.length,
      plannedMilesToDate,
      actualMilesToDate,
      thisWeekPlanned: thisWeek?.plannedMiles ?? 0,
      thisWeekActual: thisWeek?.actualMiles ?? 0,
      weekSummaries,
    }
  }

  // Active race context
  let raceContext = null
  if (activeRace) {
    const raceDate = new Date(activeRace.raceDate)
    const daysAway = daysBetween(new Date(), raceDate)
    const distanceMiles = getRaceDistanceMiles(activeRace)

    // Predicted time via Riegel
    const nonExcludedRuns = allRuns.filter(r => !overrides[r.workoutId]?.isExcluded)
    const efforts = buildQualifyingEfforts(nonExcludedRuns, 56)
    const fit = distanceMiles
      ? fitRiegel(efforts, distanceMiles, 3.0, { min: 1.05, max: 1.18 })
      : null
    const predictedSeconds = fit && distanceMiles ? predictSeconds(fit, distanceMiles) : null
    const predictedTime = predictedSeconds
      ? formatRaceTime(predictedSeconds)
      : null

    // Target pace
    const targetPace = activeRace.targetPaceSecondsPerMile
      ? formatPaceStr(activeRace.targetPaceSecondsPerMile)
      : null

    // Goal time — computed from target pace * distance
    const goalTimeSec = activeRace.targetPaceSecondsPerMile && distanceMiles
      ? activeRace.targetPaceSecondsPerMile * distanceMiles
      : null
    const goalTime = goalTimeSec ? formatRaceTime(goalTimeSec) : null

    // Comparison status
    let comparisonStatus: string | null = null
    if (predictedSeconds && goalTimeSec) {
      const delta = predictedSeconds - goalTimeSec
      if (delta <= -240) comparisonStatus = 'Ahead of goal by more than 4 minutes'
      else if (delta <= 240) comparisonStatus = 'On pace — within 4 minutes of goal'
      else comparisonStatus = `Behind goal by ${(delta / 60).toFixed(1)} minutes`
    }

    raceContext = {
      name: activeRace.name,
      raceDate: formatDateStr(raceDate),
      daysAway,
      distanceLabel: RACE_LABELS[activeRace.raceDistance] ?? 'Unknown',
      targetPace,
      goalTime,
      predictedTime,
      comparisonStatus,
    }
  }

  // ── Health metrics summary (last 30 days) ──────────────────────────

  function healthAvg(key: keyof HealthMetric): number | null {
    const vals = healthMetrics
      .map(m => m[key] as number | undefined)
      .filter((v): v is number => v !== undefined && v > 0 && isFinite(v))
    if (vals.length === 0) return null
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }

  function healthLatest(key: keyof HealthMetric): number | null {
    for (const m of healthMetrics) {
      const v = m[key] as number | undefined
      if (v !== undefined && v > 0 && isFinite(v)) return v
    }
    return null
  }

  const healthSummary = healthMetrics.length > 0 ? {
    avgSleepHours: healthAvg('sleep_total_hours'),
    avgAwakeMins:  healthAvg('sleep_awake_mins'),
    latestSleep:   healthLatest('sleep_total_hours'),
    latestWeight:  healthLatest('weight_lbs'),
    latestBMI:     healthLatest('bmi'),
    latestRestingHR: healthLatest('resting_hr'),
    avgRestingHR:  healthAvg('resting_hr'),
    avgSteps:      healthAvg('steps'),
    avgExerciseMins: healthAvg('exercise_mins'),
    avgMoveCalories: healthAvg('move_calories'),
    avgStandHours: healthAvg('stand_hours'),
    avgBrushCount:    healthAvg('brush_count'),
    avgBrushDuration: healthAvg('brush_avg_duration_mins'),
    daysOfData: healthMetrics.length,
  } : null

  return {
    runs,
    activePlan: planContext,
    activeRace: raceContext,
    stats: {
      totalRuns,
      totalMiles,
      avgWeeklyMiles,
      avgPace,
      avgHR,
      longestRun,
      longRunCount,
      mediumRunCount,
      shortRunCount,
    },
    healthSummary,
  }
}
