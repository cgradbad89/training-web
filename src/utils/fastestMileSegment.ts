import { type RoutePoint } from "@/services/routes";

const EARTH_RADIUS_MI = 3958.8;

/**
 * Persisted best-effort freshness version. Bump this whenever the route-based
 * fastest-mile algorithm changes so already-computed workout documents are
 * refreshed once on their next eligible route read/backfill.
 */
export const BEST_EFFORTS_COMPUTATION_VERSION = 2;

export const MIN_VALID_FASTEST_MILE_SECONDS = 180;
export const MAX_VALID_FASTEST_MILE_SECONDS = 1200;

/** Domain validity window for a persisted or displayed fastest-mile result. */
export function isValidFastestMileSeconds(
  seconds: number | null
): seconds is number {
  return (
    seconds !== null &&
    Number.isFinite(seconds) &&
    seconds > MIN_VALID_FASTEST_MILE_SECONDS &&
    seconds < MAX_VALID_FASTEST_MILE_SECONDS
  );
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/** Sliding window: find the fastest 1-mile segment in a route. Returns seconds or null. */
export function fastestMileSegment(points: RoutePoint[]): number | null {
  if (points.length < 2) return null;

  // Build arrays of cumulative distance (miles) and timestamps (ms)
  const timestamps: number[] = [];
  const cumDist: number[] = [0];
  for (let i = 0; i < points.length; i++) {
    const ts = new Date(points[i].timestamp).getTime();
    if (isNaN(ts)) return null;
    timestamps.push(ts);
    if (i > 0) {
      cumDist.push(
        cumDist[i - 1] +
          haversineMi(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng)
      );
    }
  }

  const totalDist = cumDist[cumDist.length - 1];
  if (totalDist < 1.0) return null; // route shorter than 1 mile

  let bestSeconds: number | null = null;
  let left = 0;

  for (let right = 1; right < points.length; right++) {
    while (cumDist[right] - cumDist[left] >= 1.0) {
      // Distance from left to right >= 1 mile — find exact 1-mile crossing
      const distFromLeft = cumDist[right] - cumDist[left];
      const segDist = cumDist[right] - cumDist[right - 1];
      const overshoot = distFromLeft - 1.0;

      // Interpolate timestamp at the 1-mile mark between right-1 and right
      let crossingMs: number;
      if (segDist > 0) {
        const fraction = 1.0 - overshoot / segDist;
        crossingMs =
          timestamps[right - 1] + fraction * (timestamps[right] - timestamps[right - 1]);
      } else {
        crossingMs = timestamps[right];
      }

      const elapsed = (crossingMs - timestamps[left]) / 1000;
      if (elapsed > 0 && (bestSeconds === null || elapsed < bestSeconds)) {
        bestSeconds = elapsed;
      }
      left++;
    }
  }

  return bestSeconds;
}

export function findBestFastestMileAcrossRuns(
  results: ({ seconds: number; date: Date } | null)[]
): { seconds: number; date: Date } | null {
  const valid = results.filter(
    (r): r is { seconds: number; date: Date } =>
      r != null && isValidFastestMileSeconds(r.seconds)
  );
  return valid.length > 0
    ? valid.reduce((a, b) => (a.seconds < b.seconds ? a : b))
    : null;
}
