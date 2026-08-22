import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { type RunningPlan, type Plan } from "@/types/plan";
import { type Race } from "@/types/race";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Regression coverage for the Plans-page ↔ Dashboard data-source desync
 * (PRD.md — /plans wired to shared AppDataContext): /plans used to fetch its
 * own copy of plans and workouts (fetchPlans + an unbounded fetchHealthWorkouts)
 * instead of the AppDataContext every other page reads, so exclusions, field
 * overrides, and post-edit freshness diverged from /dashboard. The fix routes
 * the page through useAppData()'s `plans` / `workouts` / `overrides` +
 * `refreshPlans` (the same mechanism dashboard/page.tsx and plan-insights/page.tsx
 * already use).
 *
 * `RunningPlanDetail` is stubbed so these tests assert on the PROPS the page
 * hands it (activities already override-filtered, onComplete wired to a real
 * refreshPlans-calling handler) rather than re-testing its own internals.
 */

// ── Shared, hoisted handles the mocks read/write ──────────────────────────────
const h = vi.hoisted(() => ({
  // Stable object reference — a fresh literal per useAuth() call (as real
  // useAuth's destructured `user` is NOT, since it's React state that's only
  // reassigned on real auth changes) would retrigger every `[user]`-keyed
  // effect on every render, looping forever against this test's fake user.
  authUser: { uid: "u1" },
  refreshPlans: vi.fn(),
  useAppDataReturn: {
    plans: [] as Plan[],
    plansLoading: false,
    plansResolution: "success" as "loading" | "success" | "error",
    workouts: [] as HealthWorkout[],
    workoutsLoading: false,
    overrides: {} as Record<string, WorkoutOverride>,
    races: [] as Race[],
    racesLoading: false,
  },
  setPlanCompletion: vi.fn(),
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  deletePlan: vi.fn(),
  setActivePlan: vi.fn(),
  fetchRaces: vi.fn(),
  buildSeptTravelMigration: vi.fn(),
  seedSeptHMPlan: vi.fn(),
  runningPlanDetailProps: [] as unknown[],
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: h.authUser, loading: false }),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    plans: h.useAppDataReturn.plans,
    plansLoading: h.useAppDataReturn.plansLoading,
    plansResolution: h.useAppDataReturn.plansResolution,
    workouts: h.useAppDataReturn.workouts,
    workoutsLoading: h.useAppDataReturn.workoutsLoading,
    overrides: h.useAppDataReturn.overrides,
    races: h.useAppDataReturn.races,
    racesLoading: h.useAppDataReturn.racesLoading,
    refreshPlans: h.refreshPlans,
  }),
}));

vi.mock("@/services/plans", () => ({
  createPlan: h.createPlan,
  updatePlan: h.updatePlan,
  deletePlan: h.deletePlan,
  setActivePlan: h.setActivePlan,
  setPlanCompletion: h.setPlanCompletion,
}));

vi.mock("@/services/races", () => ({
  fetchRaces: h.fetchRaces,
}));

vi.mock("@/lib/seedData", () => ({
  DEFAULT_HALF_MARATHON_PLAN: {},
  seedSeptHMPlan: h.seedSeptHMPlan,
  buildSeptTravelMigration: h.buildSeptTravelMigration,
}));

