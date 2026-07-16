import { type RoutePoint } from "@/services/routes";
import { type MileSplitDoc } from "@/utils/mileSplitsCache";
import { type HealthWorkout } from "@/types/healthWorkout";
import { buildVo2History } from "./vo2History";
import { buildPersonalRecordsByYear } from "./personalRecords";
import { buildPaceTrendsByDistanceBucket } from "./paceTrends";
import { buildHrZoneDistribution, type MileSplitSample } from "./hrZoneDistribution";
import { findBestFastestMileAcrossRuns, fastestMileSegment } from "./fastestMileSegment";
import { buildDailyLoadMap, buildLoadEwmaSeries } from "./trainingLoadSeries";
import { buildQualifyingEfforts, fitRiegel, predictSeconds, type RiegelFit } from "./riegelFit";

export const AGGREGATED_STATS_VERSION = 1;

export interface AggregatedStatsDoc {
  computationVersion: number;
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

export function isAggregatedStatsStale(
  cached: AggregatedStatsDoc | null,
  latestWorkoutId: string
): boolean {
  if (cached === null) return true;
  if (cached.computationVersion !== AGGREGATED_STATS_VERSION) return true;
  if (cached.latestWorkoutId !== latestWorkoutId) return true;
  return false;
}

export interface BuildAggregatedStatsInputs {
  workouts: HealthWorkout[];
  routePointsByWorkoutId: Record<string, RoutePoint[]>;
  mileSplitsByWorkoutId: Record<string, MileSplitDoc[]>;
  healthMetrics: { id: string; data: { date?: string; vo2_max?: number } }[];
  maxHr: number;
  restingHr: number;
  now: Date;
}

export function buildAggregatedStats(
  inputs: BuildAggregatedStatsInputs
): AggregatedStatsDoc {
  const {
    workouts,
    routePointsByWorkoutId,
    mileSplitsByWorkoutId,
    healthMetrics,
    maxHr,
    restingHr,
    now,
  } = inputs;

  const computedAt = now.toISOString();

  if (workouts.length === 0) {
    return {
      computationVersion: AGGREGATED_STATS_VERSION,
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
  const vo2History = buildVo2History(healthMetrics);

  // 3. Race Predictions
  const runInputs = workouts.map((r) => ({
    workoutId: r.workoutId,
    distanceMiles: r.distanceMiles,
    durationSeconds: r.durationSeconds,
    startDate: r.startDate,
    activityType: r.activityType,
    sourceName: r.sourceName,
  }));

  // GAP: `races` is not provided in BuildAggregatedStatsInputs. 
  // We pass undefined/empty to `buildQualifyingEfforts` per instructions not to invent a workaround.
  const efforts = buildQualifyingEfforts(runInputs, 56, { races: [] });
  
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

  // 7. Fastest Mile Segment
  const fastestMileResults = workouts.map(run => {
    if (run.distanceMiles < 1.0) return null;
    const points = routePointsByWorkoutId[run.workoutId] || [];
    const seconds = fastestMileSegment(points);
    return seconds ? { seconds, date: run.startDate } : null;
  });
  const fastestMileSegmentResult = findBestFastestMileAcrossRuns(fastestMileResults);

  return {
    computationVersion: AGGREGATED_STATS_VERSION,
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
