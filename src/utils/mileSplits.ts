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

// ─── Moving-time accumulation ─────────────────────────────────────────────────

/**
 * Sum the MOVING seconds inside the time window [tStart, tEnd], walking the
 * route segments whose point index runs from `startIdx` through `endIdx`
 * (segment i spans point i-1 → i). A segment is classified MOVING using the
 * SAME derived test the partial-mile path uses: real ground covered
 * (≥ MIN_MOVING_DIST_M) at a real speed (≥ MIN_MOVING_SPEED_MS), where speed is
 * DERIVED from 2D-haversine distance ÷ elapsed time (NOT point.speed). For each
 * moving segment, only the overlap of its time span with [tStart, tEnd] is
 * counted — so a segment straddling either interpolated mile boundary
 * contributes just its in-window portion. Stopped sub-intervals (traffic
 * lights, cool-down) are excluded from the numerator.
 *
 * This single helper backs BOTH full miles and the final partial mile, so they
 * share one moving-time definition and one MIN_MOVING_* threshold set.
 */
function accumulateMovingSeconds(
  points: RoutePoint[],
  timestamps: number[],
  startIdx: number,
  endIdx: number,
  tStart: number,
  tEnd: number
): number {
  let movingSec = 0;
  for (let i = Math.max(1, startIdx); i <= endIdx && i < points.length; i++) {
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
    // Count only the overlap of [tStart, tEnd] with this segment's time span,
    // so segments straddling a mile boundary contribute their in-window portion.
    const lo = Math.max(tStart, timestamps[i - 1]);
    const hi = Math.min(tEnd, timestamps[i]);
    if (hi > lo) movingSec += (hi - lo) / 1000;
  }
  return movingSec;
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
 * Phase 2 (moving-time exclusion): pace for EVERY mile — full miles and the
 * final partial alike — excludes stopped/cool-down time from its numerator using
 * the shared moving-time test (see accumulateMovingSeconds + movingTime.ts). The
 * interpolated boundary timestamps still define each mile's extent; only stopped
 * sub-intervals inside are removed. A stopless mile is unchanged (its moving
 * time equals the boundary-to-boundary elapsed time), so there is no regression.
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

    // Moving-only elapsed seconds for THIS mile — full miles AND the final
    // partial alike. Walk the segments overlapping [startTimestamp,
    // interpTimestamp] and sum only the sub-intervals whose segment is "moving"
    // (shared accumulateMovingSeconds → same derived speed test + same
    // MIN_MOVING_* thresholds for every mile). Stopped sub-intervals (traffic
    // lights, cool-down) are removed from the numerator; the interpolated
    // boundaries still define the mile's extent. `segStart`/`segEnd` are the
    // first point indices at/after the start (mile-1) and end (mile) boundaries.
    const movingSec = accumulateMovingSeconds(
      points,
      timestamps,
      segStart,
      segEnd,
      startTimestamp,
      interpTimestamp
    );

    // Fallback: if the ENTIRE mile classified as stopped (movingSec === 0 — e.g.
    // a GPS dropout or a mile spent paused), fall back to the interpolated
    // elapsed time rather than reporting a nonsensical 0:00 pace. Same rule for
    // full and partial miles, so there is no divide-by-tiny / NaN.
    const elapsedSec = (interpTimestamp - startTimestamp) / 1000;
    const effectiveSec = movingSec > 0 ? movingSec : elapsedSec;

    // Pace: seconds per mile
    const paceSecPerMile =
      segmentMiles > 0 ? effectiveSec / segmentMiles : 0;

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
