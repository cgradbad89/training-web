/**
 * Training week for the Hub tile (pure — no Firebase, no React, no I/O).
 *
 * This only COMPOSES the shared weekly logic the Dashboard also uses:
 *   effective workouts   selectEffectiveWorkouts          (utils/selectActiveWorkouts)
 *   runs / non-runs      selectWeekRuns / selectWeekNonRuns, sumRunMiles (utils/weekActivitySummary)
 *   planned totals       plannedRunningWeek, workoutPlanSessions (utils/plannedWeekTotals)
 *   active plans         selectActiveRunningPlan / selectActiveWorkoutPlan (utils/activePlans)
 *   planned day labels   plannedSessionsForPlan           (utils/plannedSessions)
 *   non-run label        resolveActivityTitle             (utils/resolveActivityTitle)
 * Nothing about "what counts" is re-derived here.
 *
 * Calendar: pass `timeZone` (the endpoint passes America/New_York) to pin the
 * week and day buckets to that zone. Omit it to get the HOST-LOCAL calendar the
 * Dashboard uses — the parity test relies on that default.
 *
 * `totals.workouts` counts effective non-run RECORDS in the week. The
 * dashboard's "Actual workouts" card counts completed PLAN SESSIONS instead
 * (see `workoutPlanSessions().sessionsCompleted`); that number is deliberately
 * not what this field reports.
 */

import type { Plan } from "@/types/plan";
import type { WorkoutOverride, OverridableWorkout } from "@/types/workoutOverride";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { HubRace, TrainingData } from "@/lib/hub-contract";
import type { Race } from "@/types/race";
import { RACE_DISTANCE_LABELS } from "@/types/race";
import { daysBetweenKeys, formatWeekLabel, todayInZone, zonedWeekFor } from "@/lib/hubWeek";
import { parseLocalDate, toLocalIsoDate, weekEnd, weekStart } from "@/utils/dates";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";
import { groupByDay, summarizeWeekActivity } from "@/utils/weekActivitySummary";
import { plannedRunningWeek, workoutPlanSessions } from "@/utils/plannedWeekTotals";
import { selectActiveRunningPlan, selectActiveWorkoutPlan } from "@/utils/activePlans";
import { plannedSessionsForPlan } from "@/utils/plannedSessions";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { manualWorkoutFields, workoutModelSummary } from "@/utils/workoutModelSummary";

/** The slice of a workout this module reads (a HealthWorkout satisfies it). */
export type HubWorkout = OverridableWorkout &
  Pick<HealthWorkout, "isRunLike" | "startDate"> & { customTitle?: string };

/** Raw `healthWorkouts` document → HubWorkout (no Firebase client import). */
export function toHubWorkout(id: string, data: Record<string, unknown>): HubWorkout {
  return {
    ...workoutModelSummary(id, data),
    customTitle: manualWorkoutFields(data).customTitle,
  };
}

export interface TrainingWeekInput {
  plans: Plan[];
  /** Raw workouts for the week (exclusions/overrides are applied here). */
  workouts: HubWorkout[];
  overrides: Record<string, WorkoutOverride> | null | undefined;
  /** The user's races (`halfMarathonRaces`); omit or [] when none. */
  races?: Race[];
  now: Date;
  /** IANA zone for the week and day buckets; omit for HOST-LOCAL (dashboard default). */
  timeZone?: string;
}

export interface TrainingWeek {
  periodLabel: string;
  data: TrainingData;
}

interface ResolvedWeek {
  weekStartKey: string;
  dayKeys: string[];
  startInstant: Date;
  endInclusiveInstant: Date;
}

function resolveWeek(now: Date, timeZone: string | undefined): ResolvedWeek {
  if (timeZone) {
    const week = zonedWeekFor(now, timeZone);
    return {
      weekStartKey: week.weekStartKey,
      dayKeys: week.dayKeys,
      startInstant: week.startInstant,
      endInclusiveInstant: week.endInclusiveInstant,
    };
  }
  // Host-local: exactly the dashboard's weekStart/weekEnd and WeekCalendar's seven days.
  const start = weekStart(now);
  const dayKeys = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    return toLocalIsoDate(day);
  });
  return {
    weekStartKey: dayKeys[0],
    dayKeys,
    startInstant: start,
    endInclusiveInstant: weekEnd(now),
  };
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function raceDistanceLabel(race: Race): string {
  if (race.raceDistance === "custom") {
    const miles = race.customDistanceMiles;
    return typeof miles === "number" && Number.isFinite(miles) && miles > 0
      ? `${Number(miles.toFixed(2))} mi`
      : RACE_DISTANCE_LABELS.custom;
  }
  return RACE_DISTANCE_LABELS[race.raceDistance] ?? String(race.raceDistance);
}

