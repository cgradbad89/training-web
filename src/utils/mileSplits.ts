/**
 * Compute per-mile split data from GPS route points.
 *
 * Uses cumulative haversine distance to slice route points into 1-mile
 * segments, then derives pace (from timestamps) and efficiency for each.
 */

import { type RoutePoint } from "@/services/routes";
import { efficiencyDisplayScore } from "@/utils/metrics";

export interface MileSplit {
  /** 1-indexed mile number */
  mile: number;
  /** Actual distance of this segment in miles (< 1.0 for final partial) */
  segmentMiles: number;
  /** Pace in seconds per mile */
  paceSecPerMile: number;
  /** Efficiency display score (1–10), or null if HR unavailable */
  efficiency: number | null;
  /** Whether this is a partial (final) mile */
  isPartial: boolean;
  /** Average heart rate for this mile from iOS-synced mileSplits subcollection */
  avgBpm?: number;
}

// ─── Haversine ──────────────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance between two lat/lng points, in miles. */
function haversineMi(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

// ─── Split computation ──────────────────────────────────────────────────────

/**
 * Compute mile splits from GPS route points.
 *
 * @param points   - Route points ordered by index, with timestamps
 * @param fallbackHR - Run-level avgHeartRate to use when per-point HR is unavailable
 */
export function computeMileSplits(
  points: RoutePoint[],
  fallbackHR: number | null
): MileSplit[] {
  if (points.length < 2) return [];

  // Build cumulative distance (miles) and timestamps
  const cumDist: number[] = [0];
  const timestamps: number[] = [new Date(points[0].timestamp).getTime()];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const d = haversineMi(prev.lat, prev.lng, curr.lat, curr.lng);
    cumDist.push(cumDist[i - 1] + d);
    timestamps.push(new Date(curr.timestamp).getTime());
  }

  const totalDist = cumDist[cumDist.length - 1];
  if (totalDist < 0.1) return []; // too short to split

  const fullMiles = Math.floor(totalDist);
  const splits: MileSplit[] = [];

  let segStart = 0; // index into points where current mile starts

  for (let mile = 1; mile <= fullMiles + 1; mile++) {
    const isLast = mile > fullMiles;
    const targetDist = isLast ? totalDist : mile;

    // If this is the last partial mile and it's negligibly short, skip
    if (isLast && totalDist - fullMiles < 0.05) break;

    // Find the first index where cumDist >= targetDist
    let segEnd = segStart;
    while (segEnd < cumDist.length - 1 && cumDist[segEnd] < targetDist) {
      segEnd++;
    }

    // Interpolate timestamp at the exact mile boundary
    const interpTimestamp = (() => {
      if (segEnd === 0) return timestamps[0];
      const prevDist = cumDist[segEnd - 1];
      const currDist = cumDist[segEnd];
      const distRange = currDist - prevDist;
      if (distRange === 0) return timestamps[segEnd];
      const fraction = (targetDist - prevDist) / distRange;
      return (
        timestamps[segEnd - 1] +
        fraction * (timestamps[segEnd] - timestamps[segEnd - 1])
      );
    })();

    // Start timestamp for this segment
    const startMileDist = mile === 1 ? 0 : mile - 1;
    const startTimestamp = (() => {
      if (mile === 1) return timestamps[0];
      // Find interpolated timestamp at (mile-1) boundary
      let idx = 0;
      while (idx < cumDist.length - 1 && cumDist[idx] < startMileDist) {
        idx++;
      }
      if (idx === 0) return timestamps[0];
      const prevDist = cumDist[idx - 1];
      const currDist = cumDist[idx];
      const distRange = currDist - prevDist;
      if (distRange === 0) return timestamps[idx];
      const fraction = (startMileDist - prevDist) / distRange;
      return (
        timestamps[idx - 1] +
        fraction * (timestamps[idx] - timestamps[idx - 1])
      );
    })();

    const segmentMiles = isLast ? totalDist - fullMiles : 1.0;
    const elapsedMs = interpTimestamp - startTimestamp;
    const elapsedSec = elapsedMs / 1000;

    // Pace: seconds per mile
    const paceSecPerMile =
      segmentMiles > 0 ? elapsedSec / segmentMiles : 0;

    // Speed in m/s for efficiency calc
    const segmentMeters = segmentMiles * 1609.344;
    const speedMps = elapsedSec > 0 ? segmentMeters / elapsedSec : 0;

    // Efficiency (uses run-level fallbackHR since no per-point HR exists)
    const efficiency =
      speedMps > 0 && fallbackHR != null && fallbackHR > 0
        ? efficiencyDisplayScore(speedMps, fallbackHR)
        : null;

    splits.push({
      mile,
      segmentMiles,
      paceSecPerMile,
      efficiency,
      isPartial: isLast,
    });

    segStart = segEnd;
  }

  return splits;
}
