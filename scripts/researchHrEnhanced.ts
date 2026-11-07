/**
 * Phase 3O — READ-ONLY, bounded, aggregate-only live analysis of the HR-enhanced candidate.
 *
 * Reads the same parent-field projection as the production capture path (no GPS, HR streams,
 * health metrics or raw children): <=1000 workout parents since 2026-01-01, <=100 races, <=1000
 * overrides. Writes nothing. Prints aggregates only: no workout ids, names, coordinates or per-run
 * values. Never run by CI.
 *
 *   HR_RESEARCH=1 HR_RESEARCH_OUT=/path/report.json npx vitest run scripts/researchHrEnhanced.test.ts
 *   (HR_RESEARCH_CACHE=/path/private.json reuses a local private pull instead of reading live)
 */
import { readFileSync } from "node:fs";
import admin from "firebase-admin";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { compareHrCandidates } from "@/utils/research/hrCandidates";
import { dailySeries, leaveOneOut, policySensitivity } from "@/utils/research/hrSensitivity";
import { scoreAgainstOutcomes, type QualifiedOutcome } from "@/utils/research/signalEvaluation";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";

const WORKOUT_FIELDS = ["workoutId", "startDate", "endDate", "entrySource", "updatedAt", "syncedAt", "activityType", "displayType",
  "durationSeconds", "distanceMiles", "distanceMeters", "sourceName", "isRunLike", "hasRoute", "hasHRStream", "avgHeartRate",
  "avgPaceSecPerMile", "elevationGainM", "weather", "routeClusterId"];
const RACE_FIELDS = ["name", "raceDate", "raceDistance", "customDistanceMiles", "createdAt", "actualRunId", "actualRunDate",
  "actualRunDistanceMiles", "actualRunDurationSeconds", "result", "performanceEvidence", "confirmationHistory"];
const LIMITS = { workouts: 1000, races: 100, overrides: 1000 };
const FROM = "2026-01-01";
const TZ = "America/New_York";

export interface LoadedInput { races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; truncated: boolean }

function serviceAccount(): Record<string, unknown> {
  const line = readFileSync(".env.local", "utf8").split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let v = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return JSON.parse(v);
}
/** Cache files store Timestamps as `{__ts: ISO}` (see the private pull helper). */
const revive = (x: unknown): unknown => x && typeof x === "object" && "__ts" in (x as object) ? { toDate: () => new Date((x as { __ts: string }).__ts) }
  : Array.isArray(x) ? x.map(revive) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, revive(v)])) : x;

export function loadFromCache(path: string): LoadedInput {
  const d = JSON.parse(readFileSync(path, "utf8")) as { workouts: { id: string }[]; races: { id: string }[]; overrides: { id: string }[] };
  const overrides: Record<string, WorkoutOverride> = {};
  for (const o of d.overrides) overrides[o.id] = revive(o) as WorkoutOverride;
  return { workouts: d.workouts.map(w => workoutModelSummary(w.id, revive(w) as Record<string, unknown>) as unknown as HealthWorkout),
    races: d.races.map(r => normalizeRaceDocument(r.id, revive(r) as Record<string, unknown>)), overrides, truncated: false };
}
export async function loadLive(): Promise<LoadedInput> {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount() as admin.ServiceAccount) });
  const db = admin.firestore();
  const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
  if (probe.empty) throw new Error("No healthWorkouts found");
  const owner = db.collection("users").doc(probe.docs[0].ref.path.split("/")[1]);
  const [w, r, o] = await Promise.all([
    owner.collection("healthWorkouts").where("startDate", ">=", new Date(`${FROM}T00:00:00Z`)).orderBy("startDate", "desc").select(...WORKOUT_FIELDS).limit(LIMITS.workouts + 1).get(),
    owner.collection("halfMarathonRaces").select(...RACE_FIELDS).limit(LIMITS.races + 1).get(),
    owner.collection("workoutOverrides").limit(LIMITS.overrides + 1).get(),
  ]);
  const overrides: Record<string, WorkoutOverride> = {};
  for (const d of o.docs.slice(0, LIMITS.overrides)) overrides[d.id] = d.data() as WorkoutOverride;
  return { workouts: w.docs.slice(0, LIMITS.workouts).map(d => workoutModelSummary(d.id, d.data() as Record<string, unknown>) as unknown as HealthWorkout),
    races: r.docs.slice(0, LIMITS.races).map(d => normalizeRaceDocument(d.id, d.data())), overrides,
    truncated: w.size > LIMITS.workouts || r.size > LIMITS.races || o.size > LIMITS.overrides };
}

const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = shiftPerformanceDate(d, 1)) out.push(d); return out; };
const at = (d: string) => `${d}T16:00:00.000Z`;
const round = (n: number | null, k = 1) => n === null ? null : Math.round(n * 10 ** k) / 10 ** k;

