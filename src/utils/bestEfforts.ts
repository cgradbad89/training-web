/**
 * Best Efforts.
 *
 * Finds the fastest elapsed-time continuous segment for standard race
 * distances using the GPS route. Stops/micro-pauses are intentionally included
 * in elapsed time to match Strava-style best efforts; do not apply GAP's
 * moving-time stop filtering here.
 */

import { type RoutePoint } from "@/services/routes";
import { haversineMeters } from "@/utils/mileSplits";
import {
  BEST_EFFORTS_COMPUTATION_VERSION,
  fastestMileSegment,
  isValidFastestMileSeconds,
} from "@/utils/fastestMileSegment";

export const METERS_PER_MILE = 1609.344;

// Standard best-effort distances, in meters.
export const BEST_EFFORT_DISTANCES_M = {
  // One mile.
  "1mi": 1609.344,
  // Five kilometers.
  "5k": 5000,
  // Ten kilometers.
  "10k": 10000,
  // Ten miles.
  "10mi": 16093.44,
  // Half marathon.
  half: 21097.5,
} as const;

export type BestEffortKey = keyof typeof BEST_EFFORT_DISTANCES_M;

export interface BestEffort {
  distanceKey: BestEffortKey;
  timeSeconds: number; // fastest time to cover that distance
  paceSecPerMile: number; // derived
}

/** Freshness basis persisted alongside the existing distance keys. */
export interface BestEffortEntry {
  computedFromRouteComplete: boolean;
  computedFromPointCount: number;
  computationVersion: number;
  /** Total GPS distance of the points the values were computed from (diagnostic; explains a legitimately null key). */
  computedFromRouteDistanceMeters?: number;
  /**
   * How many times a recompute still left this record looking implausible against the workout (a point count far below the
   * workout's duration, or a null key shorter than the workout). Bounded by BEST_EFFORTS_VERIFICATION.maxAttempts so a route that
   * is genuinely sparse or gapped is accepted as "legitimately unavailable" instead of being recomputed on every visit.
   */
  verificationAttempts?: number;
}

// Stored shape on the workout doc — null when run is shorter than the distance.
// Freshness fields are optional in the read type because legacy Firestore docs
// do not have them; every new write supplies all three via
// withBestEffortsFreshness().
export type BestEffortsMap = Record<BestEffortKey, number | null> &
  Partial<BestEffortEntry> & {
    /** READ-SIDE ONLY (never persisted): a stored distance value was present but not a finite number. */
    invalidStoredValues?: boolean;
  }; // distance key → timeSeconds, plus freshness basis

const BEST_EFFORT_KEYS = Object.keys(
  BEST_EFFORT_DISTANCES_M
) as BestEffortKey[];

export const EMPTY_BEST_EFFORTS: BestEffortsMap = {
  "1mi": null,
  "5k": null,
  "10k": null,
  "10mi": null,
  half: null,
};

function interpolateTimeAtDistance(
  cumulativeDistanceMeters: number[],
  cumulativeTimeSeconds: number[],
  rightIndex: number,
  targetDistanceMeters: number
): number {
  if (rightIndex <= 0) return cumulativeTimeSeconds[0] ?? 0;

  const prevDistance = cumulativeDistanceMeters[rightIndex - 1];
  const currDistance = cumulativeDistanceMeters[rightIndex];
  const prevTime = cumulativeTimeSeconds[rightIndex - 1];
  const currTime = cumulativeTimeSeconds[rightIndex];
  const segmentDistance = currDistance - prevDistance;

  if (segmentDistance <= 0) return currTime;

  // Boundary interpolation: time = t0 + ((D - d0) / (d1 - d0)) * (t1 - t0).
  // This makes the effort exactly D meters instead of the slightly overshot
  // route-point distance, avoiding systematically slow best efforts.
  const fraction = (targetDistanceMeters - prevDistance) / segmentDistance;
  return prevTime + fraction * (currTime - prevTime);
}

