/**
 * Zone-breakdown extraction + cache codec.
 *
 * The HR-zone and pace-zone time-in-zone math used by the run-detail
 * `ZoneBreakdown` component is lifted out of the component into pure functions
 * here so it can be (a) unit-tested in isolation and (b) computed once from the
 * full-resolution route and cached on the workout doc — letting the detail page
 * render zones without re-reading the `route` subcollection.
 *
 * The extraction is a VERBATIM move of the component's previous inline logic
 * (per-point HR sample durations for HR zones; per-point pace + timestamps for
 * pace zones), so cached values match what the inline calculation produced.
 *
 * Both zone sets are settings-dependent (HR zones on maxHR, pace zones on the
 * user's threshold pace), so the cache records the basis it was computed
 * against. A reader/gate treats the cache as stale when the current maxHR or
 * threshold pace no longer matches — the same invalidation pattern the
 * mileSplits cache uses for a distance override.
 */

import { type RoutePoint } from "@/services/routes";
import { mpsToSecPerMile } from "@/utils/pace";
import {
  computeHRZones,
  computePaceZones,
  type PaceZoneResult,
  type ZoneBucket,
} from "@/utils/zones";

/** HR zones (time-in-zone) from per-point route samples — the exact logic the
 *  ZoneBreakdown component computed inline. Each sample carries the duration
 *  until the next point. */
export function computeHrZonesFromPoints(
  points: RoutePoint[],
  maxHR: number
): ZoneBucket[] {
  const hrSamples: { bpm: number; seconds: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = new Date(points[i].timestamp).getTime();
    const t1 = new Date(points[i + 1].timestamp).getTime();
    const dt = (t1 - t0) / 1000;
    if (!isFinite(dt) || dt <= 0) continue;
    if (points[i].hr != null) {
      hrSamples.push({ bpm: points[i].hr as number, seconds: dt });
    }
  }
  return computeHRZones(hrSamples, maxHR);
}

/** Pace zones (time-in-zone) from per-point route samples — the exact logic the
 *  ZoneBreakdown component computed inline. Returns [] without a usable
 *  threshold pace. */
export function computePaceZonesFromPoints(
  points: RoutePoint[],
  thresholdPaceSecPerMile: number | null | undefined
): PaceZoneResult[] {
  if (!thresholdPaceSecPerMile || thresholdPaceSecPerMile <= 0) return [];
  const perPointPaceSecPerMile = points.map((point) =>
    point.speed != null ? mpsToSecPerMile(point.speed) : null
  );
  const perPointTimestampsSec = points.map(
    (point) => new Date(point.timestamp).getTime() / 1000
  );
  return computePaceZones(
    perPointPaceSecPerMile,
    perPointTimestampsSec,
    thresholdPaceSecPerMile
  );
}

export interface ZoneBreakdownCache {
  hrZones: ZoneBucket[];
  paceZones: PaceZoneResult[];
  /** maxHR the HR zones were bucketed against (staleness basis). */
  maxHr: number;
  /** Threshold pace the pace zones were bucketed against, or null when unset
   *  (staleness basis). */
  thresholdPaceSecPerMile: number | null;
  /** Unix ms. */
  computedAt: number;
}

/** Compute the full zone breakdown from route points, tagged with its basis. */
export function computeZoneBreakdown(
  points: RoutePoint[],
  maxHr: number,
  thresholdPaceSecPerMile: number | null,
  now: number = Date.now()
): ZoneBreakdownCache {
  return {
    hrZones: computeHrZonesFromPoints(points, maxHr),
    paceZones: computePaceZonesFromPoints(points, thresholdPaceSecPerMile),
    maxHr,
    thresholdPaceSecPerMile,
    computedAt: now,
  };
}

function isZoneBucketArray(v: unknown): v is ZoneBucket[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        x != null &&
        typeof x === "object" &&
        typeof (x as ZoneBucket).zone === "number" &&
        typeof (x as ZoneBucket).seconds === "number" &&
        typeof (x as ZoneBucket).pct === "number"
    )
  );
}

function isPaceZoneArray(v: unknown): v is PaceZoneResult[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        x != null &&
        typeof x === "object" &&
        typeof (x as PaceZoneResult).zone === "number" &&
        typeof (x as PaceZoneResult).secondsInZone === "number" &&
        typeof (x as PaceZoneResult).percent === "number"
    )
  );
}

/** Parse the Firestore-stored value back to ZoneBreakdownCache (else undefined). */
export function parseZoneBreakdown(
  value: unknown
): ZoneBreakdownCache | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (!isZoneBucketArray(r.hrZones) || !isPaceZoneArray(r.paceZones)) {
    return undefined;
  }
  if (typeof r.maxHr !== "number" || typeof r.computedAt !== "number") {
    return undefined;
  }
  const threshold =
    typeof r.thresholdPaceSecPerMile === "number"
      ? r.thresholdPaceSecPerMile
      : r.thresholdPaceSecPerMile === null
        ? null
        : undefined;
  if (threshold === undefined) return undefined;
  return {
    hrZones: r.hrZones,
    paceZones: r.paceZones,
    maxHr: r.maxHr,
    thresholdPaceSecPerMile: threshold,
    computedAt: r.computedAt,
  };
}
