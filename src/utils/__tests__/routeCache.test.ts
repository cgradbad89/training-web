import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutePoint } from "@/services/routes";

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
