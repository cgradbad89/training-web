import { describe, it, expect } from "vitest";
import {
  predictRaceTime,
  buildPredictionTrend,
  type PredictionRun,
} from "@/utils/racePrediction";
import { buildPredictionProjection } from "@/utils/predictionTrend";
import { parseLocalDate } from "@/utils/dates";
import { type RunningPlan } from "@/types/plan";

/**
 * Mon–Sun LOCAL plan-week window — racePrediction.ts + predictionTrend.ts.
 *
 * Both modules used to derive the plan start with `new Date(plan.startDate)`,
 * which parses "YYYY-MM-DD" as UTC midnight. Anywhere west of UTC that lands on
 * the SUNDAY EVENING before the plan's Monday, so every week window ran
 * Sun 20:00 → Sat 23:59:59.999 instead of Mon 00:00 → Sun 23:59:59.999. Each
 * trend point's `asOf` was therefore a full day early and excluded its own
 * week's Sunday — typically the long run. `parseLocalDate` fixes both, matching
 * planAdherence.ts / planMatching.ts (PRD §6 #43).
 *
 * These tests are TIMEZONE-SENSITIVE by construction: west of UTC they fail
 * against the old `new Date(...)` parse and pass against `parseLocalDate`. At
 * UTC (offset 0) the two parses coincide, so the assertions still hold but
 * prove nothing — `SHIFTS_WEST` records that explicitly.
 */

// True when local midnight is behind UTC midnight — i.e. the buggy parse would
// have shifted the plan start back onto the previous calendar day.
const SHIFTS_WEST =
  new Date("2026-06-01").getTime() > parseLocalDate("2026-06-01").getTime();

const FIVE_K = 3.10686;
const PLAN_START = "2026-06-01"; // a Monday

function mkRun(
  id: string,
  startDate: Date,
  miles: number,
  paceSecPerMile: number
): PredictionRun {
  return {
    workoutId: id,
    distanceMiles: miles,
    durationSeconds: miles * paceSecPerMile,
    startDate,
    activityType: "running",
    sourceName: "Apple Watch",
  };
}

/** Local wall-clock Date — never a UTC-parsed date-only string. */
function local(iso: string, h = 12, m = 0): Date {
  const d = parseLocalDate(iso);
  d.setHours(h, m, 0, 0);
  return d;
}

function mkPlan(startISO: string, numWeeks: number): RunningPlan {
  return {
    id: "plan1",
    name: "Window Plan",
    planType: "running",
    startDate: startISO,
    status: "active",
    isActive: true,
    weeks: Array.from({ length: numWeeks }, (_, i) => ({
      weekNumber: i + 1,
      entries: [],
    })),
  } as unknown as RunningPlan;
}

const PARAMS = { raceDistanceMiles: FIVE_K, races: [], goalSeconds: null };

// ─── buildPredictionTrend (racePrediction.ts) ─────────────────────────────────

