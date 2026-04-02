/**
 * HealthWorkout — mirrors the Firestore document stored at
 * users/{uid}/healthWorkouts/{workoutId}
 *
 * Written by iOS HealthKitSyncService from HealthKit data.
 */

export interface HealthWorkout {
  workoutId: string;
  /** Equals displayType — used as a display name across the UI */
  name: string;
  activityType: string;   // raw HK activity type string
  displayType: string;    // human-readable: "Run", "Treadmill Run", "Strength", etc.
  startDate: Date;
  endDate: Date;
  durationSeconds: number;
  sourceName: string;
  isRunLike: boolean;
  hasRoute: boolean;
  syncedAt: Date;
  sourceBundle?: string;
  calories: number;
  avgHeartRate: number | null;
  distanceMiles: number;
  distanceMeters: number | null;
  avgPaceSecPerMile: number | null;
  avgSpeedMPS: number | null;
  hrDriftPct: number | null;
  cadenceSPM: number | null;
  efficiencyRaw: number | null;
  efficiencyScore: number | null;
  elevationGainM: number | null;
}

export function isRunWorkout(w: HealthWorkout): boolean {
  return w.isRunLike;
}

export function isNonRunWorkout(w: HealthWorkout): boolean {
  return !w.isRunLike;
}

/**
 * Returns the efficiency display score (roughly 0–3 range).
 * Prefers the pre-computed efficiencyScore from iOS, falls back to
 * computing from raw speed/HR.
 */
export function computeEfficiencyDisplay(w: HealthWorkout): number | null {
  if (w.efficiencyScore != null) return w.efficiencyScore;
  if (w.efficiencyRaw != null) return w.efficiencyRaw * 1000.0;
  if (
    w.avgSpeedMPS != null &&
    w.avgHeartRate != null &&
    w.avgSpeedMPS > 0 &&
    w.avgHeartRate > 0
  ) {
    return (w.avgSpeedMPS / w.avgHeartRate) * 1000;
  }
  return null;
}

export function efficiencyColor(score: number): "good" | "ok" | "low" {
  if (score >= 1.5) return "good";
  if (score >= 1.0) return "ok";
  return "low";
}

export function driftColor(pct: number): "good" | "ok" | "low" {
  if (pct <= 5) return "good";
  if (pct <= 12) return "ok";
  return "low";
}
