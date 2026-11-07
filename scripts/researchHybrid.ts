/**
 * Phases 3Q–3T — READ-ONLY, bounded, aggregate-only live evaluation of the hybrid performance model.
 *
 * Reads (all bounded, nothing written, never run by CI):
 *   - ≤1000 workout parent documents since 2026-01-01, field-masked (adds `bestEfforts` and `routeComplete` to the Phase 3O mask),
 *   - ≤100 races, ≤1000 workout overrides, ≤10 plans,
 *   - ≤400 healthMetrics VO₂ readings since 2026-06-01 (date + vo2_max only),
 *   - HR-stream chunks for at most 20 recent steady outdoor runs (≤40 chunk documents each) to evaluate warm-up trimming.
 * Prints aggregates only: no workout ids, names, coordinates, per-sample values or per-run values. Private captures
 * (`HYBRID_RESEARCH_SAVE_CACHE`) must live outside the repository and are deleted by the operator afterwards.
 *
 *   HYBRID_RESEARCH=1 HYBRID_RESEARCH_OUT=/path/report.json npx vitest run scripts/researchHybrid.test.ts
 *   (HYBRID_RESEARCH_CACHE=/path/private.json re-uses a private capture instead of reading live)
 */
import { readFileSync, writeFileSync } from "node:fs";
import admin from "firebase-admin";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { HrSample, HrStreamSummary } from "@/types/hybridPerformance";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "@/utils/performance/hybridPerformance";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import { summarizeHrStream } from "@/utils/performance/hrStreamQuality";
import { evaluateModelsAsOf, hybridLeaveOneOut, plausibility, replay, scoreModelsAgainstOutcomes } from "@/utils/research/hybridEvaluation";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import type { Vo2Entry } from "@/utils/vo2History";

const WORKOUT_FIELDS = ["workoutId", "startDate", "endDate", "entrySource", "updatedAt", "syncedAt", "activityType", "displayType",
  "durationSeconds", "distanceMiles", "distanceMeters", "sourceName", "isRunLike", "hasRoute", "routeComplete", "hasHRStream", "avgHeartRate",
  "avgPaceSecPerMile", "elevationGainM", "weather", "routeClusterId", "bestEfforts"];
const RACE_FIELDS = ["name", "raceDate", "raceDistance", "customDistanceMiles", "createdAt", "actualRunId", "actualRunDate",
  "actualRunDistanceMiles", "actualRunDurationSeconds", "result", "performanceEvidence", "confirmationHistory", "linkedPlanId"];
const LIMITS = { workouts: 1000, races: 100, overrides: 1000, plans: 10, vo2: 400, streamRuns: 20, streamChunks: 40 };
const FROM = "2026-01-01", VO2_FROM = "2026-06-01", TZ = "America/New_York";
const TARGET_RACE = "2027-03-20";

export interface HybridLoaded {
  races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; plans: RunningPlan[];
  vo2: Vo2Entry[]; streams: Record<string, HrSample[]>; truncated: boolean;
}

function serviceAccount(): Record<string, unknown> {
  const line = readFileSync(".env.local", "utf8").split("\n").find(l => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let v = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return JSON.parse(v);
}
const toIso = (x: unknown): string | null => x && typeof x === "object" && "toDate" in (x as object) ? (x as { toDate: () => Date }).toDate().toISOString() : null;
const BEST_KEYS = ["1mi", "5k", "10k", "10mi", "half"] as const;
function bestEfforts(raw: unknown): HealthWorkout["bestEfforts"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of BEST_KEYS) out[k] = typeof r[k] === "number" && Number.isFinite(r[k]) ? r[k] : null;
  if (typeof r.computedFromRouteComplete === "boolean") out.computedFromRouteComplete = r.computedFromRouteComplete;
  if (typeof r.computationVersion === "number") out.computationVersion = r.computationVersion;
  return out as unknown as HealthWorkout["bestEfforts"];
}
function workoutFrom(id: string, data: Record<string, unknown>): HealthWorkout {
  return { ...(workoutModelSummary(id, data) as unknown as HealthWorkout), routeComplete: typeof data.routeComplete === "boolean" ? data.routeComplete : undefined, bestEfforts: bestEfforts(data.bestEfforts) };
}

