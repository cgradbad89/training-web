/**
 * Endurance preparation for a target distance (endurance-readiness-v1). It answers a different question from
 * demonstrated speed: "is this athlete currently prepared to SUSTAIN a race effort over the target distance?"
 *
 * Pure, deterministic. Uses completed non-race run parents only (distance, date); no HR, route or weather.
 * Races are excluded (a single race is not a preparation pattern). Missing history is never read as inactivity:
 * weekly figures use observed weeks only, and fewer than four observed weeks yields "unknown", not "unprepared".
 *
 * score = 0.5·longRun + 0.3·volume + 0.2·frequency, each 0..1:
 *   longRun   = clamp((L/target − 0.30)/(0.75 − 0.30)) with L = mean of the three largest weekly-longest runs in 8 weeks
 *   volume    = clamp((median observed weekly miles − 10)/(25 − 10))
 *   frequency = clamp((median observed runs per week − 2)/(4 − 2))
 * The score is the mean of seven daily offsets (smoothing). Population evidence motivates the factors (volume and long runs associate with long-distance performance,
 * e.g. Fokkema et al. 2020); the break-points and weights are ENGINEERING ASSUMPTIONS, not fitted or published.
 */
import type { EnduranceReadiness } from "@/types/hybridPerformance";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";

export const READINESS_POLICY = Object.freeze({
  version: "endurance-readiness-v1" as const,
  weeks: 8, minimumObservedWeeks: 4,
  longRunLow: 0.3, longRunFull: 0.75, volumeLow: 10, volumeFull: 25, frequencyLow: 2, frequencyFull: 4,
  weights: { longRun: 0.5, volume: 0.3, frequency: 0.2 },
  topLongRuns: 3,
});

/** The minimal run shape readiness reads (a ResearchRun satisfies it; so do projected planned runs). */
export interface ReadinessRun { date: string; workout: { workoutId: string; distanceMiles: number } }
const MILE = 1609.344;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const median = (v: readonly number[]) => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };

function readinessAt(input: {
  runs: readonly ReadinessRun[];
  raceWorkoutIds: ReadonlySet<string>;
  /** Local date the readiness is evaluated at; only runs strictly before it are used. */
  asOfDate: string;
  targetDistanceMeters: number;
}): EnduranceReadiness {
  const P = READINESS_POLICY;
  const end = shiftPerformanceDate(input.asOfDate, -1);
  const weeks = Array.from({ length: P.weeks }, (_, i) => {
    const last = shiftPerformanceDate(end, -i * 7), first = shiftPerformanceDate(last, -6);
    const sel = input.runs.filter(r => r.date >= first && r.date <= last && !input.raceWorkoutIds.has(r.workout.workoutId)
      && r.workout.distanceMiles > 0 && r.workout.distanceMiles <= 26.3);
    return { miles: sel.reduce((s, r) => s + r.workout.distanceMiles, 0), runs: sel.length, longest: Math.max(0, ...sel.map(r => r.workout.distanceMiles)) };
  });
  const observed = weeks.filter(w => w.runs > 0);
  const base = { version: P.version, asOfDate: input.asOfDate, targetDistanceMeters: input.targetDistanceMeters, weeksObserved: observed.length };
  if (observed.length < P.minimumObservedWeeks)
    return { ...base, score: null, longestRunMiles: observed.length ? Math.max(...observed.map(w => w.longest)) : null, weeklyMiles: null, runsPerWeek: null,
      longRunFraction: null, components: null,
      reasons: [`Only ${observed.length} of the last ${P.weeks} weeks have recorded runs; readiness is unknown, which is not the same as unprepared.`] };
  const targetMiles = input.targetDistanceMeters / MILE;
  const top = observed.map(w => w.longest).sort((a, b) => b - a).slice(0, P.topLongRuns);
  const longRun = top.reduce((s, x) => s + x, 0) / top.length;
  const weeklyMiles = median(observed.map(w => w.miles)), runsPerWeek = median(observed.map(w => w.runs));
  const frac = longRun / targetMiles;
  const components = {
    longRun: clamp01((frac - P.longRunLow) / (P.longRunFull - P.longRunLow)),
    volume: clamp01((weeklyMiles - P.volumeLow) / (P.volumeFull - P.volumeLow)),
    frequency: clamp01((runsPerWeek - P.frequencyLow) / (P.frequencyFull - P.frequencyLow)),
  };
  const score = P.weights.longRun * components.longRun + P.weights.volume * components.volume + P.weights.frequency * components.frequency;
  return { ...base, score, longestRunMiles: Math.max(...observed.map(w => w.longest)), weeklyMiles, runsPerWeek, longRunFraction: frac, components, reasons: [] };
}

/**
 * Smoothed over seven daily offsets (the same device v2 uses for its training windows) so a run entering or leaving
 * the eight-week window moves the score gradually instead of flipping a threshold from one day to the next.
 */
export function computeEnduranceReadiness(input: Parameters<typeof readinessAt>[0]): EnduranceReadiness {
  const now = readinessAt(input);
  if (now.score === null) return now;
  const all = Array.from({ length: 7 }, (_, k) => readinessAt({ ...input, asOfDate: shiftPerformanceDate(input.asOfDate, -k) })).filter(r => r.score !== null);
  const mean = (f: (r: EnduranceReadiness) => number) => all.reduce((s, r) => s + f(r), 0) / all.length;
  return { ...now, score: mean(r => r.score!), weeklyMiles: mean(r => r.weeklyMiles!), runsPerWeek: mean(r => r.runsPerWeek!), longRunFraction: mean(r => r.longRunFraction!),
    components: { longRun: mean(r => r.components!.longRun), volume: mean(r => r.components!.volume), frequency: mean(r => r.components!.frequency) } };
}
