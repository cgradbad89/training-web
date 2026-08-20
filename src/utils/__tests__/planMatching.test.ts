import { describe, expect, it } from "vitest";
import {
  matchPlanToActual,
  statusForRunEntry,
  isPlanEntryCompleted,
} from "@/utils/planMatching";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function runEntry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  id: string
): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType: "outdoor",
  };
}

// Single-week plan starting Mon 2026-01-19 with one Monday entry.
function makePlan(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [{ weekNumber: 1, entries }],
  };
}

// Minimal HealthWorkout — only the fields the matcher reads. UTC-noon
// timestamps keep the calendar day stable regardless of the runner's timezone.
function run(startISO: string, distanceMiles: number, id?: string): HealthWorkout {
  return {
    workoutId: id ?? `run-${startISO}`,
    isRunLike: true,
    startDate: new Date(startISO),
    distanceMiles,
    durationSeconds: distanceMiles * 600,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

// Reference "now" — used only where status derivation (missed/upcoming) matters.
const NOW = new Date(2026, 0, 24, 12, 0, 0); // Sat 2026-01-24 local

describe("matchPlanToActual — completion threshold (85%)", () => {
  it("a run at exactly 85% of planned distance matches with quality 'full'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // planned 10mi
    const w = run("2026-01-19T12:00:00Z", 8.5); // 8.5/10 = 85% exactly
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "full" });
  });

  it("a run just below 85% still matches (day proximity is the only match gate), quality 'partial'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // planned 10mi
    const w = run("2026-01-19T12:00:00Z", 8.4); // 84% — below threshold
    const matchMap = matchPlanToActual(plan, [w]);
    const match = matchMap.get("w1-mon");
    expect(match).not.toBeNull();
    expect(match).toMatchObject({ quality: "partial" });
  });

  it("a run more than 3mi short of planned (previously excluded entirely) now matches as partial", () => {
    // Under the old DISTANCE_SHORTFALL_THRESHOLD rule this run (4mi vs 8mi
    // planned, a 4mi shortfall) would never match at all. It should now match
    // same-day, graded "partial" since 4/8 = 50% < 85%.
    const plan = makePlan([runEntry(0, 1, 8, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 4);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });

  it("a run within ±1 day but below 85% still matches as partial (day-proximity structure unchanged)", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const w = run("2026-01-20T12:00:00Z", 5); // Tue, 1 day off, 50%
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });

  it("no actual run within ±1 day of the planned entry leaves it unmatched (missed/upcoming, not partial)", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const w = run("2026-01-22T12:00:00Z", 10); // Thu — 3 days off, out of window
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toBeNull();
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "missed"
    );
  });

  it("zero planned distance is treated as trivially met (meetsCompletionThreshold's <= 0 guard)", () => {
    const plan = makePlan([runEntry(0, 1, 0, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 2);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "full" });
  });

  it("zero actual distance against a nonzero plan matches as partial (0% completion)", () => {
    const plan = makePlan([runEntry(0, 1, 6, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 0);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });
});

describe("statusForRunEntry — quality → status mapping unchanged", () => {
  it("full quality → 'met'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 10);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "met"
    );
  });

  it("partial quality → 'partial'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 3);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "partial"
    );
  });

  it("no match, future entry → 'upcoming'", () => {
    const plan = makePlan([runEntry(1, 1, 10, "w2-mon")]); // week 2 Monday — future vs NOW
    const matchMap = matchPlanToActual(plan, []);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "upcoming"
    );
  });
});

// ─── isPlanEntryCompleted — canonical "any match counts" helper (Phase 1) ────

describe("isPlanEntryCompleted", () => {
  it("'met' (full match) is completed", () => {
    expect(isPlanEntryCompleted("met")).toBe(true);
  });

  it("'partial' (partial match) is completed", () => {
    expect(isPlanEntryCompleted("partial")).toBe(true);
  });

  it("'missed' (no match, past) is NOT completed", () => {
    expect(isPlanEntryCompleted("missed")).toBe(false);
  });

  it("'upcoming' (no match, future) is NOT completed", () => {
    expect(isPlanEntryCompleted("upcoming")).toBe(false);
  });
});

// ─── Override-aware match quality ────────────────────────────────────────────
//
// `distanceMilesOverride` is a user correction to a workout's recorded
// distance. It does NOT move the 85% full/partial threshold — it only changes
// the distance the threshold is applied to. Before this was wired in, a
// corrected distance showed on /runs and /plan-insights but the plan grid on
// /dashboard and /plans still graded the raw HealthKit value.

function override(
  workoutId: string,
  distanceMilesOverride: number | null,
  isExcluded = false
): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded,
    excludedAt: null,
    excludedReason: null,
    distanceMilesOverride,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-01-20T00:00:00.000Z",
  };
}

describe("matchPlanToActual — distanceMilesOverride changes the quality tier", () => {
  // Planned 10 mi → 85% threshold is 8.5 mi.
  const plan = makePlan([runEntry(0, 1, 10, "e1")]);

  it("raw 7.0 mi grades partial; corrected 9.5 mi grades full", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");

    // Before: no overrides → 7.0 / 10 = 0.70 < 0.85
    expect(matchPlanToActual(plan, [w]).get("e1")?.quality).toBe("partial");

    // After: the user corrects the GPS undercount to 9.5 → 0.95 ≥ 0.85
    const after = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(after.get("e1")?.quality).toBe("full");
  });

  it("raw 9.5 mi grades full; corrected 7.0 mi grades partial (inverse)", () => {
    const w = run("2026-01-19T12:00:00Z", 9.5, "w1");

    expect(matchPlanToActual(plan, [w]).get("e1")?.quality).toBe("full");

    const after = matchPlanToActual(plan, [w], { w1: override("w1", 7.0) });
    expect(after.get("e1")?.quality).toBe("partial");
  });

  it("statusForRunEntry follows the corrected tier (partial → met)", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const entry = plan.weeks[0].entries[0];

    const before = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, entry, before, NOW)).toBe("partial");

    const after = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(statusForRunEntry(plan, entry, after, NOW)).toBe("met");
  });

  it("PlanMatch.activity carries the override-applied distance", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const m = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(m.get("e1")?.activity.distanceMiles).toBe(9.5);
    // Source workout is never mutated.
    expect(w.distanceMiles).toBe(7.0);
  });

  it("an override with a null distanceMilesOverride leaves the tier alone", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const m = matchPlanToActual(plan, [w], { w1: override("w1", null) });
    expect(m.get("e1")?.quality).toBe("partial");
    expect(m.get("e1")?.activity.distanceMiles).toBe(7.0);
  });

  it("re-applying the same override to an already-corrected run is idempotent", () => {
    // Callers like /plans pre-apply overrides AND may pass the map through;
    // applyOverride assigns absolute values, so double application is safe.
    const raw = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const pre = applyOverride(raw, override("w1", 9.5));
    const m = matchPlanToActual(plan, [pre], { w1: override("w1", 9.5) });
    expect(m.get("e1")?.quality).toBe("full");
    expect(m.get("e1")?.activity.distanceMiles).toBe(9.5);
  });
});
