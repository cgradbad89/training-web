import { type MileSplitDoc } from "@/utils/mileSplitsCache";
import { type HealthWorkout } from "@/types/healthWorkout";
import { buildVo2History } from "./vo2History";
import { buildPersonalRecordsByYear } from "./personalRecords";
import { buildPaceTrendsByDistanceBucket } from "./paceTrends";
import { buildHrZoneDistribution, type MileSplitSample } from "./hrZoneDistribution";
import { findBestFastestMileAcrossRuns } from "./fastestMileSegment";
import { buildDailyLoadMap, buildLoadEwmaSeries } from "./trainingLoadSeries";
import { buildQualifyingEfforts, fitRiegel, predictSeconds, type RiegelFit } from "./riegelFit";

export const AGGREGATED_STATS_VERSION = 3;

export interface AggregatedStatsFreshnessFingerprint {
  latestWorkoutId: string | null;
  computationVersion: number;
  maxHr: number;
  restingHr: number;
  activeRaceId: string | null;
  activeRaceDate: string | null;
  overridesRevision: string;
  localCalendarDate: string;
  localCalendarYear: number;
}

export interface Vo2FreshnessKey {
  latestVo2SampleDate: string | null;
}

function stableSerialize(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function stableRevision(value: unknown): string {
  const serialized = stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function overridesRevision(overrides: unknown): string {
  const count = Array.isArray(overrides)
    ? overrides.length
    : overrides && typeof overrides === "object"
      ? Object.keys(overrides).length
      : 0;
  return `${count}:${stableRevision(overrides)}`;
}

export function computeWorkoutAggregationRevision(
  workouts: HealthWorkout[]
): string {
  return stableRevision(
    workouts.map((workout) => ({
      workoutId: workout.workoutId,
      startDate: workout.startDate,
      endDate: workout.endDate,
      syncedAt: workout.syncedAt,
      durationSeconds: workout.durationSeconds,
      distanceMiles: workout.distanceMiles,
      activityType: workout.activityType,
      sourceName: workout.sourceName,
      isRunLike: workout.isRunLike,
      hasRoute: workout.hasRoute,
      avgHeartRate: workout.avgHeartRate,
      bestEfforts: workout.bestEfforts,
      trainingLoadV2: workout.trainingLoadV2,
    }))
  );
}

function localCalendarDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function computeFreshnessFingerprint(inputs: {
  latestWorkoutId: string | null;
  computationVersion: number;
  maxHr: number;
  restingHr: number;
  activeRaceId: string | null;
  activeRaceDate: string | null;
  overrides: unknown;
}): AggregatedStatsFreshnessFingerprint {
  const now = new Date();
  return {
    latestWorkoutId: inputs.latestWorkoutId,
    computationVersion: inputs.computationVersion,
    maxHr: inputs.maxHr,
    restingHr: inputs.restingHr,
    activeRaceId: inputs.activeRaceId,
    activeRaceDate: inputs.activeRaceDate,
    overridesRevision: overridesRevision(inputs.overrides),
    localCalendarDate: localCalendarDate(now),
    localCalendarYear: now.getFullYear(),
  };
}

export function isFingerprintStale(
  cached: AggregatedStatsFreshnessFingerprint,
  current: AggregatedStatsFreshnessFingerprint
): boolean {
  return (
    cached.latestWorkoutId !== current.latestWorkoutId ||
    cached.computationVersion !== current.computationVersion ||
    cached.maxHr !== current.maxHr ||
    cached.restingHr !== current.restingHr ||
    cached.activeRaceId !== current.activeRaceId ||
    cached.activeRaceDate !== current.activeRaceDate ||
    cached.overridesRevision !== current.overridesRevision ||
    cached.localCalendarDate !== current.localCalendarDate ||
    cached.localCalendarYear !== current.localCalendarYear
  );
}

export function computeVo2FreshnessKey(
  latestVo2SampleDate: string | null
): Vo2FreshnessKey {
  return { latestVo2SampleDate };
}

export function isVo2Stale(
  cached: Vo2FreshnessKey,
  current: Vo2FreshnessKey
): boolean {
  return cached.latestVo2SampleDate !== current.latestVo2SampleDate;
}

/**
 * Narrow compatibility check for the run-detail CTL shortcut, whose caller
 * does not own the full Insights dependency set. Personal Insights uses the
 * complete fingerprint checks above.
 */
export function isAggregatedStatsStale(
  cached: AggregatedStatsDoc | null,
  latestWorkoutId: string | null
): boolean {
  if (!cached?.freshnessFingerprint) return true;
  return (
    cached.freshnessFingerprint.computationVersion !==
      AGGREGATED_STATS_VERSION ||
    cached.freshnessFingerprint.latestWorkoutId !== latestWorkoutId
  );
}

export interface AggregatedStatsDoc {
  computationVersion: number;
  freshnessFingerprint: AggregatedStatsFreshnessFingerprint;
  vo2FreshnessKey: Vo2FreshnessKey;
  computedAt: string; // ISO timestamp
  latestWorkoutId: string;
  latestWorkoutStartDate: string; // ISO date
  trainingLoad: {
    series: { date: string; ctl: number; atl: number; tsb: number }[];
  };
  vo2History: ReturnType<typeof buildVo2History>;
  racePredictions: {
    t5k: number | null;
    t10: number | null;
    tHalf: number | null;
    tMar: number | null;
    confidenceLevel: "good" | "ok" | "low";
    modelFit: { n: number; r2: number; k: number } | null;
  };
  personalRecordsByYear: ReturnType<typeof buildPersonalRecordsByYear>;
  paceTrends: ReturnType<typeof buildPaceTrendsByDistanceBucket>;
  hrZoneDistribution: ReturnType<typeof buildHrZoneDistribution>;
  fastestMileSegment: ReturnType<typeof findBestFastestMileAcrossRuns>;
}

/**
 * Normalize a cached AggregatedStatsDoc read back from Firestore.
 *
 * The write path serializes via JSON.parse(JSON.stringify(...)), which turns
 * every `Date` into an ISO string. On a cache-hit read those `date` leaves come
 * back as strings even though the TS type says `Date`, so callers that do
 * `.toLocaleDateString()` crash. This revives the three Date-typed leaves
 * (fastestMileSegment.date, personalRecordsByYear.prs[*].date,
 * personalRecordsByYear.specificPrs[*].date) back into real Date instances.
 *
 * Returns a new object; does not mutate `cached`. Null-safe at every level.
 */
export function reviveAggregatedStatsDates(
  cached: AggregatedStatsDoc
): AggregatedStatsDoc {
  const { fastestMileSegment, personalRecordsByYear } = cached;

  return {
    ...cached,
    fastestMileSegment: fastestMileSegment
      ? { ...fastestMileSegment, date: new Date(fastestMileSegment.date) }
      : fastestMileSegment,
    personalRecordsByYear: {
      ...personalRecordsByYear,
      prs: (personalRecordsByYear?.prs ?? []).map((pr) =>
        pr ? { ...pr, date: new Date(pr.date) } : pr
      ),
      specificPrs: (personalRecordsByYear?.specificPrs ?? []).map((pr) =>
        pr ? { ...pr, date: new Date(pr.date) } : pr
      ),
    },
  };
}

export interface BuildAggregatedStatsInputs {
  workouts: HealthWorkout[];
  mileSplitsByWorkoutId: Record<string, MileSplitDoc[]>;
  healthMetrics: { id: string; data: { date?: string; vo2_max?: number } }[];
  maxHr: number;
  restingHr: number;
  now: Date;
  races: { raceDate: Date | string; distanceMiles: number }[];
  freshnessFingerprint: AggregatedStatsFreshnessFingerprint;
  vo2FreshnessKey: Vo2FreshnessKey;
  vo2HistoryOverride?: ReturnType<typeof buildVo2History>;
}

/**
 * Build the current-year fastest mile entirely from persisted parent-workout
 * best efforts. Missing/corrupt values are skipped; there is deliberately no
 * route fallback in the aggregation path.
 */
export function buildFastestMileFromBestEfforts(
  workouts: HealthWorkout[],
  year: number
): ReturnType<typeof findBestFastestMileAcrossRuns> {
  const results = workouts.map((run) => {
    if (!run.isRunLike || run.startDate.getFullYear() !== year) return null;
    const seconds = run.bestEfforts?.["1mi"];
    return typeof seconds === "number" && Number.isFinite(seconds)
      ? { seconds, date: run.startDate }
      : null;
  });
  return findBestFastestMileAcrossRuns(results);
}

export function buildAggregatedStats(
  inputs: BuildAggregatedStatsInputs
): AggregatedStatsDoc {
  const {
    workouts,
    mileSplitsByWorkoutId,
    healthMetrics,
    maxHr,
    restingHr,
    now,
    races,
    freshnessFingerprint,
    vo2FreshnessKey,
    vo2HistoryOverride,
  } = inputs;

  const computedAt = now.toISOString();

  if (workouts.length === 0) {
    return {
      computationVersion: AGGREGATED_STATS_VERSION,
      freshnessFingerprint,
      vo2FreshnessKey,
      computedAt,
      latestWorkoutId: "",
      latestWorkoutStartDate: "",
      trainingLoad: { series: [] },
      vo2History: [],
      racePredictions: {
        t5k: null,
        t10: null,
        tHalf: null,
        tMar: null,
        confidenceLevel: "low",
        modelFit: null,
      },
      personalRecordsByYear: { prs: [], specificPrs: [] },
      paceTrends: [],
      hrZoneDistribution: { runsCounted: 0, totalMiles: 0, zoneMiles: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
      fastestMileSegment: null,
    };
  }

  // Find latest workout
  const latestWorkout = workouts.reduce((latest, current) =>
    current.startDate > latest.startDate ? current : latest
  );

  // 1. Training Load
  const dailyMap = buildDailyLoadMap(workouts, maxHr, restingHr);
  // Display window matches page.tsx
  const DISPLAY_DAYS = 112; 
  const displayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  displayStart.setDate(displayStart.getDate() - (DISPLAY_DAYS - 1));
  
  const earliestWorkoutTime = workouts.reduce(
    (min, w) => Math.min(min, w.startDate.getTime()),
    Infinity
  );
  const seedFromHistory = isFinite(earliestWorkoutTime) ? new Date(earliestWorkoutTime) : null;
  const SEED_DAYS = 180;
  const seedFromSeedWindow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  seedFromSeedWindow.setDate(seedFromSeedWindow.getDate() - (SEED_DAYS - 1));
  const seedStart = seedFromHistory && seedFromHistory > seedFromSeedWindow
    ? seedFromHistory
    : seedFromSeedWindow;

  const displayStartIso = displayStart.toISOString().split("T")[0];
  const rawSeries = buildLoadEwmaSeries(dailyMap, seedStart, now);
  const series = rawSeries
    .filter((p) => p.date >= displayStartIso)
    .map((p) => ({
      date: p.date,
      ctl: p.ctl,
      atl: p.atl,
      tsb: p.tsb,
    }));

  // 2. VO2 History
  const vo2History = vo2HistoryOverride ?? buildVo2History(healthMetrics);

  // 3. Race Predictions
  const runInputs = workouts.map((r) => ({
    workoutId: r.workoutId,
    distanceMiles: r.distanceMiles,
    durationSeconds: r.durationSeconds,
    startDate: r.startDate,
    activityType: r.activityType,
    sourceName: r.sourceName,
  }));

  // Pass races to buildQualifyingEfforts
  const efforts = buildQualifyingEfforts(runInputs, 56, { races });
  
  const fit5k = fitRiegel(efforts, 3.1069, 0, { min: 0.9, max: 1.3 });
  const fitTen = fitRiegel(efforts, 10.0, 3.0, { min: 1.04, max: 1.10 });
  const fitHalf = fitRiegel(efforts, 13.109, 3.0, { min: 1.04, max: 1.10 });
  const fitMarathon = fitRiegel(efforts, 26.219, 3.0, { min: 1.04, max: 1.10 });

  const t5k = fit5k ? predictSeconds(fit5k, 3.1069) : null;
  const t10 = fitTen ? predictSeconds(fitTen, 10.0) : null;
  const tHalf = fitHalf ? predictSeconds(fitHalf, 13.109) : null;
  const tMar = fitMarathon ? predictSeconds(fitMarathon, 26.219) : null;

  function overallConfidence(f5k: RiegelFit | null, fLong: RiegelFit | null): "good" | "ok" | "low" {
    if (!fLong) return "low";
    if (fLong.n >= 6 && fLong.r2 >= 0.55) return "good";
    if (fLong.n >= 4 && fLong.r2 >= 0.45) return "ok";
    return "low";
  }

  const confidenceLevel = overallConfidence(fit5k, fitHalf);
  const rawModelFit = fitHalf ?? fitMarathon ?? fitTen;
  const modelFit = rawModelFit ? { n: rawModelFit.n, r2: rawModelFit.r2, k: rawModelFit.k } : null;

  // 4. Personal Records
  const personalRecordsByYear = buildPersonalRecordsByYear(workouts, now.getFullYear());

  // 5. Pace Trends
  const paceTrends = buildPaceTrendsByDistanceBucket(workouts, 8, now);

  // 6. HR Zone Distribution
  const perRunMileSplits: MileSplitSample[][] = workouts.map((run) => {
    const rawSplits = mileSplitsByWorkoutId[run.workoutId] || [];
    const totalMi = run.distanceMiles;
    const fullMiles = Math.floor(totalMi);
    const partial = totalMi - fullMiles;
    
    const miles: MileSplitSample[] = [];
    rawSplits.forEach((data) => {
      const mile = typeof data.mile === "number" ? data.mile : null;
      const avgBpm = typeof data.avgBpm === "number" ? data.avgBpm : null;
      const sampleCount = typeof data.sampleCount === "number" ? data.sampleCount : 0;
      if (mile == null || avgBpm == null) return;
      if (sampleCount < 2) return;
      if (avgBpm < 40 || avgBpm > 220) return;

      let distance: number;
      if (mile <= fullMiles) {
        distance = 1.0;
      } else if (mile === fullMiles + 1 && partial > 0) {
        distance = partial;
      } else {
        return;
      }
      miles.push({ mile, bpm: avgBpm, distance });
    });
    return miles;
  });
  const hrZoneDistribution = buildHrZoneDistribution(perRunMileSplits, maxHr);

  // 7. Fastest Mile Segment — persisted parent-doc value, current year only.
  const fastestMileSegmentResult = buildFastestMileFromBestEfforts(
    workouts,
    now.getFullYear()
  );

  return {
    computationVersion: AGGREGATED_STATS_VERSION,
    freshnessFingerprint,
    vo2FreshnessKey,
    computedAt,
    latestWorkoutId: latestWorkout.workoutId,
    latestWorkoutStartDate: latestWorkout.startDate.toISOString(),
    trainingLoad: { series },
    vo2History,
    racePredictions: {
      t5k,
      t10,
      tHalf,
      tMar,
      confidenceLevel,
      modelFit,
    },
    personalRecordsByYear,
    paceTrends,
    hrZoneDistribution,
    fastestMileSegment: fastestMileSegmentResult,
  };
}
