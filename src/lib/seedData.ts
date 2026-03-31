import { type RunningPlan, type PlannedRunEntry, type PlanRunType } from "@/types";

function entry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  runType: PlanRunType,
  paceTarget?: string,
  description?: string
): PlannedRunEntry {
  return {
    id: `seed-w${weekIndex}-d${weekday}`,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType,
    paceTarget,
    description,
  };
}

// 14-week half marathon training plan (mirrored from iOS SampleTrainingPlan.swift)
// startDate: 2026-01-19 (Monday), race day: 2026-04-25 (Saturday, week 14 day 6)
// weekday encoding: 1=Mon, 3=Wed, 5=Fri, 6=Sat

const SEED_WEEKS = [
  // Week 1: 1/19
  [
    entry(0, 1, 1.5,  "treadmill", "11:00"),
    entry(0, 3, 4.0,  "outdoor",   "10:20"),
    entry(0, 5, 1.5,  "otf"),
    entry(0, 6, 3.0,  "longRun",   "10:45"),
  ],
  // Week 2: 1/26
  [
    entry(1, 1, 2.0,  "treadmill", "10:50"),
    entry(1, 3, 3.0,  "outdoor",   "10:20"),
    entry(1, 5, 1.75, "otf"),
    entry(1, 6, 4.0,  "longRun",   "10:45"),
  ],
  // Week 3: 2/2
  [
    entry(2, 1, 2.1,  "treadmill", "11:00"),
    entry(2, 3, 4.0,  "outdoor",   undefined, "Tempo"),
    entry(2, 5, 1.75, "otf"),
    entry(2, 6, 5.0,  "longRun",   "10:40"),
  ],
  // Week 4: 2/9
  [
    entry(3, 1, 2.1,  "treadmill", "10:45"),
    entry(3, 3, 4.0,  "outdoor",   "10:15"),
    entry(3, 5, 1.75, "otf"),
    entry(3, 6, 6.0,  "longRun",   "10:40"),
  ],
  // Week 5: 2/16
  [
    entry(4, 1, 2.2,  "treadmill", "10:45"),
    entry(4, 3, 5.0,  "outdoor",   undefined, "Tempo"),
    entry(4, 5, 1.75, "otf"),
    entry(4, 6, 6.5,  "longRun",   "10:35"),
  ],
  // Week 6: 2/23
  [
    entry(5, 1, 2.2,  "treadmill", "11:00"),
    entry(5, 3, 5.0,  "outdoor",   "10:10"),
    entry(5, 5, 1.75, "otf"),
    entry(5, 6, 7.0,  "longRun",   "10:30"),
  ],
  // Week 7: 3/2
  [
    entry(6, 1, 2.3,  "treadmill", "10:45"),
    entry(6, 3, 5.0,  "outdoor",   undefined, "Tempo"),
    entry(6, 5, 1.75, "otf"),
    entry(6, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 8: 3/9
  [
    entry(7, 1, 2.3,  "treadmill", "11:00"),
    entry(7, 3, 5.5,  "outdoor",   "10:05"),
    entry(7, 5, 1.75, "otf"),
    entry(7, 6, 9.0,  "longRun",   "10:30"),
  ],
  // Week 9: 3/16
  [
    entry(8, 1, 2.2,  "treadmill", "11:00"),
    entry(8, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(8, 5, 1.8,  "otf"),
    entry(8, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 10: 3/23
  [
    entry(9, 1, 2.2,  "treadmill", "10:45"),
    entry(9, 3, 6.0,  "outdoor"),
    entry(9, 5, 0,    "rest"),
    entry(9, 6, 0,    "rest"),
  ],
  // Week 11: 3/30
  [
    entry(10, 1, 2.0,  "treadmill", "11:00"),
    entry(10, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(10, 5, 1.75, "otf"),
    entry(10, 6, 10.5, "longRun"),
  ],
  // Week 12: 4/6
  [
    entry(11, 1, 2.3,  "treadmill", "11:00"),
    entry(11, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(11, 5, 1.75, "otf"),
    entry(11, 6, 11.0, "longRun"),
  ],
  // Week 13: 4/13
  [
    entry(12, 1, 2.0,  "treadmill", "10:45"),
    entry(12, 3, 4.0,  "outdoor",   undefined, "Tempo"),
    entry(12, 5, 1.75, "otf"),
    entry(12, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 14: 4/20 (race week)
  [
    entry(13, 1, 1.8,  "treadmill", "11:00"),
    entry(13, 3, 2.0,  "outdoor",   undefined, "Tempo"),
    entry(13, 5, 0,    "rest"),
    entry(13, 6, 13.1, "outdoor",   undefined, "RACE — Half Marathon"),
  ],
];

export const DEFAULT_HALF_MARATHON_PLAN: Omit<RunningPlan, "id" | "createdAt" | "updatedAt"> = {
  name: "Half Marathon — Spring 2026",
  startDate: "2026-01-19",
  isActive: true,
  isBuiltInDefault: true,
  weeks: SEED_WEEKS.map((entries, i) => ({
    weekNumber: i + 1,
    entries,
  })),
};
