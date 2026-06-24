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
import { MIN_MOVING_SPEED_MS, MIN_MOVING_DIST_M } from "@/utils/movingTime";

export interface GapPoint {
  /** Cumulative distance at this route point, in miles (includes stopped drift) */
  distanceMiles: number;
  /**
   * Grade-adjusted pace for the segment ending at this point, sec/mile.
   * null for STOPPED segments (no meaningful running pace while paused) so the
   * overlay chart draws a line break instead of a bogus stopped "pace".
   */
  gradeAdjPaceSecPerMile: number | null;
}

export interface RunGap {
  /**
   * Run-level GAP, sec/mile. Computed as the trusted raw pace
   * (avgPaceSecPerMile) scaled by a unitless grade ratio derived from the
   * aggregate smoothed elevation profile (see computeRunGap notes). Flat ground
   * → GAP == raw pace; net-uphill → faster; net-downhill → slower.
   */
  runGapSecPerMile: number;
  /** One entry per route segment, for the overlay chart */
  perPointGap: GapPoint[];
  /** Per-mile GAP, sec/mile; index = mile-1, aligned to computeMileSplits buckets */
  perMileGapSecPerMile: number[];
  /**
   * Run NET elevation change in meters (end − start), endpoint-averaged and
   * smoothed — the same value that drives the aggregate grade for GAP. Negative
   * = net descent. null when no usable route geometry (e.g. < 2 points). This
   * is NET, distinct from the device's TOTAL cumulative `elevationGainM`.
   */
  netRiseM: number | null;
  /**
   * True when the run HAS usable elevation geometry but the aggregate grade
   * resolved to flat (zero net grade, or snapped to zero by the aggregate
   * dead-band) — i.e. GAP was INTENTIONALLY left unadjusted and equals the
   * base pace. Display-only signal: lets the GAP KPI say "flat" instead of
   * looking like missing data. Never true when geometry is absent.
   */
  aggregateGradeFlat: boolean;
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
/**
 * Number of moving points averaged at each end to derive the run's NET rise.
 * Averaging the first/last N smoothed altitudes (rather than a single endpoint)
 * keeps one noisy first/last GPS sample from tilting the whole-run net grade.
 */
const NET_GRADE_ENDPOINT_SAMPLES = 5;
/**
 * Dead-band on the AGGREGATE net grade (separate from the per-span
 * GRADE_DEADBAND_PERCENT). Snaps pure endpoint-noise jitter to flat
 * (→ aggregateFactor 1.0 → GAP == pace) WITHOUT erasing real shallow descents:
 * measured real-vs-noise endpoint variance is ≈ 0.02%, while genuine net grades
 * (e.g. the −0.229% reference run) sit well above this, so 0.10% lands safely
 * between noise and signal. TUNABLE — product owner may adjust.
 */
const AGGREGATE_GRADE_DEADBAND_PERCENT = 0.1;

/**
 * Stop detection. The run KPI must reflect effort per mile of ACTUAL running,
 * not elapsed-including-stops: stopped segments (traffic lights, pauses) add
 * real stopped seconds to the numerator while contributing ~no distance to the
 * denominator, which inflates GAP slower than actual pace on every run with
 * stop time. A segment counts as MOVING only if it covers real ground
 * (≥ MIN_MOVING_DIST_M) at a real speed (≥ MIN_MOVING_SPEED_MS); otherwise its
 * time and distance are excluded from the GAP numerator and denominator.
 * MIN_MOVING_SPEED_MS / MIN_MOVING_DIST_M now live in src/utils/movingTime.ts
 * so the per-mile split partial can reuse the identical thresholds.
 */
/**
 * If less than this much moving time can be derived from per-point timestamps,
 * the timestamps are degenerate/missing — fall back to the movingTimeSec param
 * (elapsed duration) rather than trusting a near-zero derived time.
 */
const MIN_DERIVED_MOVING_SEC = 60;

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
 * Run-level GAP is RATIO-BASED: the grade effect is expressed as a unitless
 * ratio (grade-adjusted time / actual time) and applied to the trusted raw pace:
 *   runGapSecPerMile = avgPaceSecPerMile × (1 / aggregateFactor)
 * The aggregate factor comes from the run's NET smoothed elevation change over
 * total moving horizontal distance (a single Minetti factor), which both avoids
 * the Jensen convexity slow-bias of summing per-span 1/factor values and keeps
 * GAP on the SAME basis as the displayed pace (so flat ground → GAP == pace).
 * Stopped segments (see MIN_MOVING_* constants) are excluded from the moving
 * distance/time so stop time doesn't bias the basis pace.
 *
 * @param points              Route points ordered by index, with timestamps + altitude
 * @param totalDistanceMiles  Run-level distance (used as a fallback denominator)
 * @param movingTimeSec       FALLBACK ONLY — used when per-point timestamps are
 *                            degenerate (derived moving time < MIN_DERIVED_MOVING_SEC).
 *                            Normally moving time is derived from the points.
 * @param avgPaceSecPerMile   Trusted device pace (sec/mi) the grade ratio is
 *                            applied to. When null/absent, falls back to the
 *                            GPS-derived raw moving pace as the basis.
 */
export function computeRunGap(
  points: RoutePoint[],
  totalDistanceMiles: number,
  movingTimeSec: number,
  avgPaceSecPerMile?: number | null
): RunGap {
  // Empty / single point → safe: return the trusted device pace when available,
  // else the elapsed pace, else 0.
  if (!points || points.length < 2) {
    const pace =
      avgPaceSecPerMile != null && avgPaceSecPerMile > 0
        ? avgPaceSecPerMile
        : totalDistanceMiles > 0 && movingTimeSec > 0
          ? movingTimeSec / totalDistanceMiles
          : 0;
    return {
      runGapSecPerMile: pace,
      perPointGap: [],
      perMileGapSecPerMile: [],
      netRiseM: null,
      aggregateGradeFlat: false,
    };
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

  // Classify each segment as moving vs. stopped, and derive moving time from the
  // points. A segment is MOVING only if it covers real ground at a real speed;
  // pauses (traffic lights, stops) otherwise inflate GAP slower than actual.
  const segMoving: boolean[] = new Array(n).fill(false);
  let derivedMovingTimeSec = 0;
  for (let i = 1; i < n; i++) {
    const moving =
      segHorizM[i] >= MIN_MOVING_DIST_M &&
      segSec[i] > 0 &&
      segHorizM[i] / segSec[i] >= MIN_MOVING_SPEED_MS;
    segMoving[i] = moving;
    if (moving) derivedMovingTimeSec += segSec[i];
  }

  // Degenerate/missing timestamps (e.g. all equal) → derived moving time is
  // ~0; fall back to the elapsed movingTimeSec param rather than trusting it.
  // When falling back, treat every real-distance segment as "moving" so the
  // run still produces a GAP (we just can't tell stops from motion via time).
  const useDerivedMovingTime = derivedMovingTimeSec >= MIN_DERIVED_MOVING_SEC;
  if (!useDerivedMovingTime) {
    // eslint-disable-next-line no-console
    console.warn(
      `[computeRunGap] derived moving time ${derivedMovingTimeSec.toFixed(
        1
      )}s < ${MIN_DERIVED_MOVING_SEC}s — timestamps look degenerate; ` +
        `falling back to movingTimeSec=${movingTimeSec}s and counting all ` +
        `real-distance segments as moving.`
    );
    for (let i = 1; i < n; i++) {
      segMoving[i] = segHorizM[i] >= MIN_MOVING_DIST_M;
    }
  }

  // ─── Resample grade onto a ~25 m horizontal baseline ───────────────────────
  // Instead of computing grade between adjacent points (~3–15 m apart, where
  // altitude noise yields spurious ±5–15% grades that bias GAP slow via the
  // convexity of 1/factor), accumulate horizontal distance into spans of at
  // least GRADE_BASELINE_METERS and compute ONE grade/factor per span. Every
  // segment in a span inherits that span's factor, so the noise-driven grade
  // variance — and the Jensen bias it produces — collapses super-linearly,
  // while genuine sustained hills (which persist across many spans) survive.
  // Only MOVING distance counts toward the 25 m baseline trigger; stopped
  // segments (≈0 distance, ≈0 altitude change) don't extend the span.
  const segFactor: number[] = new Array(n).fill(1);
  let spanStartPoint = 0; // point index where the current span begins
  let spanFirstSeg = 1; // first segment index belonging to the current span
  let spanHorizM = 0;
  for (let i = 1; i < n; i++) {
    if (segMoving[i]) spanHorizM += segHorizM[i];
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

  let cumMiles = 0; // includes stopped drift, for accurate chart x-axis
  let totalMovingMiles = 0; // moving segments only
  // Endpoints of the moving portion, for the aggregate net-grade computation.
  let firstMovingStartPt = -1;
  let lastMovingEndPt = -1;

  for (let i = 1; i < n; i++) {
    const segMiles = segHorizM[i] / METERS_PER_MILE;
    // cumMiles tracks ALL distance (incl. stopped drift) so the overlay chart
    // x-axis stays aligned to real distance covered.
    cumMiles += segMiles;

    if (!segMoving[i]) {
      // Stopped: no meaningful running pace — line break on the chart, and
      // excluded from the KPI numerator/denominator and per-mile buckets.
      perPointGap.push({ distanceMiles: cumMiles, gradeAdjPaceSecPerMile: null });
      continue;
    }

    if (firstMovingStartPt < 0) firstMovingStartPt = i - 1;
    lastMovingEndPt = i;

    const factor = segFactor[i];
    const adjSec = segSec[i] / factor;

    totalMovingMiles += segMiles;

    const segGapPace = segMiles > 0 ? adjSec / segMiles : null;
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

  // ─── Run-level GAP: ratio applied to the trusted raw pace ──────────────────
  // Root cause #1 (basis mismatch): the displayed "Pace" KPI is the device's
  // avgPaceSecPerMile, but GAP was previously recomputed on GPS 2D-haversine
  // distance — which runs shorter than device distance, making GAP read slower
  // than pace even on flat ground. Instead, express the grade effect as a
  // UNITLESS ratio (adjusted time / actual time) and apply it to the trusted
  // device pace. This makes flat-ground GAP == displayed Pace exactly.
  //
  // Moving-time basis (GPS-derived; param fallback for degenerate timestamps).
  const totalMovingTimeSec = useDerivedMovingTime
    ? derivedMovingTimeSec
    : movingTimeSec;
  // GPS raw moving pace — same basis as the per-span series below.
  const gpsRawPace =
    totalMovingMiles > 0 ? totalMovingTimeSec / totalMovingMiles : 0;

  // Root causes #2 (Jensen convexity) + #3 (dead-band): derive ONE grade factor
  // from the AGGREGATE smoothed elevation profile — net smoothed rise over total
  // moving horizontal distance — rather than summing many per-span 1/factor
  // values. Summing per-span 1/factor inflates GAP slow on symmetric rolling
  // terrain (1/factor is convex); a single net-grade factor cannot accumulate
  // that bias, so symmetric rolling (net ≈ 0) → factor ≈ 1 → no slow-bias. The
  // per-span ±1.5% dead-band above is for NOISE rejection feeding the chart/table
  // series only; the aggregate grade gets its own tight dead-band below.
  const totalMovingHorizM = totalMovingMiles * METERS_PER_MILE;

  // Endpoint-averaged net rise (Phase 1): average the first/last
  // NET_GRADE_ENDPOINT_SAMPLES MOVING points' smoothed altitudes so one noisy
  // first/last GPS sample can't tilt the whole-run net grade. Small runs
  // (< 2× the sample count of moving points) fall back to single endpoints.
  let netRiseM: number | null = null;
  if (firstMovingStartPt >= 0 && lastMovingEndPt >= 0) {
    const movingSpan = lastMovingEndPt - firstMovingStartPt + 1;
    if (movingSpan >= 2 * NET_GRADE_ENDPOINT_SAMPLES) {
      let startSum = 0;
      let endSum = 0;
      for (let k = 0; k < NET_GRADE_ENDPOINT_SAMPLES; k++) {
        startSum += smoothAlt[firstMovingStartPt + k];
        endSum += smoothAlt[lastMovingEndPt - k];
      }
      const startAlt = startSum / NET_GRADE_ENDPOINT_SAMPLES;
      const endAlt = endSum / NET_GRADE_ENDPOINT_SAMPLES;
      netRiseM = endAlt - startAlt;
    } else {
      // Small-run guard: single-endpoint net.
      netRiseM = smoothAlt[lastMovingEndPt] - smoothAlt[firstMovingStartPt];
    }
  }

  let aggregateGradePercent =
    totalMovingHorizM > 0 && netRiseM != null
      ? (netRiseM / totalMovingHorizM) * 100
      : 0;
  // Aggregate-grade dead-band (Phase 2): snap pure endpoint-noise jitter to flat
  // so true loops read GAP == pace, without erasing real shallow descents.
  if (Math.abs(aggregateGradePercent) <= AGGREGATE_GRADE_DEADBAND_PERCENT) {
    aggregateGradePercent = 0;
  }
  // Flat = real geometry whose aggregate grade resolved to zero (incl. the
  // dead-band snap above) → GAP deliberately unadjusted. Surfaced so the UI
  // can label the value "flat" rather than implying missing data.
  const aggregateGradeFlat = netRiseM != null && aggregateGradePercent === 0;
  const aggregateFactor = gradeAdjustmentFactor(aggregateGradePercent);
  // adjusted time / actual time: < 1 net-uphill (faster GAP), > 1 net-downhill.
  const gradeRatio = aggregateFactor > 0 ? 1 / aggregateFactor : 1;

  // Trusted base pace: device avgPaceSecPerMile when available, else GPS raw.
  const basePace =
    avgPaceSecPerMile != null && avgPaceSecPerMile > 0
      ? avgPaceSecPerMile
      : gpsRawPace;

  const runGapSecPerMile = basePace > 0 ? basePace * gradeRatio : 0;

  // Align the GPS-derived per-point / per-mile series onto the trusted base-pace
  // basis so they read consistently with the KPI (same root-cause-#1 correction).
  const baseCorrection = gpsRawPace > 0 ? basePace / gpsRawPace : 1;

  const perPointGapScaled: GapPoint[] = perPointGap.map((p) => ({
    distanceMiles: p.distanceMiles,
    gradeAdjPaceSecPerMile:
      p.gradeAdjPaceSecPerMile != null
        ? p.gradeAdjPaceSecPerMile * baseCorrection
        : null,
  }));

  const perMileGapSecPerMile: number[] = [];
  for (let b = 0; b < mileDist.length; b++) {
    const d = mileDist[b] ?? 0;
    const t = mileAdjTime[b] ?? 0;
    perMileGapSecPerMile[b] = d > 0 ? (t / d) * baseCorrection : 0;
  }

  return {
    runGapSecPerMile,
    perPointGap: perPointGapScaled,
    perMileGapSecPerMile,
    netRiseM,
    aggregateGradeFlat,
  };
}

// ─── GAP display selector ─────────────────────────────────────────────────────

export type GapDisplay =
  /** No usable route/elevation data → render "—". */
  | { mode: "none" }
  /** Dead-band/zero aggregate grade → show the (unadjusted) pace + "flat". */
  | { mode: "flat"; paceSecPerMile: number }
  /** Normal grade-adjusted value. */
  | { mode: "value"; paceSecPerMile: number };

/**
 * Pure display selector for the run-header GAP stat. Display-only — the GAP
 * math above is untouched. "—" is reserved for runs with genuinely no
 * route/elevation data; a flat run shows its actual pace labelled "flat".
 */
export function selectGapDisplay(gap: RunGap): GapDisplay {
  if (!(gap.runGapSecPerMile > 0)) return { mode: "none" };
  if (gap.aggregateGradeFlat) {
    return { mode: "flat", paceSecPerMile: gap.runGapSecPerMile };
  }
  return { mode: "value", paceSecPerMile: gap.runGapSecPerMile };
}
