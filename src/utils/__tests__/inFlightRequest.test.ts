import { describe, expect, it, vi } from "vitest";
import { trackInFlightRequest } from "@/utils/inFlightRequest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("trackInFlightRequest", () => {
  it("stores and returns the original promise until it resolves", async () => {
    const pending = deferred<void>();
    const ref: { current: Promise<void> | null } = { current: null };

    const tracked = trackInFlightRequest(ref, pending.promise);

    expect(tracked).toBe(pending.promise);
    expect(ref.current).toBe(pending.promise);

    pending.resolve();
    await tracked;
    await Promise.resolve();

    expect(ref.current).toBeNull();
  });

  it("clears a rejected request without creating an unhandled rejection", async () => {
    const pending = deferred<void>();
    const ref: { current: Promise<void> | null } = { current: null };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const tracked = trackInFlightRequest(ref, pending.promise);
    pending.reject(new Error("request failed"));

    await expect(tracked).rejects.toThrow("request failed");
    await Promise.resolve();

    expect(ref.current).toBeNull();
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("does not clear a newer request when an older one settles", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const ref: { current: Promise<void> | null } = { current: null };

    trackInFlightRequest(ref, first.promise);
    trackInFlightRequest(ref, second.promise);

    first.resolve();
    await first.promise;
    await Promise.resolve();

    expect(ref.current).toBe(second.promise);

    second.resolve();
    await second.promise;
    await Promise.resolve();
    expect(ref.current).toBeNull();
  });
});
