import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunningPlanDetail } from "@/components/RunningPlanDetail";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/PlanCompletionSummary", () => ({
  PlanCompletionSummary: () => null,
}));

// Plan week 1 = Mon 2026-09-07 … Sun 2026-09-13.
const START = "2026-09-07";

function entry(weekday: number, overrides: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id: `e${weekday}`,
    weekIndex: 0,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles: 5,
    runType: "outdoor",
    workoutType: "easy",
    ...overrides,
  };
}

function planOf(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "p",
    name: "Plan",
    planType: "running",
    startDate: START,
    status: "draft",
    isActive: false,
    weeks: [{ weekNumber: 1, entries }],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** A run on plan weekday `weekday` (1=Mon) with the given distance/avg HR. */
function run(weekday: number, avgHeartRate: number | null, distanceMiles = 5): HealthWorkout {
  return {
    workoutId: `w${weekday}`,
    isRunLike: true,
    startDate: new Date(2026, 8, 6 + weekday, 12, 0, 0),
    distanceMiles,
    avgHeartRate,
    avgPaceSecPerMile: 600,
  } as unknown as HealthWorkout;
}

let container: HTMLDivElement;
let root: Root;

async function mount(plan: RunningPlan, activities: HealthWorkout[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <RunningPlanDetail
        plan={plan}
        activities={activities}
        onUpdate={vi.fn(async () => {})}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        onExport={vi.fn()}
        initialWeekIndex={0}
      />
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const counters = () => container.querySelector<HTMLElement>('[data-testid="week-hr-counters"]');

describe("Plans week accessory — HR counters", () => {
  it("counts easy under cap and workouts in range; excludes race and split long run", async () => {
    const plan = planOf([
      entry(1, { targetHr: { minBpm: null, maxBpm: 135 } }), // matched 133 → met
      entry(2, { targetHr: { minBpm: null, maxBpm: 135 } }), // matched 141 → over
      entry(3, { workoutType: "tempo", targetHr: { minBpm: 146, maxBpm: 155 } }), // 150 → in range
      entry(4, { distanceMiles: 6, targetHeartRate: 135 }), // PARTIAL match (2 of 6 mi), 140 → over, still counted
      entry(5, { workoutType: "race", targetHeartRate: 160 }), // excluded
      entry(6, { workoutType: "long", runType: "longRun", notes: "HR <135 / 145-155 bpm" }), // split: no target
    ]);
    await mount(plan, [
      run(1, 133),
      run(2, 141),
      run(3, 150),
      run(4, 140, 2),
      run(5, 158),
      run(6, 145),
    ]);
    const text = counters()?.textContent ?? "";
    expect(text).toContain("Easy runs under cap 1 of 3");
    expect(text).toContain("Workouts in range 1 of 1");
  });

  it("hides a counter whose total is 0", async () => {
    const plan = planOf([entry(1, { targetHr: { minBpm: null, maxBpm: 135 } })]);
    await mount(plan, [run(1, 130)]);
    const text = counters()?.textContent ?? "";
    expect(text).toContain("Easy runs under cap 1 of 1");
    expect(text).not.toContain("Workouts in range");
  });

  it("renders no counters when no completed entry has a target and an avg HR", async () => {
    const plan = planOf([
      entry(1, { targetHr: { minBpm: null, maxBpm: 135 } }), // unmatched
      entry(2, { targetHr: { minBpm: null, maxBpm: 135 } }), // matched but no avg HR
      entry(3, {}), // matched, no target
    ]);
    await mount(plan, [run(2, null), run(3, 140)]);
    expect(counters()).toBeNull();
  });
});

describe("Plans entry rows — HR chips", () => {
  it("shows Target and actual chips, and the legacy 'HR: N bpm' chip is gone", async () => {
    const plan = planOf([entry(1, { targetHr: { minBpm: null, maxBpm: 135 }, targetHeartRate: 135 })]);
    await mount(plan, [run(1, 138)]);
    const text = container.textContent ?? "";
    expect(text).toContain("Target ≤ 135");
    expect(text).toContain("Avg 138 · over by 3");
    expect(text).not.toContain("HR: 135 bpm");
    // The existing matched-actual line is unchanged.
    expect(text).toContain("138 bpm");
  });

  it("a legacy-only targetHeartRate still shows Target ≤ 135 through the resolver", async () => {
    const plan = planOf([entry(1, { targetHeartRate: 135 })]);
    await mount(plan, []);
    expect(container.textContent).toContain("Target ≤ 135");
    expect(container.textContent).not.toContain("HR: 135 bpm");
    expect(container.querySelector('[data-hr-chip="actual"]')).toBeNull();
  });

  it("shows a range target chip", async () => {
    const plan = planOf([entry(3, { workoutType: "tempo", targetHr: { minBpm: 146, maxBpm: 155 } })]);
    await mount(plan, [run(3, 143)]);
    expect(container.textContent).toContain("Target 146–155");
    expect(container.textContent).toContain("Avg 143 · under by 3");
  });

  it("entries with no resolved target show no HR chips and keep their notes", async () => {
    const plan = planOf([
      entry(6, { workoutType: "long", runType: "longRun", notes: "HR <135 / 145-155 bpm. Key session" }),
    ]);
    await mount(plan, [run(6, 145)]);
    expect(container.querySelector('[data-hr-chip]')).toBeNull();
    expect(container.textContent).toContain("HR <135 / 145-155 bpm. Key session");
  });
});
