import type { RacePerformanceInput } from "@/types/racePerformance";
import { shiftPerformanceDate } from "../../performanceEvidence";
import { researchRace, researchRun } from "./workoutRaceResearchFixture";
type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;

/** Invented history; never represents owner observations. */
export function currentFixture(scale = 1, frequency = 3, longMiles = 6): Input {
  const anchor = researchRace("provisional-half", "2026-08-30", 7871);
  const workouts = [anchor.workout];
  const run = (id: string, date: string, miles: number) => {
    const w = researchRun(id, date, 620, { distanceMiles: miles, durationSeconds: miles * 620,
      avgHeartRate: null, routeClusterId: undefined, weather: null });
    w.endDate = new Date(w.startDate.getTime() + w.durationSeconds * 1000);
    w.syncedAt = new Date(w.endDate.getTime() + 1000);
    return w;
  };
  // Stable baseline, eight weeks ending before taper. Current period is distinct.
  for (let week = 0; week < 8; week++) for (let day = 0; day < 3; day++) {
    workouts.push(run(`base-${week}-${day}`, shiftPerformanceDate("2026-07-01", week * 7 + day * 2), day === 2 ? 6 : 4));
  }
  for (let week = 0; week < 8; week++) for (let day = 0; day < frequency; day++) {
    workouts.push(run(`current-${week}-${day}`, shiftPerformanceDate("2026-08-31", week * 7 + day), day === frequency - 1 ? longMiles : 4 * scale));
  }
  return { workouts, races: [anchor.race], overrides: {}, asOf: "2026-10-26T16:00:00.000Z", timeZone: "America/New_York" };
}
