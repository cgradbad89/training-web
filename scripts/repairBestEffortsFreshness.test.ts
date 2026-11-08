import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RoutePoint } from "@/services/routes";
import {
  computeBestEfforts,
  withBestEffortsFreshness,
  type BestEffortsMap,
} from "@/utils/bestEfforts";
import {
  repairBestEffortsFreshnessWithStore,
  type BestEffortRepairStore,
} from "./repairBestEffortsFreshness";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";

function route(): RoutePoint[] {
  return [
    { index: 0, lat: 0, lng: 0, altitude: 0, timestamp: "2026-01-01T12:00:00.000Z", speed: null, hr: null },
    { index: 1, lat: 0, lng: 0.02, altitude: 0, timestamp: "2026-01-01T12:10:00.000Z", speed: null, hr: null },
  ];
}
const EARTH_RADIUS_M = 3958.8 * 1609.344, MILE = 1609.344;
/** A 1 Hz steady route of `miles` (so duration ≈ point count, as observed on real data). */
function steady(miles: number, pace = 590): RoutePoint[] {
  const speed = MILE / pace, n = Math.floor((miles * MILE) / speed);
  return Array.from({ length: n + 1 }, (_, i) => ({ index: i, lat: ((i * speed) / EARTH_RADIUS_M) * (180 / Math.PI), lng: 0, altitude: 0,
    timestamp: new Date(Date.UTC(2026, 10, 7, 14, 0, i)).toISOString(), speed: null, hr: null }));
}
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T12:00:00.000Z`;

function makeStore(
  workouts: Array<{ workoutId: string; data: Record<string, unknown> }>,
  routes: Record<string, RoutePoint[] | Error>
): BestEffortRepairStore & {
  writes: Array<{ workoutId: string; bestEfforts: BestEffortsMap }>;
  rereads: string[];
} {
  const writes: Array<{ workoutId: string; bestEfforts: BestEffortsMap }> = [];
  const rereads: string[] = [];
  return {
    writes,
    rereads,
    async resolveUid(override) {
      return override ?? "owner";
    },
    async listRunWorkouts() {
      return workouts;
    },
    async readRoute(_uid, workoutId) {
      const value = routes[workoutId];
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    async writeBestEfforts(_uid, workoutId, bestEfforts) {
      writes.push({ workoutId, bestEfforts });
      const workout = workouts.find((item) => item.workoutId === workoutId)!;
      workout.data.bestEfforts = bestEfforts;
    },
    async readBestEfforts(_uid, workoutId) {
      rereads.push(workoutId);
      return workouts.find((item) => item.workoutId === workoutId)?.data
        .bestEfforts;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MISSING = (id: string, d: number, extra: Record<string, unknown> = {}) =>
  ({ workoutId: id, data: { hasRoute: true, routeComplete: true, startDate: day(d), distanceMiles: 3, durationSeconds: 1770, ...extra } });

describe("repairBestEffortsFreshness (parent-only selection, bounded, idempotent)", () => {
  it("a dry run reads NO route and writes nothing, but reports the estimated cost by cache state", async () => {
    const store = makeStore([MISSING("missing", 1), MISSING("v1", 2, { bestEfforts: { "1mi": 600, computationVersion: 1 } })], { missing: route(), v1: route() });
    const readSpy = vi.spyOn(store, "readRoute");
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: true, uid: "owner" }, store);
    expect(readSpy).not.toHaveBeenCalled();
    expect(report).toMatchObject({ scanned: 2, eligible: 2, missing: 1, routeReads: 0, repaired: 0, estimatedParentWrites: 2, estimatedRouteDocumentReads: 3540 });
    expect(report.byState).toEqual({ missing_recoverable: 1, stale_version: 1 });
    expect(store.writes).toEqual([]); expect(store.rereads).toEqual([]);
  });

  it("commit mode refuses to run without an explicit bound (no implicit full-history backfill)", async () => {
    const store = makeStore([MISSING("a", 1)], { a: route() });
    await expect(repairBestEffortsFreshnessWithStore({ dryRun: false }, store)).rejects.toThrow(/explicit bound/);
    await expect(repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 0 }, store)).rejects.toThrow(RangeError);
    expect(store.writes).toEqual([]);
  });

  it("commit writes the repaired map and re-reads it; the newest workouts come first and `limit` bounds the repair", async () => {
    const store = makeStore([MISSING("old", 1), MISSING("newest", 20), MISSING("middle", 10)], { old: route(), newest: route(), middle: route() });
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 2 }, store);
    expect(report).toMatchObject({ eligible: 2, repaired: 2, skippedOutsideBounds: 1, routeReads: 2 });
    expect(store.writes.map(w => w.workoutId)).toEqual(["newest", "middle"]);
    expect(store.rereads).toEqual(["newest", "middle"]);
    expect(store.writes[0].bestEfforts).toMatchObject({ computedFromRouteComplete: true, computedFromPointCount: 2, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION });
    expect(store.writes[0].bestEfforts.computedFromRouteDistanceMeters).toBeGreaterThan(0);
  });

  it("`since` excludes older history entirely (the 85 historical version-1 records can be left alone)", async () => {
    const store = makeStore([MISSING("hist", 1, { startDate: "2026-03-01T12:00:00.000Z" }), MISSING("recent", 25)], { hist: route(), recent: route() });
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, since: "2026-09-21" }, store);
    expect(report).toMatchObject({ eligible: 1, repaired: 1, skippedOutsideBounds: 1 });
    expect(store.writes.map(w => w.workoutId)).toEqual(["recent"]);
  });

  it("selects a v2 'complete' record computed from a truncated route, repairs it, and a second run selects nothing", async () => {
    const full = steady(9.18), truncated = full.slice(0, 400);
    const stale = withBestEffortsFreshness(computeBestEfforts(truncated), true, truncated.length);
    const store = makeStore([MISSING("nov7", 7, { distanceMiles: 9.18, durationSeconds: full.length - 1, bestEfforts: stale })], { nov7: full });
    const first = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(first).toMatchObject({ eligible: 1, repaired: 1 }); expect(first.byState).toEqual({ suspicious_recoverable: 1 });
    expect(store.writes[0].bestEfforts["10k"]).not.toBeNull();
    const second = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(second).toMatchObject({ eligible: 0, repaired: 0, routeReads: 0 }); expect(second.byState).toEqual({ valid_current: 1 });
    expect(store.writes).toHaveLength(1);
  });

  it("never reads the route of a valid, current record", async () => {
    const points = steady(3);
    const valid = withBestEffortsFreshness(computeBestEfforts(points), true, points.length);
    const store = makeStore([MISSING("fresh", 3, { distanceMiles: 3, durationSeconds: points.length - 1, bestEfforts: valid })], { fresh: points });
    const readSpy = vi.spyOn(store, "readRoute");
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(readSpy).not.toHaveBeenCalled(); expect(report).toMatchObject({ eligible: 0, repaired: 0 }); expect(store.writes).toEqual([]);
  });

  it("skips a partial route without reading or force-computing it", async () => {
    const store = makeStore([MISSING("partial", 2, { routeComplete: false })], { partial: route() });
    const readSpy = vi.spyOn(store, "readRoute");
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(report).toMatchObject({ scanned: 1, eligible: 0, skippedPartial: 1, repaired: 0 });
    expect(readSpy).not.toHaveBeenCalled(); expect(store.writes).toEqual([]);
  });

  it("a partial-route record whose route has since completed is selected", async () => {
    const partial = withBestEffortsFreshness(computeBestEfforts(steady(2).slice(0, 300)), false, 300);
    const store = makeStore([MISSING("done", 4, { bestEfforts: partial, distanceMiles: 2, durationSeconds: 1180 })], { done: steady(2) });
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(report.byState).toEqual({ incomplete_route_completed: 1 }); expect(report.repaired).toBe(1);
  });

  it("keeps a better-grounded existing record when the route read returns fewer points than it was computed from (logs it, writes nothing)", async () => {
    const richer = steady(9), good = withBestEffortsFreshness(computeBestEfforts(richer), true, richer.length);
    // density looks low against the workout's duration (so it is selected), but a short/partial read must not replace it
    const store = makeStore([MISSING("x", 5, { bestEfforts: good, distanceMiles: 9, durationSeconds: 12000 })], { x: richer.slice(0, 800) });
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(report).toMatchObject({ eligible: 1, routeReads: 1, repaired: 0 });
    expect(store.writes).toEqual([]); expect(console.log).toHaveBeenCalledWith(expect.stringContaining("KEEP_BETTER_EXISTING x"));
  });

  it("falls through gracefully when bestEfforts is corrupt", async () => {
    const store = makeStore([MISSING("corrupt", 6, { bestEfforts: "bad" })], { corrupt: route() });
    await expect(repairBestEffortsFreshnessWithStore({ dryRun: true }, store)).resolves.toMatchObject({ eligible: 1, missing: 1, repaired: 0 });
  });

  it("logs and skips an unreadable route while continuing other workouts", async () => {
    const store = makeStore([MISSING("broken", 7), MISSING("good", 8)], { broken: new Error("permission denied"), good: route() });
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: false, limit: 5 }, store);
    expect(report).toMatchObject({ eligible: 2, repaired: 1 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.any(Error));
  });

  it("`verifyRoutes` in a dry run reads only the selected routes (bounded by limit) to show diffs, and still writes nothing", async () => {
    const store = makeStore([MISSING("a", 1), MISSING("b", 2), MISSING("c", 3)], { a: route(), b: route(), c: route() });
    const readSpy = vi.spyOn(store, "readRoute");
    const report = await repairBestEffortsFreshnessWithStore({ dryRun: true, verifyRoutes: true, limit: 2 }, store);
    expect(readSpy).toHaveBeenCalledTimes(2); expect(report.routeReads).toBe(2); expect(report.repaired).toBe(0); expect(store.writes).toEqual([]);
  });

  it("skips runs without a route flag", async () => {
    const store = makeStore([MISSING("none", 1, { hasRoute: false })], {});
    expect(await repairBestEffortsFreshnessWithStore({ dryRun: true }, store)).toMatchObject({ scanned: 1, skippedNoRoute: 1, eligible: 0 });
  });
});