describe("buildPredictionTrend — Mon–Sun LOCAL week window", () => {
  // Three qualifying runs Tue–Sat of week 1, plus a FOURTH on that week's
  // Sunday. fitRiegel needs ≥4 efforts, so W1 can only be fit if its asOf
  // reaches its own Sunday.
  const WEEK1_RUNS: PredictionRun[] = [
    mkRun("tue", local("2026-06-02"), 2, 500),
    mkRun("thu", local("2026-06-04"), 3, 510),
    mkRun("sat", local("2026-06-06"), 4, 520),
    mkRun("sun", local("2026-06-07", 9), 5, 525), // the week's own Sunday
  ];
  const NOW = local("2026-06-30");

  it("includes week 1's own Sunday run — the buggy Sat-EOD asOf left W1 unfittable", () => {
    const trend = buildPredictionTrend(mkPlan(PLAN_START, 4), WEEK1_RUNS, PARAMS, NOW);
    expect(trend[0].label).toBe("W1");
    expect(trend[0].predictedSeconds).not.toBeNull();
    expect(trend[0].predictedSeconds!).toBeGreaterThan(0);
  });

  it("W1 equals a prediction taken at Sunday 23:59:59.999 local, not Saturday", () => {
    const sundayEod = local("2026-06-07", 23, 59);
    sundayEod.setSeconds(59, 999);
    const saturdayEod = local("2026-06-06", 23, 59);
    saturdayEod.setSeconds(59, 999);

    const trend = buildPredictionTrend(mkPlan(PLAN_START, 4), WEEK1_RUNS, PARAMS, NOW);
    const atSunday = predictRaceTime(WEEK1_RUNS, PARAMS, sundayEod).predictedSeconds;
    const atSaturday = predictRaceTime(WEEK1_RUNS, PARAMS, saturdayEod).predictedSeconds;

    expect(trend[0].predictedSeconds).toBe(atSunday);
    expect(atSaturday).toBeNull(); // only 3 efforts by Saturday
  });

  it("a run at the NEXT Monday 00:30 local stays out of week 1", () => {
    const spill = [...WEEK1_RUNS, mkRun("mon2", local("2026-06-08", 0, 30), 6, 530)];
    const trend = buildPredictionTrend(mkPlan(PLAN_START, 4), spill, PARAMS, NOW);
    const sundayEod = local("2026-06-07", 23, 59);
    sundayEod.setSeconds(59, 999);
    // Week 1 must be blind to the Monday run: identical to the Sunday-EOD fit
    // over the 4-run set that excludes it.
    expect(trend[0].predictedSeconds).toBe(
      predictRaceTime(WEEK1_RUNS, PARAMS, sundayEod).predictedSeconds
    );
  });

  it("week 2 ends on its own Sunday, not the Saturday before it", () => {
    // Week 2 runs Mon 06-08 → Sun 06-14. Adding a run on 06-14 makes the two
    // candidate windows disagree: the buggy Sat-06-13 asOf can't see it.
    const runs = [...WEEK1_RUNS, mkRun("sun2", local("2026-06-14", 9), 6, 530)];
    const trend = buildPredictionTrend(mkPlan(PLAN_START, 4), runs, PARAMS, NOW);

    const w2SunEod = local("2026-06-14", 23, 59);
    w2SunEod.setSeconds(59, 999);
    const w2SatEod = local("2026-06-13", 23, 59);
    w2SatEod.setSeconds(59, 999);

    const atSun = predictRaceTime(runs, PARAMS, w2SunEod).predictedSeconds;
    const atSat = predictRaceTime(runs, PARAMS, w2SatEod).predictedSeconds;
    expect(atSun).not.toBeNull();
    expect(atSat).not.toBeNull();
    // The 06-14 run genuinely moves the fit, so this discriminates the windows.
    expect(atSun).not.toBeCloseTo(atSat!, 3);
    expect(trend[1].predictedSeconds).toBe(atSun);
  });

  it("stays Monday-aligned across a DST transition (Nov 2026, US)", () => {
    // Plan starts 2026-10-26 (Mon); US DST ends Sun 2026-11-01. Week 2 covers
    // Mon 11-02 → Sun 11-08 and must not drift by the DST hour.
    const dstRuns: PredictionRun[] = [
      mkRun("a", local("2026-10-27"), 2, 500),
      mkRun("b", local("2026-10-29"), 3, 510),
      mkRun("c", local("2026-11-03"), 4, 520),
      mkRun("d", local("2026-11-08", 9), 5, 525), // week 2's own Sunday
    ];
    const trend = buildPredictionTrend(
      mkPlan("2026-10-26", 4),
      dstRuns,
      PARAMS,
      local("2026-11-30")
    );
    const w2Eod = local("2026-11-08", 23, 59);
    w2Eod.setSeconds(59, 999);
    expect(trend[1].predictedSeconds).toBe(
      predictRaceTime(dstRuns, PARAMS, w2Eod).predictedSeconds
    );
    expect(trend[1].predictedSeconds).not.toBeNull();
  });

  it("records whether this runner's timezone actually exercises the bug", () => {
    // Documentation, not a gate: west of UTC these assertions discriminate the
    // two parses; at/east of UTC-0 the buggy parse coincides with the fixed one.
    expect(typeof SHIFTS_WEST).toBe("boolean");
  });
});

// ─── Regression: paths that never depended on the plan start ──────────────────

