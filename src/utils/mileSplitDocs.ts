/**
 * Mile-split cache codec — converts between the `mileSplits` subcollection
 * docs and the in-memory MileSplit shape.
 *
 * The subcollection is iOS-written with per-mile HR only ({mile, avgBpm,
 * sampleCount}). The web app EXTENDS those docs (merge write, never replacing
 * iOS fields) with the route-derived values it previously recomputed from the
 * full GPS route on every view: distanceMiles, paceSecPerMile, isPartial, and
 * basisTotalMiles (the authoritative run distance the split was computed
 * against — a distance override invalidates the cache so splits are
 * recomputed under the new total).
 *
 * Docs are merged BY THE `mile` FIELD, not by doc ID: iOS doc IDs are opaque,
 * and web-created docs (for runs iOS wrote no HR splits for) use `mile_<n>`.
 * Merging by mile keeps the reader correct even if both writers ever produce
 * a doc for the same mile.
 */

import { type MileSplitDoc } from "@/utils/mileSplitsCache";
import { type MileSplit } from "@/utils/mileSplits";

/** Same reliability gate the run-detail page applies to iOS per-mile HR. */
const MIN_HR_SAMPLE_COUNT = 2;

/** Tolerance when comparing the cached basis total to the current distance. */
const TOTAL_MILES_EPSILON = 0.005;

interface MergedMileRow {
  mile: number;
  distanceMiles?: number;
  paceSecPerMile?: number;
  isPartial?: boolean;
  basisTotalMiles?: number;
  avgBpm?: number;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Collapse subcollection docs into one row per mile (fields merged). */
function mergeByMile(docs: MileSplitDoc[]): Map<number, MergedMileRow> {
  const byMile = new Map<number, MergedMileRow>();
  for (const d of docs) {
    const mile = asFiniteNumber(d.mile);
    if (mile == null || mile < 1 || !Number.isInteger(mile)) continue;
    const row = byMile.get(mile) ?? { mile };

    const dist = asFiniteNumber(d.distanceMiles);
    const pace = asFiniteNumber(d.paceSecPerMile);
    const basis = asFiniteNumber(d.basisTotalMiles);
    if (dist != null) row.distanceMiles = dist;
    if (pace != null) row.paceSecPerMile = pace;
    if (basis != null) row.basisTotalMiles = basis;
    if (typeof d.isPartial === "boolean") row.isPartial = d.isPartial;

    const avgBpm = asFiniteNumber(d.avgBpm);
    const sampleCount = asFiniteNumber(d.sampleCount);
    if (
      avgBpm != null &&
      sampleCount != null &&
      sampleCount >= MIN_HR_SAMPLE_COUNT
    ) {
      row.avgBpm = avgBpm;
    }
    byMile.set(mile, row);
  }
  return byMile;
}

/**
 * Rebuild MileSplit[] from cached subcollection docs.
 *
 * Returns null (cache miss → caller computes from raw route points and writes
 * back) unless EVERY mile 1..N is present with finite distance + pace AND the
 * cached basis total matches `currentTotalMiles` (so an edited distance
 * override forces a recompute). avgBpm is merged in from the same docs.
 */
export function splitsFromCachedDocs(
  docs: MileSplitDoc[],
  currentTotalMiles: number
): MileSplit[] | null {
  const byMile = mergeByMile(docs);
  if (byMile.size === 0) return null;

  const maxMile = Math.max(...byMile.keys());
  const splits: MileSplit[] = [];

  for (let mile = 1; mile <= maxMile; mile++) {
    const row = byMile.get(mile);
    if (
      !row ||
      row.distanceMiles == null ||
      row.distanceMiles <= 0 ||
      row.paceSecPerMile == null ||
      row.paceSecPerMile < 0 ||
      row.basisTotalMiles == null
    ) {
      return null; // not (fully) cached — fall back to raw computation
    }
    if (Math.abs(row.basisTotalMiles - currentTotalMiles) > TOTAL_MILES_EPSILON) {
      return null; // stale basis (e.g. distance override changed)
    }
    splits.push({
      mile,
      segmentMiles: row.distanceMiles,
      paceSecPerMile: row.paceSecPerMile,
      isPartial: row.isPartial ?? (mile === maxMile && row.distanceMiles < 0.995),
      avgBpm: row.avgBpm,
    });
  }

  return splits;
}

export interface MileSplitCacheWrite {
  docId: string;
  data: {
    mile: number;
    distanceMiles: number;
    paceSecPerMile: number;
    isPartial: boolean;
    basisTotalMiles: number;
  };
}

/**
 * The merge writes that persist freshly computed splits back onto the
 * subcollection. A mile that already has an iOS doc reuses that doc's ID
 * (merge write preserves avgBpm/sampleCount); a mile with no doc gets a
 * deterministic `mile_<n>` ID. Returns [] when there is nothing valid to
 * write (empty splits — never persists an empty marker).
 */
export function mileSplitCacheWrites(
  splits: MileSplit[],
  existingDocs: MileSplitDoc[],
  authoritativeTotalMiles: number
): MileSplitCacheWrite[] {
  if (splits.length === 0) return [];

  // First existing doc per mile wins as the merge target.
  const docIdByMile = new Map<number, string>();
  for (const d of existingDocs) {
    const mile = asFiniteNumber(d.mile);
    if (mile != null && !docIdByMile.has(mile)) docIdByMile.set(mile, d.id);
  }

  return splits
    .filter(
      (s) =>
        Number.isFinite(s.paceSecPerMile) &&
        s.paceSecPerMile >= 0 &&
        Number.isFinite(s.segmentMiles) &&
        s.segmentMiles > 0
    )
    .map((s) => ({
      docId: docIdByMile.get(s.mile) ?? `mile_${s.mile}`,
      data: {
        mile: s.mile,
        distanceMiles: s.segmentMiles,
        paceSecPerMile: s.paceSecPerMile,
        isPartial: s.isPartial,
        basisTotalMiles: authoritativeTotalMiles,
      },
    }));
}