vi.mock("@/hooks/useGoals", () => ({
  useGoals: () => ({ goals: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/CrossTrainingPlanDetail", () => ({
  CrossTrainingPlanDetail: () => null,
}));

vi.mock("@/components/PlanExportModal", () => ({
  PlanExportModal: () => null,
}));

vi.mock("@/components/CalendarView", () => ({
  CalendarView: () => null,
}));

vi.mock("@/components/GoalsTab", () => ({
  GoalsTab: () => null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

// Stub RunningPlanDetail: capture the props the page hands it, and expose a
// couple of buttons that invoke the callbacks a real user action would.
vi.mock("@/components/RunningPlanDetail", () => ({
  RunningPlanDetail: (props: {
    plan: RunningPlan;
    activities: HealthWorkout[];
    onComplete: () => void;
  }) => {
    h.runningPlanDetailProps.push(props);
    return (
      <div data-testid="running-plan-detail">
        <span data-testid="plan-name">{props.plan.name}</span>
        <span data-testid="activities-count">{props.activities.length}</span>
        <button onClick={() => props.onComplete()}>Complete Plan</button>
      </div>
    );
  },
}));

function buildWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "w1",
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-08-17T09:00:00"),
    endDate: new Date("2026-08-17T10:00:00"),
    durationSeconds: 3600,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: false,
    hasHRStream: false,
    syncedAt: new Date("2026-08-17T10:05:00"),
    calories: 400,
    avgHeartRate: 150,
    distanceMiles: 6,
    distanceMeters: 9656,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: 2.68,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: 80,
    trainingLoadMethod: "stream",
    ...overrides,
  } as HealthWorkout;
}

function buildOverride(workoutId: string, isExcluded: boolean): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded,
    excludedAt: isExcluded ? new Date().toISOString() : null,
    excludedReason: null,
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: new Date().toISOString(),
  };
}

/** A "Sept 2026 ... Sub 9:30" running plan that's already the current seed
 *  version, so the seed/migration effect makes no writes (buildSeptTravelMigration
 *  is mocked to return null too) — keeps refreshPlans call counts deterministic. */
function buildSeptPlan(overrides: Partial<RunningPlan> = {}): RunningPlan {
  return {
    id: "sept1",
    name: "Sept 2026 Half Marathon Sub 9:30",
    planType: "running",
    startDate: "2026-09-07",
    status: "active",
    isActive: true,
    weeks: [{ weekNumber: 1, entries: [] }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Imported after the mocks are registered.
import PlansPage from "../page";

let container: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<PlansPage />);
  });
  await flush();
  await flush();
  await flush();
}

