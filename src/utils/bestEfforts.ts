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

const METERS_PER_MILE = 1609.344;

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

// Stored shape on the workout doc — null when run is shorter than the distance.
export type BestEffortsMap = Record<BestEffortKey, number | null>; // key → timeSeconds

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

  return result;
}

export function bestEffortToPaceSecPerMile(
  distanceKey: BestEffortKey,
  timeSeconds: number
): number {
  return timeSeconds / (BEST_EFFORT_DISTANCES_M[distanceKey] / METERS_PER_MILE);
}
