/**
 * Grade Adjusted Pace (GAP).
 *
 * Converts the pace actually run on hilly terrain into the equivalent
 * flat-ground pace for the same metabolic effort. Uphill running shows a
 * FASTER grade-adjusted pace than actual (climbing is costly), and moderate
 * downhill shows a SLOWER grade-adjusted pace than actual.
 *
 * All distances use 2D haversine (horizontal only), consistent with
 * src/utils/mileSplits.ts. Altitude comes from per-point GPS samples.
 */

import { type RoutePoint } from "@/services/routes";

export interface GapPoint {
  /** Cumulative distance at this route point, in miles */
  distanceMiles: number;
  /** Grade-adjusted pace for the segment ending at this point, sec/mile */
  gradeAdjPaceSecPerMile: number;
}

export interface RunGap {
  /** Distance-weighted run-level GAP, sec/mile (see computeRunGap notes) */
  runGapSecPerMile: number;
  /** One entry per route segment, for the overlay chart */
  perPointGap: GapPoint[];
  /** Per-mile GAP, sec/mile; index = mile-1, aligned to computeMileSplits buckets */
  perMileGapSecPerMile: number[];
}

// ─── Constants & guards ───────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;
const METERS_PER_MILE = 1609.344;

/**
 * Centered moving-average window (in points) used to damp GPS altitude noise.
 * Widened from 5 → 11: residual barometric/GPS altitude noise (~±0.3–0.5 m)
 * survives a narrow window and, because 1/factor is convex, biases GAP slow
 * (Jensen's inequality on segSec/factor). A linear elevation ramp is unchanged
 * by a centered average at interior points, so widening costs no real signal.
 */
const ALT_SMOOTHING_WINDOW = 11;
/**
 * Segments shorter than this horizontal distance are treated as flat (grade 0)
 * to avoid divide-by-tiny grade spikes from GPS jitter.
 */
const MIN_SEGMENT_METERS = 5;
/**
 * Horizontal baseline (meters) over which grade is measured. Adjacent GPS
 * points are only ~3–15 m apart, where ±0.3–0.5 m altitude noise produces
 * spurious ±5–15% grades; since 1/factor is convex, that symmetric noise does
 * NOT cancel and systematically inflates grade-adjusted time (GAP too slow).
 * Grade variance falls super-linearly with baseline length, so resampling to a
 * ~25 m span collapses the noise-driven bias while preserving real sustained
 * hills (which persist across many such spans).
 */
const GRADE_BASELINE_METERS = 25;
/**
 * Grades with |grade%| ≤ this are treated as flat (factor = 1.0). Removes the
 * residual near-flat noise that survives resampling + smoothing, without
 * touching genuine grades.
 */
