import { describe, expect, it } from "vitest";
import { buildPlanAdherence } from "@/utils/planAdherence";
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

// 3-week plan starting Mon 2026-01-19. Each week: a single planned run on
// Monday (weekday 1).
function makePlan(): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "completed",
    isActive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      { weekNumber: 1, entries: [runEntry(0, 1, 5, "w1-mon")] },
      { weekNumber: 2, entries: [runEntry(1, 1, 6, "w2-mon")] },
      { weekNumber: 3, entries: [runEntry(2, 1, 7, "w3-mon")] },
    ],
  };
}

// Minimal HealthWorkout — only the fields the util reads.
function run(
  startISO: string,
  distanceMiles: number,
  durationSeconds: number
): HealthWorkout {
  return {
    workoutId: `run-${startISO}`,
    isRunLike: true,
    startDate: new Date(startISO),
    distanceMiles,
    durationSeconds,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

// Weeks: W1 Mon 1/19, W2 Mon 1/26, W3 Mon 2/2. UTC-noon timestamps keep the
// calendar day stable regardless of the test runner's timezone.
const W1_RUN = run("2026-01-19T12:00:00Z", 5, 5 * 600); // 10:00/mi, matches W1 plan
const W2_RUN = run("2026-01-26T12:00:00Z", 6, 6 * 660); // 11:00/mi, matches W2 plan
// W3 has NO actual run.

describe("buildPlanAdherence — full span", () => {
  it("totals planned/actual miles and runs across ALL weeks", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
    });
    expect(r.weeks).toHaveLength(3); // full span — week 3 included despite no run
    expect(r.totalPlannedMiles).toBeCloseTo(18, 5); // 5 + 6 + 7
    expect(r.totalActualMiles).toBeCloseTo(11, 5); // 5 + 6 + 0
    expect(r.totalPlannedRuns).toBe(3);
    expect(r.totalCompletedRuns).toBe(2); // W1 + W2 matched, W3 unmatched
  });

  it("counts weeksHitTarget at the 85% threshold", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    // W1: 5/5 = 100% hit; W2: 6/6 = 100% hit; W3: 0/7 = miss.
    expect(r.weeksHitTarget).toBe(2);
  });

  it("computes per-week avg pace (null when no runs that week)", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    expect(r.weeks[0].avgPaceSecPerMile).toBeCloseTo(600, 5); // 10:00/mi
    expect(r.weeks[1].avgPaceSecPerMile).toBeCloseTo(660, 5); // 11:00/mi
    expect(r.weeks[2].avgPaceSecPerMile).toBeNull(); // no run in W3
  });

  it("computes overall avg pace weighted across the span", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    // (5*600 + 6*660) / (5 + 6) = (3000 + 3960) / 11 = 632.72…
    expect(r.overallAvgPaceSecPerMile).toBeCloseTo(6960 / 11, 5);
  });

  it("overall avg pace is null for a plan with no runs", () => {
    const r = buildPlanAdherence(makePlan(), [], { maxHr: 185 });
    expect(r.overallAvgPaceSecPerMile).toBeNull();
    expect(r.totalActualMiles).toBe(0);
    expect(r.totalCompletedRuns).toBe(0);
  });
});

describe("buildPlanAdherence — completedRuns counts ANY match, full or partial (isPlanEntryCompleted)", () => {
  it("a partial-quality match (below 85%) adds its mileage AND now counts as completed", () => {
    // W1 planned 5mi; actual run is only 3mi (60%) — matches (day-proximity
    // gate only) and grades "partial". Under the standardized "any match
    // counts" rule (isPlanEntryCompleted), this now counts toward
    // completedRuns too (previously it did not — only "full" counted).
    const shortRun = run("2026-01-19T12:00:00Z", 3, 3 * 600);
    const r = buildPlanAdherence(makePlan(), [shortRun, W2_RUN], { maxHr: 185 });
    expect(r.weeks[0].actualMiles).toBeCloseTo(3, 5);
    expect(r.weeks[0].completedRuns).toBe(1); // partial now counts
    // W1 (partial) + W2 (full) — was 1 (W2 only) before this change.
    expect(r.totalCompletedRuns).toBe(2);
    // actualMiles total is unaffected by the completion grading — still sums
    // matched + bonus mileage regardless of quality.
    expect(r.totalActualMiles).toBeCloseTo(9, 5); // 3 + 6
  });

  it("a run more than 3mi short of planned still matches (partial quality) and now counts as completed", () => {
    // Matches directly (partial quality) via the day-proximity gate; under
    // the new "any match counts" rule this is completed even though it's
    // far short of the planned distance.
    const plan = makePlan();
    const veryShortRun = run("2026-01-19T12:00:00Z", 1, 1 * 600); // planned 5mi, 20%
    const r = buildPlanAdherence(plan, [veryShortRun], { maxHr: 185 });
    expect(r.weeks[0].actualMiles).toBeCloseTo(1, 5);
    expect(r.weeks[0].completedRuns).toBe(1); // was 0 before this change
  });
});

