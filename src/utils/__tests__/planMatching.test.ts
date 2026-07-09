import { describe, expect, it } from "vitest";
import {
  matchPlanToActual,
  statusForRunEntry,
} from "@/utils/planMatching";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

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
