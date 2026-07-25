import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunAnalysisSection } from "../RunAnalysisSection";
import type { RunAnalysisWorkout } from "@/lib/runAnalysisTrend";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REST = 55;
const MAX = 190;

// Recharts' ResponsiveContainer relies on ResizeObserver, which happy-dom does
// not implement — stub it (established repo pattern for chart smoke tests).
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);

// One 4-mile run per week going back `count` weeks (default range [3,5] keeps
// them all in-range). Pace 540 s/mi is inside the [180,1200] guard.
function weeklyRuns(count = 12, over: Partial<RunAnalysisWorkout> = {}): RunAnalysisWorkout[] {
  return Array.from({ length: count }, (_, i) => ({
    workoutId: `w${i}`,
    date: daysAgo(i * 7 + 1).toISOString(),
    distanceMiles: 4,
    durationSeconds: 2160, // 540 s/mi
    avgPaceSecPerMile: 540,
    avgHeartRate: 150,
    cadenceSPM: 170,
    activityType: "running",
    ...over,
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

/** Click the first <button> whose visible text starts with `prefix`. */
function clickButton(prefix: string) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  );
  if (!btn) throw new Error(`button starting with "${prefix}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The distance-preset button whose text starts with `label`. */
function presetButton(label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").startsWith(`${label} ·`)
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`preset button "${label}" not found`);
  return btn;
}

describe("RunAnalysisSection", () => {
  it("renders the empty state when fewer than 3 buckets have data, but keeps the controls", () => {
    render(weeklyRuns(1)); // one run → one non-null point → empty
    expect(container.textContent).toContain(
      "Not enough runs in this range yet to show a trend."
    );
    // Controls still render so the person can adjust filters.
    expect(container.textContent).toContain("Run Analysis");
    expect(container.textContent).toContain("Pace");
    expect(container.textContent).toContain("Distance range");
  });

  it("switching the metric pill changes the rendered headline", () => {
    render(weeklyRuns(12));
    // Default metric is pace.
    expect(container.textContent).toContain("Avg pace");
    expect(container.textContent).not.toContain("Avg cadence");

    clickButton("Cadence");
    expect(container.textContent).toContain("Avg cadence");
    expect(container.textContent).toContain("spm");
    expect(container.textContent).not.toContain("Avg pace");
  });

  it("marks a distance quick-filter active only on an exact range match", () => {
    render(weeklyRuns(12));
    // Default [3,5] matches no preset → none active.
    expect(presetButton("Short").getAttribute("aria-pressed")).toBe("false");
    expect(presetButton("Mid").getAttribute("aria-pressed")).toBe("false");
    expect(presetButton("Long").getAttribute("aria-pressed")).toBe("false");

    // Clicking Short sets the range to exactly [0,5] → Short active, others not.
    clickButton("Short");
    expect(presetButton("Short").getAttribute("aria-pressed")).toBe("true");
    expect(presetButton("Mid").getAttribute("aria-pressed")).toBe("false");
    expect(presetButton("Long").getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the pace-only 'lower = faster' caption, distinct from other metrics", () => {
    render(weeklyRuns(12));
    // Pace (reversed axis) → the pace-specific caption is present.
    expect(container.textContent).toContain("Lower on chart = faster");

    // Switching to a non-pace metric drops that caption (axis not reversed).
    clickButton("Heart rate");
    expect(container.textContent).toContain("Avg HR");
    expect(container.textContent).not.toContain("Lower on chart = faster");
  });
});
