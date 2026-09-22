import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarView } from "@/components/CalendarView";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ push: vi.fn(), workoutModalProps: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/components/runs/RunActivityModal", () => ({ RunActivityModal: () => null }));
vi.mock("@/components/WorkoutDetailModal", () => ({
  WorkoutDetailModal: (props: { workout: HealthWorkout; onExcludeChange: (id: string, excluded: boolean) => void }) => {
    h.workoutModalProps(props);
    return <div role="dialog" aria-label="Workout details"><button onClick={() => props.onExcludeChange(props.workout.workoutId, true)}>Exclude</button></div>;
  },
}));
let container: HTMLDivElement;
let root: Root;
const current = new Date();
function workout(id: string, isRunLike: boolean, hour = 9): HealthWorkout {
  return { workoutId: id, isRunLike, startDate: new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour),
    endDate: new Date(), activityType: isRunLike ? "running" : "traditional_strength_training",
    displayType: isRunLike ? "Run" : "Workout", distanceMiles: isRunLike ? 3 : 0 } as HealthWorkout;
}
function mount(workouts: HealthWorkout[] = [], onExclude = vi.fn()) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CalendarView plans={[]} actualWorkouts={workouts} userId="u1"
    overrides={{}} maxHr={185} restingHr={60} onWorkoutExcludeChange={onExclude} />));
}
function clickButton(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeTruthy();
  act(() => button!.click());
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); h.push.mockReset(); h.workoutModalProps.mockReset(); });

describe("CalendarView", () => {
  it("keeps Calendar controls visible with zero active plans", () => {
    mount();
    expect(container.textContent).toContain("week");
    expect(container.textContent).toContain("month");
    expect(container.textContent).not.toContain("No active plans");
  });
  it("routes an actual run to Run Detail without mutating plans", () => {
    mount([workout("r1", true)]);
    clickButton("3mi Run");
    expect(h.push).toHaveBeenCalledWith("/runs/r1");
  });
  it("opens existing workout details for an actual workout", () => {
    const onExclude = vi.fn();
    mount([workout("w1", false)], onExclude);
    clickButton("Strength Training");
    expect(h.workoutModalProps).toHaveBeenCalledWith(expect.objectContaining({
      workout: expect.objectContaining({ workoutId: "w1" }),
      userId: "u1", maxHr: 185, restingHr: 60, override: null,
    }));
    expect(onExclude).not.toHaveBeenCalled();
    clickButton("Exclude");
    expect(onExclude).toHaveBeenCalledWith("w1", true);
  });
  it("caps Month inline events at three and opens all events from +N more", () => {
    mount([workout("w1", false, 8), workout("w2", false, 9), workout("w3", false, 10), workout("w4", false, 11)]);
    clickButton("month");
    expect(container.querySelectorAll(".lucide-dumbbell")).toHaveLength(3);
    clickButton("+1 more");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelectorAll(".lucide-dumbbell")).toHaveLength(7);
  });
});