export function buildHrResearchReport(data: LoadedInput, now: string) {
  const { races, workouts, overrides } = data;
  const base = { races, workouts, overrides, timeZone: TZ };
  const today = performanceLocalDate(now, TZ);
  const runs = workouts.filter(w => w.isRunLike);
  const steady = runs.filter(w => w.hasRoute && !/treadmill|indoor|tempo|interval|race|fartlek|hill repeat/i.test(w.displayType ?? "") && w.durationSeconds >= 1200 && w.durationSeconds <= 7200);
  const raceRows = races.filter(r => r.raceDistance === "halfMarathon" && r.actualRunId).map(r => r.raceDate).sort();
  const latestRaceBeforeToday = raceRows.filter(d => d < today).at(-1) ?? null;

  const series = latestRaceBeforeToday ? dailySeries({ ...base, asOf: now }, days(shiftPerformanceDate(latestRaceBeforeToday, 14), today).map(at)) : null;
  const reasons: Record<string, number> = {};
  if (series) for (const r of series.rows) { const e = estimateHrEnhancedHalfMarathon({ ...base, asOf: r.asOf }); for (const c of e.reasons) reasons[c] = (reasons[c] ?? 0) + 1; }
  const instants = [at(shiftPerformanceDate(today, -23)), at(shiftPerformanceDate(today, -13)), at(shiftPerformanceDate(today, -6)), at(today)];

  // Chronological sanity check against the one earlier race: as-of dates BEFORE it, anchor = the previous race.
  const outcomes: QualifiedOutcome[] = [];
  const retro: Record<string, unknown>[] = [];
  const target = races.find(r => r.raceDate === latestRaceBeforeToday);
  if (target && target.actualRunDurationSeconds && raceRows.length >= 2) {
    const actual = target.actualRunDurationSeconds;
    outcomes.push({ raceDate: target.raceDate, finishSeconds: actual, qualified: false /* maximal effort and independent timing are unverified */ });
    for (const lead of [35, 21, 14, 7, 1]) {
      const asOf = at(shiftPerformanceDate(target.raceDate, -lead));
      const o = estimateCurrentHalfMarathon({ ...base, asOf }), h = estimateHrEnhancedHalfMarathon({ ...base, asOf }, { official: o });
      const ofs = o.finishMinutes === null ? null : o.baselineSeconds! + o.adjustmentSeconds;
      retro.push({ leadDays: lead, officialErrorSeconds: ofs === null ? null : round(ofs - actual, 0), hrEnhancedErrorSeconds: h.candidateSeconds === null ? null : round(h.candidateSeconds - actual, 0),
        hrStatus: h.status, hrDirection: h.signalDirection });
    }
  }
  const accuracy = scoreAgainstOutcomes([], outcomes, TZ);
  return {
    generatedFor: now, timeZone: TZ,
    coverage: { workoutParents: workouts.length, runLike: runs.length, steadyOutdoorRuns: steady.length,
      steadyOutdoorWithWeather: steady.filter(w => w.weather != null).length, races: races.length, overrides: Object.keys(overrides).length, truncated: data.truncated },
    anchorDate: latestRaceBeforeToday,
    dailySeries: series && { days: series.days, availableDays: series.availableDays, directionalDays: series.directionalDays, suppressedDays: series.suppressedDays,
      maxAbsDifferenceSeconds: round(series.maxAbsDifferenceSeconds), maxDayToDayStepSeconds: round(series.maxDayToDayStepSeconds), meanDayToDayStepSeconds: round(series.meanDayToDayStepSeconds),
      suppressionReasonDays: reasons, trajectory: series.rows.map(r => ({ asOf: r.asOf.slice(0, 10), status: r.status, differenceSeconds: round(r.differenceSeconds), strength: round(r.strength, 2) })) },
    candidateComparison: instants.map(asOf => compareHrCandidates({ ...base, asOf })),
    leaveOneOutNow: leaveOneOut({ ...base, asOf: now }),
    policySensitivityNow: policySensitivity({ ...base, asOf: now }),
    retrospectiveSanityCheck: {
      note: retro.length && retro.every(r => r.officialErrorSeconds === null)
        ? "The earlier race has no eligible v2 anchor before it at any tested lead time, so no prediction→outcome pair exists. Nothing can be scored."
        : "One earlier race, outcome not qualified (maximal effort and independent timing unverified). Descriptive only; not an accuracy claim.",
      rows: retro },
    accuracy,
  };
}
export async function runHrResearch(now: string, cachePath?: string) {
  return buildHrResearchReport(cachePath ? loadFromCache(cachePath) : await loadLive(), now);
}
