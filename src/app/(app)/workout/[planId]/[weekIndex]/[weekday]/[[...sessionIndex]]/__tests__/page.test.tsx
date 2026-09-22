import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkoutPlan } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ fetchPlan: vi.fn(), updatePlan: vi.fn(), refreshPlans: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ planId: "p1", weekIndex: "0", weekday: "1" }), useRouter: () => ({ back: h.back }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({ refreshPlans: h.refreshPlans }) }));
vi.mock("@/services/plans", () => ({ fetchPlan: h.fetchPlan, updatePlan: h.updatePlan }));
import WorkoutDetailPage from "../page";

const plan: WorkoutPlan = {
  id: "p1", name: "Plan", planType: "workout", startDate: "2026-09-21",
  status: "active", isActive: true, createdAt: "", updatedAt: "",
  weeks: [{ weekNumber: 1, entries: [{ id: "e1", weekIndex: 0, weekday: 1,
    dayOfWeek: 0, type: "workout", label: "Strength", completed: false,
    matchedWorkoutId: "old-auto-match", exercises: [{ id: "exercise", kind: "exercise",
      name: "Squat", sets: 1, reps: 5, weight_lbs: 0 }],
  }] }],
};
let root: Root;
let container: HTMLDivElement;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("Workout session manual Finish", () => {
  it("clears old automatic match evidence while preserving completion and timestamp", async () => {
    h.fetchPlan.mockResolvedValue(plan);
    h.updatePlan.mockResolvedValue(undefined);
    h.refreshPlans.mockResolvedValue(undefined);
    h.updatePlan.mockClear();
    container = document.createElement("div"); document.body.appendChild(container);
    await act(async () => { root = createRoot(container); root.render(<WorkoutDetailPage />); });
    await flush();
    await click("Start Workout");
    await click("Finish Workout");
    expect(h.updatePlan).toHaveBeenCalledTimes(1);
    const saved = (h.updatePlan.mock.calls[0][1] as WorkoutPlan).weeks[0].entries[0];
    expect(saved.completed).toBe(true);
    expect(new Date(saved.completedAt!).getTime()).toBeGreaterThan(0);
    expect(saved.matchedWorkoutId).toBeUndefined();
    expect(h.refreshPlans).toHaveBeenCalled();
  });
});
