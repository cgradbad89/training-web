import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EfficiencyTrendSection } from "../EfficiencyTrendSection";
import type { EfficiencyWorkout } from "@/utils/efficiencyScore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REST = 65;
const MAX = 175;

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

let idCounter = 0;
function makeWorkout(over: Partial<EfficiencyWorkout> & { distanceMiles: number; secPerMile: number }): EfficiencyWorkout {
  const { distanceMiles, secPerMile, ...rest } = over;
  return {
    workoutId: `w${idCounter++}`,
    distanceMiles,
    durationSeconds: distanceMiles * secPerMile,
    startDate: daysAgo(1),
    avgPaceSecPerMile: secPerMile,
    avgHeartRate: 150,
    cadenceSPM: null,
    ...rest,
  };
}

// A dense daily series (days 1..28) so that runs with >= 5 prior runs score,
// spanning well over 3 distinct weeks with data. (Date-anchored baselines mean a
// run needs enough earlier runs to be scored, so a sparse 1-per-week set would
// never leave the building state.)
function populatedRuns(distanceMiles = 6): EfficiencyWorkout[] {
  return Array.from({ length: 28 }, (_, i) =>
    makeWorkout({ distanceMiles, secPerMile: 540, startDate: daysAgo(i + 1) })
  );
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

describe("EfficiencyTrendSection", () => {
  it("renders the empty state when fewer than 3 weeks have scored runs", () => {
    act(() => {
      root.render(<EfficiencyTrendSection workouts={[]} restingHr={REST} maxHr={MAX} />);
    });
    expect(container.textContent).toContain(
      "Not enough scored runs yet to show a trend."
    );
    expect(container.textContent).not.toContain("Short · <5 mi");
  });

  it("renders all three distance-bucket cards in the populated state", () => {
    act(() => {
      root.render(
        <EfficiencyTrendSection workouts={populatedRuns(6)} restingHr={REST} maxHr={MAX} />
      );
    });
    expect(container.textContent).not.toContain("Not enough scored runs yet");
    expect(container.textContent).toContain("Short · <5 mi");
    expect(container.textContent).toContain("Mid · 5–9 mi");
    expect(container.textContent).toContain("Long · 10+ mi");
  });

  it("shows '—' (not NaN%) for a bucket with zero scored runs", () => {
    // All runs are 6 mi (mid bucket) → short & long buckets have zero runs.
    act(() => {
      root.render(
        <EfficiencyTrendSection workouts={populatedRuns(6)} restingHr={REST} maxHr={MAX} />
      );
    });
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("NaN");
  });
});