function buildCumulativeArrays(points: RoutePoint[]): {
  cumulativeDistanceMeters: number[];
  cumulativeTimeSeconds: number[];
} {
  if (points.length < 2) {
    return { cumulativeDistanceMeters: [0], cumulativeTimeSeconds: [0] };
  }

  const cumulativeDistanceMeters: number[] = [0];
  const cumulativeTimeSeconds: number[] = [0];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const prevMs = Date.parse(prev.timestamp);
    const currMs = Date.parse(curr.timestamp);

    // Non-increasing or invalid timestamps make elapsed segment time unsafe.
    // Skip that segment; affected target distances will remain null if the
    // remaining valid route cannot cover them.
    if (!Number.isFinite(prevMs) || !Number.isFinite(currMs) || currMs <= prevMs) {
      continue;
    }

    const distance = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    if (!Number.isFinite(distance) || distance < 0) continue;

    cumulativeDistanceMeters.push(
      cumulativeDistanceMeters[cumulativeDistanceMeters.length - 1] + distance
    );
    cumulativeTimeSeconds.push(
      cumulativeTimeSeconds[cumulativeTimeSeconds.length - 1] +
        (currMs - prevMs) / 1000
    );
  }

  return { cumulativeDistanceMeters, cumulativeTimeSeconds };
}

function computeForDistance(
  cumulativeDistanceMeters: number[],
  cumulativeTimeSeconds: number[],
  targetDistanceMeters: number
): number | null {
  const totalDistance =
    cumulativeDistanceMeters[cumulativeDistanceMeters.length - 1] ?? 0;
  if (totalDistance < targetDistanceMeters) return null;

  let bestSeconds = Infinity;
  let right = 0;

  // Two-pointer sliding window, O(n): each pointer only moves forward.
  for (let left = 0; left < cumulativeDistanceMeters.length; left++) {
    if (right < left) right = left;

    // Expand right until the window spans at least the target distance.
    while (
      right < cumulativeDistanceMeters.length &&
      cumulativeDistanceMeters[right] - cumulativeDistanceMeters[left] <
        targetDistanceMeters
    ) {
      right++;
    }

    if (right >= cumulativeDistanceMeters.length) break;

    const targetEndDistance =
      cumulativeDistanceMeters[left] + targetDistanceMeters;
    const endTime = interpolateTimeAtDistance(
      cumulativeDistanceMeters,
      cumulativeTimeSeconds,
      right,
      targetEndDistance
    );
    const elapsedSeconds = endTime - cumulativeTimeSeconds[left];

    if (elapsedSeconds > 0 && elapsedSeconds < bestSeconds) {
      bestSeconds = elapsedSeconds;
    }
  }

  return Number.isFinite(bestSeconds) ? bestSeconds : null;
}

export function computeBestEfforts(points: RoutePoint[]): BestEffortsMap {
  if (points.length < 2) return { ...EMPTY_BEST_EFFORTS };

  const { cumulativeDistanceMeters, cumulativeTimeSeconds } =
    buildCumulativeArrays(points);
  const totalDistance =
    cumulativeDistanceMeters[cumulativeDistanceMeters.length - 1] ?? 0;
  if (totalDistance <= 0) return { ...EMPTY_BEST_EFFORTS };

  const result: BestEffortsMap = { ...EMPTY_BEST_EFFORTS };

  for (const key of BEST_EFFORT_KEYS) {
    const distanceMeters = BEST_EFFORT_DISTANCES_M[key];
    const timeSeconds = computeForDistance(
      cumulativeDistanceMeters,
      cumulativeTimeSeconds,
      distanceMeters
    );

    // paceSecPerMile = timeSeconds / (D_meters / 1609.344). The persisted map
    // stores only timeSeconds; UI can derive pace from the same distance table.
    result[key] = timeSeconds;
  }

  // Keep the persisted 1mi value byte-for-byte aligned with the historical
  // Personal Insights route algorithm. Other standard distances continue to
  // use the generalized meter-based implementation above.
  const fastestMileSeconds = fastestMileSegment(points);
  result["1mi"] = isValidFastestMileSeconds(fastestMileSeconds)
    ? fastestMileSeconds
    : null;

  return result;
}

/** Parse a persisted `bestEfforts` map; unusable values become null and are flagged (read-side only) so the freshness policy can see corruption. */
export function parseStoredBestEfforts(value: unknown): BestEffortsMap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const parsed: BestEffortsMap = { ...EMPTY_BEST_EFFORTS };
  for (const key of BEST_EFFORT_KEYS) {
    const v = raw[key];
    parsed[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
    if (v !== undefined && v !== null && parsed[key] === null) parsed.invalidStoredValues = true;
  }
  parsed.computedFromRouteComplete = typeof raw.computedFromRouteComplete === "boolean" ? raw.computedFromRouteComplete : undefined;
  parsed.computedFromPointCount = typeof raw.computedFromPointCount === "number" && Number.isFinite(raw.computedFromPointCount) ? raw.computedFromPointCount : undefined;
  parsed.computationVersion = typeof raw.computationVersion === "number" && Number.isFinite(raw.computationVersion) ? raw.computationVersion : undefined;
  if (typeof raw.computedFromRouteDistanceMeters === "number" && Number.isFinite(raw.computedFromRouteDistanceMeters)) parsed.computedFromRouteDistanceMeters = raw.computedFromRouteDistanceMeters;
  if (typeof raw.verificationAttempts === "number" && Number.isFinite(raw.verificationAttempts) && raw.verificationAttempts > 0) parsed.verificationAttempts = raw.verificationAttempts;
  return parsed;
}

