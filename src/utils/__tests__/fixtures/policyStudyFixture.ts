import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import { addDays, makeRun } from "./hrEnhancedFixture";
import { researchRace } from "./workoutRaceResearchFixture";

/** Invented, deterministic histories for the "keep Hybrid v1.2 simple" policy study. Never owner data. */
export const POLICY_TZ = "America/New_York";
const jitter = (i: number) => (((i * 7919) % 13) - 6) / 6;
/** Seeded, roughly bell-shaped noise in [-1, 1] (mulberry32; sum of three uniforms) for Monte-Carlo replicates. */
function seededNoise(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => ((u() + u() + u()) / 3 - 0.5) * 2;
}

export interface CadenceSpec {
  start: string; end: string;
  /** Days between consecutive runs, cycled (e.g. [5, 6] ≈ 1.3 runs/week). */
  gaps: number[];
  /** Run lengths in miles, cycled. */
  miles?: number[];
  basePace?: number; baseHr?: number;
  /** Fractional change of pace at constant heart rate per 28 days (negative = getting faster), applied from `start`. */
  trendPer28d?: number;
  /** Noise amplitude of pace (fraction). */
  noise?: number;
  /** When set, pace noise is seeded random instead of the fixed deterministic jitter (Monte-Carlo replicates). */
  seed?: number;
  /** Multiply run length by `factor` for runs on/after `from` (taper / reduction scenarios). Later entries win. */
  volume?: { from: string; factor: number }[];
  tempF?: number | null;
  idPrefix?: string;
}

/** Ordinary easy/steady outdoor runs with a controllable cadence and an optional steady pace trend at constant heart rate. */
export function cadenceRuns(s: CadenceSpec): HealthWorkout[] {
  const out: HealthWorkout[] = [];
  const miles = s.miles ?? [4, 5, 6, 4, 8];
  const rnd = s.seed === undefined ? null : seededNoise(s.seed);
  let date = s.start, i = 0;
  while (date <= s.end) {
    const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${s.start}T00:00:00Z`)) / 86_400_000;
    const factor = (s.volume ?? []).filter(v => date >= v.from).at(-1)?.factor ?? 1;
    const m = miles[i % miles.length] * factor;
    const pace = (s.basePace ?? 620) * Math.exp((s.trendPer28d ?? 0) * days / 28) * (1 + (s.noise ?? 0.012) * (rnd ? rnd() : jitter(i)));
    const hr = (s.baseHr ?? 146) + Math.round(4 * jitter(i + 5));
    out.push(makeRun({ id: `${s.idPrefix ?? "cad"}-${i}`, date, pace, hr, minutes: Math.max(21, m * pace / 60), tempF: s.tempF === undefined ? 62 : s.tempF, climbPerMile: 8 + (i % 5) }));
    date = addDays(date, s.gaps[i % s.gaps.length]);
    i++;
  }
  return out;
}

export type EffortAttestation = "maximal" | "nonmaximal" | "unknown" | "none";

/** A half-marathon race with a linked workout. `attest: "none"` leaves it as a recorded, unconfirmed race (the shape of an un-entered result). */
export function halfRace(id: string, date: string, seconds: number, attest: EffortAttestation): { race: Race; workout: HealthWorkout } {
  const r = researchRace(id, date, seconds, false);
  r.workout.avgHeartRate = 168; r.workout.hasRoute = true;
  if (attest !== "none") {
    r.race.performanceEvidence = { status: "owner_confirmed", kind: "official_race", knownAt: new Date(r.workout.endDate.getTime() + 3000).toISOString(), raceDate: date,
      distanceMeters: 21097.5, finishSeconds: seconds, effort: attest, conditions: "Synthetic controlled context", source: "Synthetic fixture only" };
  }
  return { race: r.race, workout: r.workout };
}

/** A strong whole-run effort (5 mi at a hard heart rate), the shape the shipped qualifier accepts. */
export function strongEffort(id: string, date: string, pace: number): HealthWorkout {
  return makeRun({ id, date, pace, hr: 172, minutes: 5 * pace / 60, tempF: 55, climbPerMile: 8 });
}
