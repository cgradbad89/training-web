import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";
import {
  matchPlanToActual,
  statusForRunEntry,
  type RunEntryStatus,
} from "@/utils/planMatching";
import type { HealthWorkout } from "@/types/healthWorkout";

export interface CalendarEvent {
  date: Date;
  /** Id of the source plan entry — used to look the entry/match back up on click. */
  entryId: string;
  planId: string;
  planName: string;
  planType: "running" | "workout";
  weekIndex: number;
  dayIndex: number;   // 0-6, Mon=0, Sun=6
  weekday: number;    // 1-7, Mon=1, Sun=7 (used for /workout route navigation)
  /**
   * Index of this event within the same-weekday group of its plan. 0 for
   * single-session days; 0/1/2/... when multiple sessions share the day.
   * Used to disambiguate the /workout/{planId}/{weekIndex}/{weekday}/{N}
   * route when more than one session lives on the same calendar day.
   */
  sessionIndex: number;
  label: string;
  distanceMiles?: number;
  category?: WorkoutCategory;
  /** @deprecated Kept for backward compat (true on ANY match, any quality).
   *  Running events should prefer `status`; workout events have no `status`
   *  (their completion isn't mileage-matched) and still rely on this field. */
  completed: boolean;
  isRestDay: boolean;
  /**
   * Four-state completion status, present ONLY for running events (mirrors
   * `statusForRunEntry`). Workout events have no mileage-based match concept
   * (completion is the entry's own stored `completed` boolean) and leave
   * this undefined.
   */
  status?: RunEntryStatus;
  /** The matched actual run for a running event, if any (undefined for workout events). */
  activity?: HealthWorkout | null;
}

const RUN_TYPE_LABELS: Record<string, string> = {
  outdoor:   "Outdoor",
  treadmill: "Treadmill",
  otf:       "OTF",
  longRun:   "Long Run",
};

function sessionDate(startDate: string, weekIndex: number, dayIndex: number): Date {
  const [year, month, day] = startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const d = new Date(start);
  d.setDate(start.getDate() + weekIndex * 7 + dayIndex);
  return d;
}

export function buildCalendarEvents(
  plans: (RunningPlan | WorkoutPlan)[],
  actualRuns: HealthWorkout[] = []
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const plan of plans) {
    if (plan.status !== "active") continue;

    if (plan.planType === "workout") {
      // Track per-weekday counters so each emitted event gets a stable
      // sessionIndex matching its position in the same-weekday group.
      const counters = new Map<string, number>();
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.type === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          events.push({
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id,
            planId: plan.id,
            planName: plan.name,
            planType: "workout",
            weekIndex: entry.weekIndex,
            dayIndex,
            weekday: entry.weekday,
            sessionIndex,
            label: entry.label ?? "Workout",
            category: entry.category,
            completed: entry.completed ?? false,
            isRestDay: false,
          });
        }
      }
    } else {
      const matchMap = matchPlanToActual(plan, actualRuns);
      const counters = new Map<string, number>();
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.runType === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          const label =
            entry.description ??
            (entry.runType ? (RUN_TYPE_LABELS[entry.runType] ?? entry.runType) : "Run");
          const match = matchMap.get(entry.id) ?? null;
          events.push({
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id,
            planId: plan.id,
            planName: plan.name,
            planType: "running",
            weekIndex: entry.weekIndex,
            dayIndex,
            weekday: entry.weekday,
            sessionIndex,
            label,
            distanceMiles: entry.distanceMiles,
            completed: match != null,
            isRestDay: false,
            status: statusForRunEntry(plan, entry, matchMap),
            activity: match?.activity ?? null,
          });
        }
      }
    }
  }

  return events;
}
