import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";
import { matchPlanToActual } from "@/utils/planMatching";
import type { HealthWorkout } from "@/types/healthWorkout";

export interface CalendarEvent {
  date: Date;
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
  completed: boolean;
  isRestDay: boolean;
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
    if (!plan.isActive) continue;

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
          events.push({
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            planId: plan.id,
            planName: plan.name,
            planType: "running",
            weekIndex: entry.weekIndex,
            dayIndex,
            weekday: entry.weekday,
            sessionIndex,
            label,
            distanceMiles: entry.distanceMiles,
            completed: matchMap.get(entry.id) != null,
            isRestDay: false,
          });
        }
      }
    }
  }

  return events;
}
