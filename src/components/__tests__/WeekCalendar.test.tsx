import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EventPill, WeekCalendar } from "@/components/WeekCalendar";
import type { CalendarEvent } from "@/utils/planCalendar";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RunningPlan } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/runs/RunActivityModal", () => ({ RunActivityModal: () => "Run activity detail" }));

let container: HTMLDivElement;
let root: Root;
function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); push.mockClear(); });
const date = new Date(2026, 8, 21, 9, 15);
function activity(id: string, isRunLike: boolean): HealthWorkout {
  return { workoutId: id, startDate: date, isRunLike,
    activityType: isRunLike ? "running" : "traditional_strength_training",
    displayType: isRunLike ? "Run" : "Strength Training",
    distanceMiles: isRunLike ? 3 : 0,
  } as HealthWorkout;
}
const actualRun: CalendarEvent = { kind: "actual-run", date, label: "3mi Run", activity: activity("r1", true), distanceMiles: 3 };
const actualWorkout: CalendarEvent = { kind: "actual-workout", date, label: "Strength Training", activity: activity("w1", false) };

describe("EventPill", () => {
  it("shows Footprints and local time for an actual run without a plan-status badge", () => {
    render(<EventPill event={actualRun} onClick={vi.fn()} />);
    expect(container.querySelector(".lucide-footprints")).not.toBeNull();
    expect(container.textContent).toContain("9:15 AM · 3mi Run");
    expect(container.textContent).not.toContain("Unplanned");
    expect(container.textContent).not.toContain("3.0 mi");
  });
  it("shows Dumbbell and local time for an actual workout", () => {
    render(<EventPill event={actualWorkout} onClick={vi.fn()} />);
    expect(container.querySelector(".lucide-dumbbell")).not.toBeNull();
    expect(container.textContent).toContain("9:15 AM · Strength Training");
  });
  it("preserves planned run status and workout completion treatment", () => {
    const plannedRun: CalendarEvent = { kind: "planned-running", planType: "running", date,
      entryId: "e1", planId: "p1", planName: "Plan", weekIndex: 0, dayIndex: 0,
      weekday: 1, sessionIndex: 0, label: "Long Run", completed: true,
      isRestDay: false, status: "partial", activity: null, distanceMiles: 10 };
    render(<><EventPill event={plannedRun} onClick={vi.fn()} />
      <EventPill event={{ ...plannedRun, kind: "planned-workout", planType: "workout", entryId: "e2" } as CalendarEvent} onClick={vi.fn()} /></>);
    expect(container.querySelector(".lucide-circle-minus")).not.toBeNull();
    expect(container.textContent).toContain("10.0 mi");
    expect(container.textContent).toContain("✓");
  });
});

describe("WeekCalendar", () => {
  it("renders every supplied event and delegates clicks", () => {
    const onEventClick = vi.fn();
    render(<WeekCalendar plans={[]} actualRuns={[]} weekStart={new Date(2026, 8, 21)}
      prebuiltEvents={[actualRun, actualWorkout]} onEventClick={onEventClick} />);
    expect(container.textContent).toContain("3mi Run");
    expect(container.textContent).toContain("Strength Training");
    act(() => (container.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(onEventClick).toHaveBeenCalledWith(actualRun);
  });
  it("remains planned-only when no prebuilt event array is supplied", () => {
    render(<WeekCalendar plans={[]} actualRuns={[activity("r1", true), activity("w1", false)]}
      weekStart={new Date(2026, 8, 21)} />);
    expect(container.textContent).not.toContain("3mi Run");
    expect(container.textContent).not.toContain("Strength Training");
  });
  it("shows an actual run without a plan when opted in", () => {
    render(<WeekCalendar plans={[]} actualRuns={[activity("r1", true)]} includeActualOnly
      weekStart={new Date(2026, 8, 21)} />);
    expect(container.textContent).toContain("9:15 AM · 3mi Run");
    expect(container.querySelectorAll(".lucide-footprints")).toHaveLength(1);
  });
  it("shows an actual workout without a plan when opted in", () => {
    render(<WeekCalendar plans={[]} actualRuns={[activity("w1", false)]} includeActualOnly
      weekStart={new Date(2026, 8, 21)} />);
    expect(container.textContent).toContain("9:15 AM · Strength Training");
    expect(container.querySelectorAll(".lucide-dumbbell")).toHaveLength(1);
  });
  it("passes the exact actual workout to its callback", () => {
    const workout = activity("w1", false);
    const onActualWorkoutClick = vi.fn();
    render(<WeekCalendar plans={[]} actualRuns={[workout]} includeActualOnly
      onActualWorkoutClick={onActualWorkoutClick} weekStart={new Date(2026, 8, 21)} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(onActualWorkoutClick).toHaveBeenCalledExactlyOnceWith(workout);
    expect(push).not.toHaveBeenCalled();
  });
  it("still routes actual runs to Run Detail by default", () => {
    render(<WeekCalendar plans={[]} actualRuns={[activity("r1", true)]} includeActualOnly
      weekStart={new Date(2026, 8, 21)} />);
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(push).toHaveBeenCalledExactlyOnceWith("/runs/r1");
  });
  it("gives prebuilt events precedence over the opt-in builder and delegates clicks", () => {
    const onEventClick = vi.fn();
    const onActualWorkoutClick = vi.fn();
    render(<WeekCalendar plans={[]} actualRuns={[activity("r1", true)]} includeActualOnly
      prebuiltEvents={[actualWorkout]} onEventClick={onEventClick}
      onActualWorkoutClick={onActualWorkoutClick} weekStart={new Date(2026, 8, 21)} />);
    expect(container.textContent).not.toContain("3mi Run");
    expect(container.textContent).toContain("Strength Training");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(onEventClick).toHaveBeenCalledExactlyOnceWith(actualWorkout);
    expect(onActualWorkoutClick).not.toHaveBeenCalled();
  });
  it("keeps planned workout routing and planned run detail behavior", () => {
    const entry = { id: "e1", weekIndex: 0, weekday: 1, dayOfWeek: 0,
      distanceMiles: 5, runType: "outdoor" } as const;
    const plan = { id: "p1", planType: "running", weeks: [{ entries: [entry] }] } as RunningPlan;
    const plannedRun: CalendarEvent = { kind: "planned-running", planType: "running", date,
      entryId: "e1", planId: "p1", planName: "Plan", weekIndex: 0, dayIndex: 0,
      weekday: 1, sessionIndex: 0, label: "Run", completed: false,
      isRestDay: false, status: "upcoming", activity: null };
    const plannedWorkout: CalendarEvent = { kind: "planned-workout", planType: "workout", date,
      entryId: "e2", planId: "p2", planName: "Workout Plan", weekIndex: 0, dayIndex: 0,
      weekday: 1, sessionIndex: 0, label: "Strength", completed: false, isRestDay: false };
    render(<WeekCalendar plans={[plan]} actualRuns={[]} prebuiltEvents={[plannedRun, plannedWorkout]}
      weekStart={new Date(2026, 8, 21)} />);
    const [runPill, workoutPill] = container.querySelectorAll("button");
    act(() => (runPill as HTMLButtonElement).click());
    expect(container.textContent).toContain("Run activity detail");
    act(() => (workoutPill as HTMLButtonElement).click());
    expect(push).toHaveBeenCalledExactlyOnceWith("/workout/p2/0/1/0");
  });
});
