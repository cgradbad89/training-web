/**
 * Hybrid v1.1 FOUR-DISTANCE current-fitness evaluation — READ-ONLY, bounded, aggregate-only (never run by CI; never writes).
 *
 * Reuses the Phase 3Q–3T loader (`researchHybrid.ts`) and the v1.1 production-hydration reads (`researchHybridV11.ts`: one VO₂ window, ≤16 stratified
 * HR streams) so the numbers reproduce what the app computes. Prints aggregates only: no workout ids, names, coordinates or per-run values.
 *
 *   HYBRID_RESEARCH=1 HYBRID_RESEARCH_AS_OF=… HYBRID_RESEARCH_OUT=/path/report.json TZ=America/New_York npx vitest run scripts/researchHybridTargets.test.ts
 *   (HYBRID_RESEARCH_CACHE / HYBRID_V11_PROD_CACHE re-use private captures instead of reading live; keep them OUTSIDE the repository)
 */
import { estimateHybridHalfMarathonV11 } from "@/utils/performance/hybridPerformanceV11";
import { computeCurrentFitness, type CurrentFitness } from "@/utils/performance/hybridCurrentFitness";
import { treatConfirmedRacesAsMaximal } from "@/utils/performance/confirmedRaceAssumption";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { evaluateFitnessAsOf, replayFitness, riegelBaselineSeconds, scoreFitnessAgainstOutcomes, stabilityMetrics } from "@/utils/research/hybridTargetsEvaluation";
import { loadFromCache, loadLive, type HybridLoaded } from "./researchHybrid";
import { loadProdReads, type ProdReads } from "./researchHybridV11";

const TZ = "America/New_York";
const round = (n: number | null | undefined, k = 1) => n == null ? null : Math.round(n * 10 ** k) / 10 ** k;
const hms = (s: number | null) => s === null ? null : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = shiftPerformanceDate(d, 1)) out.push(d); return out; };
const at = (d: string) => `${d}T17:00:00.000Z`;
const MILE = 1609.344;

const summarise = (f: CurrentFitness) => f.rows.map(r => ({
  distance: r.label, status: r.status, time: hms(r.finishSeconds), pacePerMile: r.paceSecondsPerMile === null ? null : `${Math.floor(r.paceSecondsPerMile / 60)}:${String(r.paceSecondsPerMile % 60).padStart(2, "0")}`,
  confidence: r.confidence, evidenceQuality: r.evidenceQuality, unavailableCause: r.unavailableCause, provisionalReasons: r.provisionalReasons, flags: r.flags,
  exactSeconds: round(r.estimate.seconds, 1),
  range: r.estimate.sensitivityRange && { fast: hms(r.estimate.sensitivityRange.fastSeconds), slow: hms(r.estimate.sensitivityRange.slowSeconds) },
  directShare: round(r.estimate.target?.directShare, 2), durability: r.estimate.target?.durability ?? null,
  evidence: r.estimate.combination.items.map(i => ({ kind: i.kind, group: i.group, ageDays: i.ageDays, distanceKm: round(i.sourceDistanceMeters / 1000, 2), share: round(i.effectiveShare, 3), uncertaintyPct: round(i.uncertaintyFraction * 100, 2) })),
  exponent: round(r.estimate.combination.exponent, 3),
  adjustments: { physiologySeconds: round(r.estimate.influence.physiologyAdjustmentSeconds, 1), enduranceSeconds: round(r.estimate.influence.enduranceAdjustmentSeconds, 1) },
  readiness: r.estimate.readiness && { score: round(r.estimate.readiness.score, 2), longestRunMiles: round(r.estimate.readiness.longestRunMiles), weeklyMiles: round(r.estimate.readiness.weeklyMiles), longRunMeanMiles: r.estimate.readiness.longRunFraction === null ? null : round(r.estimate.readiness.longRunFraction * r.distanceMiles) },
}));

