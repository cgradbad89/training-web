import { type BestEffortsMap } from "@/utils/bestEfforts";
import { type WeatherSnapshot } from "@/types/weather";
import { type MileSplit } from "@/utils/mileSplits";
import { type OverlayChartCache } from "@/utils/overlayChartCache";
import { type ZoneBreakdownCache } from "@/utils/zoneBreakdown";
import { type SimplifiedPathPoint } from "@/utils/simplifyPolyline";

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
  /** iOS route-completion marker: true = full route written, false = partial
   *  (still completing on a later wake), absent = legacy doc (treat as
   *  complete). Display-hint only — a partial route still renders its points;
   *  route availability is NEVER gated on this. */
  routeComplete?: boolean;
  /** True when iOS wrote a per-sample HR stream subcollection (hrStream) for
   *  this workout. Drives the streamed-load path for non-route workouts.
   *  Absent/false ⇒ no stream (fall back to avg HR). */
  hasHRStream?: boolean;
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
  /** Whether the route basis was COMPLETE (routeComplete !== false) at the moment
   *  trainingLoadV2 was computed. Written by computeAndStoreTrainingLoad. Lets the
   *  enrich guard recompute a "streamed" load exactly once after a two-pass iOS
   *  sync finishes — when routeComplete flips to true but this still reads false —
   *  without re-running healthy, already-complete loads. Absent on legacy docs. */
  trainingLoadBasisComplete?: boolean;
  /** Historical weather at the run's start point/time, fetched from Open-Meteo
   *  and persisted by the web app. Absent on iOS-synced docs until backfilled
   *  (null/undefined = not yet fetched or no GPS). */
  weather?: WeatherSnapshot | null;
  /** Deterministic route-cluster ID (see src/utils/routeClusterId.ts). Written
   *  lazily by the web app (run-detail view / backfill); absent until then.
   *  Drives the narrow Route Performance query. */
  routeClusterId?: string;
  /** Decimated pace/HR/elevation series for the overlay chart, computed once
   *  from the route subcollection and cached here by the web app. Absent until
   *  the run's detail page has been viewed. */
  overlayChartCache?: OverlayChartCache;
  /** Run-level grade-adjusted pace (sec/mi) — the GAP KPI value. Cached from the
   *  full route on first detail view; lets the KPI render without a route read.
   *  No basis field, so it is only used/written when there is no distance or
   *  duration override (an override recomputes GAP live from the route). */
  gapSecPerMile?: number;
  /** Cached HR + pace zone breakdown, tagged with the maxHR / threshold pace it
   *  was computed against (stale when the current settings differ). Absent until
   *  the run's detail page has been viewed. */
  zoneBreakdown?: ZoneBreakdownCache;
  /** Douglas–Peucker simplified map path, computed once from the full route so
   *  the map renders without a route read. Absent until the detail page has been
   *  viewed. */
  simplifiedPath?: SimplifiedPathPoint[];
  /** TRANSIENT (never persisted to Firestore): per-mile splits hydrated from the
   *  GPS `route` subcollection (pace) merged with the `mileSplits` subcollection
   *  (per-mile avgBpm). Attached at the wiring layer for HR-gated best-effort
   *  extraction — see src/utils/bestEffortExtraction.ts. */
  mileSplits?: MileSplit[];
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
