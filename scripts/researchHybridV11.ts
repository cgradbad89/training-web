/**
 * Hybrid v1.1 — READ-ONLY, bounded, aggregate-only live evaluation (never run by CI; never writes).
 *
 * Reuses the Phase 3Q–3T loader (`researchHybrid.ts`: ≤1000 workout parents since 2026-01-01 field-masked, ≤100 races,
 * ≤1000 overrides, ≤10 plans, ≤400 VO₂ readings) and then performs EXACTLY the production hydration reads v1.1 would do, so their
 * cost and utilization are measured, not estimated:
 *   - VO₂: one healthMetrics window of PHYSIOLOGY_LIMITS.vo2WindowDays (date + vo2_max only), docs counted;
 *   - HR streams: the stratified ≤16 trend-eligible runs with a stream, ≤40 chunk documents each (a stream that reaches the bound is
 *     discarded, as in production); chunk documents counted; only SUMMARIES are kept.
 * Prints aggregates only: no workout ids, names, coordinates, per-sample or per-run values. Private captures
 * (`HYBRID_RESEARCH_SAVE_CACHE`, `HYBRID_V11_PROD_CACHE`) must live outside the repository and be deleted by the operator afterwards.
 *
 *   HYBRID_RESEARCH=1 HYBRID_RESEARCH_AS_OF=… HYBRID_RESEARCH_OUT=/path/report.json TZ=America/New_York npx vitest run scripts/researchHybridV11.test.ts
 *   (HYBRID_RESEARCH_CACHE=/path/private.json and HYBRID_V11_PROD_CACHE=/path/prod.json re-use private captures instead of reading live)
 */
import { readFileSync, writeFileSync } from "node:fs";
import admin from "firebase-admin";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { Vo2Entry } from "@/utils/vo2History";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "@/utils/performance/hybridPerformance";
import { estimateHybridHalfMarathonV11 } from "@/utils/performance/hybridPerformanceV11";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import { summarizeHrStream } from "@/utils/performance/hrStreamQuality";
import { selectStreamCandidates } from "@/utils/performance/hrStreamSelection";
import { PHYSIOLOGY_LIMITS } from "@/services/physiologyEvidenceStores";
import { scoreModelsAgainstOutcomes } from "@/utils/research/hybridEvaluation";
import { compareVersionsAsOf, leaveOneOutV11, leaveOneWeekOutV11, replayV11, sweepsV11 } from "@/utils/research/hybridV11Evaluation";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { loadFromCache, loadLive, serviceAccount, type HybridLoaded } from "./researchHybrid";

const TZ = "America/New_York", TARGET_RACE = "2027-03-20";
export interface ProdReads {
  vo2: { entries: Vo2Entry[]; docsRead: number; windowDays: number };
  streams: { summaries: Record<string, HrStreamSummary>; candidates: number; eligible: number; withStream: number; chunkReads: number; truncated: number; failed: number; ms: number };
}

const round = (n: number | null | undefined, k = 1) => n == null ? null : Math.round(n * 10 ** k) / 10 ** k;
const hms = (s: number | null) => s === null ? null : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = shiftPerformanceDate(d, 1)) out.push(d); return out; };
const at = (d: string) => `${d}T17:00:00.000Z`;
const sec = (s: number | null) => ({ seconds: round(s, 1), time: hms(s) });
const ms = <T,>(f: () => T): [T, number] => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };

