import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPerformanceSessionStore } from "../performanceSessionStore";
import { ASSESSMENT_NOW, savedPerformanceFixture } from "./fixtures/savedPerformanceFixture";
import type { SavedPerformanceCurrent } from "@/types/performancePersistence";

let saved: SavedPerformanceCurrent;
let valid: boolean;
let now: string;
let load: ReturnType<typeof vi.fn<() => Promise<SavedPerformanceCurrent | null>>>;
let store: ReturnType<typeof createPerformanceSessionStore>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  saved = await savedPerformanceFixture(); valid = true; now = ASSESSMENT_NOW;
  load = vi.fn<() => Promise<SavedPerformanceCurrent | null>>().mockResolvedValue(saved);
  store = createPerformanceSessionStore({ load, isCurrent: () => valid, now: () => now });
});

describe("authenticated resident performance store", () => {
  it.each(["Plan first", "Personal first"])("%s makes one cold call and zero warm calls", async () => {
    expect(store.getSnapshot().status).toBe("not_loaded");
    await store.ensureLoaded();
    await store.ensureLoaded(); await store.ensureLoaded();
    expect(load).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ status: "available", current: saved, origin: "server", retrievedAt: ASSESSMENT_NOW });
  });
  it("deduplicates concurrent page consumers, including a pending request", async () => {
    const pending = deferred<SavedPerformanceCurrent>(); load.mockReturnValue(pending.promise);
    const first = store.ensureLoaded(), second = store.ensureLoaded();
    expect(first).toBe(second); expect(store.getSnapshot().status).toBe("loading");
    pending.resolve(saved); await Promise.all([first, second]); expect(load).toHaveBeenCalledOnce();
  });
  it("caches successful absence for the session", async () => {
    load.mockResolvedValue(null); await store.ensureLoaded(); await store.ensureLoaded();
    expect(store.getSnapshot()).toMatchObject({ status: "absent", current: null }); expect(load).toHaveBeenCalledOnce();
  });
  it("retains a failed cold read, with retry only by explicit action", async () => {
    load.mockRejectedValueOnce(new Error("Permission denied"));
    await store.ensureLoaded(); await store.ensureLoaded();
    expect(store.getSnapshot()).toMatchObject({ status: "error", error: "Permission denied" }); expect(load).toHaveBeenCalledOnce();
    await store.retry(); expect(load).toHaveBeenCalledTimes(2); expect(store.getSnapshot().current).toBe(saved);
  });
  it("rejects an old epoch's in-flight result and subsequent publication", async () => {
    const pending = deferred<SavedPerformanceCurrent>(); load.mockReturnValue(pending.promise);
    const task = store.ensureLoaded(); await Promise.resolve(); valid = false;
    pending.resolve(saved); await task; store.receivePublication(saved, true);
    expect(store.getSnapshot().current).toBeNull();
    expect(store.getSnapshot().publication).toBe("idle");
  });
  it("rejects settled results after provider disposal", async () => {
    const pending = deferred<SavedPerformanceCurrent>(); load.mockReturnValue(pending.promise);
    const task = store.ensureLoaded(); await Promise.resolve(); store.deactivate();
    pending.resolve(saved); await task; expect(store.getSnapshot().current).toBeNull();
  });
  it("reuses a request across synchronous Strict Mode effect replay for the same owner", async () => {
    const pending = deferred<SavedPerformanceCurrent>(); load.mockReturnValue(pending.promise);
    const task = store.ensureLoaded(); store.deactivate(); store.activate();
    expect(store.ensureLoaded()).toBe(task); pending.resolve(saved); await task;
    expect(load).toHaveBeenCalledOnce(); expect(store.getSnapshot().current).toBe(saved);
  });
  it("publishes directly and notifies both consumers without reloading", async () => {
    await store.ensureLoaded(); const first = vi.fn(), second = vi.fn();
    const unsub = store.subscribe(first); store.subscribe(second);
    const next = { ...saved, revision: 2, snapshotId: "d".repeat(64) };
    now = "2026-11-04T14:05:00.000Z";
    store.beginPublication(); store.receivePublication(next, true); await store.ensureLoaded();
    expect(store.getSnapshot()).toMatchObject({ current: next, publication: "published", origin: "session", retrievedAt: now });
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledOnce();
    unsub(); store.beginPublication(); expect(first).toHaveBeenCalledTimes(2);
  });
  it("retains the exact resident snapshot and calculation clock on unchanged publication", async () => {
    await store.ensureLoaded(); store.receivePublication(structuredClone(saved), false);
    expect(store.getSnapshot().current).toBe(saved);
    expect(store.getSnapshot().current?.payload.calculationCompletedAt).toBe(saved.payload.calculationCompletedAt);
    expect(store.getSnapshot().publication).toBe("unchanged");
  });
  it("retains prior valid evidence and exposes failed publication", async () => {
    await store.ensureLoaded(); store.beginPublication(); store.failPublication("Conflict");
    expect(store.getSnapshot()).toMatchObject({ current: saved, status: "available", publication: "failed", publicationError: "Conflict" });
  });
  it("does not let an earlier cold read overwrite a successful publication", async () => {
    const pending = deferred<SavedPerformanceCurrent>(); load.mockReturnValue(pending.promise);
    const task = store.ensureLoaded(); await Promise.resolve();
    const next = { ...saved, revision: 2, snapshotId: "d".repeat(64) }; store.receivePublication(next, true);
    pending.resolve(saved); await task; expect(store.getSnapshot().current).toBe(next);
  });
  it("separate session instances cannot share cached owner evidence", async () => {
    await store.ensureLoaded();
    const replacement = createPerformanceSessionStore({ load, isCurrent: () => true, now: () => ASSESSMENT_NOW });
    expect(replacement.getSnapshot()).toMatchObject({ status: "not_loaded", current: null });
    await replacement.ensureLoaded(); expect(load).toHaveBeenCalledTimes(2);
  });
});