/** Total GPS distance of the usable segments (same segment screening as computeBestEfforts). */
export function routeDistanceMeters(points: RoutePoint[]): number {
  if (points.length < 2) return 0;
  const { cumulativeDistanceMeters } = buildCumulativeArrays(points);
  return cumulativeDistanceMeters[cumulativeDistanceMeters.length - 1] ?? 0;
}

export function withBestEffortsFreshness(
  efforts: BestEffortsMap,
  routeComplete: boolean,
  pointCount: number,
  extra: { routeDistanceMeters?: number; verificationAttempts?: number } = {}
): BestEffortsMap & BestEffortEntry {
  return {
    ...efforts,
    computedFromRouteComplete: routeComplete,
    computedFromPointCount: pointCount,
    computationVersion: BEST_EFFORTS_COMPUTATION_VERSION,
    ...(extra.routeDistanceMeters !== undefined && Number.isFinite(extra.routeDistanceMeters)
      ? { computedFromRouteDistanceMeters: extra.routeDistanceMeters } : {}),
    ...(extra.verificationAttempts ? { verificationAttempts: extra.verificationAttempts } : {}),
  };
}

/**
 * Cache-integrity policy for the persisted best-effort map (see PRD §6 "best-effort cache integrity").
 * Pure: decided from the stored record, the workout's own route-completion marker and (optionally) the workout's duration/distance.
 */
export const BEST_EFFORTS_VERIFICATION = Object.freeze({
  /** A recompute that still looks implausible is retried at most this many times in the record's lifetime. */
  maxAttempts: 2,
  /** HealthKit routes sample about once per second; a stored basis far below that is a truncated (mid-upload) route. */
  minPointsPerSecond: 0.5,
  minDurationForDensitySeconds: 120,
  /** A key is "expected" when its distance is at most this share of the workout's reported distance. */
  expectedDistanceShare: 0.95,
  plausibleSecondsPerMile: { min: 150, max: 3000 },
});

export type BestEffortCacheState =
  | "valid_current"
  | "missing_recoverable"
  | "stale_version"
  | "incomplete_route_completed"
  | "temporarily_incomplete"
  | "inconsistent_metadata"
  | "invalid_recoverable"
  | "suspicious_recoverable"
  | "unavailable_confirmed";

export interface WorkoutRouteFacts {
  distanceMiles?: number | null;
  durationSeconds?: number | null;
}
export interface BestEffortCacheAssessment {
  state: BestEffortCacheState;
  /** Whether the route should be (re)read and the map recomputed. */
  recompute: boolean;
  reasons: string[];
}

const positiveFinite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Values that cannot be a real best effort: implausible pace, or a longer distance faster than a shorter one. */
function invalidValueReasons(map: BestEffortsMap): string[] {
  const reasons: string[] = [];
  if (map.invalidStoredValues) reasons.push("non_finite_or_non_numeric_value");
  const { min, max } = BEST_EFFORTS_VERIFICATION.plausibleSecondsPerMile;
  let previous: { key: BestEffortKey; seconds: number } | null = null;
  for (const key of BEST_EFFORT_KEYS) {
    const seconds = map[key];
    if (seconds === null || seconds === undefined) continue;
    const pace = seconds / (BEST_EFFORT_DISTANCES_M[key] / METERS_PER_MILE);
    if (!(seconds > 0) || pace < min || pace > max) reasons.push(`implausible_${key}`);
    if (previous && seconds <= previous.seconds) reasons.push(`${key}_not_slower_than_${previous.key}`);
    previous = { key, seconds };
  }
  return reasons;
}