export function candidateSelection(data: HybridLoaded, now: string) {
  const { runs } = selectResearchRuns({ races: data.races, workouts: data.workouts, overrides: data.overrides, asOf: now, capturedAt: now, timeZone: TZ, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  return selectStreamCandidates({ runs, raceWorkoutIds: new Set(data.races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: performanceLocalDate(now, TZ) });
}

/** The production hydration reads, performed read-only with the admin SDK (same queries, same bounds). */
export async function loadProdReads(data: HybridLoaded, now: string, cachePath?: string, saveCache?: string): Promise<ProdReads> {
  if (cachePath) return JSON.parse(readFileSync(cachePath, "utf8")) as ProdReads;
  const sel = candidateSelection(data, now);
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount() as admin.ServiceAccount) });
  const db = admin.firestore();
  const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
  const owner = db.collection("users").doc(probe.docs[0].ref.path.split("/")[1]);
  const L = PHYSIOLOGY_LIMITS, today = performanceLocalDate(now, TZ);
  const cutoff = shiftPerformanceDate(today, -L.vo2WindowDays);
  const m = await owner.collection("healthMetrics").where("date", ">=", cutoff).orderBy("date", "asc").select("date", "vo2_max").get();
  const entries: Vo2Entry[] = m.docs.flatMap(d => { const x = d.data() as { date?: string; vo2_max?: number }; return x.vo2_max && x.vo2_max > 0 ? [{ date: x.date ?? d.id, value: x.vo2_max }] : []; });
  const t0 = performance.now();
  const summaries: Record<string, HrStreamSummary> = {};
  let chunkReads = 0, truncated = 0, failed = 0;
  for (const c of sel.candidates) {
    try {
      const snap = await owner.collection("healthWorkouts").doc(c.workoutId).collection("hrStream").orderBy("chunkIndex", "asc").limit(L.maxChunksPerRun).get();
      chunkReads += snap.size;
      if (snap.size >= L.maxChunksPerRun) { truncated++; summaries[c.workoutId] = { ...summarizeHrStream([]), flags: ["stream_truncated_by_read_bound"] }; continue; }
      const raw: { ms: number; bpm: number }[] = [];
      for (const d of snap.docs) for (const s of ((d.data().samples as { t?: { toDate: () => Date }; hr?: number }[]) ?? [])) {
        const t = s.t?.toDate?.().getTime(); if (t !== undefined && typeof s.hr === "number") raw.push({ ms: t, bpm: s.hr });
      }
      const base = raw.length ? Math.min(...raw.map(r => r.ms)) : 0;
      summaries[c.workoutId] = summarizeHrStream(raw.map(r => ({ t: (r.ms - base) / 1000, bpm: r.bpm })));
    } catch { failed++; }
  }
  const out: ProdReads = { vo2: { entries, docsRead: m.size, windowDays: L.vo2WindowDays },
    streams: { summaries, candidates: sel.candidates.length, eligible: sel.eligible, withStream: sel.withStream, chunkReads, truncated, failed, ms: performance.now() - t0 } };
  if (saveCache) writeFileSync(saveCache, JSON.stringify(out));
  return out;
}

