import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RacePerformanceInput } from "@/types/racePerformance";
import { shiftPerformanceDate } from "../../performanceEvidence";
import { researchRun } from "./workoutRaceResearchFixture";
import { currentFixture } from "./currentPerformanceFixture";

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;

/** Invented history only. Keeps the shared fixture's race anchor and 8-week baseline. */
export const ANCHOR_RUN_ID = "provisional-half-run";
export const FIXTURE_AS_OF = "2026-10-26T16:00:00.000Z";

export function summaryRun(id: string, date: string, miles: number): HealthWorkout {
  const w = researchRun(id, date, 620, { distanceMiles: miles, durationSeconds: miles * 620,
    avgHeartRate: null, routeClusterId: undefined, weather: null });
  w.endDate = new Date(w.startDate.getTime() + w.durationSeconds * 1000);
  w.syncedAt = new Date(w.endDate.getTime() + 1000);
  return w;
}

/** Replace the shared fixture's current period with `[weekIndex, dayOffset, miles]` runs (`cur-W-D`). */
export function fixtureWithCurrentRuns(spec: [number, number, number][], asOf = FIXTURE_AS_OF): Input {
  const base = currentFixture();
  const current = spec.map(([week, day, miles]) => summaryRun(`cur-${week}-${day}`, shiftPerformanceDate("2026-08-31", week * 7 + day), miles));
  return { ...base, asOf, workouts: [...base.workouts.filter(w => !w.workoutId.startsWith("current-")), ...current] };
}

const sessions = (plan: [number, number][], miles: number): [number, number, number][] =>
  plan.flatMap(([week, n]) => Array.from({ length: n }, (_, day): [number, number, number] => [week, day, miles]));

/** Nine stronger current sessions: more mileage than the baseline ⇒ including a run supports a FASTER estimate. */
export const improvingNine = () => fixtureWithCurrentRuns(sessions([[2, 3], [3, 2], [4, 2], [5, 2]], 10));
/** Exactly six current sessions over four weeks: removing any one run withholds the summary adjustment. */
export const thresholdSix = () => fixtureWithCurrentRuns([[2, 0, 10], [2, 1, 10], [3, 0, 10], [3, 1, 10], [4, 0, 10], [5, 0, 10]]);
/** Exactly three recent runs over two weeks: the minimum for any current estimate. */
export const minimumThree = () => fixtureWithCurrentRuns([[5, 0, 5], [5, 1, 5], [6, 0, 5]]);
/** Sparse low-frequency fixture whose sub-second positive delta exercises fractional-second display. */
export function subsecondSlower(): Input {
  const f = currentFixture(1.5, 4, 9);
  const keep = (id: string) => !id.startsWith("current-") || (Number(id.split("-")[1]) >= 1 && Number(id.split("-")[1]) <= 5 && Number(id.split("-")[2]) < 2);
  return { ...f, workouts: f.workouts.filter(w => keep(w.workoutId)) };
}

export const exclusionOverride = (workoutId: string): Record<string, WorkoutOverride> => ({ [workoutId]: {
  workoutId, userId: "owner", isExcluded: true, excludedAt: "2026-10-20T00:00:00Z", excludedReason: null,
  distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "2026-10-20T00:00:00Z" } });
export const fieldOverride = (workoutId: string, fields: Partial<WorkoutOverride>): Record<string, WorkoutOverride> => ({ [workoutId]: {
  workoutId, userId: "owner", isExcluded: false, excludedAt: null, excludedReason: null,
  distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "2026-10-20T00:00:00Z", ...fields } });
