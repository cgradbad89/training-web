import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCurrentLocalYear } from "@/hooks/useCurrentLocalYear";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: number[] = [];

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  function Probe() {
    const y = useCurrentLocalYear();
    seen.push(y);
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });
}
const last = () => seen[seen.length - 1];

beforeEach(() => {
  seen = [];
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe("useCurrentLocalYear", () => {
  it("starts at the current local year", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30));
    mount();
    expect(last()).toBe(2026);
  });

  it("flips 2026 → 2027 when the clock crosses local midnight", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30));
    mount();
    expect(last()).toBe(2026);
    act(() => {
      vi.advanceTimersByTime(31 * 60 * 1000);
    });
    expect(last()).toBe(2027);
  });

  it("re-arms after midnight (stays correct on a later day)", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
    mount();
    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });
    expect(last()).toBe(2027);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(last()).toBe(2027);
  });

  it("flips when visibilitychange fires after the clock was advanced (timers throttled)", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30));
    mount();
    expect(last()).toBe(2026);
    vi.setSystemTime(new Date(2027, 0, 1, 8, 0)); // clock moved without timers firing
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(last()).toBe(2027);
  });

  it("flips on window focus", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30));
    mount();
    vi.setSystemTime(new Date(2027, 0, 1, 8, 0));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(last()).toBe(2027);
  });

  it("removes listeners and timers on unmount", () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 30));
    mount();
    act(() => root.unmount());
    const before = seen.length;
    vi.setSystemTime(new Date(2027, 0, 1, 8, 0));
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(seen.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    // re-mount root so afterEach unmount is a no-op
    root = createRoot(container);
  });
});

import { useRollingSelectedYear } from "@/hooks/useCurrentLocalYear";

describe("useRollingSelectedYear", () => {
  let api: { selected: number; set: (y: number) => void; current: number };

  function mountRolling(initial: number) {
    container = document.createElement("div");
    document.body.appendChild(container);
    function Probe({ current }: { current: number }) {
      const [selected, set] = useRollingSelectedYear(current);
      api = { selected, set, current };
      return null;
    }
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Probe, { current: initial }));
    });
    return (current: number) =>
      act(() => root.render(React.createElement(Probe, { current })));
  }

  it("defaults to the current year", () => {
    mountRolling(2026);
    expect(api.selected).toBe(2026);
  });
  it("advances to the new year when the selection sat on the old current year", () => {
    const rerender = mountRolling(2026);
    rerender(2027);
    expect(api.selected).toBe(2027);
  });
  it("leaves a user-chosen earlier year alone when the current year rolls", () => {
    const rerender = mountRolling(2026);
    act(() => api.set(2025));
    rerender(2027);
    expect(api.selected).toBe(2025);
  });
  it("keeps a manual selection of the old current year → does not matter after it already advanced", () => {
    const rerender = mountRolling(2026);
    rerender(2027);
    act(() => api.set(2026));
    rerender(2027);
    expect(api.selected).toBe(2026);
  });
});
