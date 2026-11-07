import type { HealthWorkout } from "@/types/healthWorkout";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";
import { hybridAthlete, makeRun, type AthleteOptions, type HybridInput } from "./hybridFixture";
import { addDays } from "./hrEnhancedFixture";

/** Invented, deterministic histories for hybrid v1.1 (never owner data). Adds GPS best-effort segments to the Phase 3Q fixture. */
const KEYS = { "5k": 5000, "10k": 10000, "10mi": 16093.44 } as const;
type Key = keyof typeof KEYS;
const MILE = 1609.344;
const jitter = (i: number) => (((i * 7919) % 13) - 6) / 6;

export interface SegmentRunSpec {
  id?: string; date: string; hostMiles: number; hostPace: number; hr: number;
  /** Pace (s/mi) of the best segment of `key` inside the run. */
  key: Key; segPace: number; type?: string; tempF?: number | null;
}

/** A run whose fastest `key` segment is `segPace`; shorter segments are slightly faster than the host pace so the envelope is realistic. */
export function bestEffortsOf(host: HealthWorkout, hostPace: number, key: Key, segPace: number): HealthWorkout["bestEfforts"] {
  const be: Record<string, unknown> = { "1mi": null, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION };
  for (const k of Object.keys(KEYS) as Key[]) {
    if (KEYS[k] > host.distanceMiles * MILE) continue;
    be[k] = KEYS[k] <= KEYS[key] ? (KEYS[k] === KEYS[key] ? segPace : Math.min(hostPace, segPace * 1.02)) * (KEYS[k] / MILE) : hostPace * (KEYS[k] / MILE);
  }
  return be as unknown as HealthWorkout["bestEfforts"];
}

export interface AthleteV11Options extends AthleteOptions {
  segments?: SegmentRunSpec[];
  /** Give ordinary runs a realistic best-effort envelope (default true): needed for the athlete's own segment reference. */
  envelope?: boolean;
}

export function athleteV11(o: AthleteV11Options = {}): HybridInput & { raceWorkoutId: string | null } {
  const a = hybridAthlete({ longRunMiles: 8, ...o });
  const envelope = o.envelope ?? true;
  const workouts = a.workouts.map((w, i) => {
    if (!envelope || !w.workoutId.startsWith("ord-")) return w;
    const pace = w.avgPaceSecPerMile ?? w.durationSeconds / w.distanceMiles;
    const be = { "1mi": null, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION } as Record<string, unknown>;
    for (const k of Object.keys(KEYS) as Key[]) if (KEYS[k] <= w.distanceMiles * MILE) be[k] = pace * (0.985 + 0.01 * jitter(i + 2)) * (KEYS[k] / MILE);
    return { ...w, bestEfforts: be as unknown as HealthWorkout["bestEfforts"] };
  });
  for (const s of o.segments ?? []) {
    const host = makeRun({ id: s.id ?? `seg-${s.date}`, date: s.date, pace: s.hostPace, hr: s.hr, minutes: s.hostMiles * s.hostPace / 60,
      tempF: s.tempF === undefined ? 55 : s.tempF, climbPerMile: 8, type: s.type });
    workouts.push({ ...host, bestEfforts: bestEffortsOf(host, s.hostPace, s.key, s.segPace) });
  }
  return { ...a, workouts };
}

export { addDays, hybridAthlete, makeRun };

import type { Race, RaceDistance } from "@/types/race";
import { researchRace } from "./workoutRaceResearchFixture";

/** A race of any supported distance (the Phase 3Q fixture only builds half marathons). Same record shape and integrity fields. */
export function distanceRace(id: string, date: string, meters: number, seconds: number, confirmed: boolean, raceDistance: RaceDistance): { race: Race; workout: HealthWorkout } {
  const r = researchRace(id, date, seconds, confirmed);
  const miles = meters / MILE;
  r.workout.distanceMiles = miles; r.workout.distanceMeters = meters; r.workout.durationSeconds = seconds; r.workout.avgPaceSecPerMile = seconds / miles;
  r.workout.endDate = new Date(r.workout.startDate.getTime() + seconds * 1000); r.workout.syncedAt = new Date(r.workout.endDate.getTime() + 1000);
  r.workout.avgHeartRate = 172; r.workout.hasRoute = true;
  r.race.raceDistance = raceDistance; r.race.createdAt = new Date(r.workout.endDate.getTime() + 2000).toISOString();
  if (r.race.performanceEvidence) r.race.performanceEvidence = { ...r.race.performanceEvidence, distanceMeters: meters, finishSeconds: seconds, knownAt: new Date(r.workout.endDate.getTime() + 3000).toISOString() };
  return r;
}
