/**
 * Compute per-mile split data from GPS route points.
 *
 * Uses cumulative haversine distance to slice route points into 1-mile
 * segments, then derives pace (from timestamps) for each.
 */

import { type RoutePoint } from "@/services/routes";
import { MIN_MOVING_SPEED_MS, MIN_MOVING_DIST_M } from "@/utils/movingTime";

export interface MileSplit {
  /** 1-indexed mile number */
  mile: number;
  /** Actual distance of this segment in miles (< 1.0 for final partial) */
  segmentMiles: number;
  /** Pace in seconds per mile */
  paceSecPerMile: number;
  /** Whether this is a partial (final) mile */
  isPartial: boolean;
  /** Average heart rate for this mile from iOS-synced mileSplits subcollection */
  avgBpm?: number;
}

// ─── Haversine ──────────────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.8;
const METERS_PER_MILE = 1609.344;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance between two lat/lng points, in miles. */
export function haversineMi(
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

/** Same 2D haversine as mile splits, converted to meters. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  return haversineMi(lat1, lng1, lat2, lng2) * METERS_PER_MILE;
}

// ─── Split computation ──────────────────────────────────────────────────────

/**
 * Compute mile splits from GPS route points.
 *
 * Phase 1 (distance anchoring): the raw cumulative 2D-haversine distance drifts
 * vs. the workout's stored authoritative total, so each mile boundary lands at a
 * slightly wrong physical point. When `authoritativeTotalMiles` is supplied, the
 * cumulative-distance axis (and each segment's distance) is scaled so its
 * endpoint equals the stored total before any mile boundary is placed. Time and
 * timestamps are NEVER scaled. When the param is absent (or the raw total is 0),
 * behaviour is identical to the pre-anchoring version — no caller regresses.
 *
 * @param points                 - Route points ordered by index, with timestamps
 * @param avgHeartRate            - Run-level avgHeartRate (currently unused here;
 *                                  per-mile HR is merged by the caller from the
 *                                  iOS mileSplits subcollection — kept for API
 *                                  compatibility / future use)
 * @param authoritativeTotalMiles - Stored distanceMiles from the workout doc.
 *                                  When provided, the haversine distance axis is
 *                                  scaled so its endpoint equals this value.
 */
export function computeMileSplits(
  points: RoutePoint[],
  avgHeartRate?: number | null,
  authoritativeTotalMiles?: number
): MileSplit[] {
  if (points.length < 2) return [];

  // Build RAW cumulative distance (miles) and timestamps.
  const cumDist: number[] = [0];
  const timestamps: number[] = [new Date(points[0].timestamp).getTime()];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const d = haversineMi(prev.lat, prev.lng, curr.lat, curr.lng);
    cumDist.push(cumDist[i - 1] + d);
    timestamps.push(new Date(curr.timestamp).getTime());
  }

  const rawTotalMiles = cumDist[cumDist.length - 1];
  if (rawTotalMiles < 0.1) return []; // too short to split

  // ─── Phase 1: anchor the distance axis to the stored authoritative total ────
  // Scale the cumulative distance so cumDist[last] === authoritativeTotalMiles.
  // Mile boundaries are then placed on this scaled axis, so each boundary lands
  // at the physically correct fraction of the run the header reports. Falls back
  // to unscaled (scaleFactor 1) when no authoritative total is available.
  const scaleFactor =
    authoritativeTotalMiles != null &&
    authoritativeTotalMiles > 0 &&
    rawTotalMiles > 0
      ? authoritativeTotalMiles / rawTotalMiles
      : 1;
  if (scaleFactor !== 1) {
    for (let i = 0; i < cumDist.length; i++) cumDist[i] *= scaleFactor;
  }

  const totalDist = cumDist[cumDist.length - 1];

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

    // segmentMiles references the SCALED total (Phase 2.1), so the "(0.X mi)"
    // label and the pace below are computed against the same authoritative total
    // the run header shows — the prior label-vs-pace basis mismatch is gone.
    const segmentMiles = isLast ? totalDist - fullMiles : 1.0;

    let elapsedSec: number;
    if (isLast) {
      // ─── Phase 2.2: moving-only elapsed time for the partial mile ──────────
      // The final partial's tiny denominator made it hypersensitive to stopped /
      // cool-down time sitting in its numerator (observed +35s blowup). Exclude
      // stopped segments using the SHARED MIN_MOVING_* thresholds (identical to
      // gradeAdjustedPace.ts) instead of trusting raw elapsed wall-clock.
      // NOTE: this stopped-time filter is applied to the PARTIAL mile ONLY; full
      // miles still use interpolated elapsed time (flagged in the session report).
      // `segStart` here is the boundary point index `bi` (first point at/after the
      // fullMiles boundary). The segment ending at `bi` straddles the boundary —
      // only its post-boundary time portion belongs to the partial.
      const bi = segStart;
      let movingSec = 0;
      for (let i = Math.max(1, bi); i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const segMeters =
          haversineMi(prev.lat, prev.lng, curr.lat, curr.lng) * METERS_PER_MILE;
        let segSec = (timestamps[i] - timestamps[i - 1]) / 1000;
        if (!isFinite(segSec) || segSec < 0) segSec = 0;
        const moving =
          segMeters >= MIN_MOVING_DIST_M &&
          segSec > 0 &&
          segMeters / segSec >= MIN_MOVING_SPEED_MS;
        if (!moving) continue;
        if (i === bi && bi > 0) {
          // Straddling segment: count only the portion after the boundary.
          const portionMs = timestamps[i] - startTimestamp;
          movingSec += Math.max(0, portionMs) / 1000;
        } else {
          movingSec += segSec;
        }
      }
      elapsedSec = movingSec;
    } else {
      elapsedSec = (interpTimestamp - startTimestamp) / 1000;
    }

    // Pace: seconds per mile
    const paceSecPerMile =
      segmentMiles > 0 ? elapsedSec / segmentMiles : 0;

    splits.push({
      mile,
      segmentMiles,
      paceSecPerMile,
      isPartial: isLast,
    });

    segStart = segEnd;
  }

  return splits;
}
