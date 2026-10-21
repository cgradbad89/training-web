import { afterEach, describe, expect, it, vi } from "vitest";

// hydrateFastFinishSplits must (1) pre-filter on the cheap per-mile HR rows and
// spend a GPS route read ONLY when a run has a mile at/above the HRR gate, and
// (2) attach route-derived mileSplits with per-mile avgBpm merged when it does.
// Firestore, the route cache, and the haversine split derivation are mocked.

let hrRows: Record<string, { mile: number; avgBpm: number; sampleCount: number }[]> = {};
let routeEpoch = 0;
const getRoutePointsMock = vi.fn();
const computeMileSplitsMock = vi.fn();
const getMileSplitsMock = vi.fn(async (_uid: string, id: string) =>
  (hrRows[id] ?? []).map((row, index) => ({ id: String(index), ...row }))
);

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("@/utils/mileSplitsCache", () => ({
  getMileSplits: (...args: [string, string]) => getMileSplitsMock(...args),
}));

vi.mock("@/utils/routeCache", () => ({
  getRoutePoints: (...args: unknown[]) => getRoutePointsMock(...args),
  getRouteCacheEpoch: () => routeEpoch,
}));

vi.mock("@/utils/mileSplits", () => ({
  computeMileSplits: (...args: unknown[]) => computeMileSplitsMock(...args),
}));

import { hydrateFastFinishSplits } from "@/services/fastFinishSplits";
import { type HealthWorkout } from "@/types/healthWorkout";

const ASOF = new Date("2026-07-08T12:00:00Z");
const IN_WINDOW = new Date("2026-06-20T12:00:00Z"); // 18 days back (< 56d)

const mk = (p: Partial<HealthWorkout>): HealthWorkout =>
  ({
    isRunLike: true,
    distanceMiles: 6,
    avgHeartRate: 150,
    startDate: IN_WINDOW,
    ...p,
  }) as HealthWorkout;