describe("buildPlanAdherence — Phase 2 fixture: before/after count on a mixed week", () => {
  it("3 full + 1 partial + 1 missed → completedRuns is 4 (was 3 when only 'full' counted)", () => {
    // Single week, 5 entries: e1-e3 match at >=85% ("full"), e4 matches below
    // 85% ("partial"), e5 has no actual run at all ("missed"). Before this
    // session's Phase 2 change, buildPlanAdherence counted quality === "full"
    // only, so completedRuns would have been 3. Routed through the canonical
    // isPlanEntryCompleted helper, full AND partial both count → 4.
    const plan: RunningPlan = {
      id: "plan-fixture",
      name: "Fixture Plan",
      planType: "running",
      startDate: "2026-01-19", // Monday
      status: "completed",
      isActive: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      weeks: [
        {
          weekNumber: 1,
          entries: [
            runEntry(0, 1, 5, "e1"), // Mon — full match
            runEntry(0, 2, 5, "e2"), // Tue — full match
            runEntry(0, 3, 5, "e3"), // Wed — full match
            runEntry(0, 4, 5, "e4"), // Thu — partial match (40%)
            runEntry(0, 5, 5, "e5"), // Fri — no run at all (missed)
          ],
        },
      ],
    };
    const runs = [
      run("2026-01-19T12:00:00Z", 5, 5 * 600), // Mon → e1, full
      run("2026-01-20T12:00:00Z", 5, 5 * 600), // Tue → e2, full
      run("2026-01-21T12:00:00Z", 5, 5 * 600), // Wed → e3, full
      run("2026-01-22T12:00:00Z", 2, 2 * 600), // Thu → e4, partial (40%)
      // Fri (e5): intentionally no run.
    ];
    const r = buildPlanAdherence(plan, runs, { maxHr: 185 });
    expect(r.totalPlannedRuns).toBe(5);
    // Pin the AFTER value. Old ("full"-only) behavior would have been 3.
    expect(r.totalCompletedRuns).toBe(4);
  });
});

describe("buildPlanAdherence — throughDate cutoff (Plan Insights parity)", () => {
  it("includes only weeks whose start is on/before throughDate", () => {
    // Cut off mid-plan: only weeks 1 and 2 have started by 2026-01-28.
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-01-28T00:00:00"),
    });
    expect(r.weeks.map((w) => w.weekNumber)).toEqual([1, 2]);
    expect(r.totalPlannedMiles).toBeCloseTo(11, 5); // 5 + 6 (week 3 excluded)
    expect(r.totalActualMiles).toBeCloseTo(11, 5);
  });

  it("regression: elapsed-only totals differ from full span when a future week exists", () => {
    const full = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], { maxHr: 185 });
    const elapsed = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-01-28T00:00:00"),
    });
    expect(full.weeks).toHaveLength(3);
    expect(elapsed.weeks).toHaveLength(2);
    // Planned miles drop by exactly week 3's 7 mi when the cutoff excludes it.
    expect(full.totalPlannedMiles - elapsed.totalPlannedMiles).toBeCloseTo(7, 5);
  });

  it("throughDate on/after the last week includes the whole plan", () => {
    const r = buildPlanAdherence(makePlan(), [W1_RUN, W2_RUN], {
      maxHr: 185,
      throughDate: new Date("2026-03-01T00:00:00"),
    });
    expect(r.weeks).toHaveLength(3);
  });
});

// ─── Week-window date parsing (local vs UTC midnight) ────────────────────────
//
// A plan week's range is [Mon 00:00 local, Sun 23:59:59.999 local], derived
// from `plan.startDate` parsed through `parseLocalDate` (invariant #12). It
// used to be parsed with `new Date("YYYY-MM-DD")` — UTC midnight — which west
// of UTC lands on the SUNDAY EVENING before the plan's Monday, sliding every
// week's window off the calendar: it opened Sun ~19:00–20:00 local and closed
// Sat 23:59:59.999, so the week's own SUNDAY fell into a gap between this
// week's window and the next one's and was counted in NO week at all.
//
// These fixtures build timestamps from LOCAL components so "Sunday morning" is
// genuinely Sunday morning wherever the suite runs. Planned entries sit on
// WEDNESDAYS so the extra runs below are ≥3 days from any entry and cannot be
// claimed by the ±1-day matcher — they exercise the bonus-run window only.

/** 3-week plan starting Mon 2026-01-19, one planned run each Wednesday. */
function makeWedPlan(weekCount = 3): RunningPlan {
  return {
    ...makePlan(),
    weeks: Array.from({ length: weekCount }, (_, i) => ({
      weekNumber: i + 1,
      entries: [runEntry(i, 3, 5, `w${i + 1}-wed`)],
    })),
  };
}

function localRun(
  y: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  distanceMiles: number,
  durationSeconds: number,
  trainingLoadV2: number | null = null
): HealthWorkout {
  return {
    workoutId: `local-${y}-${monthIndex + 1}-${day}-${hour}:${minute}`,
    isRunLike: true,
    startDate: new Date(y, monthIndex, day, hour, minute, 0),
    distanceMiles,
    durationSeconds,
    avgHeartRate: null,
    trainingLoadV2,
  } as unknown as HealthWorkout;
}

