import { describe, expect, it } from "vitest";
import {
  buildActualVsPlannedWeeks,
  distanceDelta,
  paceDelta,
  actualPaceFor,
} from "@/utils/planActualTable";
import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanRunType,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

const MINUS = "−"; // − true minus sign
const EN_DASH = "–"; // – range separator

// ─── Fixtures ────────────────────────────────────────────────────────────────

function runEntry(opts: {
  id: string;
  weekIndex: number;
  weekday: number;
  distanceMiles: number;
  targetPaceSecondsPerMile?: number;
  runType?: PlanRunType;
}): PlannedRunEntry {
  return {
    id: opts.id,
    weekIndex: opts.weekIndex,
    weekday: opts.weekday,
    dayOfWeek: opts.weekday - 1,
    distanceMiles: opts.distanceMiles,
    targetPaceSecondsPerMile: opts.targetPaceSecondsPerMile,
    runType: opts.runType ?? "outdoor",
  };
}

// Minimal HealthWorkout — only the fields the builder reads. UTC-noon
// timestamps keep the calendar day stable regardless of the runner's timezone.
function run(opts: {
  startISO: string;
  distanceMiles: number;
  durationSeconds?: number;
  avgPaceSecPerMile?: number | null;
  avgHeartRate?: number | null;
}): HealthWorkout {
  return {
    workoutId: `run-${opts.startISO}`,
    isRunLike: true,
    startDate: new Date(opts.startISO),
    distanceMiles: opts.distanceMiles,
    durationSeconds: opts.durationSeconds ?? 0,
    avgPaceSecPerMile: opts.avgPaceSecPerMile ?? null,
    avgHeartRate: opts.avgHeartRate ?? null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

// 2-week plan starting Mon 2026-01-19.
//   W1: Mon 5mi@600 (matched, faster actual), Wed 3mi@540 (matched, exact),
//       Fri 4mi@600 (no run → missed), Sun rest.
//   W2: Mon 6mi@600 (future → upcoming).
function makePlan(): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          runEntry({ id: "w1-mon", weekIndex: 0, weekday: 1, distanceMiles: 5, targetPaceSecondsPerMile: 600 }),
          runEntry({ id: "w1-wed", weekIndex: 0, weekday: 3, distanceMiles: 3, targetPaceSecondsPerMile: 540 }),
          runEntry({ id: "w1-fri", weekIndex: 0, weekday: 5, distanceMiles: 4, targetPaceSecondsPerMile: 600 }),
          runEntry({ id: "w1-sun", weekIndex: 0, weekday: 7, distanceMiles: 0, runType: "rest" }),
        ],
      },
      {
        weekNumber: 2,
        entries: [
          runEntry({ id: "w2-mon", weekIndex: 1, weekday: 1, distanceMiles: 6, targetPaceSecondsPerMile: 600 }),
        ],
      },
    ],
  };
}

// Mon run is FASTER than its 600 target (590); Wed run is exact (540).
const MON_RUN = run({ startISO: "2026-01-19T12:00:00Z", distanceMiles: 5, durationSeconds: 2950, avgPaceSecPerMile: 590, avgHeartRate: 150 });
const WED_RUN = run({ startISO: "2026-01-21T12:00:00Z", distanceMiles: 3, durationSeconds: 1620, avgPaceSecPerMile: 540, avgHeartRate: null });

// Reference "now" = Sat 2026-01-24 (local). W1's Fri is past (missed); W2's Mon
// is future (upcoming).
const NOW = new Date(2026, 0, 24, 12, 0, 0);

// ─── buildActualVsPlannedWeeks ───────────────────────────────────────────────

describe("buildActualVsPlannedWeeks — happy path & subtotals", () => {
  it("groups all plan weeks with correct labels, date ranges, and indices", () => {
    const weeks = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].weekIndex).toBe(0);
    expect(weeks[0].weekLabel).toBe("Week 1");
    expect(weeks[0].dateRangeLabel).toBe(`Jan 19${EN_DASH}25`);
    expect(weeks[1].weekLabel).toBe("Week 2");
    // Cross-month range spells out both months.
    expect(weeks[1].dateRangeLabel).toBe(`Jan 26${EN_DASH}Feb 1`);
  });

  it("computes distance subtotals (planned counts missed runs; actual sums matched only)", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    // planned 5 + 3 + 4 (+ rest 0) = 12; actual 5 + 3 (Fri unmatched) = 8.
    expect(w1.plannedDistanceTotal).toBeCloseTo(12, 5);
    expect(w1.actualDistanceTotal).toBeCloseTo(8, 5);
  });

  it("computes distance-weighted average paces, null-safe", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    // planned: (600*5 + 540*3 + 600*4) / 12 = 7020/12 = 585
    expect(w1.plannedPaceAvgSecPerMile).toBeCloseTo(585, 5);
    // actual: (590*5 + 540*3) / 8 = 4570/8 = 571.25
    expect(w1.actualPaceAvgSecPerMile).toBeCloseTo(571.25, 5);
  });

  it("populates a matched (met) row with actual distance, pace, and run-level HR", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    const mon = w1.rows[0];
    expect(mon).toMatchObject({
      weekday: "Mon",
      dateLabel: "Jan 19",
      runType: "outdoor",
      status: "met",
      plannedDistanceMiles: 5,
      actualDistanceMiles: 5,
      plannedPaceSecPerMile: 600,
      actualPaceSecPerMile: 590,
      actualAvgHr: 150,
    });
    // HR is null when the matched run has none.
    expect(w1.rows[1].actualAvgHr).toBeNull();
  });

  it("the matched row's actual pace is faster than planned (drives the inverted delta)", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    const mon = w1.rows[0];
    const d = paceDelta(mon.plannedPaceSecPerMile, mon.actualPaceSecPerMile);
    expect(d).not.toBeNull();
    expect(d!.tone).toBe("positive"); // faster = good
    expect(d!.label).toBe(`${MINUS}0:10`); // 590 − 600 = −10s
  });
});

