/**
 * Overlay-chart cache — a decimated pace/HR/elevation series persisted on the
 * workout doc (`overlayChartCache`) so chart consumers don't have to smooth and
 * decimate the full ~1 Hz route subcollection on every render.
 *
 * The series is produced with the SAME pipeline RunOverlayChart uses: outlier
 * filtering and smoothing run on the FULL-resolution array first, and only the
 * already-smooth result is sampled down (even sampling across the whole run,
 * never truncation).
 *
 * GAP is cached too: the caller passes the FULL-resolution per-point grade-
 * adjusted pace series (computed by computeRunGap, which does its own 25 m
 * baseline resampling), and it is outlier-nulled + smoothed on the full array
 * and only THEN decimated — never decimated first (that would destroy the
 * baseline resampling GAP relies on to damp GPS noise).
 */

import { type RoutePoint } from "@/services/routes";
import { haversineMi } from "@/utils/mileSplits";
import { mpsToSecPerMile } from "@/utils/pace";
import { computePaceAxisDomain, nullifyOutliers } from "@/utils/paceAxisDomain";
import { rollingAverage, SMOOTH_WINDOW_SEC } from "@/utils/smoothSeries";

/** Target cached point count — matches RunOverlayChart's MAX_CHART_POINTS. */
export const OVERLAY_CACHE_TARGET_POINTS = 200;

/** Elevation smoothing window (matches RunOverlayChart). */
const ELEV_SMOOTH_WINDOW_SEC = 20;

/** GAP smoothing window — matches RunOverlayChart's GAP_SMOOTH_WINDOW_SEC (35s)
 *  so the cached GAP line renders identically to the raw-points GAP line. */
const GAP_SMOOTH_WINDOW_SEC = 35;

const METERS_TO_FEET = 3.28084;

// Anomaly filters (consistent with RunOverlayChart / existing charts).
export const OVERLAY_MAX_PACE = 1800; // sec/mi
export const OVERLAY_MIN_HR = 40;
export const OVERLAY_MAX_HR = 220;

export interface OverlayChartCache {
  distancesMiles: number[];
  /** Smoothed pace, sec/mi; null = glitch/no-signal gap (line break). */
  paceSecPerMile: (number | null)[];
  /** Per-point HR, bpm; null where absent/out of range. */
  heartRateBpm: (number | null)[];
  elevationFt: number[];
  /** Smoothed grade-adjusted pace, sec/mi; null = stopped/glitch gap (line
   *  break). Same index alignment as pace/HR/elevation. Empty on caches
   *  written before GAP was cached (a prior build) — the run-detail gate
   *  treats a length mismatch with distancesMiles as incomplete and recomputes. */
  gapSecPerMile: (number | null)[];
  /** Raw route point count this cache was computed from. Consumers must
   *  ignore the cache when it doesn't match the current route length
   *  (guards against a later route resync adding points). */
  sourcePointCount: number;
  /** Unix ms. */
  computedAt: number;
}

/**
 * Indices for even sampling of an n-length series down to `target` points.
 * Always includes the first and last index; spacing is uniform across the full
 * range (never truncation). Returns 0..n-1 unchanged when n <= target.
 */
export function evenSampleIndices(n: number, target: number): number[] {
  if (n <= 0) return [];
  if (target <= 1) return [0];
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = new Array(target);
  for (let i = 0; i < target; i++) {
    out[i] = Math.round((i * (n - 1)) / (target - 1));
  }
  return out;
}

/**
 * Compute the decimated overlay series from full-resolution route points.
 * Returns null when the route is too short to chart (< 2 points).
 *
 * @param gapByPoint FULL-resolution, POINT-ALIGNED grade-adjusted pace
 *   (sec/mi): index i is the GAP of the segment ending at point i, index 0 is
 *   null (no preceding segment). Build it from computeRunGap's `perPointGap`
 *   (whose entry k describes the segment ending at point k+1). Pass `[]` to
 *   omit the GAP channel — the cache then stores an empty gapSecPerMile array.
 */