beforeEach(() => {
  h.refreshPlans.mockClear();
  h.setPlanCompletion.mockReset().mockResolvedValue(undefined);
  h.createPlan.mockReset().mockResolvedValue(buildSeptPlan());
  h.updatePlan.mockReset().mockResolvedValue(undefined);
  h.deletePlan.mockReset().mockResolvedValue(undefined);
  h.setActivePlan.mockReset().mockResolvedValue(undefined);
  h.fetchRaces.mockReset().mockResolvedValue([]);
  h.seedSeptHMPlan.mockReset().mockResolvedValue({ plan: buildSeptPlan() });
  h.buildSeptTravelMigration.mockReset().mockReturnValue(null);
  h.runningPlanDetailProps.length = 0;
  h.useAppDataReturn.plans = [buildSeptPlan()];
  h.useAppDataReturn.plansLoading = false;
  h.useAppDataReturn.plansResolution = "success";
  h.useAppDataReturn.workouts = [];
  h.useAppDataReturn.workoutsLoading = false;
  h.useAppDataReturn.overrides = {};
  h.useAppDataReturn.races = [];
  h.useAppDataReturn.racesLoading = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("PlansPage — shared AppDataContext wiring", () => {
  it("excludes a workout via the shared overrides map so it never reaches RunningPlanDetail's activities", async () => {
    const included = buildWorkout({ workoutId: "w-included" });
    const excluded = buildWorkout({ workoutId: "w-excluded" });
    h.useAppDataReturn.workouts = [included, excluded];
    h.useAppDataReturn.overrides = { "w-excluded": buildOverride("w-excluded", true) };

    await mount();

    expect(container.querySelector('[data-testid="activities-count"]')?.textContent).toBe(
      "1"
    );
    const lastProps = h.runningPlanDetailProps.at(-1) as {
      activities: HealthWorkout[];
    };
    expect(lastProps.activities.map((a) => a.workoutId)).toEqual(["w-included"]);
  });

  it("calls the shared refreshPlans() after a plan-mutating action (complete plan)", async () => {
    await mount();

    // The seed/migration pass makes no writes for an already-current Sept
    // plan (buildSeptTravelMigration mocked to null), so refreshPlans should
    // not have fired yet from mount alone.
    expect(h.refreshPlans).not.toHaveBeenCalled();

    const completeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Complete Plan"
    );
    expect(completeBtn).toBeTruthy();
    await act(async () => {
      completeBtn!.click();
    });
    await flush();

    expect(h.setPlanCompletion).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "sept1" }),
      "complete"
    );
    expect(h.refreshPlans).toHaveBeenCalledTimes(1);
  });

  it("renders the plan list and detail view after the dead-code removal (Phase 3)", async () => {
    await mount();

    // Tab toggle still renders.
    expect(container.textContent).toContain("Plans");
    expect(container.textContent).toContain("Calendar");
    expect(container.textContent).toContain("Goals");

    // Sidebar shows the seeded plan, and the (stubbed) detail view mounted
    // with the right plan — proves currentWeek/weekEntries/weekStats/
    // weekDateRange/matchMap/statusForRunEntry removal didn't break render.
    expect(container.textContent).toContain("Sept 2026 Half Marathon Sub 9:30");
    expect(
      container.querySelector('[data-testid="plan-name"]')?.textContent
    ).toBe("Sept 2026 Half Marathon Sub 9:30");
  });

  it("renders plans while shared workouts and races are still loading", async () => {
    h.useAppDataReturn.workoutsLoading = true;
    h.useAppDataReturn.racesLoading = true;

    await mount();

    expect(container.textContent).toContain("Plans & Goals");
    expect(container.textContent).toContain("Sept 2026 Half Marathon Sub 9:30");
    expect(container.querySelector('[data-testid="running-plan-detail"]')).toBeTruthy();
    expect(h.fetchRaces).not.toHaveBeenCalled();
  });

  it("renders the page shell and existing plan before migration finishes", async () => {
    let resolveMigration!: () => void;
    h.buildSeptTravelMigration.mockImplementation(() => ({
      ...buildSeptPlan(),
      name: "Sept 2026 Half Marathon Sub 9:30 Migrated",
    }));
    h.updatePlan.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveMigration = resolve;
      })
    );

    await mount();

    expect(h.updatePlan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Plans & Goals");
    expect(container.textContent).toContain("Calendar");
    expect(container.querySelector('[data-testid="running-plan-detail"]')).toBeTruthy();

    resolveMigration();
    await flush();
    await flush();
    expect(h.refreshPlans).toHaveBeenCalledTimes(1);
  });

  it("does not seed, migrate, or present empty plans after a failed plans read", async () => {
    h.useAppDataReturn.plans = [];
    h.useAppDataReturn.plansResolution = "error";

    await mount();

    expect(container.textContent).toContain("Plans could not be loaded");
    expect(h.createPlan).not.toHaveBeenCalled();
    expect(h.seedSeptHMPlan).not.toHaveBeenCalled();
    expect(h.updatePlan).not.toHaveBeenCalled();
  });
});

// ─── Plan.startDate Monday normalization (both plan types) ───────────────────
//
// RunningPlan.startDate has long been Monday-normalized by contract; new
// WorkoutPlans were snapped as of the prior session. This session closes the
// gap: new RunningPlans now snap too, so BOTH plan types share the same
// creation-time contract (a non-Monday start previously desynced the
// calendar from the week tiles). Both paths snap to the Monday of the week
// containing the chosen date via the existing `snapToMonday` helper in
// planDateEdit.ts — the same one the copy/slide paths already use.
// Existing plan documents of EITHER type are deliberately NOT migrated.

