import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { addDays, makeRun } from "./hrEnhancedFixture";
import { researchRace } from "./workoutRaceResearchFixture";

/** Invented, deterministic athlete histories for the Phase 3Q–3T models. Never owner data. */
export const HYBRID_TZ = "America/New_York";
export const HYBRID_AS_OF = "2026-11-07T17:00:00.000Z";
export type HybridInput = { races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; asOf: string; timeZone: string };

export interface StrongEffort { id?: string; date: string; miles: number; pace: number; hr: number; tempF?: number | null; type?: string; route?: boolean }
export interface AthleteOptions {
  asOf?: string;
  start?: string;
  /** Last date (inclusive) with ordinary training. */
  trainingEnd?: string;
  raceDate?: string | null;
  raceSeconds?: number;
  confirmedRace?: boolean;
  strong?: StrongEffort[];
  runsPerWeek?: 2 | 3 | 4;
  easyMiles?: number;
  longRunMiles?: number;
  basePace?: number;
  baseHr?: number;
  /** pace multiplier applied to ordinary runs after `paceChangeFrom` (HR unchanged): <1 = faster at the same HR. */
  paceFactorAfter?: number;
  paceChangeFrom?: string;
  tempF?: number | null;
  /** After `from`, runs are done at `tempF` and slowed by exp(effectPerF·(tempF − 62)). */
  heat?: { from: string; tempF: number | null; effectPerF: number; /** True temperature when `tempF` (the recorded weather) is null/hidden. */ actualTempF?: number };
  /** Ordinary mileage multiplier after `volumeChangeFrom` (taper = 0.5). */
  volumeFactorAfter?: number;
  volumeChangeFrom?: string;
  overrides?: Record<string, WorkoutOverride>;
  extra?: HealthWorkout[];
}

const jitter = (i: number) => (((i * 7919) % 13) - 6) / 6;

export function hybridAthlete(o: AthleteOptions = {}): HybridInput & { raceWorkoutId: string | null } {
  const start = o.start ?? "2026-01-05", asOf = o.asOf ?? HYBRID_AS_OF;
  const asOfDate = asOf.slice(0, 10);
  const end = o.trainingEnd ?? addDays(asOfDate, -1);
  const per = o.runsPerWeek ?? 3, offsets = per === 2 ? [1, 5] : per === 3 ? [1, 3, 5] : [0, 2, 4, 5];
  const workouts: HealthWorkout[] = [];
  let i = 0;
  for (let week = 0; ; week++) {
    const monday = addDays(start, week * 7);
    if (monday > end) break;
    for (const off of offsets) {
      const date = addDays(monday, off);
      if (date > end) continue;
      const isLong = off === 5 && (o.longRunMiles ?? 0) > 0;
      const volumeChanged = o.volumeChangeFrom !== undefined && date >= o.volumeChangeFrom;
      const miles = (isLong ? o.longRunMiles! : (o.easyMiles ?? 4.5) + (jitter(i + 3) > 0.5 ? 0.5 : 0)) * (volumeChanged ? o.volumeFactorAfter ?? 1 : 1);
      const changed = o.paceChangeFrom !== undefined && date >= o.paceChangeFrom;
      const hot = o.heat !== undefined && date >= o.heat.from;
      const temp = hot ? o.heat!.tempF : o.tempF === undefined ? 62 : o.tempF;
      const pace = (o.basePace ?? 620) * (isLong ? 1.03 : 1) * (changed ? o.paceFactorAfter ?? 1 : 1) * (1 + 0.012 * jitter(i))
        * (hot ? Math.exp(o.heat!.effectPerF * ((o.heat!.actualTempF ?? o.heat!.tempF ?? 62) - 62)) : 1);
      const hr = (o.baseHr ?? 146) + Math.round(4 * jitter(i + 5));
      workouts.push(makeRun({ id: `ord-${i}`, date, pace, hr, minutes: miles * pace / 60, tempF: temp, climbPerMile: 8 + (i % 5) }));
      i++;
    }
  }
  const races: Race[] = [];
  let raceWorkoutId: string | null = null;
  if (o.raceDate !== null) {
    const r = researchRace("hm", o.raceDate ?? "2026-09-20", o.raceSeconds ?? 7870.75, o.confirmedRace ?? false);
    r.workout.avgHeartRate = 168; r.workout.hasRoute = true;
    workouts.push(r.workout); races.push(r.race); raceWorkoutId = r.workout.workoutId;
  }
  for (const s of o.strong ?? []) {
    workouts.push(makeRun({ id: s.id ?? `strong-${s.date}`, date: s.date, pace: s.pace, hr: s.hr, minutes: s.miles * s.pace / 60,
      tempF: s.tempF === undefined ? 55 : s.tempF, climbPerMile: 8, type: s.type, route: s.route }));
  }
  return { races, workouts: [...workouts, ...(o.extra ?? [])], overrides: o.overrides ?? {}, asOf, timeZone: HYBRID_TZ, raceWorkoutId };
}

export { addDays, makeRun };