export function buildTargetsReport(data: HybridLoaded, now: string, prod: ProdReads) {
  const today = performanceLocalDate(now, TZ);
  const vo2 = prod.vo2.entries.filter(e => e.date <= today);
  const extra = { vo2Entries: vo2, streamSummaries: prod.streams.summaries, vo2Load: "loaded" as const, streamLoad: "loaded" as const };
  const input = { races: data.races, workouts: data.workouts, overrides: data.overrides, timeZone: TZ, asOf: now };
  const fitness = computeCurrentFitness(input, extra);

  // Half-marathon parity with the pre-existing v1.1 (what Plan Insights shows): same adapter, same official/HR-enhanced corroboration, NO profile.
  const adapted = { ...input, races: treatConfirmedRacesAsMaximal(data.races) };
  const official = estimateCurrentHalfMarathon(adapted), hr = estimateHrEnhancedHalfMarathon(adapted, { official });
  const baseline = estimateHybridHalfMarathonV11(adapted, { ...extra, official, hrEnhanced: hr, targetDistanceMeters: 21097.5 });
  const half = fitness.rows.find(r => r.id === "half")!;

  // Stability: daily as-of replay from the day after the latest race (or 60 days) to today.
  const raceDates = data.races.filter(r => r.actualRunId).map(r => r.raceDate).sort();
  const latestRace = raceDates.filter(d => d < today).at(-1) ?? null;
  const start = latestRace ? shiftPerformanceDate(latestRace, 1) : shiftPerformanceDate(today, -60);
  const replay = replayFitness(input, days(start, today).map(at), extra);
  const stability = stabilityMetrics(replay);

  // As-of checkpoints before each race: a SANITY CHECK against the realised result, never validation (accuracy needs ≥ 5 qualified outcomes per distance).
  const idOf = (d: string): "5k" | "10mi" | "half" | "marathon" | null => d === "5K" ? "5k" : d === "halfMarathon" ? "half" : d === "marathon" ? "marathon" : null;
  const checkpoints = data.races.filter(r => r.actualRunId && idOf(r.raceDistance) && r.raceDate < today).flatMap(r => {
    const id = idOf(r.raceDistance)!;
    return [1, 7, 14, 28].map(back => {
      const asOfDate = shiftPerformanceDate(r.raceDate, -back);
      const { fitness: f } = evaluateFitnessAsOf(input, at(asOfDate), extra);
      const row = f.rows.find(x => x.id === id)!;
      const actual = r.actualRunDurationSeconds ?? null;
      return { distance: row.label, daysBeforeRace: back, status: row.status, predicted: hms(row.estimate.seconds), actual: hms(actual),
        errorPct: row.estimate.seconds !== null && actual ? round((row.estimate.seconds / actual - 1) * 100, 2) : null };
    });
  });
  const raceList = data.races.filter(r => r.actualRunId && r.actualRunDurationSeconds && idOf(r.raceDistance)).map(r => ({ date: r.raceDate, distanceMeters: r.raceDistance === "halfMarathon" ? 21097.5 : r.raceDistance === "marathon" ? 42195 : 5000, seconds: r.actualRunDurationSeconds! }));
  const riegelContext = ["5k", "10mi", "half", "marathon"].map((id, k) => ({ distance: fitness.rows[k].label, riegelFromLatestRace: hms(riegelBaselineSeconds(raceList, today, fitness.rows[k].distanceMeters)) }));
  const accuracy = scoreFitnessAgainstOutcomes(replay, []);   // no outcome is qualified here by construction: the owner's confirmations are not an independent validation set

  return {
    generatedFor: now, timeZone: TZ, labels: "Observed owner-data aggregates (read-only). Nothing written or committed. No coefficient was fitted to any race outcome.",
    coverage: { workoutParents: data.workouts.length, runLike: data.workouts.filter(w => w.isRunLike).length, races: data.races.length, vo2ReadingsInWindow: vo2.length, truncated: data.truncated },
    currentFitness: { version: fitness.version, asOfDate: fitness.asOfDate, rows: summarise(fitness), consistency: fitness.consistency },
    halfMarathonParity: { baselineStatus: baseline.status, baselineSeconds: round(baseline.seconds, 3), tableSeconds: round(half.estimate.seconds, 3), identical: baseline.seconds === half.estimate.seconds,
      baselineConfidence: baseline.confidence, tableConfidence: half.estimate.confidence, baselineMinutes: baseline.minutes, tableMinutes: half.estimate.minutes },
    stability: { fromDate: start, days: replay.length, perDistance: stability.map(s => ({ ...s, maxStepPct: round(s.maxStepFraction === null ? null : s.maxStepFraction * 100, 2), meanStepPct: round(s.meanStepFraction === null ? null : s.meanStepFraction * 100, 3) })),
      impliedExponentRange: replay.length ? { min: round(Math.min(...replay.flatMap(r => r.impliedExponents)), 3), max: round(Math.max(...replay.flatMap(r => r.impliedExponents)), 3) } : null, inconsistentDays: replay.filter(r => !r.consistent).length },
    checkpoints, riegelContext,
    accuracy: { perDistance: accuracy, note: "Owner races are few and some informed the policy discussion; none is treated as an independent qualified validation outcome. Checkpoints above are sanity checks only." },
    cost: { extraFirestoreReads: { vo2WindowDocs: prod.vo2.docsRead, hrStreamChunkDocs: prod.streams.chunkReads, total: prod.vo2.docsRead + prod.streams.chunkReads }, note: "The four-distance table adds NO reads beyond the existing v1.1 hydration (shared in-memory stores)." },
    milesCheck: fitness.rows.map(r => ({ distance: r.label, miles: round(r.distanceMeters / MILE, 4) })),
  };
}

export async function runTargetsResearch(now: string, cachePath?: string, saveCache?: string, prodCache?: string, saveProdCache?: string) {
  const data = cachePath ? loadFromCache(cachePath) : await loadLive(saveCache);
  const prod = await loadProdReads(data, now, prodCache, saveProdCache);
  return buildTargetsReport(data, now, prod);
}
