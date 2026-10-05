import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutePoint } from "@/services/routes";
import type { HealthWorkout } from "@/types/healthWorkout";
import { clusterRoutesGeographic } from "@/utils/routeClustering";

const h = vi.hoisted(() => ({ fetch: vi.fn(), getDocs: vi.fn() }));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.fetch }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  query: (ref: unknown) => ref,
  orderBy: vi.fn(), limit: vi.fn(), getDocs: h.getDocs,
}));

import {
  clearRouteCache, setRouteCacheSession, getRoutePoints, getRouteStartPoint,
  isRouteCached, prefetchRoutes,
} from "@/utils/routeCache";

const points = (lat: number): RoutePoint[] => [{
  index: 0, lat, lng: -77, altitude: 0, timestamp: "", speed: null, hr: null,
}];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setRouteCacheSession(null);
  clearRouteCache();
  h.fetch.mockReset();
  h.getDocs.mockReset().mockResolvedValue({ empty: true });
});
afterEach(() => { clearRouteCache(); vi.useRealTimers(); });

describe("GPS memory identity and session ownership", () => {
  it("reuses resolved GPS for the same UID/workout", async () => {
    h.fetch.mockResolvedValue(points(38));
    expect(await getRoutePoints("A", "X")).toEqual(points(38));
    expect(await getRoutePoints("A", "X")).toEqual(points(38));
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(isRouteCached("A", "X")).toBe(true);
    expect(isRouteCached("B", "X")).toBe(false);
  });

  it("deduplicates concurrent requests only within a UID/workout key", async () => {
    const pending = deferred<RoutePoint[]>();
    h.fetch.mockReturnValue(pending.promise);
    const first = getRoutePoints("A", "X");
    const second = getRoutePoints("A", "X");
    expect(h.fetch).toHaveBeenCalledOnce();
    pending.resolve(points(38));
    expect(await first).toEqual(await second);
  });

  it("never returns A's cached workout X to B", async () => {
    h.fetch.mockResolvedValueOnce(points(38)).mockResolvedValueOnce(points(42));
    await getRoutePoints("A", "X");
    expect(await getRoutePoints("B", "X")).toEqual(points(42));
    expect(h.fetch.mock.calls).toEqual([["A", "X"], ["B", "X"]]);
  });

  it("never deduplicates B into A's pending request for workout X", async () => {
    const a = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(a.promise).mockResolvedValueOnce(points(42));
    const old = getRoutePoints("A", "X");
    expect(await getRoutePoints("B", "X")).toEqual(points(42));
    a.resolve(points(38));
    await old;
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("logout clears usable memory and same-UID login starts a fresh session", async () => {
    setRouteCacheSession("A");
    h.fetch.mockResolvedValueOnce(points(38)).mockResolvedValueOnce(points(39));
    await getRoutePoints("A", "X");
    setRouteCacheSession("A"); // token refresh / duplicate auth observation
    expect(isRouteCached("A", "X")).toBe(true);
    setRouteCacheSession(null);
    expect(isRouteCached("A", "X")).toBe(false);
    setRouteCacheSession("A");
    expect(await getRoutePoints("A", "X")).toEqual(points(39));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("direct UID replacement retires A's pending cache owner before B resolves", async () => {
    setRouteCacheSession("A");
    const a = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(a.promise).mockResolvedValueOnce(points(42));
    const old = getRoutePoints("A", "X");
    setRouteCacheSession("B");
    expect(await getRoutePoints("B", "X")).toEqual(points(42));
    a.resolve(points(38));
    await old;
    expect(isRouteCached("A", "X")).toBe(false);
    expect(isRouteCached("B", "X")).toBe(true);
  });

  it("an old session cannot repopulate memory or remove a fresh same-key in-flight request", async () => {
    setRouteCacheSession("A");
    const old = deferred<RoutePoint[]>();
    const fresh = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldRead = getRoutePoints("A", "X");
    setRouteCacheSession(null);
    setRouteCacheSession("A");
    const freshRead = getRoutePoints("A", "X");
    old.resolve(points(38));
    await oldRead;
    expect(isRouteCached("A", "X")).toBe(false);
    const reusedFresh = getRoutePoints("A", "X");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    fresh.resolve(points(39));
    expect(await freshRead).toEqual(points(39));
    expect(await reusedFresh).toEqual(points(39));
    expect(await getRoutePoints("A", "X")).toEqual(points(39));
  });

  it("clear remains effective when a late old promise resolves with no replacement", async () => {
    const pending = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(points(40));
    const read = getRoutePoints("A", "X");
    clearRouteCache();
    pending.resolve(points(38));
    await read;
    expect(isRouteCached("A", "X")).toBe(false);
    expect(await getRoutePoints("A", "X")).toEqual(points(40));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("an old rejected promise cannot remove the new session's request", async () => {
    const old = deferred<RoutePoint[]>();
    const fresh = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const read = getRoutePoints("A", "X").catch(() => {});
    clearRouteCache();
    const newRead = getRoutePoints("A", "X");
    old.reject(new Error("retired failure"));
    await read;
    const deduplicated = getRoutePoints("A", "X");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    fresh.resolve(points(40));
    await Promise.all([newRead, deduplicated]);
  });

  it("route start points reuse only the requesting UID's full GPS cache", async () => {
    h.fetch.mockResolvedValue(points(38));
    await getRoutePoints("A", "X");
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 38, lng: -77 });
    h.getDocs.mockResolvedValue({ empty: false, docs: [{ data: () => ({ lat: 42, lng: -71 }) }] });
    expect(await getRouteStartPoint("B", "X")).toEqual({ lat: 42, lng: -71 });
    expect(h.getDocs).toHaveBeenCalledWith("users/B/healthWorkouts/X/route");
  });

  it("preserves prefetch/detail reuse and prevents retired prefetch batches from starting", async () => {
    vi.useFakeTimers();
    const pending = deferred<RoutePoint[]>();
    h.fetch.mockReturnValueOnce(pending.promise);
    const prefetch = prefetchRoutes("A", ["X", "Y"], 1);
    clearRouteCache();
    pending.resolve(points(38));
    await vi.runAllTimersAsync();
    await prefetch;
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.fetch.mockResolvedValue(points(40));
    await prefetchRoutes("A", ["X"]);
    expect(await getRoutePoints("A", "X")).toEqual(points(40));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("bounded session route-start cache", () => {
  const snapshot = (lat = 38) => ({ empty: false, docs: [{ data: () => ({ lat, lng: -77 }) }] });

  it("queries once then reuses a successful same-session start", async () => {
    setRouteCacheSession("A"); h.getDocs.mockResolvedValue(snapshot());
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 38, lng: -77 });
    setRouteCacheSession("A");
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 38, lng: -77 });
    expect(h.getDocs).toHaveBeenCalledOnce(); expect(h.fetch).not.toHaveBeenCalled();
    expect(isRouteCached("A", "X")).toBe(false);
  });

  it("shares one underlying query between 50 concurrent consumers", async () => {
    const pending = deferred<ReturnType<typeof snapshot>>(); h.getDocs.mockReturnValue(pending.promise);
    const reads = Array.from({ length: 50 }, () => getRouteStartPoint("A", "X"));
    await vi.waitFor(() => expect(h.getDocs).toHaveBeenCalledOnce());
    pending.resolve(snapshot());
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 50 }, () => ({ lat: 38, lng: -77 })));
  });

  it.each(["empty", "failure", "invalid coordinates"])("does not retain %s and retries incomplete GPS", async kind => {
    if (kind === "failure") h.getDocs.mockRejectedValueOnce(new Error("offline"));
    else if (kind === "empty") h.getDocs.mockResolvedValueOnce({ empty: true });
    else h.getDocs.mockResolvedValueOnce(snapshot(NaN));
    h.getDocs.mockResolvedValueOnce(snapshot(39));
    expect(await getRouteStartPoint("A", "X")).toBeNull();
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 39, lng: -77 });
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 39, lng: -77 });
    expect(h.getDocs).toHaveBeenCalledTimes(2);
  });

  it("scopes identical workout IDs by UID", async () => {
    h.getDocs.mockResolvedValueOnce(snapshot(38)).mockResolvedValueOnce(snapshot(42));
    await getRouteStartPoint("A", "X");
    expect(await getRouteStartPoint("B", "X")).toEqual({ lat: 42, lng: -77 });
    expect(h.getDocs.mock.calls).toEqual([["users/A/healthWorkouts/X/route"], ["users/B/healthWorkouts/X/route"]]);
  });

  it.each(["UID change", "same UID new session", "explicit epoch clear"])("retires resolved starts at %s", async kind => {
    setRouteCacheSession("A"); h.getDocs.mockResolvedValueOnce(snapshot(38)).mockResolvedValueOnce(snapshot(39));
    await getRouteStartPoint("A", "X");
    if (kind === "UID change") setRouteCacheSession("B");
    else if (kind === "explicit epoch clear") clearRouteCache();
    else { setRouteCacheSession(null); setRouteCacheSession("A"); }
    expect(await getRouteStartPoint(kind === "UID change" ? "B" : "A", "X")).toEqual({ lat: 39, lng: -77 });
    expect(h.getDocs).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("late retired %s cannot publish or remove replacement work", async kind => {
    setRouteCacheSession("A");
    const old = deferred<ReturnType<typeof snapshot>>(); const fresh = deferred<ReturnType<typeof snapshot>>();
    h.getDocs.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldRead = getRouteStartPoint("A", "X"); await vi.waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(1));
    setRouteCacheSession(null); setRouteCacheSession("A");
    const freshRead = getRouteStartPoint("A", "X"); await vi.waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(2));
    if (kind === "success") old.resolve(snapshot(38)); else old.reject(new Error("retired failure"));
    expect(await oldRead).toBeNull();
    const reused = getRouteStartPoint("A", "X"); fresh.resolve(snapshot(39));
    expect(await freshRead).toEqual({ lat: 39, lng: -77 }); expect(await reused).toEqual({ lat: 39, lng: -77 });
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 39, lng: -77 }); expect(h.getDocs).toHaveBeenCalledTimes(2);
  });

  it("retirement before async imports finish prevents the old query starting", async () => {
    const read = getRouteStartPoint("A", "X"); clearRouteCache();
    expect(await read).toBeNull(); expect(h.getDocs).not.toHaveBeenCalled();
  });

  it("full GPS remains a separate demand read and takes precedence afterward", async () => {
    h.getDocs.mockResolvedValue(snapshot(38)); await getRouteStartPoint("A", "X");
    h.fetch.mockResolvedValue(points(39)); expect(await getRoutePoints("A", "X")).toEqual(points(39));
    expect(await getRouteStartPoint("A", "X")).toEqual({ lat: 39, lng: -77 });
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.getDocs).toHaveBeenCalledOnce();
  });

  it("empty full GPS preserves its existing contract without a separate start query", async () => {
    h.fetch.mockResolvedValue([]); await getRoutePoints("A", "X");
    expect(await getRouteStartPoint("A", "X")).toBeNull(); expect(h.getDocs).not.toHaveBeenCalled();
  });

  it.each(["UID change", "same UID new session"])("stops retired geographic batches after %s", async kind => {
    setRouteCacheSession("A");
    const pending = deferred<ReturnType<typeof snapshot>>(); h.getDocs.mockReturnValue(pending.promise);
    const runs = Array.from({ length: 50 }, (_, i) => ({ workoutId: String(i), distanceMiles: 3 } as HealthWorkout));
    const preparation = clusterRoutesGeographic(runs, "A");
    await vi.waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(10));
    if (kind === "UID change") setRouteCacheSession("B");
    else { setRouteCacheSession(null); setRouteCacheSession("A"); }
    pending.resolve(snapshot()); expect(await preparation).toEqual([]);
    expect(h.getDocs).toHaveBeenCalledTimes(10);
    h.getDocs.mockResolvedValue(snapshot(39));
    expect(await getRouteStartPoint(kind === "UID change" ? "B" : "A", "49")).toEqual({ lat: 39, lng: -77 });
    expect(h.getDocs).toHaveBeenCalledTimes(11);
  });

  it("requests distinct workout starts independently in parallel", async () => {
    h.getDocs.mockResolvedValue(snapshot());
    await Promise.all(Array.from({ length: 50 }, (_, i) => getRouteStartPoint("A", String(i))));
    expect(h.getDocs).toHaveBeenCalledTimes(50);
  });

  it("retains at most 500 starts, evicting the least recently used", async () => {
    h.getDocs.mockResolvedValue(snapshot());
    for (let i = 0; i < 500; i++) await getRouteStartPoint("A", String(i));
    await getRouteStartPoint("A", "0"); await getRouteStartPoint("A", "500");
    await getRouteStartPoint("A", "0"); expect(h.getDocs).toHaveBeenCalledTimes(501);
    await getRouteStartPoint("A", "1"); expect(h.getDocs).toHaveBeenCalledTimes(502);
  });
});