/** Why a record looks like it was computed from a truncated or failed route, judged against the workout (empty = plausible). */
export function bestEffortsSuspicion(map: BestEffortsMap, facts: WorkoutRouteFacts | undefined): string[] {
  if (!facts) return [];
  const V = BEST_EFFORTS_VERIFICATION, reasons: string[] = [];
  const duration = facts.durationSeconds, miles = facts.distanceMiles;
  if (positiveFinite(duration) && duration >= V.minDurationForDensitySeconds && positiveFinite(map.computedFromPointCount)
    && map.computedFromPointCount < V.minPointsPerSecond * duration) reasons.push("point_count_far_below_workout_duration");
  if (positiveFinite(miles)) {
    const workoutMeters = miles * METERS_PER_MILE;
    const missing = BEST_EFFORT_KEYS.filter(key => BEST_EFFORT_DISTANCES_M[key] <= V.expectedDistanceShare * workoutMeters && map[key] === null);
    if (missing.length) reasons.push(`null_for_distance_shorter_than_workout:${missing.join(",")}`);
  }
  return reasons;
}

export function assessBestEffortsCache(
  existing: BestEffortsMap | undefined,
  routeComplete: boolean,
  facts?: WorkoutRouteFacts
): BestEffortCacheAssessment {
  const done = (state: BestEffortCacheState, recompute: boolean, reasons: string[] = []): BestEffortCacheAssessment => ({ state, recompute, reasons });
  if (existing === undefined) return done("missing_recoverable", true, ["no_best_efforts_record"]);
  const invalid = invalidValueReasons(existing);
  if (invalid.length) return done("invalid_recoverable", true, invalid);
  if (existing.computationVersion !== BEST_EFFORTS_COMPUTATION_VERSION) return done("stale_version", true, ["computation_version_mismatch"]);
  if (existing.computedFromRouteComplete === false) {
    return routeComplete ? done("incomplete_route_completed", true, ["computed_from_partial_route_now_complete"])
      : done("temporarily_incomplete", false, ["route_still_incomplete"]);
  }
  if (existing.computedFromRouteComplete !== true || typeof existing.computedFromPointCount !== "number"
    || !Number.isFinite(existing.computedFromPointCount) || existing.computedFromPointCount < 0) {
    return done("inconsistent_metadata", true, ["freshness_metadata_missing_or_invalid"]);
  }
  const suspicion = bestEffortsSuspicion(existing, facts);
  if (suspicion.length) {
    return (existing.verificationAttempts ?? 0) < BEST_EFFORTS_VERIFICATION.maxAttempts
      ? done("suspicious_recoverable", true, suspicion)
      : done("unavailable_confirmed", false, suspicion);
  }
  return done("valid_current", false);
}

/**
 * Recompute exactly when the persisted value is absent, invalid, uses an old algorithm version, was computed from a partial route that
 * has since completed, has unusable freshness metadata, or looks computed from a truncated route (bounded retries). A genuinely
 * short, sparse or gapped route that already got its bounded retries is never recomputed again.
 */
export function shouldRecomputeBestEfforts(
  existing: BestEffortsMap | undefined,
  routeComplete: boolean,
  facts?: WorkoutRouteFacts
): boolean {
  return assessBestEffortsCache(existing, routeComplete, facts).recompute;
}

/**
 * The attempt counter for a freshly computed record: it advances only when the NEW record still looks implausible against the
 * workout, so a successful recovery carries no counter and a futile retry loop terminates.
 */
export function nextVerificationAttempts(
  existing: BestEffortsMap | undefined,
  fresh: BestEffortsMap,
  facts: WorkoutRouteFacts | undefined
): number {
  return bestEffortsSuspicion(fresh, facts).length ? (existing?.verificationAttempts ?? 0) + 1 : 0;
}

/**
 * Never replace a more complete or better-grounded result with a partial one: a current-version record computed from a complete
 * route is kept over one computed from an incomplete route or from fewer points.
 */
export function shouldReplaceBestEfforts(existing: BestEffortsMap | undefined, fresh: BestEffortsMap): boolean {
  if (existing === undefined) return true;
  const existingGood = existing.computationVersion === BEST_EFFORTS_COMPUTATION_VERSION && existing.computedFromRouteComplete === true
    && invalidValueReasons(existing).length === 0;
  if (!existingGood) return true;
  if (fresh.computedFromRouteComplete !== true) return false;
  if (positiveFinite(existing.computedFromPointCount) && typeof fresh.computedFromPointCount === "number"
    && fresh.computedFromPointCount < existing.computedFromPointCount) return false;
  return true;
}

export function bestEffortToPaceSecPerMile(
  distanceKey: BestEffortKey,
  timeSeconds: number
): number {
  return timeSeconds / (BEST_EFFORT_DISTANCES_M[distanceKey] / METERS_PER_MILE);
}