export function computeOverlayChartCache(
  points: RoutePoint[],
  gapByPoint: (number | null)[] = [],
  target: number = OVERLAY_CACHE_TARGET_POINTS,
  now: number = Date.now()
): OverlayChartCache | null {
  if (points.length < 2) return null;

  const n = points.length;
  const cumMiles: number[] = [0];
  for (let i = 1; i < n; i++) {
    const p = points[i - 1];
    const c = points[i];
    cumMiles.push(cumMiles[i - 1] + haversineMi(p.lat, p.lng, c.lat, c.lng));
  }

  const baseMs = new Date(points[0].timestamp).getTime();
  const timeSec: number[] = new Array(n);
  const rawPace: (number | null)[] = new Array(n);
  const hr: (number | null)[] = new Array(n);
  const elevFt: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const tMs = new Date(p.timestamp).getTime();
    timeSec[i] = Number.isFinite(tMs - baseMs) ? (tMs - baseMs) / 1000 : NaN;
    const paceRaw = p.speed != null ? mpsToSecPerMile(p.speed) : 0;
    rawPace[i] = paceRaw > 0 && paceRaw <= OVERLAY_MAX_PACE ? paceRaw : null;
    hr[i] =
      p.hr != null && p.hr >= OVERLAY_MIN_HR && p.hr <= OVERLAY_MAX_HR
        ? p.hr
        : null;
    elevFt[i] = p.altitude * METERS_TO_FEET;
  }

  // Null glitch paces BEFORE smoothing so they never enter the moving average,
  // then smooth on the full-resolution array (same order as RunOverlayChart).
  const domain = computePaceAxisDomain(
    rawPace.filter((v): v is number => v != null)
  );
  const smoothedPace = rollingAverage(
    nullifyOutliers(rawPace, domain),
    SMOOTH_WINDOW_SEC,
    timeSec
  );
  const smoothedElev = rollingAverage(elevFt, ELEV_SMOOTH_WINDOW_SEC, timeSec);

  // GAP: same pipeline as pace (outlier-null → smooth on the FULL array →
  // decimate). The per-point grade series already reflects the 25 m baseline
  // resampling done inside computeRunGap, so nothing is decimated before GAP.
  // Empty gapByPoint → empty gapSecPerMile (GAP channel omitted for this cache).
  let gapSecPerMile: (number | null)[] = [];
  if (gapByPoint.length === n) {
    const rawGap: (number | null)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const g = gapByPoint[i];
      rawGap[i] = g != null && g > 0 && g <= OVERLAY_MAX_PACE ? g : null;
    }
    // Domain over pace + GAP combined (matches RunOverlayChart) so GAP outliers
    // are nulled against the same band the chart uses.
    const gapDomain = computePaceAxisDomain([
      ...rawPace.filter((v): v is number => v != null),
      ...rawGap.filter((v): v is number => v != null),
    ]);
    const smoothedGap = rollingAverage(
      nullifyOutliers(rawGap, gapDomain),
      GAP_SMOOTH_WINDOW_SEC,
      timeSec
    );
    const indicesForGap = evenSampleIndices(n, target);
    gapSecPerMile = indicesForGap.map((i) => smoothedGap[i]);
  }

  const indices = evenSampleIndices(n, target);
  return {
    distancesMiles: indices.map((i) => cumMiles[i]),
    paceSecPerMile: indices.map((i) => smoothedPace[i]),
    heartRateBpm: indices.map((i) => hr[i]),
    elevationFt: indices.map((i) => smoothedElev[i] ?? elevFt[i]),
    gapSecPerMile,
    sourcePointCount: n,
    computedAt: now,
  };
}

function isNumberOrNullArray(v: unknown): v is (number | null)[] {
  return (
    Array.isArray(v) &&
    v.every((x) => x === null || (typeof x === "number" && Number.isFinite(x)))
  );
}

function isNumberArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

/** Parse the Firestore-stored value back to OverlayChartCache (else undefined). */
export function parseOverlayChartCache(
  value: unknown
): OverlayChartCache | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (
    !isNumberArray(r.distancesMiles) ||
    !isNumberOrNullArray(r.paceSecPerMile) ||
    !isNumberOrNullArray(r.heartRateBpm) ||
    !isNumberArray(r.elevationFt) ||
    typeof r.sourcePointCount !== "number" ||
    typeof r.computedAt !== "number"
  ) {
    return undefined;
  }
  const len = r.distancesMiles.length;
  if (
    len < 2 ||
    r.paceSecPerMile.length !== len ||
    r.heartRateBpm.length !== len ||
    r.elevationFt.length !== len
  ) {
    return undefined;
  }
  // gapSecPerMile is tolerated as absent/legacy: a cache written before GAP was
  // cached simply has no (or a mismatched-length) array. Default to [] so the
  // rest of the cache still parses; the run-detail gate detects the empty/short
  // array and recomputes. A present, correctly-sized array is kept as-is.
  const gapSecPerMile =
    isNumberOrNullArray(r.gapSecPerMile) && r.gapSecPerMile.length === len
      ? r.gapSecPerMile
      : [];
  return {
    distancesMiles: r.distancesMiles,
    paceSecPerMile: r.paceSecPerMile,
    heartRateBpm: r.heartRateBpm,
    elevationFt: r.elevationFt,
    gapSecPerMile,
    sourcePointCount: r.sourcePointCount,
    computedAt: r.computedAt,
  };
}

/**
 * Build the POINT-ALIGNED GAP array computeOverlayChartCache expects from
 * computeRunGap's `perPointGap` (whose entry k is the segment ending at point
 * k+1). Index 0 is always null (no preceding segment); index i (>=1) is
 * perPointGap[i-1]'s grade-adjusted pace. Returns [] if the shapes don't line
 * up (perPointGap must have pointCount-1 entries).
 */
export function gapByPointFromPerPoint(
  perPointGap: { gradeAdjPaceSecPerMile: number | null }[],
  pointCount: number
): (number | null)[] {
  if (pointCount < 2 || perPointGap.length !== pointCount - 1) return [];
  const out: (number | null)[] = new Array(pointCount);
  out[0] = null;
  for (let i = 1; i < pointCount; i++) {
    out[i] = perPointGap[i - 1]?.gradeAdjPaceSecPerMile ?? null;
  }
  return out;
}