/** Private-capture serialisation: Timestamps as `{__ts}`. Never committed. */
const revive = (x: unknown): unknown => x && typeof x === "object" && "__ts" in (x as object) ? { toDate: () => new Date((x as { __ts: string }).__ts) }
  : Array.isArray(x) ? x.map(revive) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, revive(v)])) : x;
const stamp = (x: unknown): unknown => x && typeof x === "object" && "toDate" in (x as object) ? { __ts: (x as { toDate: () => Date }).toDate().toISOString() }
  : Array.isArray(x) ? x.map(stamp) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, stamp(v)])) : x;

export function loadFromCache(path: string): HybridLoaded {
  const d = JSON.parse(readFileSync(path, "utf8")) as { workouts: { id: string }[]; races: { id: string }[]; overrides: { id: string }[]; plans: unknown[]; vo2: Vo2Entry[]; streams: Record<string, HrSample[]> };
  const overrides: Record<string, WorkoutOverride> = {};
  for (const o of d.overrides) overrides[o.id] = revive(o) as WorkoutOverride;
  return { workouts: d.workouts.map(w => workoutFrom(w.id, revive(w) as Record<string, unknown>)), races: d.races.map(r => normalizeRaceDocument(r.id, revive(r) as Record<string, unknown>)),
    overrides, plans: d.plans as RunningPlan[], vo2: d.vo2, streams: d.streams, truncated: false };
}

export async function loadLive(saveCache?: string): Promise<HybridLoaded> {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount() as admin.ServiceAccount) });
  const db = admin.firestore();
  const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
  if (probe.empty) throw new Error("No healthWorkouts found");
  const owner = db.collection("users").doc(probe.docs[0].ref.path.split("/")[1]);
  const [w, r, o, p, m] = await Promise.all([
    owner.collection("healthWorkouts").where("startDate", ">=", new Date(`${FROM}T00:00:00Z`)).orderBy("startDate", "desc").select(...WORKOUT_FIELDS).limit(LIMITS.workouts + 1).get(),
    owner.collection("halfMarathonRaces").select(...RACE_FIELDS).limit(LIMITS.races + 1).get(),
    owner.collection("workoutOverrides").limit(LIMITS.overrides + 1).get(),
    owner.collection("plans").limit(LIMITS.plans + 1).get(),
    owner.collection("healthMetrics").where("date", ">=", VO2_FROM).orderBy("date", "asc").select("date", "vo2_max").limit(LIMITS.vo2 + 1).get(),
  ]);
  const overrides: Record<string, WorkoutOverride> = {};
  for (const d of o.docs.slice(0, LIMITS.overrides)) overrides[d.id] = d.data() as WorkoutOverride;
  const workoutDocs = w.docs.slice(0, LIMITS.workouts);
  const workouts = workoutDocs.map(d => workoutFrom(d.id, d.data() as Record<string, unknown>));
  const plans = p.docs.slice(0, LIMITS.plans).flatMap(d => { const x = d.data() as Record<string, unknown>;
    return (x.planType ?? "running") === "running" && Array.isArray(x.weeks) ? [{ ...x, id: d.id, startDate: toIso(x.startDate)?.slice(0, 10) ?? String(x.startDate) } as unknown as RunningPlan] : []; });
  const vo2: Vo2Entry[] = m.docs.slice(0, LIMITS.vo2).flatMap(d => { const x = d.data() as { date?: string; vo2_max?: number }; return x.vo2_max && x.vo2_max > 0 ? [{ date: x.date ?? d.id, value: x.vo2_max }] : []; });
  // Bounded HR-stream sample: the most recent steady outdoor runs that have a stream.
  const candidates = workouts.filter(x => x.isRunLike && x.hasRoute && x.hasHRStream && !/treadmill|indoor|tempo|interval|race|fartlek/i.test(x.displayType ?? "")
    && x.durationSeconds >= 1200 && x.durationSeconds <= 7200).sort((a, b) => b.startDate.getTime() - a.startDate.getTime()).slice(0, LIMITS.streamRuns);
  const streams: Record<string, HrSample[]> = {};
  for (const x of candidates) {
    const snap = await owner.collection("healthWorkouts").doc(x.workoutId).collection("hrStream").orderBy("chunkIndex", "asc").limit(LIMITS.streamChunks).get();
    const samples: { t: number; bpm: number }[] = [];
    let t0: number | null = null;
    for (const c of snap.docs) for (const s of ((c.data().samples as { t?: { toDate: () => Date }; hr?: number }[]) ?? [])) {
      const ms = s.t?.toDate?.().getTime(); if (ms === undefined || typeof s.hr !== "number") continue;
      t0 ??= ms; samples.push({ t: (ms - t0) / 1000, bpm: s.hr });
    }
    if (samples.length) streams[x.workoutId] = samples;
  }
  const loaded: HybridLoaded = { workouts, races: r.docs.slice(0, LIMITS.races).map(d => normalizeRaceDocument(d.id, d.data())), overrides, plans, vo2, streams,
    truncated: w.size > LIMITS.workouts || r.size > LIMITS.races || o.size > LIMITS.overrides || m.size > LIMITS.vo2 };
  if (saveCache) writeFileSync(saveCache, JSON.stringify({
    workouts: workoutDocs.map(d => ({ id: d.id, ...(stamp(d.data()) as object) })), races: r.docs.map(d => ({ id: d.id, ...(stamp(d.data()) as object) })),
    overrides: o.docs.map(d => ({ id: d.id, ...(stamp(d.data()) as object) })), plans: loaded.plans, vo2, streams }));
  return loaded;
}

