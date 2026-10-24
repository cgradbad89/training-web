import type { HealthWorkout } from "@/types/healthWorkout";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { parseLocalDate } from "@/utils/dates";
import { matchPlanToActual } from "@/utils/planMatching";
import { isPerformanceDate, performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";

/** A descriptive display policy, never a race-time adjustment. */
export const RACE_CONTEXT_LONG_RUN_MILES = 6;

export interface TrainingPeriodSummary {
  startDate: string;
  endDate: string;
  miles: number;
  sessions: number;
  durationSeconds: number;
  runningDays: number;
}

export interface RaceTrainingWeek extends TrainingPeriodSummary {
  weekStart: string;
  partialWeek: boolean;
  longestRunMiles: number | null;
  longRunCount: number;
}

export interface RaceTrainingContext {
  asOfDate: string;
  weekly: RaceTrainingWeek[];
  recentFourWeeks: TrainingPeriodSummary;
  priorFourWeeks: TrainingPeriodSummary;
  mileageChangePct: number | null;
  longestRecentRun: { workoutId: string; date: string; miles: number; durationSeconds: number } | null;
  longRuns: {
    thresholdMiles: number;
    recentCount: number;
    priorCount: number;
    recentLongestMiles: number | null;
    priorLongestMiles: number | null;
    progressionMiles: number | null;
    byWeek: { weekStart: string; longestRunMiles: number | null; count: number }[];
  };
  recentDurations: { workoutId: string; date: string; durationSeconds: number }[];
  fasterSessions: { count: number; workoutIds: string[]; basis: string };
  consistency: { weeksWithRuns: number; totalWeeks: number; fraction: number | null };
  planAdherence: {
    plannedSessions: number;
    completedSessions: number;
    completionFraction: number | null;
    plannedMiles: number;
    actualMiles: number;
    scope: string;
  } | null;
  daysToTargetRace: number | null;
  limitations: string[];
}

function monday(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return shiftPerformanceDate(date, -((day + 6) % 7));
}

function calendarDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

function entryDate(plan: RunningPlan, entry: PlannedRunEntry): string {
  return shiftPerformanceDate(plan.startDate, entry.weekIndex * 7 + entry.weekday - 1);
}

interface DatedRun { workout: HealthWorkout; date: string }

/**
 * Completed parent summaries only. Canonical exclusions/overrides and plan
 * matching are reused; route, HR-stream and future planned efforts are unused.
 * The optional IANA zone keeps calendar arithmetic independent of the host.
 */
export function buildRaceTrainingContext(input: {
  workouts: readonly HealthWorkout[];
  overrides?: Record<string, WorkoutOverride> | null;
  plan?: RunningPlan | null;
  asOf: Date;
  targetRaceDate?: string | null;
  timeZone?: string;
}): RaceTrainingContext {
  if (!Number.isFinite(input.asOf.getTime())) throw new TypeError("Invalid training context as-of date");
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const asOfDate = performanceLocalDate(input.asOf.toISOString(), timeZone);
  const cutoff = input.asOf.getTime();
  const recentStart = shiftPerformanceDate(asOfDate, -27);
  const priorEnd = shiftPerformanceDate(recentStart, -1);
  const priorStart = shiftPerformanceDate(priorEnd, -27);
  const limitations = new Set<string>([
    "Training summaries describe completed recorded running; no mileage, consistency, or plan credit is converted into a race-time prediction.",
    "Loaded workout history may be incomplete. Totals and empty weeks describe available records, not verified complete training coverage.",
    "Four-week comparisons use trailing 28 local calendar days; the weekly chart uses Monday-start weeks and labels the current week partial.",
    `Long runs use a descriptive ${RACE_CONTEXT_LONG_RUN_MILES}-mile threshold, not a validated readiness cutoff.`,
  ]);

  // A later correction cannot be silently backdated for an as-of view. The
  // original pre-correction values are unavailable in these parent records.
  const available = input.workouts.filter((workout) => {
    const override = input.overrides?.[workout.workoutId];
    const syncedAt = workout.syncedAt?.getTime();
    const overrideAt = override ? Date.parse(override.updatedAt) : null;
    if ((syncedAt !== undefined && (!Number.isFinite(syncedAt) || syncedAt > cutoff))
      || (overrideAt !== null && (!Number.isFinite(overrideAt) || overrideAt > cutoff))) {
      limitations.add("Later or undated summary revisions were excluded from the as-of view; earlier versions cannot be reconstructed.");
      return false;
    }
    if (syncedAt === undefined) limitations.add("Some original summary availability times are unknown.");
    return true;
  });
  const effective = selectEffectiveWorkouts([...available], input.overrides);
  const byId = new Map<string, HealthWorkout[]>();
  for (const workout of effective) byId.set(workout.workoutId, [...(byId.get(workout.workoutId) ?? []), workout]);
  const contentKey = (w: HealthWorkout) => JSON.stringify([
    w.startDate?.getTime(), w.endDate?.getTime(), w.isRunLike, w.distanceMiles, w.durationSeconds,
  ]);
  const seenSummaries = new Set<string>();
  const runs: DatedRun[] = [];
  for (const id of [...byId.keys()].sort()) {
    const versions = byId.get(id)!;
    if (new Set(versions.map(contentKey)).size !== 1) {
      limitations.add("Conflicting summaries for one workout ID were excluded.");
      continue;
    }
    const workout = versions[0];
    if (!workout.isRunLike) continue;
    if (!Number.isFinite(workout.startDate?.getTime()) || !Number.isFinite(workout.endDate?.getTime())
      || workout.endDate <= workout.startDate || workout.endDate.getTime() > cutoff
      || !Number.isFinite(workout.durationSeconds) || workout.durationSeconds <= 0
      || !Number.isFinite(workout.distanceMiles) || workout.distanceMiles <= 0) continue;
    const signature = contentKey(workout);
    if (seenSummaries.has(signature)) {
      limitations.add("Exact repeated running summaries were counted once; owner exclusions remain authoritative for other duplicate activities.");
      continue;
    }
    seenSummaries.add(signature);
    runs.push({ workout, date: performanceLocalDate(workout.startDate.toISOString(), timeZone) });
  }
  runs.sort((a, b) => a.date.localeCompare(b.date) || a.workout.workoutId.localeCompare(b.workout.workoutId));
  const between = (start: string, end: string) => runs.filter((run) => run.date >= start && run.date <= end);
  function period(startDate: string, endDate: string): TrainingPeriodSummary {
    const selected = between(startDate, endDate);
    return {
      startDate, endDate,
      miles: selected.reduce((total, run) => total + run.workout.distanceMiles, 0),
      sessions: selected.length,
      durationSeconds: selected.reduce((total, run) => total + run.workout.durationSeconds, 0),
      runningDays: new Set(selected.map((run) => run.date)).size,
    };
  }
  const recent = between(recentStart, asOfDate);
  const prior = between(priorStart, priorEnd);
  const longest = (selected: DatedRun[]) => [...selected].sort((a, b) => b.workout.distanceMiles - a.workout.distanceMiles
    || b.date.localeCompare(a.date) || a.workout.workoutId.localeCompare(b.workout.workoutId))[0] ?? null;
  const currentMonday = monday(asOfDate);
  const weekly = Array.from({ length: 8 }, (_, index): RaceTrainingWeek => {
    const weekStart = shiftPerformanceDate(currentMonday, (index - 7) * 7);
    const sunday = shiftPerformanceDate(weekStart, 6);
    const endDate = sunday > asOfDate ? asOfDate : sunday;
    const selected = between(weekStart, endDate);
    return {
      ...period(weekStart, endDate), weekStart, partialWeek: weekStart === currentMonday,
      longestRunMiles: longest(selected)?.workout.distanceMiles ?? null,
      longRunCount: selected.filter((run) => run.workout.distanceMiles >= RACE_CONTEXT_LONG_RUN_MILES).length,
    };
  });
  const recentFourWeeks = period(recentStart, asOfDate);
  const priorFourWeeks = period(priorStart, priorEnd);
  const recentLongest = longest(recent);
  const recentLongRuns = recent.filter((run) => run.workout.distanceMiles >= RACE_CONTEXT_LONG_RUN_MILES);
  const priorLongRuns = prior.filter((run) => run.workout.distanceMiles >= RACE_CONTEXT_LONG_RUN_MILES);
  const recentLongestLongRun = longest(recentLongRuns);
  const priorLongestLongRun = longest(priorLongRuns);
  const completeWeeks = weekly.filter((week) => !week.partialWeek);
  const weeksWithRuns = completeWeeks.filter((week) => week.sessions > 0).length;

  let planAdherence: RaceTrainingContext["planAdherence"] = null;
  const fasterIds = new Set<string>();
  if (input.plan && input.plan.status !== "draft" && isPerformanceDate(input.plan.startDate)) {
    const plan = input.plan;
    // Exclude future entries before matching so a future exact-day entry can
    // never displace a completed due entry. Project the explicit zone's local
    // date into the matcher's host-local dates; the shared ±1-day rule stays.
    const elapsedPlan = { ...plan, weeks: plan.weeks.map((week) => ({ ...week,
      entries: week.entries.filter((entry) => entryDate(plan, entry) <= asOfDate && entry.workoutType !== "rest"),
    })) };
    const datedWorkouts = runs.map(({ workout, date }) => ({ ...workout, startDate: parseLocalDate(date) }));
    const matches = matchPlanToActual(elapsedPlan, datedWorkouts);
    const entries = elapsedPlan.weeks.flatMap((week) => week.entries)
      .filter((entry) => entry.runType !== "rest" && entry.workoutType !== "rest"
        && entryDate(plan, entry) >= recentStart);
    let completedSessions = 0;
    for (const entry of entries) {
      const match = matches.get(entry.id);
      if (match) completedSessions++;
      if (match?.quality === "full" && (entry.workoutType === "tempo" || entry.workoutType === "race")
        && performanceLocalDate(runs.find((run) => run.workout.workoutId === match.activity.workoutId)!.workout.startDate.toISOString(), timeZone) === entryDate(plan, entry)) {
        fasterIds.add(match.activity.workoutId);
      }
    }
    planAdherence = {
      plannedSessions: entries.length, completedSessions,
      completionFraction: entries.length > 0 ? completedSessions / entries.length : null,
      plannedMiles: entries.reduce((sum, entry) => sum + (Number.isFinite(entry.distanceMiles) ? entry.distanceMiles : 0), 0),
      actualMiles: recentFourWeeks.miles,
      scope: `${recentStart} through ${asOfDate}; due entries only, including today's partial day. Full and partial canonical matches count as completed. Actual miles include recorded extra runs.`,
    };
  }
  const workoutIds = [...fasterIds].sort();
  return {
    asOfDate, weekly, recentFourWeeks, priorFourWeeks,
    mileageChangePct: priorFourWeeks.miles > 0 ? (recentFourWeeks.miles / priorFourWeeks.miles - 1) * 100 : null,
    longestRecentRun: recentLongest ? { workoutId: recentLongest.workout.workoutId, date: recentLongest.date,
      miles: recentLongest.workout.distanceMiles, durationSeconds: recentLongest.workout.durationSeconds } : null,
    longRuns: {
      thresholdMiles: RACE_CONTEXT_LONG_RUN_MILES,
      recentCount: recentLongRuns.length,
      priorCount: priorLongRuns.length,
      recentLongestMiles: recentLongestLongRun?.workout.distanceMiles ?? null,
      priorLongestMiles: priorLongestLongRun?.workout.distanceMiles ?? null,
      progressionMiles: recentLongestLongRun && priorLongestLongRun ? recentLongestLongRun.workout.distanceMiles - priorLongestLongRun.workout.distanceMiles : null,
      byWeek: weekly.map((week) => ({ weekStart: week.weekStart, longestRunMiles: week.longestRunMiles, count: week.longRunCount })),
    },
    recentDurations: [...recent].reverse().map(({ workout, date }) => ({ workoutId: workout.workoutId, date, durationSeconds: workout.durationSeconds })),
    fasterSessions: { count: workoutIds.length, workoutIds,
      basis: "Full same-day completed matches to explicitly recorded tempo/race plan intent; pace or HR alone never establishes workout intent or maximal effort." },
    consistency: { weeksWithRuns, totalWeeks: completeWeeks.length,
      fraction: runs.length > 0 ? weeksWithRuns / completeWeeks.length : null },
    planAdherence,
    daysToTargetRace: input.targetRaceDate && isPerformanceDate(input.targetRaceDate) ? calendarDays(asOfDate, input.targetRaceDate) : null,
    limitations: [...limitations].sort(),
  };
}
