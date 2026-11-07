import { describe, expect, it, vi } from "vitest";
import type { HrSample } from "@/types/hybridPerformance";
import type { StreamCandidate } from "@/utils/performance/hrStreamSelection";
import { HrStreamEvidenceStore, PHYSIOLOGY_LIMITS, Vo2EvidenceStore, type StreamFetcher } from "../physiologyEvidenceStores";

const L = PHYSIOLOGY_LIMITS;
const entries = [{ date: "2026-11-01", value: 47 }];
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const current = () => true;

describe("VO₂ evidence store", () => {
  it("shares one in-flight read between concurrent callers and serves repeat visits from memory", async () => {
    const d = deferred<{ entries: typeof entries; docsRead: number }>(), fetcher = vi.fn(() => d.promise);
    const store = new Vo2EvidenceStore(fetcher, () => 1000);
    const a = store.load("u1", 1, current), b = store.load("u1", 1, current);
    d.resolve({ entries, docsRead: 42 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ra).toEqual(rb); expect(ra).toMatchObject({ state: "loaded", docsRead: 42 });
    await store.load("u1", 1, current); await store.load("u1", 1, current);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(store.reads).toBe(42);
  });
  it("reads again only after the freshness window", async () => {
    let t = 0; const fetcher = vi.fn(async () => ({ entries, docsRead: 10 }));
    const store = new Vo2EvidenceStore(fetcher, () => t);
    await store.load("u1", 1, current); t = L.vo2TtlMs - 1; await store.load("u1", 1, current); expect(fetcher).toHaveBeenCalledTimes(1);
    t = L.vo2TtlMs + 1; await store.load("u1", 1, current); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("is isolated per user and per sign-in: another account never sees the first account's readings", async () => {
    const fetcher = vi.fn(async (uid: string) => ({ entries: [{ date: "2026-11-01", value: uid === "u1" ? 47 : 52 }], docsRead: 1 }));
    const store = new Vo2EvidenceStore(fetcher, () => 0);
    const a = await store.load("u1", 1, current), b = await store.load("u2", 1, current), c = await store.load("u2", 2, current);
    expect(a).toMatchObject({ entries: [{ value: 47 }] }); expect(b).toMatchObject({ entries: [{ value: 52 }] });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(c).toMatchObject({ state: "loaded" });
    expect(store.reads).toBe(1);                                              // counters reset with the session
  });
  it("discards a result that settles after the session changed (never delivered, never cached for the new owner)", async () => {
    const d = deferred<{ entries: typeof entries; docsRead: number }>();
    const fetcher = vi.fn((uid: string) => uid === "u1" ? d.promise : Promise.resolve({ entries: [{ date: "2026-11-02", value: 50 }], docsRead: 1 }));
    const store = new Vo2EvidenceStore(fetcher, () => 0);
    let live = true;
    const first = store.load("u1", 1, () => live);
    live = false;
    const second = await store.load("u2", 1, current);
    d.resolve({ entries, docsRead: 99 });
    expect(await first).toBeNull(); expect(second).toMatchObject({ entries: [{ value: 50 }] });
    expect(await store.load("u2", 1, current)).toMatchObject({ entries: [{ value: 50 }] });
  });
  it("reports a failure as failed (never a substitute value) and backs off briefly; a permission error is never retried", async () => {
    let t = 0;
    const net = vi.fn(async () => { throw new Error("offline"); });
    const s1 = new Vo2EvidenceStore(net, () => t);
    expect(await s1.load("u1", 1, current)).toMatchObject({ state: "failed", failure: { kind: "network" } });
    t = L.failureCooldownMs - 1; await s1.load("u1", 1, current); expect(net).toHaveBeenCalledTimes(1);
    t = L.failureCooldownMs + 1; await s1.load("u1", 1, current); expect(net).toHaveBeenCalledTimes(2);
    const perm = vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); });
    const s2 = new Vo2EvidenceStore(perm, () => t);
    expect(await s2.load("u1", 1, current)).toMatchObject({ failure: { kind: "permission" } });
    t += 10 * 60 * 60_000; await s2.load("u1", 1, current); expect(perm).toHaveBeenCalledTimes(1);
  });
  it("the read window is bounded (70 days) and never the unbounded history", () => { expect(L.vo2WindowDays).toBeLessThanOrEqual(90); expect(L.vo2WindowDays).toBeGreaterThanOrEqual(56); });
});