const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = shiftPerformanceDate(d, 1)) out.push(d); return out; };
const at = (d: string) => `${d}T17:00:00.000Z`;
const round = (n: number | null | undefined, k = 1) => n == null ? null : Math.round(n * 10 ** k) / 10 ** k;
const hms = (s: number | null) => s === null ? null : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const median = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };

export function buildHybridResearchReport(data: HybridLoaded, now: string) {
  const { races, workouts, overrides } = data;
  const base = { races, workouts, overrides, timeZone: TZ };
  const today = performanceLocalDate(now, TZ);
  const runs = workouts.filter(w => w.isRunLike);
  const raceRows = races.filter(r => r.raceDistance === "halfMarathon" && r.actualRunId).map(r => r.raceDate).sort();
  const latestRace = raceRows.filter(d => d < today).at(-1) ?? null;

  // Stream quality (aggregate), then the same trend with and without trimmed HR.
  const summaries: Record<string, HrStreamSummary> = {};
  for (const [id, s] of Object.entries(data.streams)) summaries[id] = summarizeHrStream(s);
  const sv = Object.values(summaries);
  const delta = sv.flatMap(s => s.trimmedAvgHr !== null && s.rawAvgHr !== null ? [s.trimmedAvgHr - s.rawAvgHr] : []);
  const streamQuality = { runsWithStream: sv.length, good: sv.filter(s => s.quality === "good").length, limited: sv.filter(s => s.quality === "limited").length, unusable: sv.filter(s => s.quality === "unusable").length,
    intervalLike: sv.filter(s => s.intervalLike).length, medianWarmupSeconds: median(sv.flatMap(s => s.warmupSeconds === null ? [] : [s.warmupSeconds])),
    trimmedMinusRawAvgHrBpm: { median: round(median(delta)), min: delta.length ? round(Math.min(...delta)) : null, max: delta.length ? round(Math.max(...delta)) : null },
    flagCounts: sv.flatMap(s => s.flags).reduce<Record<string, number>>((a, f) => ({ ...a, [f]: (a[f] ?? 0) + 1 }), {}) };

  const nowOpts = { vo2Entries: data.vo2.filter(e => e.date <= today) };
  const official = estimateCurrentHalfMarathon({ ...base, asOf: now });
  const hr = estimateHrEnhancedHalfMarathon({ ...base, asOf: now }, { official });
  const hybrid = estimateHybridHalfMarathon({ ...base, asOf: now }, { official, hrEnhanced: hr, ...nowOpts });
  const hybridStreams = estimateHybridHalfMarathon({ ...base, asOf: now }, { official, hrEnhanced: hr, ...nowOpts, streamSummaries: summaries });
  const row = evaluateModelsAsOf({ ...base, asOf: now }, now, nowOpts);
  const q = hybrid.capacity.qualification;
  const planned = data.plans.find(p => races.find(r => r.raceDate === TARGET_RACE)?.linkedPlanId === p.id) ?? data.plans.find(p => p.status === "active") ?? null;
  const forecast = estimateRaceDayForecast({ ...base, asOf: now }, { raceDate: TARGET_RACE, plan: planned, hybrid, official, hrEnhanced: hr, ...nowOpts });

  const series = latestRace ? replay({ ...base, asOf: now }, days(shiftPerformanceDate(latestRace, 1), today).map(at), nowOpts) : null;
  const retro: Record<string, unknown>[] = [];
  const target = races.find(r => r.raceDate === latestRace);
  if (target && target.actualRunDurationSeconds) for (const lead of [35, 21, 14, 7, 1]) {
    const r = evaluateModelsAsOf({ ...base, asOf: now }, at(shiftPerformanceDate(target.raceDate, -lead)), nowOpts);
    const by = (id: string) => r.models.find(m => m.id === id)!;
    const e = (id: string) => by(id).seconds === null ? null : round(by(id).seconds! - target.actualRunDurationSeconds!, 0);
    retro.push({ leadDays: lead, officialErrorSeconds: e("official_v2"), hrEnhancedErrorSeconds: e("hr_enhanced_v1"), hybridErrorSeconds: e("hybrid_v1"), hybridStatus: by("hybrid_v1").status, hybridCause: by("hybrid_v1").cause ?? null });
  }
  const accuracy = scoreModelsAgainstOutcomes(series?.rows ?? [], target?.actualRunDurationSeconds
    ? [{ raceDate: target.raceDate, finishSeconds: target.actualRunDurationSeconds, qualified: false /* maximal effort and independent timing are unverified */ }] : []);

  const trend = hybrid.physiology!, trendS = hybridStreams.physiology!;
  const sec = (s: number | null) => ({ seconds: round(s, 1), time: hms(s) });
  return {
    generatedFor: now, timeZone: TZ, labels: "Observed owner-data aggregates (read-only). Nothing written or committed. Coefficients were NOT fitted to any race outcome.",
    coverage: { workoutParents: workouts.length, runLike: runs.length, races: races.length, overrides: Object.keys(overrides).length, plans: data.plans.length, vo2Readings: data.vo2.length, truncated: data.truncated,
      outdoorWithBestEfforts: runs.filter(w => w.hasRoute && w.bestEfforts?.computedFromRouteComplete === true).length, outdoorWithWeather: runs.filter(w => w.hasRoute && w.weather != null).length, withStream: runs.filter(w => w.hasHRStream).length },
    evidence: { tierCounts: q.counts, independent: q.independent.map(i => ({ kind: i.kind, tier: i.tier, ageDays: i.ageDays, distanceKm: round(i.distanceMeters / 1000, 2), quality: round(i.quality, 2) })),
      expired: q.expired.map(i => ({ kind: i.kind, ageDays: i.ageDays })), excludedByReason: q.excludedByReason,
      effortReference: { runs: q.effortReference.runs, available: q.effortReference.available, hrThresholdBpm: round(q.effortReference.hrThreshold, 1), equivalentThresholdTime: hms(q.effortReference.equivalentSecondsThreshold) },
      bestEffortEnvelopePoints: q.curve.length },
    current: {
      official_v2: { status: official.status, ...sec(official.baselineSeconds === null ? null : official.baselineSeconds + official.adjustmentSeconds), minutes: official.finishMinutes },
      hr_enhanced_v1: { status: hr.status, ...sec(hr.candidateSeconds), minutes: hr.candidateMinutes },
      capacity: hybrid.capacity.methods.map(m => ({ method: m.id, status: m.status, ...sec(m.seconds), evidenceCount: m.evidenceCount, reason: m.reasons[0] ?? "" })),
      hybrid: { status: hybrid.status, cause: hybrid.unavailableCause, ...sec(hybrid.seconds), minutes: hybrid.minutes, confidence: hybrid.confidence, evidenceQuality: hybrid.evidenceQuality,
        flags: hybrid.flags, sensitivityRange: hybrid.sensitivityRange && { fast: hms(hybrid.sensitivityRange.fastSeconds), slow: hms(hybrid.sensitivityRange.slowSeconds) },
        contributions: hybrid.contributions.map(c => ({ family: c.family, status: c.status, seconds: round(c.seconds), fractionPct: round(c.fraction * 100, 2), influence: round(c.influence, 2) })),
        missing: hybrid.missing, exponent: round(hybrid.capacity.exponent, 3) },
      differences: { hybridVsOfficialSeconds: round(hybrid.comparison.differenceVsOfficialSeconds), hybridVsHrEnhancedSeconds: round(hybrid.comparison.differenceVsHrEnhancedSeconds),
        hybridVsCapacityBaseSeconds: hybrid.seconds !== null && hybrid.capacity.seconds !== null ? round(hybrid.seconds - hybrid.capacity.seconds) : null },
      evidenceUsedByModel: Object.fromEntries(row.models.map(m => [m.id, m.evidenceUsed])),
      plausibility: plausibility(row),
    },
    physiology: { parentHr: { status: trend.status, classification: trend.classification, runs: trend.runs, weeks: trend.weeks, slopePctPer28d: round(trend.slopePer28d === null ? null : trend.slopePer28d * 100, 2),
        t: round(trend.tStatistic, 2), flags: trend.flags, weatherAdjustment: trend.weatherAdjustment, vo2: trend.vo2, vo2Corroboration: trend.vo2Corroboration, reasons: trend.reasons },
      trimmedStreamHrSample: { source: trendS.hrSource, status: trendS.status, classification: trendS.classification, slopePctPer28d: round(trendS.slopePer28d === null ? null : trendS.slopePer28d * 100, 2) },
      streamQuality, readiness: hybrid.readiness && { score: round(hybrid.readiness.score, 2), longestRunMiles: round(hybrid.readiness.longestRunMiles), weeklyMiles: round(hybrid.readiness.weeklyMiles), runsPerWeek: round(hybrid.readiness.runsPerWeek), components: hybrid.readiness.components } },
    sensitivity: { leaveOneOut: hybridLeaveOneOut({ ...base, asOf: now }),
      dailyReplay: series && { days: series.instants, availability: series.availability, hybridStatus: series.hybridStatus, hybridUnavailableCauses: series.hybridUnavailableCauses, dayToDay: series.hybridDayToDay,
        differencesVsOfficial: series.differencesVsOfficial,
        trajectory: series.rows.filter((_, i) => i % 3 === 0 || i === series.rows.length - 1).map(r => ({ date: r.asOfDate, v2: round(r.models.find(m => m.id === "official_v2")!.seconds, 0),
          hr: round(r.models.find(m => m.id === "hr_enhanced_v1")!.seconds, 0), hybrid: round(r.models.find(m => m.id === "hybrid_v1")!.seconds, 0) })) } },
    forecast: { raceDate: TARGET_RACE, status: forecast.status, withheldCause: forecast.withheldCause, daysToRace: forecast.daysToRace, ...sec(forecast.seconds), minutes: forecast.minutes,
      currentCapability: sec(forecast.currentCapabilitySeconds), range: forecast.scenarioRange && { fast: hms(forecast.scenarioRange.fastSeconds), slow: hms(forecast.scenarioRange.slowSeconds) },
      horizonAllowancePct: round(forecast.horizonAllowanceFraction * 100, 2), evidenceAgeAtRaceDays: forecast.evidenceAgeAtRaceDays,
      scenarios: forecast.scenarios.map(s => ({ id: s.id, time: hms(s.seconds), fractionPct: round(s.fraction * 100, 2), central: s.central })),
      plan: forecast.plan, readiness: forecast.readiness, assumptions: forecast.assumptions, uncertainty: forecast.uncertainty },
    retrospectiveSanityCheck: { note: "One earlier race, outcome NOT qualified (maximal effort and independent timing unverified). Descriptive only; not an accuracy claim, and not independent of the evidence the models may use.", rows: retro },
    accuracy,
  };
}

export async function runHybridResearch(now: string, cachePath?: string, saveCache?: string) {
  return buildHybridResearchReport(cachePath ? loadFromCache(cachePath) : await loadLive(saveCache), now);
}
