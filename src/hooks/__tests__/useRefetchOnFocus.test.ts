import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRefetchOnFocus } from "@/hooks/useRefetchOnFocus";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fireVisibilityChange(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

let container: HTMLDivElement;
let root: Root;

function mount(refetchFn: () => void, minIntervalMs?: number) {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Probe() {
    useRefetchOnFocus(refetchFn, minIntervalMs);
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });
}

function unmount() {
  act(() => {
    root?.unmount();
  });
  container?.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("useRefetchOnFocus", () => {
  it("fires refetchFn when the tab regains visibility after minIntervalMs has elapsed", () => {
    const refetchFn = vi.fn();
    mount(refetchFn, 30000);

    vi.advanceTimersByTime(30001);
    act(() => {
      fireVisibilityChange("visible");
    });

    expect(refetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not fire if the tab becomes hidden (not visible)", () => {
    const refetchFn = vi.fn();
    mount(refetchFn, 30000);

    vi.advanceTimersByTime(30001);
    act(() => {
      fireVisibilityChange("hidden");
    });

    expect(refetchFn).not.toHaveBeenCalled();
  });

  it("does not fire again within minIntervalMs of the last run", () => {
    const refetchFn = vi.fn();
    mount(refetchFn, 30000);

    vi.advanceTimersByTime(30001);
    act(() => {
      fireVisibilityChange("visible");
    });
    expect(refetchFn).toHaveBeenCalledTimes(1);

    // Immediately fire again — should be skipped, well within the interval.
    act(() => {
      fireVisibilityChange("visible");
    });
    expect(refetchFn).toHaveBeenCalledTimes(1);

    // Advance past the interval — should fire again.
    vi.advanceTimersByTime(30001);
    act(() => {
      fireVisibilityChange("visible");
    });
    expect(refetchFn).toHaveBeenCalledTimes(2);
  });

  it("cleans up its event listener on unmount", () => {
    const refetchFn = vi.fn();
    mount(refetchFn, 30000);
    vi.advanceTimersByTime(30001);

    unmount();

    act(() => {
      fireVisibilityChange("visible");
    });
    expect(refetchFn).not.toHaveBeenCalled();
  });
});
