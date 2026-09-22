import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EventPill, WeekCalendar } from "@/components/WeekCalendar";
import type { CalendarEvent } from "@/utils/planCalendar";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/runs/RunActivityModal", () => ({ RunActivityModal: () => null }));

let container: HTMLDivElement;
let root: Root;
function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
const date = new Date(2026, 8, 21, 9, 15);
function activity(id: string, isRunLike: boolean): HealthWorkout {
  return { workoutId: id, startDate: date, isRunLike } as HealthWorkout;
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
    render(<WeekCalendar plans={[]} actualRuns={[activity("r1", true)]} weekStart={new Date(2026, 8, 21)} />);
    expect(container.textContent).not.toContain("3mi Run");
  });
});
