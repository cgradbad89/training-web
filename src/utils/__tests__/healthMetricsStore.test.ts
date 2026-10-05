import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthMetric } from "@/services/healthMetrics";
import { HealthMetricsStore } from "../healthMetricsStore";
import { getUncoveredGaps, healthDateStatus, healthRollingRange, metricsInCacheRange } from "../healthMetricsCache";

function deferred() {
  let resolve!: (value: HealthMetric[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<HealthMetric[]>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("bounded Health session request ownership", () => {
  const range = { start: "2026-10-01", end: "2026-10-03" };
  let loader: ReturnType<typeof vi.fn<(uid: string, start: string, end: string) => Promise<HealthMetric[]>>>;
  let current: boolean;
  let store: HealthMetricsStore;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 5, 12));
    vi.spyOn(console, "error").mockImplementation(() => {});
    current = true;
    loader = vi.fn().mockResolvedValue([{ date: "2026-10-02", steps: 20 }]);
    store = new HealthMetricsStore("A", loader, () => current);
    store.activate(true);
  });
  afterEach(() => { store.retire(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("a dormant training-only shell has no metric cache or read", async () => {
    store.setActive(false);
    expect(store.getSnapshot().cache).toBeNull();
    await store.ensureRange(range);
    expect(store.getSnapshot().cache).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
  it("first Health request creates canonical entries and successful/empty coverage", async () => {
    await store.ensureRange(range);
    expect(loader).toHaveBeenCalledWith("A", range.start, range.end);
    const cache = store.getSnapshot().cache!;
    expect(cache.coveredRanges).toEqual([range]);
    expect(healthDateStatus(cache, "2026-10-01", Date.now())).toBe("covered-empty");
    expect(cache.entries.get("2026-10-02")?.metrics.steps).toBe(20);
  });
  it("retains resident cache across inactivity, ignores inactive requests, and reuses fresh coverage", async () => {
    await store.ensureRange(range);
    const cache = store.getSnapshot().cache;
    store.setActive(false);
    await store.ensureRange(range, true);
    expect(store.getSnapshot().cache).toBe(cache);
    store.setActive(true);
    await store.ensureRange(range);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("stale re-entry starts one authoritative range and retains resident content while pending", async () => {
    await store.ensureRange(range);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const work = store.ensureRange(range);
    await Promise.resolve();
    expect(store.getSnapshot().pendingRanges).toEqual([range]);
    expect(store.getSnapshot().cache?.entries.has("2026-10-02")).toBe(true);
    pending.resolve([]); await work;
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().cache?.entries.size).toBe(0);
  });
  it("fresh empty coverage prevents redundant reads until stale", async () => {
    loader.mockResolvedValue([]);
    await store.ensureRange(range); await store.ensureRange(range);
    expect(loader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 30));
    await store.ensureRange(range);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("identical mount/visibility/manual requests reuse the pending promise", async () => {
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const first = store.ensureRange(range);
    expect(store.ensureRange(range)).toBe(first);
    expect(store.ensureRange(range, true)).toBe(first);
    await Promise.resolve(); expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve([]); await first;
  });
  it("overlapping YTD/rolling ranges join work and query exact disjoint gaps", async () => {
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const rolling = store.ensureRange(range);
    const broader = store.ensureRange({ start: "2026-09-30", end: "2026-10-04" });
    await Promise.resolve();
    expect(loader.mock.calls).toEqual([
      ["A", "2026-10-01", "2026-10-03"], ["A", "2026-09-30", "2026-09-30"], ["A", "2026-10-04", "2026-10-04"],
    ]);
    pending.resolve([{ date: "2026-10-02", steps: 20 }]); await Promise.all([rolling, broader]);
    expect(store.getSnapshot().cache?.coveredRanges).toEqual([{ start: "2026-09-30", end: "2026-10-04" }]);
  });
  it("disjoint in-flight reservations are sorted and reused without widened reads", async () => {
    const left = deferred(); const right = deferred();
    loader.mockReturnValueOnce(right.promise).mockReturnValueOnce(left.promise);
    const r = store.ensureRange({ start: "2026-10-03", end: "2026-10-03" });
    const l = store.ensureRange({ start: "2026-10-01", end: "2026-10-01" });
    const all = store.ensureRange(range);
    await Promise.resolve();
    expect(loader.mock.calls.map(call => call.slice(1))).toEqual([["2026-10-03", "2026-10-03"], ["2026-10-01", "2026-10-01"], ["2026-10-02", "2026-10-02"]]);
    left.resolve([]); right.resolve([]); await Promise.all([l, r, all]);
  });
  it("failed extensions preserve resident rows and coverage, expose errors and retry", async () => {
    await store.ensureRange(range);
    loader.mockRejectedValueOnce(new Error("offline"));
    const extension = { start: "2026-10-04", end: "2026-10-05" };
    await store.ensureRange(extension);
    const cache = store.getSnapshot().cache!;
    expect(cache.entries.get("2026-10-02")?.metrics.steps).toBe(20);
    expect(getUncoveredGaps(cache, extension)).toEqual([extension]);
    expect(store.getSnapshot().error).toBe("offline");
    await store.ensureRange(extension);
    expect(getUncoveredGaps(store.getSnapshot().cache!, extension)).toEqual([]);
    expect(store.getSnapshot().error).toBeNull();
  });
  it("initial failure is a real error with no successful residency and remains retryable", async () => {
    loader.mockRejectedValueOnce(new Error("offline"));
    await store.ensureRange(range);
    expect(store.getSnapshot()).toMatchObject({ error: "offline", pendingRanges: [] });
    expect(store.getSnapshot().cache?.coveredRanges).toEqual([]);
    await store.ensureRange(range);
    expect(store.getSnapshot().error).toBeNull();
  });
  it("failed explicit refresh preserves success metadata/rows without pretending freshness", async () => {
    await store.ensureRange(range);
    const timestamp = store.getSnapshot().cache?.coverage.get(range.start)?.lastSuccessAt;
    loader.mockRejectedValueOnce(new Error("offline"));
    await store.ensureRange(range, true);
    expect(store.getSnapshot().cache?.coverage.get(range.start)).toEqual({ lastSuccessAt: timestamp, error: "offline" });
    expect(store.getSnapshot().cache?.entries.has("2026-10-02")).toBe(true);
    await store.ensureRange(range);
    expect(loader).toHaveBeenCalledTimes(3);
  });
  it("local midnight fetches only the new day while historical coverage is fresh", async () => {
    vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 59));
    await store.ensureRange(healthRollingRange("2026-10-05"));
    vi.setSystemTime(new Date(2026, 9, 6, 0, 0, 1));
    await store.ensureRange(healthRollingRange("2026-10-06"));
    expect(loader.mock.calls[1]).toEqual(["A", "2026-10-06", "2026-10-06"]);
    expect(store.getSnapshot().cache?.coverage.has("2026-10-05")).toBe(true);
  });
  it("local year rollover isolates new YTD and retains reachable prior-year dates", async () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    loader.mockResolvedValueOnce([{ date: "2026-12-31", steps: 10 }]).mockResolvedValueOnce([{ date: "2027-01-01", steps: 20 }]);
    await store.ensureRange(healthRollingRange("2026-12-31"));
    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 1));
    expect(healthDateStatus(store.getSnapshot().cache!, "2027-01-01", Date.now())).toBe("never-requested");
    await store.ensureRange(healthRollingRange("2027-01-01"));
    expect(metricsInCacheRange(store.getSnapshot().cache, { start: "2027-01-01", end: "2027-01-01" })).toEqual([{ date: "2027-01-01", steps: 20 }]);
    expect(store.getSnapshot().cache?.entries.has("2026-12-31")).toBe(true);
  });
  it("pending same-session reads settle while inactive and rapid re-entry joins them", async () => {
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const work = store.ensureRange(range); await Promise.resolve();
    store.setActive(false); store.setActive(true);
    expect(store.ensureRange(range)).toBe(work);
    store.setActive(false); pending.resolve([{ date: "2026-10-02", steps: 20 }]); await work;
    store.setActive(true); await store.ensureRange(range);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().cache?.entries.size).toBe(1);
  });
  it.each(["logout", "UID replacement", "same-UID new epoch"])("synchronous %s invalidation rejects late publication and all further requests", async () => {
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const work = store.ensureRange(range); await Promise.resolve(); current = false;
    const oldSnapshot = store.getSnapshot();
    pending.resolve([{ date: "2026-10-02", steps: 999 }]); await work;
    expect(store.getSnapshot()).toBe(oldSnapshot);
    await store.ensureRange(range, true); expect(loader).toHaveBeenCalledTimes(1);
    store.retire(); expect(store.getSnapshot().cache).toBeNull();
  });
  it.each(["resolve", "reject"])("retired Strict Mode work cannot %s into the replacement generation or remove its request", async outcome => {
    const old = deferred(); const fresh = deferred();
    loader.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldWork = store.ensureRange(range); await Promise.resolve();
    store.retire(); store.activate(true);
    const newWork = store.ensureRange(range); await Promise.resolve();
    if (outcome === "resolve") old.resolve([{ date: "2026-10-02", steps: 999 }]);
    else old.reject(new Error("retired failure"));
    await oldWork;
    expect(store.getSnapshot().pendingRanges).toEqual([range]);
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().cache?.coveredRanges).toEqual([]);
    fresh.resolve([{ date: "2026-10-02", steps: 20 }]); await newWork;
    expect(store.getSnapshot().pendingRanges).toEqual([]);
    expect(store.getSnapshot().cache?.entries.get("2026-10-02")?.metrics.steps).toBe(20);
  });
  it("a day change during a pending read cannot fabricate future coverage", async () => {
    vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 59));
    const pending = deferred(); loader.mockReturnValueOnce(pending.promise);
    const work = store.ensureRange(healthRollingRange("2026-10-05")); await Promise.resolve();
    vi.setSystemTime(new Date(2026, 9, 6, 0, 0, 1)); pending.resolve([]); await work;
    expect(healthDateStatus(store.getSnapshot().cache!, "2026-10-06", Date.now())).toBe("never-requested");
    await store.ensureRange(healthRollingRange("2026-10-06"));
    expect(loader.mock.calls.at(-1)?.slice(1)).toEqual(["2026-10-06", "2026-10-06"]);
  });
  it("arbitrary historic/future requests cannot expand bounded residency", async () => {
    await store.ensureRange({ start: "2000-01-01", end: "9999-12-31" });
    expect(loader).toHaveBeenCalledWith("A", "2026-01-01", "2026-10-05");
    expect(store.getSnapshot().cache?.coverage.size).toBe(278);
    loader.mockClear(); await store.ensureRange({ start: "2000-01-01", end: "2000-12-31" });
    expect(loader).not.toHaveBeenCalled();
  });
});
