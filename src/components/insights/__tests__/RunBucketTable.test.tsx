import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunBucketTable } from "../RunBucketTable";
import type { RunAnalysisWorkout } from "@/lib/runAnalysisTrend";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => push(...args) }),
}));

const REST = 55;
const MAX = 190;

function w(
  id: string,
  date: string,
  over: Partial<RunAnalysisWorkout> = {}
): RunAnalysisWorkout {
  return {
    workoutId: id,
    date,
    distanceMiles: 4,
    durationSeconds: 2160,
    avgPaceSecPerMile: 540,
    avgHeartRate: 150,
    cadenceSPM: 170,
    activityType: "running",
    ...over,
  };
}

/** Enough neighbours (>= MIN_BASELINE_RUNS) for a real efficiency baseline. */
function baselinePopulation(): RunAnalysisWorkout[] {
  return Array.from({ length: 10 }, (_, i) =>
    w(`base${i}`, `2026-05-${String(i + 1).padStart(2, "0")}T12:00:00`, {
      avgHeartRate: 145 + (i % 5),
      avgPaceSecPerMile: 530 + (i % 4) * 6,
    })
  );
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

function render(runs: RunAnalysisWorkout[], allWorkouts = runs) {
  act(() => {
    root.render(
      <RunBucketTable
        runs={runs}
        allWorkouts={allWorkouts}
        bucketLabel="May 11"
        runCount={runs.length}
        restingHr={REST}
        maxHr={MAX}
      />
    );
  });
}

/** The rendered data rows (the header row has no click handler / cursor class). */
function rows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("div.cursor-pointer")
  );
}

describe("RunBucketTable", () => {
  it("renders the caption with the bucket label and run count", () => {
    render([w("a", "2026-05-11T12:00:00"), w("b", "2026-05-13T12:00:00")]);
    expect(container.textContent).toContain("May 11 · 2 runs");
  });

  it("singularizes the caption for a one-run bucket", () => {
    render([w("a", "2026-05-11T12:00:00")]);
    expect(container.textContent).toContain("May 11 · 1 run");
  });

  it("renders all 7 column headers in order", () => {
    render([w("a", "2026-05-11T12:00:00")]);
    const headers = ["Date", "Distance", "Pace", "HR", "Cadence", "Efficiency", "Load"];
    const text = container.textContent ?? "";
    let cursor = -1;
    for (const h of headers) {
      const at = text.indexOf(h, cursor + 1);
      expect(at, `header ${h} in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("renders correct values for a fully-populated run", () => {
    const pop = baselinePopulation();
    const run = w("target", "2026-05-20T12:00:00");
    render([run], [...pop, run]);
    const text = rows()[0].textContent ?? "";
    expect(text).toContain("May 20");
    expect(text).toContain("4.00 mi");
    expect(text).toContain("9:00/mi"); // 540 s/mi
    expect(text).toContain("150 bpm");
    expect(text).toContain("170 spm");
  });

  it("renders a computed load for a run with HR and duration", () => {
    render([w("a", "2026-05-11T12:00:00")]);
    // computeTrainingLoadV2(2160s, 150bpm, 190, 55) is a positive integer.
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    const load = cells[cells.length - 1];
    expect(load).toMatch(/^\d+$/);
    expect(Number(load)).toBeGreaterThan(0);
  });

  it("renders — for a missing pace, without affecting other columns", () => {
    render([w("a", "2026-05-11T12:00:00", { avgPaceSecPerMile: null })]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[2]).toBe("—"); // pace
    expect(cells[3]).toBe("150 bpm"); // HR unaffected
    expect(cells[4]).toBe("170 spm"); // cadence unaffected
  });

  it("renders — for a missing cadence", () => {
    render([w("a", "2026-05-11T12:00:00", { cadenceSPM: null })]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[4]).toBe("—");
  });

  it("renders — for missing HR, and — (not 0) for the load that depends on it", () => {
    render([w("a", "2026-05-11T12:00:00", { avgHeartRate: null })]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[3]).toBe("—"); // HR
    expect(cells[6]).toBe("—"); // load is null without HR — never 0
  });

  it("renders — for efficiency when the baseline is still building", () => {
    // A lone run has no neighbours, so status is 'building_baseline'.
    render([w("solo", "2026-05-11T12:00:00")]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[5]).toBe("—");
  });

  it("renders a numeric efficiency score once the baseline is established", () => {
    const pop = baselinePopulation();
    const run = w("target", "2026-05-20T12:00:00");
    render([run], [...pop, run]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[5]).toMatch(/^\d+$/);
  });

  it("never renders NaN or null in any cell", () => {
    render([
      w("bare", "2026-05-11T12:00:00", {
        avgPaceSecPerMile: null,
        avgHeartRate: null,
        cadenceSPM: null,
      }),
    ]);
    const text = container.textContent ?? "";
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
  });

  it("shows the RAW pace of an out-of-[MIN,MAX]_VALID_PACE run, not —", () => {
    // 100 s/mi is far below MIN_VALID_PACE (180) — excluded from the chart's
    // average, but the table shows the run's actual number.
    render([w("glitch", "2026-05-11T12:00:00", { avgPaceSecPerMile: 100 })]);
    const cells = Array.from(rows()[0].children).map((c) => c.textContent ?? "");
    expect(cells[2]).toBe("1:40/mi");
  });

  it("pushes /runs/{workoutId} when a row is clicked", () => {
    render([w("abc123", "2026-05-11T12:00:00"), w("def456", "2026-05-13T12:00:00")]);
    act(() => {
      rows()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/runs/def456");
  });

  it("renders one clickable row per run", () => {
    render([
      w("a", "2026-05-11T12:00:00"),
      w("b", "2026-05-13T12:00:00"),
      w("c", "2026-05-16T12:00:00"),
    ]);
    expect(rows()).toHaveLength(3);
  });
});
