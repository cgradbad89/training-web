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

function route(): RoutePoint[] {
  return [
    {
      index: 0,
      lat: 0,
      lng: 0,
      altitude: 0,
      timestamp: "2026-01-01T12:00:00.000Z",
      speed: null,
      hr: null,
    },
    {
      index: 1,
      lat: 0,
      lng: 0.02,
      altitude: 0,
      timestamp: "2026-01-01T12:10:00.000Z",
      speed: null,
      hr: null,
    },
  ];
}

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

describe("repairBestEffortsFreshness", () => {
  it("dry-run reports the full diff but performs no write or re-read", async () => {
    const store = makeStore(
      [{ workoutId: "missing", data: { routeComplete: true } }],
      { missing: route() }
    );
    const report = await repairBestEffortsFreshnessWithStore(
      { dryRun: true, uid: "owner" },
      store
    );

    expect(report).toMatchObject({ scanned: 1, stale: 1, missing: 1, repaired: 0 });
    expect(report.diffs).toHaveLength(1);
    expect(report.diffs[0]).toMatchObject({ workoutId: "missing", oldValue: null });
    expect(store.writes).toEqual([]);
    expect(store.rereads).toEqual([]);
  });

  it("apply writes the repaired map and immediately re-reads it", async () => {
    const store = makeStore(
      [{ workoutId: "stale", data: { routeComplete: true, bestEfforts: { "1mi": 999 } } }],
      { stale: route() }
    );
    const report = await repairBestEffortsFreshnessWithStore(
      { dryRun: false },
      store
    );

    expect(report.repaired).toBe(1);
    expect(store.writes).toHaveLength(1);
    expect(store.rereads).toEqual(["stale"]);
    expect(store.writes[0].bestEfforts).toMatchObject({
      computedFromRouteComplete: true,
      computedFromPointCount: 2,
      computationVersion: 1,
    });
  });

  it("skips a partial route without reading or force-computing it", async () => {
    const store = makeStore(
      [{ workoutId: "partial", data: { routeComplete: false } }],
      { partial: route() }
    );
    const readSpy = vi.spyOn(store, "readRoute");
    const report = await repairBestEffortsFreshnessWithStore(
      { dryRun: false },
      store
    );
    expect(report).toEqual({ scanned: 1, stale: 0, missing: 0, repaired: 0, diffs: [] });
    expect(readSpy).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it("falls through gracefully when bestEfforts is corrupt", async () => {
    const store = makeStore(
      [{ workoutId: "corrupt", data: { routeComplete: true, bestEfforts: "bad" } }],
      { corrupt: route() }
    );
    await expect(
      repairBestEffortsFreshnessWithStore({ dryRun: true }, store)
    ).resolves.toMatchObject({ stale: 1, missing: 1, repaired: 0 });
  });

  it("logs and skips an unreadable route while continuing other workouts", async () => {
    const store = makeStore(
      [
        { workoutId: "broken", data: { routeComplete: true } },
        { workoutId: "good", data: { routeComplete: true } },
      ],
      { broken: new Error("permission denied"), good: route() }
    );
    const report = await repairBestEffortsFreshnessWithStore(
      { dryRun: true },
      store
    );
    expect(report).toMatchObject({ scanned: 2, stale: 1, missing: 1 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("broken"),
      expect.any(Error)
    );
  });

  it("does not rewrite an already-current complete-route value", async () => {
    const points = route();
    const fresh = withBestEffortsFreshness(
      computeBestEfforts(points),
      true,
      points.length
    );
    const store = makeStore(
      [{ workoutId: "fresh", data: { routeComplete: true, bestEfforts: fresh } }],
      { fresh: points }
    );
    const report = await repairBestEffortsFreshnessWithStore(
      { dryRun: false },
      store
    );
    expect(report.stale).toBe(0);
    expect(store.writes).toEqual([]);
  });
});