const W1 = (r: ReturnType<typeof buildPlanAdherence>) => r.weeks[0];
const W2 = (r: ReturnType<typeof buildPlanAdherence>) => r.weeks[1];

describe("buildPlanAdherence — week window is Mon→Sun LOCAL (was UTC-midnight shifted)", () => {
  it("a Sunday bonus run counts toward its own week, not the next one — and is never dropped", () => {
    // Sun 2026-01-25 is the LAST day of week 1 (Mon 1/19 – Sun 1/25).
    const sundayBonus = localRun(2026, 0, 25, 9, 0, 4, 4 * 600);
    const r = buildPlanAdherence(makeWedPlan(), [sundayBonus], { maxHr: 185 });

    expect(W1(r).actualMiles).toBeCloseTo(4, 6);
    expect(W2(r).actualMiles).toBe(0);
    // Nothing fell through the cracks: the plan's total equals the run.
    expect(r.totalActualMiles).toBeCloseTo(4, 6);
  });

  it("a Sunday run's LOAD and PACE land in its own week too (they were dropped with it)", () => {
    // The mileage of a Sunday run MATCHED to a planned entry was already
    // counted through the match path — but runLoad and avgPace come from the
    // week-window loop, so a shifted window silently lost them.
    const sundayBonus = localRun(2026, 0, 25, 9, 0, 5, 5 * 600, 250);
    const r = buildPlanAdherence(makeWedPlan(), [sundayBonus], { maxHr: 185 });

    expect(W1(r).runLoad).toBe(250);
    expect(W1(r).avgPaceSecPerMile).toBeCloseTo(600, 6);
    expect(W2(r).runLoad).toBe(0);
    expect(W2(r).avgPaceSecPerMile).toBeNull();
  });

  it("a run on the Sunday BEFORE the plan starts is excluded from week 1", () => {
    // Sun 2026-01-18 20:00 — inside the old UTC-shifted window (which opened
    // Sun ~19:00), outside the plan entirely under the local Mon-start window.
    const dayBefore = localRun(2026, 0, 18, 20, 0, 3, 3 * 600, 100);
    const r = buildPlanAdherence(makeWedPlan(), [dayBefore], { maxHr: 185 });

    expect(W1(r).actualMiles).toBe(0);
    expect(W1(r).runLoad).toBe(0);
    expect(r.totalActualMiles).toBe(0);
  });

  it("both week boundaries are inclusive: Mon 00:00 and Sun 23:59 land in the same week", () => {
    const weekOpen = localRun(2026, 0, 19, 0, 0, 2, 2 * 600); // Mon 00:00
    const weekClose = localRun(2026, 0, 25, 23, 59, 3, 3 * 600); // Sun 23:59
    const r = buildPlanAdherence(makeWedPlan(), [weekOpen, weekClose], {
      maxHr: 185,
    });

    expect(W1(r).actualMiles).toBeCloseTo(5, 6);
    expect(W2(r).actualMiles).toBe(0);
  });

  it("weeks stay Monday-aligned across a spring-forward DST transition", () => {
    // US DST starts Sun 2026-03-08. Week 8 of a plan starting Mon 2026-01-19
    // is Mon 3/9 – Sun 3/15, entirely after the transition.
    const sundayAfterDst = localRun(2026, 2, 15, 9, 0, 8, 8 * 600, 300);
    const r = buildPlanAdherence(makeWedPlan(8), [sundayAfterDst], {
      maxHr: 185,
    });

    const w8 = r.weeks[7];
    expect(w8.weekNumber).toBe(8);
    expect(w8.actualMiles).toBeCloseTo(8, 6);
    expect(w8.runLoad).toBe(300);
    expect(r.totalActualMiles).toBeCloseTo(8, 6);
  });

  it("regression: a typical mid-week bonus run keeps its existing week attribution", () => {
    // Sat 2026-01-24, nowhere near a week boundary — inside week 1 under both
    // the old and the new window.
    const saturdayBonus = localRun(2026, 0, 24, 10, 0, 6, 6 * 600, 180);
    const r = buildPlanAdherence(makeWedPlan(), [saturdayBonus], { maxHr: 185 });

    expect(W1(r).actualMiles).toBeCloseTo(6, 6);
    expect(W1(r).runLoad).toBe(180);
    expect(W2(r).actualMiles).toBe(0);
  });

  it("regression: the throughDate cutoff still includes a week starting exactly ON the cutoff", () => {
    // throughDate = Mon 2026-01-26 local midnight — week 2's own start. The
    // cutoff is `weekStart <= throughDate`, so week 2 is in and week 3 is out;
    // moving planStart from Sun-evening to Mon-midnight must not flip this.
    const r = buildPlanAdherence(makeWedPlan(), [], {
      maxHr: 185,
      throughDate: new Date(2026, 0, 26),
    });

    expect(r.weeks.map((w) => w.weekNumber)).toEqual([1, 2]);
  });
});
