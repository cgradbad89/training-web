import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunAnalysisWorkout } from "@/lib/runAnalysisTrend";

// Recharts' ResponsiveContainer measures its parent, and happy-dom reports 0×0 —
// so the chart (and therefore every clickable dot) renders nothing at all. Give
// the inner LineChart explicit dimensions so the dots exist to be clicked. Kept in
// THIS file only, so the sibling RunAnalysisSection.test.tsx keeps exercising the
// real ResponsiveContainer.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 600, height: 220 }),
  };
});

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => push(...args) }),
}));

import { RunAnalysisSection } from "../RunAnalysisSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REST = 55;
const MAX = 190;

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);

/** One run per week going back `count` weeks, each a distinct in-range distance
 *  so the rendered table content identifies WHICH bucket is open. */
function weeklyRuns(count = 12, over: Partial<RunAnalysisWorkout> = {}): RunAnalysisWorkout[] {
  return Array.from({ length: count }, (_, i) => {
    const miles = 3 + (i % 5) * 0.25; // 3.00 … 4.00, all inside [3,5]
    return {
      workoutId: `w${i}`,
      date: daysAgo(i * 7 + 1).toISOString(),
      distanceMiles: miles,
      durationSeconds: Math.round(miles * 540),
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: 170,
      activityType: "running",
      ...over,
    };
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  push.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(workouts: RunAnalysisWorkout[]) {
  act(() => {
    root.render(
      <RunAnalysisSection workouts={workouts} restingHr={REST} maxHr={MAX} />
    );
  });
}

function dots(): SVGCircleElement[] {
  return Array.from(container.querySelectorAll("circle"));
}

function clickDot(i: number) {
  const d = dots()[i];
  if (!d) throw new Error(`dot ${i} not found (have ${dots().length})`);
  act(() => {
    d.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function findButton(prefix: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  ) as HTMLButtonElement | undefined;
}

function clickButton(prefix: string) {
  const btn = findButton(prefix);
  if (!btn) throw new Error(`button starting with "${prefix}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Rows inside the drill-down table. */
function tableRows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("div.cursor-pointer")
  );
}

describe("RunAnalysisSection — click-to-expand runs table", () => {
  it("renders exactly one dot per non-null point (no double-invocation)", () => {
    render(weeklyRuns(12));
    // 12 weekly buckets, all with a computable pace → 12 dots, not 24.
    expect(dots()).toHaveLength(12);
  });

  it("renders no dot for a null-valued bucket, so gaps are not clickable", () => {
    const runs = weeklyRuns(12);
    runs[3].durationSeconds = 0; // no computable pace → that bucket's value is null
    render(runs);
    expect(dots()).toHaveLength(11);
  });

  it("shows no 'Show runs' button until a dot is clicked", () => {
    render(weeklyRuns(12));
    expect(findButton("Show runs")).toBeUndefined();
    clickDot(0);
    expect(findButton("Show runs")).toBeDefined();
  });

  it("clicking the button reveals the table for the selected bucket", () => {
    render(weeklyRuns(12));
    clickDot(0);
    expect(tableRows()).toHaveLength(0);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);
    expect(findButton("Hide runs")).toBeDefined();
  });

  it("enlarges the selected dot and leaves the others small", () => {
    render(weeklyRuns(12));
    clickDot(2);
    const radii = dots().map((d) => d.getAttribute("r"));
    expect(radii[2]).toBe("7");
    expect(radii.filter((r) => r === "7")).toHaveLength(1);
    expect(radii[0]).toBe("3");
  });

  it("clicking a DIFFERENT dot while open swaps the rows with no extra click", () => {
    render(weeklyRuns(12));
    clickDot(0);
    clickButton("Show runs");
    const first = tableRows()[0].textContent ?? "";

    clickDot(1); // no second "Show runs" click
    expect(findButton("Hide runs")).toBeDefined(); // table stayed open
    const second = tableRows()[0].textContent ?? "";
    expect(second).not.toBe(first);
    expect(tableRows()).toHaveLength(1);
  });

  it("'Hide runs' closes the table but KEEPS the dot selected", () => {
    render(weeklyRuns(12));
    clickDot(2);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);

    clickButton("Hide runs");
    expect(tableRows()).toHaveLength(0);
    // Selection survives: the toggle is still offered, and the dot stays ringed.
    expect(findButton("Show runs")).toBeDefined();
    expect(dots().map((d) => d.getAttribute("r"))[2]).toBe("7");
  });

  it("changing the METRIC clears the selection and hides the table", () => {
    render(weeklyRuns(12));
    clickDot(0);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);

    clickButton("Cadence");
    expect(tableRows()).toHaveLength(0);
    expect(findButton("Show runs")).toBeUndefined();
    expect(findButton("Hide runs")).toBeUndefined();
  });

  it("changing the WINDOW clears the selection and hides the table", () => {
    render(weeklyRuns(12));
    clickDot(0);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);

    clickButton("6 mo");
    expect(tableRows()).toHaveLength(0);
    expect(findButton("Show runs")).toBeUndefined();
  });

  it("changing the DISTANCE range clears the selection and hides the table", () => {
    render(weeklyRuns(12));
    clickDot(0);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);

    clickButton("Short"); // preset → [0,5]
    expect(tableRows()).toHaveLength(0);
    expect(findButton("Show runs")).toBeUndefined();
  });

  it("shows the tap hint while no bucket is selected", () => {
    render(weeklyRuns(12));
    expect(container.textContent).toContain("Tap a point to view those runs");
  });

  it("drops the hint once a dot is selected, replacing it with the toggle", () => {
    render(weeklyRuns(12));
    clickDot(0);
    expect(container.textContent).not.toContain("Tap a point to view those runs");
    expect(findButton("Show runs")).toBeDefined();
  });

  it("never renders the hint and the toggle at the same time", () => {
    render(weeklyRuns(12));
    const hintShown = () =>
      (container.textContent ?? "").includes("Tap a point to view those runs");
    const toggleShown = () =>
      findButton("Show runs") !== undefined || findButton("Hide runs") !== undefined;

    expect(hintShown()).toBe(true);
    expect(toggleShown()).toBe(false);

    clickDot(1);
    expect(hintShown()).toBe(false);
    expect(toggleShown()).toBe(true);

    clickButton("Show runs"); // table open — still no hint
    expect(hintShown()).toBe(false);
    expect(toggleShown()).toBe(true);
  });

  it("restores the hint when a filter change clears the selection", () => {
    render(weeklyRuns(12));
    clickDot(0);
    expect(container.textContent).not.toContain("Tap a point to view those runs");

    clickButton("Cadence"); // metric change resets the selection
    expect(container.textContent).toContain("Tap a point to view those runs");
    expect(findButton("Show runs")).toBeUndefined();
  });

  it("navigates to the run detail page when a table row is clicked", () => {
    render(weeklyRuns(12));
    clickDot(0); // oldest bucket → w11 (points are chronological ascending)
    clickButton("Show runs");
    act(() => {
      tableRows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatch(/^\/runs\/w\d+$/);
  });
});