afterEach(() => {
  hrRows = {};
  routeEpoch = 0;
  getRoutePointsMock.mockReset();
  computeMileSplitsMock.mockReset();
  getMileSplitsMock.mockReset().mockImplementation(async (_uid, id) =>
    (hrRows[id] ?? []).map((row, index) => ({ id: String(index), ...row }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe("hydrateFastFinishSplits — pre-filter", () => {
  it("skips the GPS route read for a run with no mile at/above the gate", async () => {
    // Gate at maxHr 175 / restingHr 65 → 153 bpm. All miles below → skip.
    hrRows["easy"] = [
      { mile: 1, avgBpm: 140, sampleCount: 10 },
      { mile: 2, avgBpm: 148, sampleCount: 10 },
      { mile: 3, avgBpm: 150, sampleCount: 10 },
    ];
    const runs = [mk({ workoutId: "easy" })];
    const res = await hydrateFastFinishSplits("u", runs, {
      maxHr: 175,
      restingHr: 65,
      asOf: ASOF,
    });
    expect(getRoutePointsMock).not.toHaveBeenCalled();
    expect(res.routeFetches).toBe(0);
    expect(res.runs[0].mileSplits).toBeUndefined();
  });

  it("fetches the route and attaches merged mileSplits when a hard mile exists", async () => {
    hrRows["hard"] = [
      { mile: 1, avgBpm: 140, sampleCount: 10 },
      { mile: 2, avgBpm: 156, sampleCount: 10 }, // ≥ 153 gate → pre-filter passes
    ];
    getRoutePointsMock.mockResolvedValue([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ]);
    computeMileSplitsMock.mockReturnValue([
      { mile: 1, segmentMiles: 1, paceSecPerMile: 600, isPartial: false },
      { mile: 2, segmentMiles: 1, paceSecPerMile: 480, isPartial: false },
    ]);
    const runs = [mk({ workoutId: "hard" })];
    const res = await hydrateFastFinishSplits("u", runs, {
      maxHr: 175,
      restingHr: 65,
      asOf: ASOF,
    });
    expect(getRoutePointsMock).toHaveBeenCalledTimes(1);
    expect(res.routeFetches).toBe(1);
    const splits = res.runs[0].mileSplits!;
    expect(splits).toHaveLength(2);
    expect(splits[0].avgBpm).toBe(140); // merged by mile
    expect(splits[1].avgBpm).toBe(156);
    expect(splits[1].paceSecPerMile).toBe(480); // route-derived pace preserved
  });

  it("leaves out-of-window and non-run workouts untouched (no reads)", async () => {
    hrRows["old"] = [{ mile: 1, avgBpm: 160, sampleCount: 10 }];
    const runs = [
      mk({ workoutId: "old", startDate: new Date("2026-01-01T12:00:00Z") }), // > 56d back
      mk({ workoutId: "walk", isRunLike: false }),
    ];
    const res = await hydrateFastFinishSplits("u", runs, {
      maxHr: 175,
      restingHr: 65,
      asOf: ASOF,
    });
    expect(getRoutePointsMock).not.toHaveBeenCalled();
    expect(res.routeFetches).toBe(0);
    expect(res.runs[0].mileSplits).toBeUndefined();
    expect(res.runs[1].mileSplits).toBeUndefined();
  });

  it("does not begin child reads for a retired consumer", async () => {
    const runs = [mk({ workoutId: "retired" })];
    expect(await hydrateFastFinishSplits("u", runs, {
      maxHr: 175, restingHr: 65, asOf: ASOF, isCurrent: () => false,
    })).toEqual({ runs, routeFetches: 0 });
    expect(getMileSplitsMock).not.toHaveBeenCalled();
    expect(getRoutePointsMock).not.toHaveBeenCalled();
  });

  it.each(["navigation", "auth session"])("does not start GPS after %s retires a pending prefilter", async retirement => {
    const pending = deferred<{ id: string; mile: number; avgBpm: number; sampleCount: number }[]>();
    getMileSplitsMock.mockReturnValue(pending.promise);
    let current = true;
    const runs = [mk({ workoutId: "pending" })];
    const hydration = hydrateFastFinishSplits("u", runs, {
      maxHr: 175, restingHr: 65, asOf: ASOF, isCurrent: () => current,
    });
    expect(getMileSplitsMock).toHaveBeenCalledOnce();
    if (retirement === "navigation") current = false;
    else routeEpoch++;
    pending.resolve([{ id: "1", mile: 1, avgBpm: 160, sampleCount: 10 }]);
    expect(await hydration).toEqual({ runs, routeFetches: 0 });
    expect(getRoutePointsMock).not.toHaveBeenCalled();
  });

  it("does not compute or publish route-derived splits after navigation", async () => {
    hrRows.pending = [{ mile: 1, avgBpm: 160, sampleCount: 10 }];
    const pending = deferred<{ lat: number; lng: number }[]>();
    getRoutePointsMock.mockReturnValue(pending.promise);
    let current = true;
    const runs = [mk({ workoutId: "pending" })];
    const hydration = hydrateFastFinishSplits("u", runs, {
      maxHr: 175, restingHr: 65, asOf: ASOF, isCurrent: () => current,
    });
    await vi.waitFor(() => expect(getRoutePointsMock).toHaveBeenCalledOnce());
    current = false;
    pending.resolve([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }]);
    expect((await hydration).runs).toEqual(runs);
    expect(computeMileSplitsMock).not.toHaveBeenCalled();
  });

  it("limits pending hydration to three runs and retires queued batches", async () => {
    const pending = deferred<{ id: string; mile: number; avgBpm: number; sampleCount: number }[]>();
    getMileSplitsMock.mockReturnValue(pending.promise);
    let current = true;
    const runs = Array.from({ length: 8 }, (_, i) => mk({ workoutId: String(i) }));
    const hydration = hydrateFastFinishSplits("u", runs, {
      maxHr: 175, restingHr: 65, asOf: ASOF, isCurrent: () => current,
    });
    expect(getMileSplitsMock).toHaveBeenCalledTimes(3);
    current = false;
    pending.resolve([]);
    expect((await hydration).runs).toEqual(runs);
    expect(getMileSplitsMock).toHaveBeenCalledTimes(3);
  });
});