describe("plan-start parse fix leaves plan-independent predictions untouched", () => {
  const RUNS: PredictionRun[] = [
    mkRun("a", local("2026-05-04"), 2, 500),
    mkRun("b", local("2026-05-11"), 3, 510),
    mkRun("c", local("2026-05-18"), 4, 520),
    mkRun("d", local("2026-05-25"), 5, 525),
  ];

  it("predictRaceTime at an explicit asOf is unchanged (the live card's path)", () => {
    // The prediction CARD calls predictRaceTime directly with asOf = now and
    // never touches plan.startDate, so the fix cannot move it.
    const asOf = local("2026-06-01");
    const got = predictRaceTime(RUNS, { raceDistanceMiles: FIVE_K, races: [] }, asOf);
    expect(got.predictedSeconds).not.toBeNull();
    expect(got.fit).not.toBeNull();
    // Re-running with the same asOf is deterministic and plan-agnostic.
    expect(
      predictRaceTime(RUNS, { raceDistanceMiles: FIVE_K, races: [] }, asOf).predictedSeconds
    ).toBe(got.predictedSeconds);
  });

  it("a week with no boundary-day run predicts the same either way", () => {
    // Every run sits Mon–Fri, well clear of the Sat/Sun boundary the bug moved,
    // and inside the 56d window under BOTH asOf candidates — so the shifted
    // window selected the same effort set and the prediction is unaffected.
    const trend = buildPredictionTrend(mkPlan("2026-05-25", 3), RUNS, PARAMS, local("2026-06-20"));
    const w2SunEod = local("2026-06-07", 23, 59);
    w2SunEod.setSeconds(59, 999);
    const w2SatEod = local("2026-06-06", 23, 59);
    w2SatEod.setSeconds(59, 999);
    const atSun = predictRaceTime(RUNS, PARAMS, w2SunEod).predictedSeconds;
    const atSat = predictRaceTime(RUNS, PARAMS, w2SatEod).predictedSeconds;
    expect(atSun).not.toBeNull();
    // Same effort set on both sides of the shift → same number …
    expect(atSat).toBeCloseTo(atSun!, 6);
    // … and the trend reports it.
    expect(trend[1].predictedSeconds).toBeCloseTo(atSun!, 6);
  });
});

// ─── buildPredictionProjection (predictionTrend.ts) ───────────────────────────

function mkPlanWithEntries(startISO: string, numWeeks: number): RunningPlan {
  return {
    id: "plan2",
    name: "Projection Plan",
    planType: "running",
    startDate: startISO,
    status: "active",
    isActive: true,
    weeks: Array.from({ length: numWeeks }, (_, i) => ({
      weekNumber: i + 1,
      entries: [
        {
          id: `w${i}-mon`,
          weekIndex: i,
          weekday: 1, // Monday
          dayOfWeek: 0,
          runType: "outdoor",
          distanceMiles: 5,
          targetPaceSecondsPerMile: 540,
        },
      ],
    })),
  } as unknown as RunningPlan;
}

describe("buildPredictionProjection — Mon–Sun LOCAL week window", () => {
  const RUNS: PredictionRun[] = [
    mkRun("a", local("2026-05-04"), 2, 500),
    mkRun("b", local("2026-05-11"), 3, 510),
    mkRun("c", local("2026-05-18"), 4, 520),
    mkRun("d", local("2026-05-25"), 5, 525),
  ];
  const params = { raceDistanceMiles: FIVE_K, races: [] };

  it("every projected week ends on a local SUNDAY (the buggy window ended Saturday)", () => {
    const raceDate = local("2026-07-05", 23, 59);
    const points = buildPredictionProjection({
      plan: mkPlanWithEntries(PLAN_START, 5),
      historicalRuns: RUNS,
      params,
      raceDate,
      today: local("2026-06-03"),
    });
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      const end = new Date(p.weekEndDate);
      // Only the race-day-capped terminal point may fall on another weekday.
      if (end.getTime() === raceDate.getTime()) continue;
      expect(end.getDay()).toBe(0); // 0 = Sunday, local
      expect(end.getHours()).toBe(23);
    }
  });

  it("a Monday planned entry is dated on the plan's Monday, not the Sunday before", () => {
    // `today` = the Sunday EVENING before the plan starts. With the buggy UTC
    // parse the week-1 Monday entry was dated to THIS Sunday midday, so it read
    // as already past and dropped out of `remaining` — collapsing the whole
    // projection to []. Parsed locally it is still in the future.
    const today = local("2026-05-31", 18); // Sunday 18:00 local
    // ONE week, so the week-1 Monday entry is the ONLY projection candidate —
    // if it is mis-dated to Sunday midday, `remaining` empties and the whole
    // projection collapses to [].
    const points = buildPredictionProjection({
      plan: mkPlanWithEntries(PLAN_START, 1),
      historicalRuns: RUNS,
      params,
      raceDate: local("2026-06-07", 23, 59),
      today,
    });
    expect(points.length).toBeGreaterThan(0);
    expect(points[0].weekLabel).toBe("W1");
  });

  it("the first projected week's label tracks the Monday-aligned grid", () => {
    // today = Wed of week 1 → week 1 is in progress (skipped), so the first
    // PROJECTED week is W2, ending Sun 2026-06-14.
    const points = buildPredictionProjection({
      plan: mkPlanWithEntries(PLAN_START, 4),
      historicalRuns: RUNS,
      params,
      raceDate: local("2026-06-28", 23, 59),
      today: local("2026-06-03"),
    });
    expect(points[0].weekLabel).toBe("W2");
    const end = new Date(points[0].weekEndDate);
    expect(end.getDay()).toBe(0);
    expect(end.getMonth()).toBe(5); // June
    expect(end.getDate()).toBe(14);
  });
});
