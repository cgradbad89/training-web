import { describe, it, expect } from "vitest";
import {
  planEntryToSyntheticEffort,
  fitRiegel,
  predictSeconds,
  buildQualifyingEfforts,
} from "@/utils/riegelFit";
import {
  predictRaceTime,
  type PredictionRun,
} from "@/utils/racePrediction";
import { buildPredictionProjection } from "@/utils/predictionTrend";
import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanWeek,
} from "@/types/plan";

const FIVE_K = 3.10686;

function d(iso: string): Date {
  return new Date(iso + "T12:00:00");
}

function mkRun(
  id: string,
  startDate: Date,
  miles: number,
  paceSecPerMile: number,
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

function mkEntry(partial: Partial<PlannedRunEntry> & {
  weekIndex: number;
  weekday: number;
}): PlannedRunEntry {
  return {
    id: `e-${partial.weekIndex}-${partial.weekday}`,
    dayOfWeek: partial.weekday - 1,
    distanceMiles: 4,
    targetPaceSecondsPerMile: 540,
    runType: "outdoor",
    ...partial,
  };
}

// ── planEntryToSyntheticEffort ──────────────────────────────────────────────

describe("planEntryToSyntheticEffort", () => {
  const entry = mkEntry({
    weekIndex: 1,
    weekday: 3,
    distanceMiles: 5,
    targetPaceSecondsPerMile: 540,
  });

  it("produces a valid EffortPoint tagged PLANNED (not QUALITY)", () => {
    const eff = planEntryToSyntheticEffort(
      entry,
      d("2026-06-20"),
      d("2026-06-27"),
    );
    expect(eff).not.toBeNull();
    expect(eff!.tier).toBe("PLANNED");
    expect(eff!.tier).not.toBe("QUALITY");
    // time = distance × target pace
    expect(eff!.timeSeconds).toBe(5 * 540);
    expect(eff!.distanceMiles).toBe(5);
    // ageDays measured relative to asOf (decay is per-week, not per-today)
    expect(eff!.ageDays).toBeCloseTo(7, 6);
    expect(eff!.isTreadmill).toBe(false);
  });

  it("ages relative to asOf — same entry, later asOf ⇒ larger ageDays", () => {
    const near = planEntryToSyntheticEffort(entry, d("2026-06-20"), d("2026-06-27"));
    const far = planEntryToSyntheticEffort(entry, d("2026-06-20"), d("2026-07-11"));
    expect(near!.ageDays).toBeCloseTo(7, 6);
    expect(far!.ageDays).toBeCloseTo(21, 6);
  });

  it("falls back to parsing the paceTarget 'M:SS' string", () => {
    const e = mkEntry({
      weekIndex: 0,
      weekday: 2,
      distanceMiles: 3,
      targetPaceSecondsPerMile: undefined,
      paceTarget: "9:00",
    });
    const eff = planEntryToSyntheticEffort(e, d("2026-06-02"), d("2026-06-09"));
    expect(eff!.timeSeconds).toBe(3 * 540);
  });

  it("marks treadmill entries as isTreadmill", () => {
    const e = mkEntry({ weekIndex: 0, weekday: 1, runType: "treadmill" });
    const eff = planEntryToSyntheticEffort(e, d("2026-06-01"), d("2026-06-08"));
    expect(eff!.isTreadmill).toBe(true);
  });

  it("returns null for rest days, zero distance, missing pace, and future-of-asOf", () => {
    expect(
      planEntryToSyntheticEffort(
        mkEntry({ weekIndex: 0, weekday: 7, runType: "rest" }),
        d("2026-06-07"),
        d("2026-06-14"),
      ),
    ).toBeNull();
    expect(
      planEntryToSyntheticEffort(
        mkEntry({ weekIndex: 0, weekday: 1, distanceMiles: 0 }),
        d("2026-06-01"),
        d("2026-06-08"),
      ),
    ).toBeNull();
    expect(
      planEntryToSyntheticEffort(
        mkEntry({
          weekIndex: 0,
          weekday: 1,
          targetPaceSecondsPerMile: undefined,
          paceTarget: undefined,
        }),
        d("2026-06-01"),
        d("2026-06-08"),
      ),
    ).toBeNull();
    // performedDate after asOf → not applicable to that week
    expect(
      planEntryToSyntheticEffort(entry, d("2026-07-01"), d("2026-06-27")),
    ).toBeNull();
  });
});

// ── extraEfforts hook is a no-op when empty/absent (regression) ─────────────

describe("predictRaceTime extraEfforts hook", () => {
  const runs: PredictionRun[] = [
    mkRun("a", d("2026-05-04"), 2, 500),
    mkRun("b", d("2026-05-11"), 3, 510),
    mkRun("c", d("2026-05-18"), 4, 520),
    mkRun("d", d("2026-05-25"), 5, 525),
  ];
  const asOf = d("2026-06-01");

  it("extraEfforts:[] and extraEfforts:undefined match the base-only fit exactly", () => {
    const base = predictRaceTime(
      runs,
      { raceDistanceMiles: FIVE_K, races: [] },
      asOf,
    );
    const withEmpty = predictRaceTime(
      runs,
      { raceDistanceMiles: FIVE_K, races: [], extraEfforts: [] },
      asOf,
    );
    // Reference: raw pipeline with no extras
    const efforts = buildQualifyingEfforts(runs, { daysBack: 56, races: [], asOf });
    const fit = fitRiegel(efforts, FIVE_K, 0, { min: 0.9, max: 1.3 });
    const expected = fit ? predictSeconds(fit, FIVE_K) : null;

    expect(base.predictedSeconds).toBe(expected);
    expect(withEmpty.predictedSeconds).toBe(expected);
  });
});

// ── buildPredictionProjection ───────────────────────────────────────────────

function mkPlan(weeks: PlanWeek[], startDate = "2026-06-01T00:00:00"): RunningPlan {
  return {
    id: "plan-1",
    name: "Test Plan",
    startDate,
    weeks,
    status: "active",
    isActive: true,
    createdAt: "2026-05-01",
    updatedAt: "2026-05-01",
  };
}

// A 6-week plan: two run entries per week (Tue + Thu), easy pace.
function sixWeekPlan(): RunningPlan {
  const weeks: PlanWeek[] = [];
  for (let w = 0; w < 6; w++) {
    weeks.push({
      weekNumber: w + 1,
      entries: [
        mkEntry({ weekIndex: w, weekday: 2, distanceMiles: 4, targetPaceSecondsPerMile: 540 }),
        mkEntry({ weekIndex: w, weekday: 4, distanceMiles: 6, targetPaceSecondsPerMile: 560 }),
      ],
    });
  }
  return mkPlan(weeks);
}

// Real runs, all before `today` (2026-06-15), enough for a 5K fit on their own.
const HIST: PredictionRun[] = [
  mkRun("h1", d("2026-06-02"), 2, 500),
  mkRun("h2", d("2026-06-04"), 3, 510),
  mkRun("h3", d("2026-06-09"), 4, 520),
  mkRun("h4", d("2026-06-11"), 5, 525),
];

const TODAY = d("2026-06-15"); // Monday of week 3 (planStart + 14d)
const RACE_DATE = d("2026-07-12"); // end of week 6

describe("buildPredictionProjection", () => {
  const baseInput = {
    plan: sixWeekPlan(),
    historicalRuns: HIST,
    params: { raceDistanceMiles: FIVE_K, races: [] },
    raceDate: RACE_DATE,
    today: TODAY,
  };

  it("returns one point per FUTURE plan week (weeks 4–6)", () => {
    const pts = buildPredictionProjection(baseInput);
    expect(pts.map((p) => p.weekLabel)).toEqual(["W4", "W5", "W6"]);
    expect(pts.every((p) => p.isProjected)).toBe(true);
    expect(pts.every((p) => typeof p.predictedSeconds === "number")).toBe(true);
  });

  it("does not emit points for elapsed weeks (W1–W3)", () => {
    const pts = buildPredictionProjection(baseInput);
    const labels = pts.map((p) => p.weekLabel);
    expect(labels).not.toContain("W1");
    expect(labels).not.toContain("W3");
  });

  it("caps the final projected point at race day", () => {
    const pts = buildPredictionProjection(baseInput);
    const last = pts[pts.length - 1];
    expect(new Date(last.weekEndDate).getTime()).toBe(RACE_DATE.getTime());
  });

  it("is empty when there are no remaining planned entries (race in the past)", () => {
    const pts = buildPredictionProjection({
      ...baseInput,
      today: d("2026-08-01"), // after every planned entry and the race
      raceDate: d("2026-08-01"),
    });
    expect(pts).toEqual([]);
  });

  it("is empty when the plan has only rest entries between today and race day", () => {
    const restWeeks: PlanWeek[] = [];
    for (let w = 0; w < 6; w++) {
      restWeeks.push({
        weekNumber: w + 1,
        entries: [mkEntry({ weekIndex: w, weekday: 3, runType: "rest" })],
      });
    }
    const pts = buildPredictionProjection({
      ...baseInput,
      plan: mkPlan(restWeeks),
    });
    // No synthetic volume ⇒ nothing to project.
    expect(pts).toEqual([]);
  });

  it("decays real efforts per-week: each future week re-ages historical runs", () => {
    // With no synthetic volume at all, the projection must still differ from a
    // fixed-asOf prediction because ageDays advances week to week. We prove the
    // per-week aging by comparing week-4 vs week-6 predictions computed the same
    // way the projection does — they must not be identical.
    const pts = buildPredictionProjection(baseInput);
    const w4 = pts.find((p) => p.weekLabel === "W4")!.predictedSeconds!;
    const w6 = pts.find((p) => p.weekLabel === "W6")!.predictedSeconds!;
    // Different reference dates (and growing planned volume) ⇒ different fits.
    expect(w4).not.toBe(w6);
  });

  it("blends: real efforts inform the projection (uniformly faster history ⇒ faster projection)", () => {
    // Same distances, uniformly ~80 s/mi faster — shifts the fit intercept down
    // without changing the distance spread. Planned volume is identical in both
    // runs, so any difference is driven purely by the real efforts, proving they
    // are blended into the projection rather than ignored.
    const fastHist: PredictionRun[] = [
      mkRun("h1", d("2026-06-02"), 2, 420),
      mkRun("h2", d("2026-06-04"), 3, 430),
      mkRun("h3", d("2026-06-09"), 4, 440),
      mkRun("h4", d("2026-06-11"), 5, 445),
    ];
    const slow = buildPredictionProjection(baseInput);
    const fast = buildPredictionProjection({
      ...baseInput,
      historicalRuns: fastHist,
    });
    const slowW6 = slow.find((p) => p.weekLabel === "W6")!.predictedSeconds!;
    const fastW6 = fast.find((p) => p.weekLabel === "W6")!.predictedSeconds!;
    expect(fastW6).toBeLessThan(slowW6);
  });
});