/** Drive the create flow: + → plan-type → set dates → Create. */
async function createPlanViaUI(
  type: "Running Plan" | "Workout Plan",
  startDate: string,
  endDate: string,
  name = "New Plan"
) {
  const findBtn = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text)
    );

  // The "+" new-plan trigger (icon-only, identified by its title) opens the
  // plan-type picker.
  const plusBtn = container.querySelector<HTMLButtonElement>(
    'button[title="New plan"]'
  );
  expect(plusBtn).toBeTruthy();
  await act(async () => {
    plusBtn!.click();
  });

  await act(async () => {
    findBtn(type)!.click();
  });

  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const textInputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="text"]')
  );
  const dateInputs = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="date"]')
  );
  await act(async () => {
    setInput(textInputs[0], name);
  });
  await act(async () => {
    setInput(dateInputs[0], startDate);
  });
  await act(async () => {
    setInput(dateInputs[1], endDate);
  });

  await act(async () => {
    findBtn("Create")!.click();
  });
  await flush();
}

describe("PlansPage — new plan startDate is Monday-normalized (both plan types)", () => {
  it("snaps a Wednesday start back to that week's Monday", async () => {
    await mount();
    // Wed 2026-01-21 → Mon 2026-01-19.
    await createPlanViaUI("Workout Plan", "2026-01-21", "2026-03-15");

    expect(h.createPlan).toHaveBeenCalledTimes(1);
    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.planType).toBe("workout");
    expect(payload.startDate).toBe("2026-01-19");
  });

  it("snaps a Sunday start back to the Monday ON OR BEFORE it, not forward", async () => {
    await mount();
    // Sun 2026-01-25 belongs to the week starting Mon 2026-01-19.
    await createPlanViaUI("Workout Plan", "2026-01-25", "2026-03-15");

    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.startDate).toBe("2026-01-19");
  });

  it("is a no-op when the chosen start date is already a Monday", async () => {
    await mount();
    await createPlanViaUI("Workout Plan", "2026-01-19", "2026-03-15");

    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.startDate).toBe("2026-01-19");
  });

  it("re-derives the week count from the snapped start so the chosen end stays covered", async () => {
    await mount();
    // Wed 2026-01-21 → Tue 2026-02-03 is 2 weeks from the raw input, but only
    // covers through Sun 2026-02-01 once the start snaps back to Mon 01-19.
    await createPlanViaUI("Workout Plan", "2026-01-21", "2026-02-03");

    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.startDate).toBe("2026-01-19");
    // Mon 01-19 + 3*7 - 1 = Sun 02-08, which covers the chosen Feb 3 end.
    expect(payload.weeks).toHaveLength(3);
  });

  it("snaps a new RunningPlan's Wednesday start back to that week's Monday", async () => {
    await mount();
    // Wed 2026-01-21 → Mon 2026-01-19 — RunningPlan.startDate is
    // Monday-normalized by the same contract WorkoutPlan.startDate now is.
    await createPlanViaUI("Running Plan", "2026-01-21", "2026-03-15");

    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.planType).toBe("running");
    expect(payload.startDate).toBe("2026-01-19");
  });

  it("is a no-op for a new RunningPlan when the chosen start date is already a Monday", async () => {
    await mount();
    await createPlanViaUI("Running Plan", "2026-01-19", "2026-03-15");

    const [, payload] = h.createPlan.mock.calls[0];
    expect(payload.planType).toBe("running");
    expect(payload.startDate).toBe("2026-01-19");
  });

  it("never rewrites an EXISTING workout plan document — no updatePlan on mount", async () => {
    // A pre-session workout plan with a Thursday start stays exactly as stored.
    const legacy: Plan = {
      id: "wp-legacy",
      name: "Legacy Strength Block",
      planType: "workout",
      startDate: "2026-01-22", // Thursday — deliberately not Monday
      status: "active",
      isActive: true,
      weeks: [{ weekNumber: 1, entries: [] }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Plan;
    h.useAppDataReturn.plans = [buildSeptPlan(), legacy];

    await mount();

    expect(h.updatePlan).not.toHaveBeenCalled();
    expect(h.createPlan).not.toHaveBeenCalled();
    // The in-memory copy the page holds is still the stored Thursday date.
    expect((h.useAppDataReturn.plans[1] as Plan).startDate).toBe("2026-01-22");
  });
});
