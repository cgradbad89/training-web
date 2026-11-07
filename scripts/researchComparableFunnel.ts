/**
 * Phase 3K — READ-ONLY dated comparable-effort funnel on live owner data.
 *
 * Reproduces what the production capture sees at one instant: the same bounded
 * parent-field projection (no GPS/HR/health-metric reads), the same race and
 * override documents, the same normalizers, the same estimator inputs
 * (as-of = now, owner time zone) — then runs the research-only
 * `buildComparableEffortFunnel` and prints COUNTS ONLY (no ids, names, dates of
 * individual runs, coordinates or per-run values).
 *
 * Writes nothing. Reads: ≤1000 workout parents (field-masked, startDate-windowed),
 * ≤100 races, ≤1000 overrides. Never run by CI.
 *
 *   FUNNEL=1 npx vitest run scripts/researchComparableFunnel.test.ts
 *   (FUNNEL_AS_OF=2026-10-10T16:00:00Z to evaluate an earlier instant on current data)
 */
import { readFileSync } from "node:fs";
import admin from "firebase-admin";
import { buildComparableEffortFunnel, type ComparableEffortFunnel } from "@/utils/comparableEffortFunnel";
import { estimateCurrentHalfMarathon, CURRENT_HALF_POLICY } from "@/utils/experimentalCurrentPerformance";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { shiftPerformanceDate, performanceLocalDate } from "@/utils/performanceEvidence";
import { WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";

const WORKOUT_FIELDS = [
  "workoutId", "startDate", "endDate", "entrySource", "updatedAt", "syncedAt", "activityType", "displayType",
  "durationSeconds", "distanceMiles", "distanceMeters", "sourceName", "isRunLike", "hasRoute", "hasHRStream",
  "avgHeartRate", "avgPaceSecPerMile", "elevationGainM", "weather", "routeClusterId",
];
const RACE_FIELDS = [
  "name", "raceDate", "raceDistance", "customDistanceMiles", "createdAt", "actualRunId", "actualRunDate",
  "actualRunDistanceMiles", "actualRunDurationSeconds", "result", "performanceEvidence", "confirmationHistory",
];
const LIMITS = { workouts: 1000, races: 100, overrides: 1000 };

function serviceAccount(): Record<string, unknown> {
  const line = readFileSync(".env.local", "utf8").split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let v = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return JSON.parse(v);
}

/** Counts only: how the weather tolerances behave on pairs that DO have weather. */
export interface WeatherToleranceDiagnostics {
  pairsWithBothWeather: number;
  withinTemperature: number;
  withinHumidity: number;
  withinWind: number;
  withinAllThree: number;
  medianAbsTempDiffF: number | null;
  baselineMedianTempF: number | null;
  recentMedianTempF: number | null;
}

function med(values: number[]): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

/** Same windows/duration screen as the funnel (baseline: 56 d before the anchor; recent: last 35 d after it). */
export function weatherToleranceDiagnostics(
  workouts: readonly HealthWorkout[], anchorDate: string | null, asOf: string, timeZone: string, raceRunIds: ReadonlySet<string>
): WeatherToleranceDiagnostics {
  const P = WORKOUT_RESEARCH_POLICY;
  const empty = { pairsWithBothWeather: 0, withinTemperature: 0, withinHumidity: 0, withinWind: 0, withinAllThree: 0,
    medianAbsTempDiffF: null, baselineMedianTempF: null, recentMedianTempF: null };
  if (!anchorDate) return empty;
  const today = performanceLocalDate(asOf, timeZone);
  const local = (x: HealthWorkout) => performanceLocalDate(x.startDate.toISOString(), timeZone);
  const steady = workouts.filter((x) => x.isRunLike && !raceRunIds.has(x.workoutId)
    && x.durationSeconds >= P.minimumDurationSeconds && x.durationSeconds <= P.maximumDurationSeconds
    && !/tempo|interval|race|fartlek|hill repeat/i.test(x.displayType ?? "")
    && x.weather != null && Date.parse(x.weather.fetchedAt) <= Date.parse(asOf));
  const base = steady.filter((x) => local(x) >= shiftPerformanceDate(anchorDate, -P.baselineDays) && local(x) < anchorDate);
  const recent = steady.filter((x) => local(x) >= shiftPerformanceDate(today, -34) && local(x) > anchorDate);
  const out: WeatherToleranceDiagnostics = { ...empty, baselineMedianTempF: med(base.map((x) => x.weather!.tempF)), recentMedianTempF: med(recent.map((x) => x.weather!.tempF)) };
  const diffs: number[] = [];
  for (const b of base) for (const r of recent) {
    out.pairsWithBothWeather += 1;
    const t = Math.abs(b.weather!.tempF - r.weather!.tempF), h = Math.abs(b.weather!.humidity - r.weather!.humidity), w = Math.abs(b.weather!.windMph - r.weather!.windMph);
    diffs.push(t);
    const ok = [t <= P.maximumTemperatureDifferenceF, h <= P.maximumHumidityDifference, w <= P.maximumWindDifferenceMph];
    out.withinTemperature += ok[0] ? 1 : 0; out.withinHumidity += ok[1] ? 1 : 0; out.withinWind += ok[2] ? 1 : 0;
    out.withinAllThree += ok.every(Boolean) ? 1 : 0;
  }
  out.medianAbsTempDiffF = med(diffs);
  return out;
}

export interface LiveFunnelReport {
  asOf: string;
  coverage: { workoutParents: number; races: number; overrides: number; truncated: boolean };
  weather: { runsInWindow: number; withWeather: number; outdoorGpsRuns: number; outdoorGpsWithWeather: number };
  estimate: { method: string; anchorPresent: boolean; matchedPairs: number; effectivePairs: number };
  weatherTolerances: WeatherToleranceDiagnostics;
  funnel: ComparableEffortFunnel;
}

export async function runLiveFunnel(asOf: string, timeZone = "America/New_York", uidOverride?: string): Promise<LiveFunnelReport> {
  if (!admin.apps.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount() as any) });
  }
  const db = admin.firestore();
  let uid = uidOverride;
  if (!uid) {
    const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
    if (probe.empty) throw new Error("No healthWorkouts found");
    uid = probe.docs[0].ref.path.split("/")[1];
  }
  const owner = db.collection("users").doc(uid);
  const from = shiftPerformanceDate(performanceLocalDate(asOf, timeZone), -CURRENT_HALF_POLICY.maximumAnchorDays - WORKOUT_RESEARCH_POLICY.baselineDays - 7);
  const first = new Date(`${from}T00:00:00Z`);
  const [w, r, o] = await Promise.all([
    owner.collection("healthWorkouts").where("startDate", ">=", first).orderBy("startDate", "desc").select(...WORKOUT_FIELDS).limit(LIMITS.workouts + 1).get(),
    owner.collection("halfMarathonRaces").select(...RACE_FIELDS).limit(LIMITS.races + 1).get(),
    owner.collection("workoutOverrides").limit(LIMITS.overrides + 1).get(),
  ]);
  const cutoff = Date.parse(asOf);
  const workouts = w.docs.slice(0, LIMITS.workouts)
    .map((d) => workoutModelSummary(d.id, d.data() as Record<string, unknown>) as unknown as HealthWorkout)
    .filter((x) => x.startDate.getTime() <= cutoff);
  const races = r.docs.slice(0, LIMITS.races).map((d) => normalizeRaceDocument(d.id, d.data()));
  const overrides: Record<string, WorkoutOverride> = {};
  for (const d of o.docs.slice(0, LIMITS.overrides)) overrides[d.id] = d.data() as WorkoutOverride;

  const input = { races, workouts, overrides, asOf, timeZone };
  const estimate = estimateCurrentHalfMarathon(input);
  const funnel = buildComparableEffortFunnel(input);
  const runs = workouts.filter((x) => x.isRunLike);
  const outdoor = runs.filter((x) => x.hasRoute && !/treadmill|indoor/i.test(x.displayType ?? ""));
  return {
    asOf,
    coverage: { workoutParents: w.size, races: r.size, overrides: o.size,
      truncated: w.size > LIMITS.workouts || r.size > LIMITS.races || o.size > LIMITS.overrides },
    weather: { runsInWindow: runs.length, withWeather: runs.filter((x) => x.weather != null).length,
      outdoorGpsRuns: outdoor.length, outdoorGpsWithWeather: outdoor.filter((x) => x.weather != null).length },
    estimate: { method: String(estimate.adjustmentMethod), anchorPresent: !!estimate.anchor,
      matchedPairs: estimate.diagnostics.matchedPairs, effectivePairs: estimate.diagnostics.effectivePairs },
    weatherTolerances: weatherToleranceDiagnostics(workouts, funnel.anchorDate, asOf, timeZone,
      new Set(races.flatMap((x) => (x.actualRunId ? [x.actualRunId] : [])))),
    funnel,
  };
}