/**
 * The race being trained for, as of `todayKey`: the goal race (`isActive`)
 * when its date is today or later, else the soonest upcoming race (ties by
 * name), else null. Same "upcoming" rule as `daysUntil(raceDate) >= 0` on the
 * Races / Coach pages, with the day count taken on civil dates.
 */
export function selectHubRace(races: Race[] | undefined, todayKey: string): HubRace | null {
  const upcoming = (races ?? [])
    .filter((r) => typeof r.raceDate === "string" && DATE_KEY.test(r.raceDate))
    .map((r) => ({ race: r, days: daysBetweenKeys(todayKey, r.raceDate) }))
    .filter((r) => r.days >= 0)
    .sort((a, b) => a.days - b.days || (a.race.name ?? "").localeCompare(b.race.name ?? ""));
  const chosen = upcoming.find((r) => r.race.isActive === true) ?? upcoming[0];
  if (!chosen) return null;
  return {
    name: typeof chosen.race.name === "string" && chosen.race.name.trim() ? chosen.race.name : "Race",
    date: chosen.race.raceDate,
    distance: raceDistanceLabel(chosen.race),
    daysRemaining: chosen.days,
  };
}

export function deriveTrainingWeek(input: TrainingWeekInput): TrainingWeek {
  const { plans, workouts, overrides, races, now, timeZone } = input;
  const week = resolveWeek(now, timeZone);

  const effective = selectEffectiveWorkouts(workouts, overrides);
  const { runs, nonRuns, runMiles } = summarizeWeekActivity(
    effective,
    week.startInstant,
    week.endInclusiveInstant
  );
  const byDay = groupByDay([...runs, ...nonRuns], { timeZone });

  // Plan-week math uses the Monday's civil date only (host-timezone independent).
  const monday = parseLocalDate(week.weekStartKey);
  const runningPlan = selectActiveRunningPlan(plans);
  const workoutPlan = selectActiveWorkoutPlan(plans);
  const plannedRuns = plannedRunningWeek(runningPlan, monday);
  const { sessionsPlanned } = workoutPlanSessions(workoutPlan, monday);

  const plannedByDay = new Map<string, string[]>();
  const targetMilesByDay = new Map<string, number>();
  const addPlanned = (date: Date, text: string) => {
    const key = toLocalIsoDate(date);
    const list = plannedByDay.get(key);
    if (list) list.push(text);
    else plannedByDay.set(key, [text]);
  };
  if (runningPlan) {
    for (const s of plannedSessionsForPlan(runningPlan)) {
      const key = toLocalIsoDate(s.date);
      const miles = Number.isFinite(s.distanceMiles) && s.distanceMiles > 0 ? s.distanceMiles : 0;
      targetMilesByDay.set(key, (targetMilesByDay.get(key) ?? 0) + miles);
      addPlanned(
        s.date,
        s.distanceMiles > 0 ? `${s.distanceMiles.toFixed(1)} mi ${s.label}` : s.label
      );
    }
  }
  if (workoutPlan) {
    for (const s of plannedSessionsForPlan(workoutPlan)) addPlanned(s.date, s.label);
  }

  const days = week.dayKeys.map((date) => {
    const planned = plannedByDay.get(date);
    const targetMiles = targetMilesByDay.get(date) ?? 0;
    const completed = (byDay.get(date) ?? []).map((w) =>
      w.isRunLike
        ? { type: "run", miles: w.distanceMiles }
        : {
            type: resolveActivityTitle({
              customTitle: w.customTitle,
              activityType: w.displayType,
              rawActivityType: w.activityType,
              distanceMiles: w.distanceMiles,
            }),
          }
    );
    return planned && planned.length > 0
      ? { date, planned: planned.join(" · "), targetMiles, completed }
      : { date, targetMiles, completed };
  }) as TrainingData["days"];

  return {
    periodLabel: formatWeekLabel(week.weekStartKey),
    data: {
      days,
      totals: { runs: runs.length, miles: runMiles, workouts: nonRuns.length },
      planned: {
        runs: plannedRuns.runs,
        miles: plannedRuns.miles,
        workouts: sessionsPlanned,
      },
      race: selectHubRace(races, timeZone ? todayInZone(now, timeZone) : toLocalIsoDate(now)),
    },
  };
}
