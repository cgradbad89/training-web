import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RoutePoint } from "@/services/routes";

// Real service implementations and calculations; only the Firestore and route
// acquisition boundaries are synthetic. No Firebase project is contacted.
const h = vi.hoisted(() => ({
  getDoc: vi.fn(), setDoc: vi.fn(), start: vi.fn(),
  batchSet: vi.fn(), commit: vi.fn(), writeBatch: vi.fn(),
}));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...parts: string[]) => parts.join("/"),
  doc: (_db: unknown, ...parts: string[]) => parts.join("/"),
  getDoc: h.getDoc, setDoc: h.setDoc,
  getDocs: vi.fn(), onSnapshot: vi.fn(), query: vi.fn(), where: vi.fn(),
  orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn(), writeBatch: h.writeBatch,
}));
vi.mock("@/utils/routeCache", () => ({ getRouteStartPoint: h.start }));

import { backfillRouteClusterIds, computeAndStoreBestEfforts } from "@/services/healthWorkouts";
import { deriveRouteClusterId } from "@/utils/routeClusterId";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const route: RoutePoint[] = Array.from({ length: 21 }, (_, i) => ({
  index: i, lat: i * 0.001, lng: 0, altitude: 0, speed: 3.7, hr: 150,
  timestamp: new Date(Date.UTC(2026, 9, 14, 12, 0, i * 30)).toISOString(),
}));
const start = { lat: 1, lng: 2 };
const workouts = (count: number) => Array.from({ length: count }, (_, i) => ({
  workoutId: `synthetic-${i}`, distanceMiles: 4, isRunLike: true, hasRoute: true,
} as HealthWorkout));

beforeEach(() => {
  vi.clearAllMocks();
  h.getDoc.mockResolvedValue({ exists: () => true, data: () => ({}) });
  h.setDoc.mockResolvedValue(undefined);
  h.start.mockResolvedValue(start);
  h.commit.mockResolvedValue(undefined);
  h.writeBatch.mockImplementation(() => ({ set: h.batchSet, commit: h.commit }));
});

describe("best-effort cache writer ownership", () => {
  it("performs no document read or write for an already-retired owner", async () => {
    await computeAndStoreBestEfforts("synthetic-owner", "run", route, true, { isCurrent: () => false });
    expect(h.getDoc).not.toHaveBeenCalled();
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it("does not initiate a cache write when ownership retires during its parent read", async () => {
    const pending = deferred<{ exists: () => boolean; data: () => object }>();
    h.getDoc.mockReturnValue(pending.promise);
    let current = true;
    const work = computeAndStoreBestEfforts("synthetic-owner", "run", route, true, { isCurrent: () => current });
    expect(h.getDoc).toHaveBeenCalledOnce();
    current = false;
    pending.resolve({ exists: () => true, data: () => ({}) });
    await work;
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it("preserves one merge write for a current owner's missing cache", async () => {
    const result = await computeAndStoreBestEfforts("synthetic-owner", "run", route, true, { isCurrent: () => true });
    expect(h.getDoc).toHaveBeenCalledOnce();
    expect(h.setDoc).toHaveBeenCalledExactlyOnceWith("users/synthetic-owner/healthWorkouts/run", {
      bestEfforts: result,
    }, { merge: true });
    expect(result["1mi"]).toBeGreaterThan(0);
    expect(result.computedFromRouteComplete).toBe(true);
    expect(result.computedFromPointCount).toBe(route.length);
  });

  it("does not rewrite an already-valid best-effort cache", async () => {
    const result = await computeAndStoreBestEfforts("synthetic-owner", "run", route, true);
    h.getDoc.mockResolvedValue({ exists: () => true, data: () => ({ bestEfforts: result }) });
    h.setDoc.mockClear();
    await computeAndStoreBestEfforts("synthetic-owner", "run", route, true, { isCurrent: () => true });
    expect(h.setDoc).not.toHaveBeenCalled();
  });
});

describe("route-cluster cache writer ownership", () => {
  it("performs no start-point reads or writes for an already-retired owner", async () => {
    expect(await backfillRouteClusterIds("synthetic-owner", workouts(12), { isCurrent: () => false })).toBe(0);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.writeBatch).not.toHaveBeenCalled();
  });

  it("does not start a second point batch or write after retirement during the first batch", async () => {
    const pending = deferred<typeof start>();
    h.start.mockReturnValue(pending.promise);
    let current = true;
    const work = backfillRouteClusterIds("synthetic-owner", workouts(12), { isCurrent: () => current });
    expect(h.start).toHaveBeenCalledTimes(10);
    current = false;
    pending.resolve(start);
    expect(await work).toBe(0);
    expect(h.start).toHaveBeenCalledTimes(10);
    expect(h.writeBatch).not.toHaveBeenCalled();
  });

  it("does not commit an earlier resolved result after retirement during a later point read", async () => {
    const pending = deferred<typeof start | null>();
    h.start.mockResolvedValueOnce(start).mockReturnValueOnce(pending.promise);
    let current = true;
    const work = backfillRouteClusterIds("synthetic-owner", workouts(2), { isCurrent: () => current });
    await Promise.resolve();
    current = false;
    pending.resolve(null);
    expect(await work).toBe(0);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.writeBatch).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("preserves active start-point hydration and a merged ID write for every missing workout", async () => {
    const input = workouts(12);
    expect(await backfillRouteClusterIds("synthetic-owner", input, { isCurrent: () => true })).toBe(12);
    expect(h.start).toHaveBeenCalledTimes(12);
    expect(h.writeBatch).toHaveBeenCalledOnce();
    expect(h.batchSet).toHaveBeenCalledTimes(12);
    expect(h.commit).toHaveBeenCalledOnce();
    for (const workout of input) {
      expect(h.batchSet).toHaveBeenCalledWith(`users/synthetic-owner/healthWorkouts/${workout.workoutId}`, {
        routeClusterId: deriveRouteClusterId(4, start),
      }, { merge: true });
    }
  });

  it("does not read or rewrite already-assigned geographic IDs", async () => {
    const input = workouts(2).map(workout => ({ ...workout, routeClusterId: deriveRouteClusterId(4, start) }));
    expect(await backfillRouteClusterIds("synthetic-owner", input)).toBe(0);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.writeBatch).not.toHaveBeenCalled();
  });
});
