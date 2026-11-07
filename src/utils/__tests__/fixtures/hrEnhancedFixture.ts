import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { researchRace, researchRun } from "./workoutRaceResearchFixture";

/** Synthetic, deterministic scenarios for the HR effort signal. No private data. */
export const HR_FIXTURE_ANCHOR_DATE = "2026-08-30";
export const HR_FIXTURE_AS_OF = "2026-10-12T16:00:00.000Z";
export const HR_FIXTURE_TZ = "America/New_York";

export interface RunSpec {
  id: string; date: string; pace: number; hr: number | null; minutes?: number;
  tempF?: number | null; climbPerMile?: number | null; type?: string; route?: boolean;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

export function makeRun(s: RunSpec): HealthWorkout {
  const minutes = s.minutes ?? 40, durationSeconds = minutes * 60, distanceMiles = durationSeconds / s.pace;
  const startDate = new Date(s.date + "T12:00:00Z"), endDate = new Date(startDate.getTime() + durationSeconds * 1000);
  const base = researchRun(s.id, s.date, s.pace);
  return {
    ...base, displayType: s.type ?? "Run", hasRoute: s.route ?? true, startDate, endDate, syncedAt: new Date(endDate.getTime() + 1000),
    durationSeconds, distanceMiles, distanceMeters: distanceMiles * 1609.344, avgPaceSecPerMile: s.pace,
    avgHeartRate: s.hr, elevationGainM: s.climbPerMile == null ? null : s.climbPerMile * distanceMiles,
    routeClusterId: undefined,
    weather: s.tempF == null ? null : { tempF: s.tempF, feelsLikeF: s.tempF, humidity: 50, windMph: 3, dewPointF: 45, conditionCode: 1,
      conditionText: "Clear", fetchedAt: new Date(endDate.getTime() + 2000).toISOString() },
  };
}

export interface ScenarioOptions {
  /** Pace multipliers at the reference HR (1 = 600 s/mi at 150 bpm). */
  baselineLevel?: number; recentLevel?: number;
  /** ln(pace) change per bpm of average HR (physiological: negative). */
  slope?: number;
  baselineHrShift?: number; recentHrShift?: number;
  /** Relative amplitude of deterministic jitter in pace. */
  noise?: number;
  nBaseline?: number; nRecent?: number;
  baselineStart?: string; recentStart?: string; step?: number;
  baselineTemp?: number | null; recentTemp?: number | null;
  asOf?: string;
  anchorSeconds?: number;
  mutate?: (spec: RunSpec, period: "baseline" | "recent", index: number) => RunSpec;
  extra?: HealthWorkout[];
  overrides?: Record<string, WorkoutOverride>;
}

const OFFSETS = [-6, -3, 0, 3, 6, -4, 2, 5, -2, 1, 4, -5, 3, -1];
const jitter = (i: number) => (((i * 7919) % 13) - 6) / 6;

export function hrScenario(o: ScenarioOptions = {}) {
  const slope = o.slope ?? -0.006, noise = o.noise ?? 0.01, step = o.step ?? 4;
  const anchor = researchRace("anchor", HR_FIXTURE_ANCHOR_DATE, o.anchorSeconds ?? 7871);
  const specs: { spec: RunSpec; period: "baseline" | "recent" }[] = [];
  const build = (period: "baseline" | "recent", n: number, start: string, level: number, shift: number) => {
    for (let i = 0; i < n; i++) {
      const hr = 150 + shift + OFFSETS[i % OFFSETS.length];
      const pace = 600 * level * Math.exp(slope * (hr - 150)) * (1 + noise * jitter(i + (period === "recent" ? 5 : 0)));
      const spec: RunSpec = { id: `${period[0]}${i}`, date: addDays(start, i * step), pace, hr,
        tempF: period === "baseline" ? (o.baselineTemp === undefined ? 62 : o.baselineTemp) : (o.recentTemp === undefined ? 62 : o.recentTemp), climbPerMile: 8 };
      specs.push({ spec: o.mutate ? o.mutate(spec, period, i) : spec, period });
    }
  };
  build("baseline", o.nBaseline ?? 14, o.baselineStart ?? "2026-06-30", o.baselineLevel ?? 1, o.baselineHrShift ?? 0);
  build("recent", o.nRecent ?? 9, o.recentStart ?? "2026-09-08", o.recentLevel ?? 1, o.recentHrShift ?? 0);
  const workouts = [anchor.workout, ...specs.map(s => makeRun(s.spec)), ...(o.extra ?? [])];
  return {
    specs, anchor,
    input: { races: [anchor.race], workouts, overrides: o.overrides ?? {}, asOf: o.asOf ?? HR_FIXTURE_AS_OF, timeZone: HR_FIXTURE_TZ },
  };
}
