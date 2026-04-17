import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";

export interface CalendarEvent {
  date: Date;
  planId: string;
  planName: string;
  planType: "running" | "workout";
  weekIndex: number;
  dayIndex: number;   // 0-6, Mon=0, Sun=6
  weekday: number;    // 1-7, Mon=1, Sun=7 (used for /workout route navigation)
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
  plans: (RunningPlan | WorkoutPlan)[]
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const plan of plans) {
    if (!plan.isActive) continue;

    if (plan.planType === "workout") {
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.type === "rest") continue;
          const dayIndex = entry.weekday - 1;
          events.push({
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            planId: plan.id,
            planName: plan.name,
            planType: "workout",
            weekIndex: entry.weekIndex,
            dayIndex,
            weekday: entry.weekday,
            label: entry.label ?? "Workout",
            category: entry.category,
            completed: entry.completed ?? false,
            isRestDay: false,
          });
        }
      }
    } else {
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.runType === "rest") continue;
          const dayIndex = entry.weekday - 1;
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
            label,
            distanceMiles: entry.distanceMiles,
            completed: false,
            isRestDay: false,
          });
        }
      }
    }
  }

  return events;
}
