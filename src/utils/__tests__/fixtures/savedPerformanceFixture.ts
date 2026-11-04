import type { HealthWorkout } from "@/types/healthWorkout";
import type { SavedPerformanceCurrent } from "@/types/performancePersistence";
import { buildPerformanceSnapshotPayload, calculatePerformanceAnalysis, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS } from "@/utils/performanceAnalysis";

export const SAVED_CUTOFF = "2026-10-21T14:00:00.000Z";
export const ASSESSMENT_NOW = "2026-11-04T14:00:00.000Z";

export function metadataRun(id = "incorporated", startedAt = "2026-10-20T12:00:00.000Z"): HealthWorkout {
  const startDate = new Date(startedAt);
  return { workoutId: id, name: "Synthetic Run", displayType: "Run", activityType: "running",
    startDate, endDate: new Date(startDate.getTime() + 1800000), durationSeconds: 1800,
    syncedAt: startDate, sourceName: "Synthetic Watch", isRunLike: true, hasRoute: true,
    routeComplete: true, hasHRStream: true, calories: 200, avgHeartRate: 142,
    distanceMiles: 3, distanceMeters: 4828.032, avgPaceSecPerMile: 600, avgSpeedMPS: 2.68224,
    hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: 0 };
}

export async function savedPerformanceFixture(): Promise<SavedPerformanceCurrent> {
  const result = await calculatePerformanceAnalysis({ asOf: SAVED_CUTOFF, timeZone: "America/New_York",
    workouts: [], features: [], linkedRaces: [], deviceVo2: [], versions: PERFORMANCE_VERSIONS, ...PERFORMANCE_DEFAULTS,
    coverage: { window: { startDate: "2026-04-25", endDate: "2026-10-21" }, workouts: "partial", telemetry: "partial",
      deviceVo2: "unknown", expectedWorkoutCount: null, limitations: ["Synthetic, bounded coverage."] } });
  return { schemaVersion: 1, revision: 1, snapshotId: "a".repeat(64), previousSnapshotId: null,
    publicationDigest: "b".repeat(64), committedAt: null,
    featureRevisions: [{ workoutId: "incorporated", revision: 1, featureDigest: "c".repeat(64) }],
    payload: buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: SAVED_CUTOFF,
      calculationCompletedAt: "2026-10-21T14:00:01.000Z", provenance: [] }) };
}