describe("buildActualVsPlannedWeeks — non-matched row states", () => {
  it("marks a past unmatched planned run as missed with null actuals", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    const fri = w1.rows[2];
    expect(fri.status).toBe("missed");
    expect(fri.plannedDistanceMiles).toBe(4); // still shows the plan
    expect(fri.actualDistanceMiles).toBeNull();
    expect(fri.actualPaceSecPerMile).toBeNull();
    expect(fri.actualAvgHr).toBeNull();
  });

  it("marks a rest entry as status 'rest' with all planned/actual values null", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    const sun = w1.rows[3];
    expect(sun.status).toBe("rest");
    expect(sun.runType).toBe("rest");
    expect(sun.plannedDistanceMiles).toBeNull();
    expect(sun.plannedPaceSecPerMile).toBeNull();
    expect(sun.actualDistanceMiles).toBeNull();
  });

  it("marks a future unmatched planned run as upcoming with null actuals", () => {
    const [, w2] = buildActualVsPlannedWeeks(makePlan(), [MON_RUN, WED_RUN], NOW);
    const mon = w2.rows[0];
    expect(mon.status).toBe("upcoming");
    expect(mon.plannedDistanceMiles).toBe(6);
    expect(mon.actualDistanceMiles).toBeNull();
  });

  it("with no actual runs, actual totals are 0 and actual avg pace is null", () => {
    const [w1] = buildActualVsPlannedWeeks(makePlan(), [], NOW);
    expect(w1.actualDistanceTotal).toBe(0);
    expect(w1.actualPaceAvgSecPerMile).toBeNull();
    expect(w1.plannedDistanceTotal).toBeCloseTo(12, 5); // planned unaffected
  });
});

// ─── delta formatters (conditional-formatting source of truth) ───────────────

describe("paceDelta — faster pace is GOOD (inverted)", () => {
  it("faster actual → positive tone, leading minus", () => {
    const d = paceDelta(600, 593)!;
    expect(d.tone).toBe("positive");
    expect(d.label).toBe(`${MINUS}0:07`);
  });

  it("slower actual → negative tone, leading plus", () => {
    const d = paceDelta(600, 612)!;
    expect(d.tone).toBe("negative");
    expect(d.label).toBe("+0:12");
  });

  it("equal pace → neutral", () => {
    const d = paceDelta(600, 600)!;
    expect(d.tone).toBe("neutral");
    expect(d.label).toBe("0:00");
  });

  it("returns null when a side is missing or non-positive", () => {
    expect(paceDelta(null, 600)).toBeNull();
    expect(paceDelta(600, null)).toBeNull();
    expect(paceDelta(0, 600)).toBeNull();
  });
});

describe("distanceDelta — longer is GOOD", () => {
  it("actual over planned → positive", () => {
    const d = distanceDelta(5, 5.5)!;
    expect(d.tone).toBe("positive");
    expect(d.label).toBe("+0.5");
  });

  it("actual under planned → negative with true minus", () => {
    const d = distanceDelta(5, 4.5)!;
    expect(d.tone).toBe("negative");
    expect(d.label).toBe(`${MINUS}0.5`);
  });

  it("exact match → neutral", () => {
    const d = distanceDelta(5, 5)!;
    expect(d.tone).toBe("neutral");
    expect(d.label).toBe("0.0");
  });

  it("returns null when a side is missing", () => {
    expect(distanceDelta(null, 5)).toBeNull();
    expect(distanceDelta(5, null)).toBeNull();
  });
});

describe("actualPaceFor — stored pace, fallback, and zero-distance guard", () => {
  it("prefers the stored avgPaceSecPerMile", () => {
    expect(
      actualPaceFor(run({ startISO: "2026-01-19T12:00:00Z", distanceMiles: 5, durationSeconds: 3000, avgPaceSecPerMile: 590 }))
    ).toBe(590);
  });

  it("falls back to durationSeconds / distanceMiles when pace is absent", () => {
    expect(
      actualPaceFor(run({ startISO: "2026-01-19T12:00:00Z", distanceMiles: 5, durationSeconds: 3000, avgPaceSecPerMile: null }))
    ).toBeCloseTo(600, 5);
  });

  it("returns null for a zero-distance run (no Infinity pace)", () => {
    expect(
      actualPaceFor(run({ startISO: "2026-01-19T12:00:00Z", distanceMiles: 0, durationSeconds: 1800, avgPaceSecPerMile: null }))
    ).toBeNull();
  });
});
