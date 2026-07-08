import { afterEach, describe, expect, it, vi } from "vitest";

// hydrateFastFinishSplits must (1) pre-filter on the cheap per-mile HR rows and
// spend a GPS route read ONLY when a run has a mile at/above the HRR gate, and
// (2) attach route-derived mileSplits with per-mile avgBpm merged when it does.
// Firestore, the route cache, and the haversine split derivation are mocked.

let hrRows: Record<string, { mile: number; avgBpm: number; sampleCount: number }[]> = {};
const getRoutePointsMock = vi.fn();
const computeMileSplitsMock = vi.fn();

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => ({ path }),
  orderBy: vi.fn(),
  query: (ref: { path: string }) => ref,
  getDocs: async (ref: { path: string }) => {
    // path = users/{uid}/healthWorkouts/{id}/mileSplits
    const parts = ref.path.split("/");
    const id = parts[parts.length - 2];
    const rows = hrRows[id] ?? [];
    return { docs: rows.map((r) => ({ data: () => r })) };
  },
}));

vi.mock("@/utils/routeCache", () => ({
  getRoutePoints: (...args: unknown[]) => getRoutePointsMock(...args),
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
  getRoutePointsMock.mockReset();
  computeMileSplitsMock.mockReset();
});

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
});
