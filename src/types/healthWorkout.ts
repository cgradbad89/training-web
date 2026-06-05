import { type BestEffortsMap } from "@/utils/bestEfforts";

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
  /** PR badge labels held by this run, e.g. ["5K PR", "1 Mile PR"].
   *  Computed by PRComputerRunner; absent or empty = no PRs. */
  prBadges?: string[];
  /** Standard-distance best efforts, keyed by distance → timeSeconds | null. */
  bestEfforts?: BestEffortsMap;
  /** Training Load V2 (Banister HR-reserve) score; null when HR/duration can't
   *  yield a score (UI renders "—"). Written by computeAndStoreTrainingLoad. */
  trainingLoadV2?: number | null;
  /** Which V2 model produced trainingLoadV2: per-second "streamed" integral or
   *  the avg-HR baseline ("avg-hr-fallback"). */
  trainingLoadMethod?: "streamed" | "avg-hr-fallback";
}

export function isRunWorkout(w: HealthWorkout): boolean {
  return w.isRunLike;
}

export function isNonRunWorkout(w: HealthWorkout): boolean {
  return !w.isRunLike;
}

// Efficiency-score helpers (computeEfficiencyDisplay / efficiencyColor) were
// removed when the efficiency metric was replaced by Training Load — see
// src/utils/trainingLoad.ts. The Firestore fields `efficiencyRaw` and
// `efficiencyScore` on HealthWorkout remain in the type for backward compat
// with iOS-synced docs but are no longer read by any UI.

export function driftColor(pct: number): "good" | "ok" | "low" {
  if (pct <= 5) return "good";
  if (pct <= 12) return "ok";
  return "low";
}