const samples = (avg = 150, seconds = 1800): HrSample[] => Array.from({ length: seconds }, (_, t) => ({ t, bpm: Math.round(t < 240 ? 100 + (avg - 100) * t / 240 : avg + ((t * 7919) % 5) - 2) }));
const cand = (n: number): StreamCandidate[] => Array.from({ length: n }, (_, i) => ({ workoutId: `w${i}`, date: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, durationSeconds: 1800, cacheKey: `w${i}:1:0:1800` }));
const ok = (chunks = 5) => vi.fn<StreamFetcher>(async () => ({ samples: samples(), chunks }));

describe("HR-stream evidence store", () => {
  it("summarizes streams (summaries only) and passes the per-stream chunk bound to every read", async () => {
    const fetcher = ok(), store = new HrStreamEvidenceStore(fetcher);
    const r = (await store.hydrate("u1", 1, current, cand(3)))!;
    expect(Object.keys(r.summaries)).toEqual(["w0", "w1", "w2"]); expect(r.summaries.w0.quality).not.toBe("unusable"); expect(r.summaries.w0.trimmedAvgHr!).toBeGreaterThan(r.summaries.w0.rawAvgHr!);
    for (const call of fetcher.mock.calls) expect(call[2]).toBe(L.maxChunksPerRun);
    expect(r).toMatchObject({ requested: 3, fetched: 3, fromCache: 0, failed: 0, chunkReads: 15, state: "loaded" });
    expect(JSON.stringify(r)).not.toMatch(/"samples":\[\{/);                                  // no raw per-sample data is retained or reported
  });
  it("never requests more than the per-request run cap, even when handed more candidates", async () => {
    const fetcher = ok(), store = new HrStreamEvidenceStore(fetcher);
    const r = (await store.hydrate("u1", 1, current, cand(40)))!;
    expect(fetcher).toHaveBeenCalledTimes(L.maxRuns); expect(r.requested).toBe(L.maxRuns);
  });
  it("limits parallelism", async () => {
    let active = 0, peak = 0;
    const fetcher = vi.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { samples: samples(), chunks: 2 }; });
    await new HrStreamEvidenceStore(fetcher).hydrate("u1", 1, current, cand(12));
    expect(peak).toBeLessThanOrEqual(L.concurrency); expect(peak).toBeGreaterThan(1);
  });
  it("deduplicates concurrent hydrations and repeated page visits (no second read for the same unchanged workout)", async () => {
    const fetcher = ok(), store = new HrStreamEvidenceStore(fetcher);
    const [a, b] = await Promise.all([store.hydrate("u1", 1, current, cand(4)), store.hydrate("u1", 1, current, cand(4))]);
    expect(fetcher).toHaveBeenCalledTimes(4); expect(Object.keys(a!.summaries)).toEqual(Object.keys(b!.summaries));
    const again = (await store.hydrate("u1", 1, current, cand(4)))!;
    expect(fetcher).toHaveBeenCalledTimes(4); expect(again.fromCache).toBe(4); expect(again.chunkReads).toBe(0);
  });
  it("re-hydrates a workout whose record changed (cache keyed by the workout's own change fingerprint)", async () => {
    const fetcher = ok(), store = new HrStreamEvidenceStore(fetcher);
    await store.hydrate("u1", 1, current, cand(1));
    await store.hydrate("u1", 1, current, [{ ...cand(1)[0], cacheKey: "w0:2:0:1800" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("is isolated per user and sign-in, and drops results that settle after the session changed", async () => {
    const fetcher = ok(), store = new HrStreamEvidenceStore(fetcher);
    await store.hydrate("u1", 1, current, cand(2)); expect(store.totalChunkReads).toBe(10);
    await store.hydrate("u2", 1, current, cand(2));                                   // another account: nothing is served from u1's cache
    expect(fetcher).toHaveBeenCalledTimes(4); expect(store.totalChunkReads).toBe(10);
    let live = true;
    const slow = vi.fn(async () => { await new Promise(r => setTimeout(r, 5)); live = false; return { samples: samples(), chunks: 1 }; });
    expect(await new HrStreamEvidenceStore(slow).hydrate("u1", 1, () => live, cand(1))).toBeNull();
  });
  it("discards a stream that reached the chunk bound: a prefix would bias the trimmed mean", async () => {
    const r = (await new HrStreamEvidenceStore(ok(L.maxChunksPerRun)).hydrate("u1", 1, current, cand(1)))!;
    expect(r.summaries.w0.quality).toBe("unusable"); expect(r.summaries.w0.flags).toContain("stream_truncated_by_read_bound"); expect(r.summaries.w0.trimmedAvgHr).toBeNull();
  });
  it("stops reading once the per-session chunk budget is spent and says so", async () => {
    const fetcher = ok(L.maxChunksPerRun - 1), store = new HrStreamEvidenceStore(fetcher);
    let skipped = 0, fetched = 0;
    for (let i = 0; i < 4; i++) { const r = (await store.hydrate("u1", 1, current, cand(16).map(c => ({ ...c, cacheKey: `${c.cacheKey}-${i}` }))))!; skipped += r.skippedBudget; fetched += r.fetched; }
    expect(store.totalChunkReads).toBeLessThanOrEqual(L.maxTotalChunkReads + L.concurrency * L.maxChunksPerRun);
    expect(skipped).toBeGreaterThan(0); expect(fetched).toBeLessThan(64);
  });
  it("reports failures, never a plausible substitute; all-failed is a failed state; a permission failure is not retried", async () => {
    const some = vi.fn(async (_u: string, id: string) => { if (id === "w1") throw new Error("offline"); return { samples: samples(), chunks: 2 }; });
    const r = (await new HrStreamEvidenceStore(some).hydrate("u1", 1, current, cand(3)))!;
    expect(r.failed).toBe(1); expect(r.summaries.w1).toBeUndefined(); expect(r.state).toBe("loaded");
    const perm = vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); });
    let t = 0; const store = new HrStreamEvidenceStore(perm, () => t);
    expect((await store.hydrate("u1", 1, current, cand(2)))!.state).toBe("failed");
    t = 10 * 60 * 60_000; await store.hydrate("u1", 1, current, cand(2)); expect(perm).toHaveBeenCalledTimes(2);   // not retried
  });
  it("a transient network failure is retried only after the cooldown", async () => {
    let t = 0; const net = vi.fn(async () => { throw new Error("offline"); });
    const store = new HrStreamEvidenceStore(net, () => t);
    await store.hydrate("u1", 1, current, cand(1)); await store.hydrate("u1", 1, current, cand(1)); expect(net).toHaveBeenCalledTimes(1);
    t = L.failureCooldownMs + 1; await store.hydrate("u1", 1, current, cand(1)); expect(net).toHaveBeenCalledTimes(2);
  });
  it("nothing is read when there is nothing to hydrate", async () => {
    const fetcher = ok();
    const r = (await new HrStreamEvidenceStore(fetcher).hydrate("u1", 1, current, []))!;
    expect(fetcher).not.toHaveBeenCalled(); expect(r.state).toBe("loaded"); expect(r.requested).toBe(0);
  });
  it("documents the hard bounds", () => { expect(L).toMatchObject({ maxRuns: 16, maxChunksPerRun: 40, maxTotalChunkReads: 400, concurrency: 3 }); });
});