const GRADE_DEADBAND_PERCENT = 1.5;
/** Grade is clamped to ±30% before adjustment to avoid altitude-noise blowups. */
const MAX_GRADE_PERCENT = 30;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 2D haversine distance between two lat/lng points, in meters. */
function haversineMeters(
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
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ─── Grade adjustment factor ──────────────────────────────────────────────────

/**
 * Grade adjustment factor = relative metabolic cost of running at a given
 * gradient versus flat ground, using the Minetti et al. (2002) energy-cost
 * polynomial (J·kg⁻¹·m⁻¹):
 *
 *   C(i) = 155.4·i⁵ − 30.4·i⁴ − 43.3·i³ + 46.3·i² + 19.5·i + 3.6
 *
 * where i is the gradient as a FRACTION (rise/run, e.g. 0.10 = 10% uphill).
 * Flat cost C(0) = 3.6. factor = C(i)/C(0).
 *
 *   factor > 1  → uphill (costlier) → GAP faster than actual
 *   factor < 1  → moderate downhill (cheaper) → GAP slower than actual
 *
 * Grade is clamped to ±30% so GPS altitude noise can't blow the factor up.
 * The factor is floored at 0.1 as a final safety guard.
 */
export function gradeAdjustmentFactor(gradePercent: number): number {
  const clamped = Math.max(
    -MAX_GRADE_PERCENT,
    Math.min(MAX_GRADE_PERCENT, gradePercent)
  );
  const i = clamped / 100;
  const cost =
    155.4 * i ** 5 -
    30.4 * i ** 4 -
    43.3 * i ** 3 +
    46.3 * i ** 2 +
    19.5 * i +
    3.6;
  const factor = cost / 3.6;
  return factor > 0.1 ? factor : 0.1;
}

// ─── Run-level GAP ──────────────────────────────────────────────────────────

/**
 * Compute grade-adjusted pace from GPS route points.
 *
 * Run-level GAP is DISTANCE-WEIGHTED, not the mean of per-mile GAPs:
 * each segment's actual time is divided by its grade adjustment factor to get
 * a grade-adjusted time, all grade-adjusted times are summed, and
 *   runGapSecPerMile = (total grade-adjusted time) / (total distance in miles).
 *
 * @param points              Route points ordered by index, with timestamps + altitude
 * @param totalDistanceMiles  Run-level distance (used as a fallback denominator)
 * @param movingTimeSec       Run moving/elapsed time (used as a fallback when
 *                            per-point timestamps are unusable, e.g. all equal)
 */
export function computeRunGap(
  points: RoutePoint[],
  totalDistanceMiles: number,
  movingTimeSec: number
): RunGap {
  // Empty / single point → safe: return actual pace if derivable, else 0.
  if (!points || points.length < 2) {
    const pace =
      totalDistanceMiles > 0 && movingTimeSec > 0
        ? movingTimeSec / totalDistanceMiles
        : 0;
    return { runGapSecPerMile: pace, perPointGap: [], perMileGapSecPerMile: [] };
  }

  const n = points.length;

  // Smooth altitude with a centered moving average to damp GPS vertical noise.
  const smoothAlt: number[] = new Array(n);
  const half = Math.floor(ALT_SMOOTHING_WINDOW / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += points[j].altitude;
      cnt++;
    }
    smoothAlt[i] = cnt > 0 ? sum / cnt : points[i].altitude;
  }

  // Per-segment horizontal distance (m) and elapsed time (s), computed once.
  // segHorizM[i] / segSec[i] describe the segment from point i-1 → i.
  const segHorizM: number[] = new Array(n).fill(0);
  const segSec: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    segHorizM[i] = haversineMeters(
      points[i - 1].lat,
      points[i - 1].lng,
      points[i].lat,
      points[i].lng
    );
    const t0 = new Date(points[i - 1].timestamp).getTime();
    const t1 = new Date(points[i].timestamp).getTime();
    let s = (t1 - t0) / 1000;
    if (!isFinite(s) || s < 0) s = 0;
    segSec[i] = s;
  }

  // ─── Resample grade onto a ~25 m horizontal baseline ───────────────────────
  // Instead of computing grade between adjacent points (~3–15 m apart, where
  // altitude noise yields spurious ±5–15% grades that bias GAP slow via the
  // convexity of 1/factor), accumulate horizontal distance into spans of at
  // least GRADE_BASELINE_METERS and compute ONE grade/factor per span. Every
  // segment in a span inherits that span's factor, so the noise-driven grade
  // variance — and the Jensen bias it produces — collapses super-linearly,
  // while genuine sustained hills (which persist across many spans) survive.
  const segFactor: number[] = new Array(n).fill(1);
  let spanStartPoint = 0; // point index where the current span begins
  let spanFirstSeg = 1; // first segment index belonging to the current span
  let spanHorizM = 0;
  for (let i = 1; i < n; i++) {
    spanHorizM += segHorizM[i];
    const atEnd = i === n - 1;
    if (spanHorizM >= GRADE_BASELINE_METERS || atEnd) {
      let gradePercent = 0;
      if (spanHorizM >= MIN_SEGMENT_METERS) {
        gradePercent =
          ((smoothAlt[i] - smoothAlt[spanStartPoint]) / spanHorizM) * 100;
      }
      // Dead-band: near-flat noise that survives resampling + smoothing → flat.
      if (Math.abs(gradePercent) <= GRADE_DEADBAND_PERCENT) gradePercent = 0;
      const factor = gradeAdjustmentFactor(gradePercent); // clamps ±30%, floors 0.1
      for (let k = spanFirstSeg; k <= i; k++) segFactor[k] = factor;
      spanStartPoint = i;
      spanFirstSeg = i + 1;
      spanHorizM = 0;
    }
  }

  const perPointGap: GapPoint[] = [];
  const mileAdjTime: number[] = [];
  const mileDist: number[] = [];

  let cumMiles = 0;
  let totalAdjTimeSec = 0;
  let totalMiles = 0;

  for (let i = 1; i < n; i++) {
    const segMiles = segHorizM[i] / METERS_PER_MILE;
    const factor = segFactor[i];
    const adjSec = segSec[i] / factor;

    cumMiles += segMiles;
    totalMiles += segMiles;
    totalAdjTimeSec += adjSec;

    const segGapPace = segMiles > 0 ? adjSec / segMiles : 0;
    perPointGap.push({
      distanceMiles: cumMiles,
      gradeAdjPaceSecPerMile: segGapPace,
    });

    // Bucket into a mile by the segment midpoint's cumulative distance.
    const midMiles = cumMiles - segMiles / 2;
    const bucket = Math.max(0, Math.floor(midMiles)); // 0-indexed mile
    mileAdjTime[bucket] = (mileAdjTime[bucket] ?? 0) + adjSec;
    mileDist[bucket] = (mileDist[bucket] ?? 0) + segMiles;
  }

  const denomMiles = totalMiles > 0 ? totalMiles : totalDistanceMiles;
  const runGapSecPerMile = denomMiles > 0 ? totalAdjTimeSec / denomMiles : 0;

  const perMileGapSecPerMile: number[] = [];
  for (let b = 0; b < mileDist.length; b++) {
    const d = mileDist[b] ?? 0;
    const t = mileAdjTime[b] ?? 0;
    perMileGapSecPerMile[b] = d > 0 ? t / d : 0;
  }

  return { runGapSecPerMile, perPointGap, perMileGapSecPerMile };
}