export function buildV11Report(data: HybridLoaded, now: string, prod: ProdReads) {
  const base = { races: data.races, workouts: data.workouts, overrides: data.overrides, timeZone: TZ };
  const today = performanceLocalDate(now, TZ);
  const vo2 = prod.vo2.entries.filter(e => e.date <= today), extra = { vo2Entries: vo2, streamSummaries: prod.streams.summaries };
  const input = { ...base, asOf: now };
  const [official, tOfficial] = ms(() => estimateCurrentHalfMarathon(input));
  const hr = estimateHrEnhancedHalfMarathon(input, { official });
  const [v1, tV1] = ms(() => estimateHybridHalfMarathon(input, { official, hrEnhanced: hr, vo2Entries: vo2 }));
  const [v11, tV11] = ms(() => estimateHybridHalfMarathonV11(input, { official, hrEnhanced: hr, vo2Entries: vo2, streamSummaries: prod.streams.summaries, hybridV1: v1, vo2Load: "loaded", streamLoad: "loaded" }));
  const v11NoPhys = estimateHybridHalfMarathonV11(input, { official, hrEnhanced: hr, hybridV1: v1 });
  const plan = data.plans.find(p => data.races.find(r => r.raceDate === TARGET_RACE)?.linkedPlanId === p.id) ?? data.plans.find(p => p.status === "active") ?? null;
  const [f1, tF1] = ms(() => estimateRaceDayForecast(input, { raceDate: TARGET_RACE, plan, hybrid: v1, official, hrEnhanced: hr, vo2Entries: vo2 }));
  const [f2, tF2] = ms(() => estimateRaceDayForecast(input, { raceDate: TARGET_RACE, plan, hybrid: v11, official, hrEnhanced: hr, vo2Entries: vo2, streamSummaries: prod.streams.summaries, vo2Load: "loaded", streamLoad: "loaded", hybridV1: v1 }));
  const raceDates = data.races.filter(r => r.raceDistance === "halfMarathon" && r.actualRunId).map(r => r.raceDate).sort();
  const latestRace = raceDates.filter(d => d < today).at(-1) ?? null;
  const replay = latestRace ? replayV11(input, days(shiftPerformanceDate(latestRace, 1), today).map(at), { vo2Entries: vo2, streamSummaries: prod.streams.summaries }) : null;
  const q = v11.qualification, c = v11.combination, i = v11.influence;
  const sv = Object.values(prod.streams.summaries);
  const accuracy = scoreModelsAgainstOutcomes([], []);
  return {
    generatedFor: now, timeZone: TZ, labels: "Observed owner-data aggregates (read-only). Nothing written or committed. No coefficient was fitted to any race outcome.",
    coverage: { workoutParents: data.workouts.length, runLike: data.workouts.filter(w => w.isRunLike).length, races: data.races.length, vo2ReadingsInWindow: vo2.length, truncated: data.truncated },
    evidence: { v1Counts: q.base.counts, independentUsed: c.items.map(x => ({ kind: x.kind, group: x.group, ageDays: x.ageDays, distanceKm: round(x.sourceDistanceMeters / 1000, 2), effectiveShare: round(x.effectiveShare, 3), uncertaintyPct: round(x.uncertaintyFraction * 100, 2), flags: x.flags })),
      ignored: c.ignored.map(x => ({ kind: x.kind, reason: x.reason })), expired: q.base.expired.map(x => ({ kind: x.kind, ageDays: x.ageDays })), excludedByReasonV1: q.base.excludedByReason,
      segments: q.segments, informativeExcluded: q.informativeExcluded,
      v1WholeRunReference: { runs: q.base.effortReference.runs, available: q.base.effortReference.available, hrThresholdBpm: round(q.base.effortReference.hrThreshold, 1), equivalentThresholdTime: hms(q.base.effortReference.equivalentSecondsThreshold) } },
    current: {
      official_v2: { status: official.status, ...sec(official.baselineSeconds === null ? null : official.baselineSeconds + official.adjustmentSeconds) },
      hr_enhanced_v1: { status: hr.status, ...sec(hr.candidateSeconds) },
      hybrid_v1: { status: v1.status, ...sec(v1.seconds), confidence: v1.confidence, flags: v1.flags },
      hybrid_v11: { status: v11.status, cause: v11.unavailableCause, ...sec(v11.seconds), minutes: v11.minutes, confidence: v11.confidence, evidenceQuality: v11.evidenceQuality, flags: v11.flags, conflicts: v11.conflicts.map(x => x.id),
        sensitivityRange: v11.sensitivityRange && { fast: hms(v11.sensitivityRange.fastSeconds), slow: hms(v11.sensitivityRange.slowSeconds) }, evidenceBase: sec(c.baseSeconds), exponent: round(c.exponent, 3) },
      hybrid_v11_withoutVo2AndStreams: { status: v11NoPhys.status, ...sec(v11NoPhys.seconds) },
      differences: { v11VsV1Seconds: round(v11.comparison.differenceVsHybridV1Seconds), v11VsOfficialSeconds: round(v11.comparison.differenceVsOfficialSeconds), v11VsHrEnhancedSeconds: round(v11.comparison.differenceVsHrEnhancedSeconds),
        physiologyAndStreamsEffectSeconds: v11.seconds !== null && v11NoPhys.seconds !== null ? round(v11.seconds - v11NoPhys.seconds, 2) : null },
      contribution: { raceShare: round(i.raceShare, 3), recentShare: round(i.recentShare, 3), raceDominance: i.raceDominance, latestRaceAgeDays: i.latestRaceAgeDays, independentObservations: i.independentObservations,
        newerEvidenceDisplacedRace: i.newerEvidenceDisplacedRace, displacementSeconds: round(i.displacementSeconds), physiologyAdjustmentSeconds: round(i.physiologyAdjustmentSeconds, 2),
        enduranceAdjustmentSeconds: round(i.enduranceAdjustmentSeconds, 2), provisional: i.provisional, provisionalReasons: i.provisionalReasons, raceOnly: sec(c.raceOnlySeconds), recentOnly: sec(c.recentOnlySeconds),
        internalUncertaintyPct: round(c.uncertaintyFraction === null ? null : c.uncertaintyFraction * 100, 2) },
      missing: v11.missing,
    },
    physiology: {
      vo2: { ...v11.inputs.vo2, docsRead: prod.vo2.docsRead, windowDays: prod.vo2.windowDays }, trend: v11.physiology && { status: v11.physiology.status, classification: v11.physiology.classification, runs: v11.physiology.runs, weeks: v11.physiology.weeks,
        slopePctPer28d: round(v11.physiology.slopePer28d === null ? null : v11.physiology.slopePer28d * 100, 2), t: round(v11.physiology.tStatistic, 2), hrSource: v11.physiology.hrSource, flags: v11.physiology.flags },
      streams: { ...v11.inputs.hrStreams, production: { eligibleRuns: prod.streams.eligible, withStream: prod.streams.withStream, hydratedCandidates: prod.streams.candidates, chunkDocumentReads: prod.streams.chunkReads, truncatedByBound: prod.streams.truncated, failed: prod.streams.failed, readMs: round(prod.streams.ms, 0) },
        quality: { good: sv.filter(s => s.quality === "good").length, limited: sv.filter(s => s.quality === "limited").length, unusable: sv.filter(s => s.quality === "unusable").length, intervalLike: sv.filter(s => s.intervalLike).length } },
      readiness: v11.readiness && { score: round(v11.readiness.score, 2), longestRunMiles: round(v11.readiness.longestRunMiles), weeklyMiles: round(v11.readiness.weeklyMiles), runsPerWeek: round(v11.readiness.runsPerWeek), components: v11.readiness.components },
    },
    forecast: { raceDate: TARGET_RACE, v1: { status: f1.status, ...sec(f1.seconds), currentCapability: sec(f1.currentCapabilitySeconds), model: f1.currentCapabilityModel, version: f1.version, evidenceAgeAtRaceDays: f1.evidenceAgeAtRaceDays },
      v2: { status: f2.status, ...sec(f2.seconds), currentCapability: sec(f2.currentCapabilitySeconds), model: f2.currentCapabilityModel, version: f2.version, evidenceAgeAtRaceDays: f2.evidenceAgeAtRaceDays,
        range: f2.scenarioRange && { fast: hms(f2.scenarioRange.fastSeconds), slow: hms(f2.scenarioRange.slowSeconds) }, scenarios: f2.scenarios.map(s => ({ id: s.id, time: hms(s.seconds), fractionPct: round(s.fraction * 100, 2) })),
        readiness: f2.readiness, plan: f2.plan && { remainingPlannedRuns: f2.plan.remainingPlannedRuns, historicalAdherence: round(f2.plan.historicalAdherence, 2), usedAdherence: round(f2.plan.usedAdherence, 2) } },
      differenceSeconds: f1.seconds !== null && f2.seconds !== null ? round(f2.seconds - f1.seconds) : null },
    sensitivity: { leaveOneRunOut: leaveOneOutV11(input, extra), leaveOneWeekOut: leaveOneWeekOutV11(input, extra), assumptionSweeps: sweepsV11(input, extra),
      dailyReplay: replay && { days: replay.instants, availability: replay.availability, v11Status: replay.v11Status, causes: replay.v11Causes, dayToDayV11: replay.dayToDay, dayToDayV1: replay.v1DayToDay, differencesVsV1: replay.differencesVsV1, raceShare: replay.raceShare,
        trajectory: replay.rows.filter((_, k) => k % 3 === 0).map(r => ({ date: r.asOfDate, v2: round(r.officialSeconds, 0), v1: round(r.hybridV1Seconds, 0), v11: round(r.hybridV11Seconds, 0), raceShare: round(r.raceShare, 2) })) } },
    cost: { extraFirestoreReadsV1: 0, extraFirestoreReadsV11: { vo2WindowDocs: prod.vo2.docsRead, hrStreamChunkDocs: prod.streams.chunkReads, total: prod.vo2.docsRead + prod.streams.chunkReads, boundedBy: { vo2WindowDays: PHYSIOLOGY_LIMITS.vo2WindowDays, maxRuns: PHYSIOLOGY_LIMITS.maxRuns, maxChunksPerRun: PHYSIOLOGY_LIMITS.maxChunksPerRun, maxTotalChunkReads: PHYSIOLOGY_LIMITS.maxTotalChunkReads } },
      computeMs: { officialV2: round(tOfficial, 1), hybridV1: round(tV1, 1), hybridV11: round(tV11, 1), forecastV1: round(tF1, 1), forecastV2: round(tF2, 1) }, cachedPerSession: "VO₂ 30 min; stream summaries for the session (keyed by workout change fingerprint)" },
    accuracy: { ...accuracy, qualifiedOutcomes: 0, note: "No qualified outcome exists for scoring; criteria unchanged." },
    comparisonAtInstantExample: compareVersionsAsOf(input, now, extra),
  };
}

export async function runHybridV11Research(now: string, cachePath?: string, saveCache?: string, prodCache?: string, saveProdCache?: string) {
  const data = cachePath ? loadFromCache(cachePath) : await loadLive(saveCache);
  const prod = await loadProdReads(data, now, prodCache, saveProdCache);
  return buildV11Report(data, now, prod);
}
