import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Plan, type WorkoutPlan } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  plans: [] as Plan[],
  plansLoading: false,
  plansResolution: "success" as "loading" | "success" | "error",
  fetchPlans: vi.fn(),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    plans: h.plans,
    plansLoading: h.plansLoading,
    plansResolution: h.plansResolution,
  }),
}));

vi.mock("@/services/plans", () => ({
  fetchPlans: h.fetchPlans,
}));

vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    BarChart: Stub,
    Bar: Stub,
    LineChart: Stub,
    Line: Stub,
    XAxis: Stub,
    YAxis: Stub,
    Tooltip: Stub,
    CartesianGrid: Stub,
    ResponsiveContainer: Stub,
    Legend: Stub,
  };
});

import { WorkoutTrendsSection } from "../WorkoutTrendsSection";

function workoutPlan(): WorkoutPlan {
  return {
    id: "plan-1",
    name: "Strength",
    planType: "workout",
    startDate: "2026-08-03",
    status: "active",
    isActive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          {
            id: "entry-1",
            weekIndex: 0,
            weekday: 1,
            dayOfWeek: 0,
            type: "workout",
            completed: true,
            completedAt: "2026-08-04T12:00:00.000Z",
            exercises: [
              {
                id: "exercise-1",
                kind: "exercise",
                name: "Bench Press",
                sets: 3,
                reps: 8,
                weight_lbs: 100,
              },
            ],
          },
          {
            id: "entry-2",
            weekIndex: 0,
            weekday: 3,
            dayOfWeek: 2,
            type: "workout",
            completed: true,
            completedAt: "2026-08-06T12:00:00.000Z",
            exercises: [
              {
                id: "exercise-2",
                kind: "exercise",
                name: "Bench Press",
                sets: 3,
                reps: 8,
                weight_lbs: 105,
              },
            ],
          },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

function render(show = true): void {
  act(() => {
    root.render(
      show ? <WorkoutTrendsSection workouts={[]} /> : <div>Other tab</div>
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.plans = [];
  h.plansLoading = false;
  h.plansResolution = "success";
  h.fetchPlans.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkoutTrendsSection shared plans", () => {
  it("uses already-loaded AppDataContext plans without issuing a plans query", () => {
    h.plans = [workoutPlan()];
    render();

    expect(container.textContent).toContain("Bench Press");
    expect(h.fetchPlans).not.toHaveBeenCalled();
  });

  it("shows the existing loading state while context plans are loading", () => {
    h.plansLoading = true;
    h.plansResolution = "loading";
    render();

    expect(container.textContent).toContain("Loading…");
    expect(h.fetchPlans).not.toHaveBeenCalled();
  });

  it("does not present a failed plans read as empty workout-plan history", () => {
    h.plansResolution = "error";
    render();

    expect(container.textContent).toContain(
      "Workout-plan trends are unavailable because plans could not be loaded."
    );
    expect(container.textContent).not.toContain(
      "Complete workout sessions to see weight progression"
    );
    expect(container.textContent).not.toContain(
      "Complete at least 2 weeks of workouts to see volume trends"
    );
  });

  it("does not fetch plans when the section unmounts and mounts again", () => {
    h.plans = [workoutPlan()];
    render();
    render(false);
    render();

    expect(container.textContent).toContain("Bench Press");
    expect(h.fetchPlans).not.toHaveBeenCalled();
  });
});
