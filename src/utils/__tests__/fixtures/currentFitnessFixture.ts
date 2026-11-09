import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import { treatConfirmedRacesAsMaximal } from "@/utils/performance/confirmedRaceAssumption";
import { confirmedRaceFixture } from "./raceConfirmationFixture";
import { cadenceRuns, halfRace, strongEffort } from "./policyStudyFixture";
import { addDays, makeRun } from "./hrEnhancedFixture";

/**
 * Reproducible, INVENTED worlds for the four-distance current-fitness estimator. Race results mirror the owner's two confirmed half
 * marathons (April 2026 PNC Alexandria 2:15:30 ≈ 80 % perceived effort; 2026-09-20 DC Half 2:11:11 ≈ 90 %) but every run, heart rate and
 * date of ordinary training is synthetic: no owner data is committed. Confirmations use the real versioned `confirmationHistory` schema and
 * carry the attested effort `nonmaximal` (80 %) / `hard` (90 %); the shared adapter re-reads them as maximal for PREDICTION only.
 */
export const FIT_TZ = "America/New_York";
export const APRIL_SECONDS = 8130;     // 2:15:30
export const SEPTEMBER_SECONDS = 7871; // 2:11:11
export const OWNER_AS_OF = "2026-11-10";

type Effort = "maximal" | "hard" | "nonmaximal" | "unknown";
export interface RaceSpec { id: string; date: string; seconds: number; effort: Effort }
export type RaceWorld = { race: Race; workout: HealthWorkout };

export function confirmedHalf(s: RaceSpec): RaceWorld {
  const f = confirmedRaceFixture({ id: s.id, date: s.date, seconds: s.seconds });
  f.revision.details.effort = s.effort;
  f.workout.avgHeartRate = 168; f.workout.hasRoute = true;
  return { race: f.race, workout: f.workout };
}
export const APRIL_RACE = (): RaceWorld => confirmedHalf({ id: "april", date: "2026-04-26", seconds: APRIL_SECONDS, effort: "nonmaximal" });
export const SEPTEMBER_RACE = (): RaceWorld => confirmedHalf({ id: "september", date: "2026-09-20", seconds: SEPTEMBER_SECONDS, effort: "hard" });

export interface WorldOptions {
  asOfDate: string;
  races?: RaceWorld[];
  /** Ordinary training cadence (days between runs, cycled) and lengths (miles, cycled). */
  gaps?: number[]; miles?: number[]; start?: string;
  basePace?: number; baseHr?: number; trendPer28d?: number;
  extra?: HealthWorkout[];
  /** Apply the shared owner-approved adapter exactly as the app does (default true). */
  adapted?: boolean;
}
export function fitnessWorld(o: WorldOptions) {
  const races = (o.races ?? []).map(r => r.race);
  const workouts = [
    ...cadenceRuns({ start: o.start ?? "2025-08-04", end: addDays(o.asOfDate, -1), gaps: o.gaps ?? [2, 2, 3], miles: o.miles ?? [5, 6, 5, 8],
      basePace: o.basePace, baseHr: o.baseHr, trendPer28d: o.trendPer28d }),
    ...(o.races ?? []).map(r => r.workout), ...(o.extra ?? [])];
  return { races: o.adapted === false ? races : treatConfirmedRacesAsMaximal(races), workouts, overrides: {}, timeZone: FIT_TZ, asOf: `${o.asOfDate}T17:00:00.000Z` };
}
/** September race plus two strong whole-run efforts (5 mi at a hard heart rate) in different weeks: newer, corroborating evidence. */
export function strongEffortWorld(asOfDate = "2026-11-10", pace = 560) {
  return fitnessWorld({ asOfDate, races: [SEPTEMBER_RACE()], extra: [strongEffort("s1", addDays(asOfDate, -14), pace), strongEffort("s2", addDays(asOfDate, -30), pace + 5)] });
}
export { addDays, makeRun, cadenceRuns, halfRace, strongEffort };
