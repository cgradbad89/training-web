/**
 * Overlay-chart cache — a decimated pace/HR/elevation series persisted on the
 * workout doc (`overlayChartCache`) so chart consumers don't have to smooth and
 * decimate the full ~1 Hz route subcollection on every render.
 *
 * The series is produced with the SAME pipeline RunOverlayChart uses: outlier
 * filtering and smoothing run on the FULL-resolution array first, and only the
 * already-smooth result is sampled down (even sampling across the whole run,
 * never truncation). GAP is deliberately NOT cached — it depends on the
 * per-point grade series computed from raw route points at render time.
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
 */
export function computeOverlayChartCache(
  points: RoutePoint[],
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

  const indices = evenSampleIndices(n, target);
  return {
    distancesMiles: indices.map((i) => cumMiles[i]),
    paceSecPerMile: indices.map((i) => smoothedPace[i]),
    heartRateBpm: indices.map((i) => hr[i]),
    elevationFt: indices.map((i) => smoothedElev[i] ?? elevFt[i]),
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
  return {
    distancesMiles: r.distancesMiles,
    paceSecPerMile: r.paceSecPerMile,
    heartRateBpm: r.heartRateBpm,
    elevationFt: r.elevationFt,
    sourcePointCount: r.sourcePointCount,
    computedAt: r.computedAt,
  };
}
