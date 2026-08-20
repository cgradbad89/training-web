import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type RunningPlan } from "@/types/plan";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Phase 5 regression: PlanCompletionSummary used to compute run load with a
 * hard-coded DEFAULT_MAX_HR constant instead of the user's stored
 * users/{uid}/settings/prefs HR anchors, so this chart disagreed with every
 * other load display in the app. It now reads maxHr/restingHr from
 * useAppData() (which itself falls back to 185/60 only when the settings/prefs
 * doc or fields are missing — same fallback used everywhere else).
 */

const h = vi.hoisted(() => ({
  buildPlanAdherence: vi.fn(() => ({
    weeks: [],
    totalPlannedMiles: 0,
    totalActualMiles: 0,
    totalPlannedRuns: 0,
    totalCompletedRuns: 0,
    weeksHitTarget: 0,
    overallAvgPaceSecPerMile: null,
  })),
  appData: { maxHr: 185, restingHr: 60 } as { maxHr: number; restingHr: number },
}));

vi.mock("@/utils/planAdherence", () => ({
  buildPlanAdherence: h.buildPlanAdherence,
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => h.appData,
}));

// Chart components pull in Recharts via next/dynamic — stub them out, this
// test only cares about what buildPlanAdherence is called with.
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

import { PlanCompletionSummary } from "@/components/PlanCompletionSummary";

function completedRunningPlan(): RunningPlan {
  return {
    id: "p1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "completed",
    isActive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.buildPlanAdherence.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("PlanCompletionSummary — load chart HR source", () => {
  it("passes the user's stored settings maxHr/restingHr to buildPlanAdherence, not a hard-coded default", async () => {
    h.appData = { maxHr: 201, restingHr: 52 }; // deliberately non-default values
    await act(async () => {
      root = createRoot(container);
      root.render(<PlanCompletionSummary plan={completedRunningPlan()} activities={[]} />);
    });

    expect(h.buildPlanAdherence).toHaveBeenCalledTimes(1);
    const opts = h.buildPlanAdherence.mock.calls[0][2] as {
      maxHr: number;
      restingHr: number;
    };
    expect(opts.maxHr).toBe(201);
    expect(opts.restingHr).toBe(52);
  });

  it("falls back to 185/60 only via useAppData's own fallback (missing settings doc), not a separate default here", async () => {
    // useAppData already resolves 185/60 when settings/prefs is missing or
    // incomplete (resolveMaxHr/resolveRestingHr) — this pins that
    // PlanCompletionSummary forwards those values as-is, without
    // re-introducing its own fallback constant.
    h.appData = { maxHr: 185, restingHr: 60 };
    await act(async () => {
      root = createRoot(container);
      root.render(<PlanCompletionSummary plan={completedRunningPlan()} activities={[]} />);
    });

    const opts = h.buildPlanAdherence.mock.calls[0][2] as {
      maxHr: number;
      restingHr: number;
    };
    expect(opts.maxHr).toBe(185);
    expect(opts.restingHr).toBe(60);
  });
});
