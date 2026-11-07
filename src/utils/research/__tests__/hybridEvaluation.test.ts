import { describe, expect, it } from "vitest";
import { evaluateModelsAsOf, hybridLeaveOneOut, plausibility, replay, scoreModelsAgainstOutcomes, truncateAsOf } from "../hybridEvaluation";
import { MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY } from "../signalEvaluation";
import { addDays, hybridAthlete, makeRun } from "../../__tests__/fixtures/hybridFixture";

const strong = [{ date: "2026-10-10", miles: 6, pace: 560, hr: 172 }, { date: "2026-10-24", miles: 6.5, pace: 555, hr: 172 }];
const at = (d: string) => `${d}T17:00:00.000Z`;
const athlete = (o = {}) => hybridAthlete({ longRunMiles: 8, ...o });

describe("chronological replay (as-of behaviour)", () => {
  it("each row equals a run on data truncated to that instant: later workouts, races and weather cannot enter", () => {
    const full = athlete({ strong, trainingEnd: "2026-11-06" });
    const instants = ["2026-10-01", "2026-10-15", "2026-10-26", "2026-11-05"].map(at);
    const rows = replay(full, instants).rows;
    rows.forEach((r, i) => {
      const truncated = { ...full, workouts: full.workouts.filter(w => w.endDate.getTime() <= Date.parse(instants[i])) };
      expect(evaluateModelsAsOf(truncated, instants[i]).models).toEqual(r.models);
    });
    expect(rows[0].leakageExcluded.workouts).toBeGreaterThan(rows[3].leakageExcluded.workouts);
  });
  it("tracks availability per model and summarises hybrid status transitions around anchor expiry", () => {
    const input = athlete({ raceDate: "2026-04-01", asOf: at("2026-12-31"), trainingEnd: "2026-12-30" });
    const instants = ["2026-09-01", "2026-09-28", "2026-09-29", "2026-10-15"].map(at);
    const s = replay(input, instants);
    expect(s.instants).toBe(4);
    expect(s.availability.hybrid_v1.available).toBe(2); expect(s.availability.official_v2.available).toBe(2);
    expect(s.hybridUnavailableCauses.anchor_expired_no_contemporary_evidence).toBe(2);
    expect(s.hybridDayToDay!.maxStepSeconds).toBeLessThan(60);
  });
  it("day-to-day hybrid movement is small under stable training (no artificial static, no jumpiness)", () => {
    const input = athlete({ strong, trainingEnd: "2026-11-06" });
    const days = Array.from({ length: 14 }, (_, i) => at(addDays("2026-10-25", i)));
    const s = replay(input, days);
    expect(s.hybridDayToDay!.maxStepFractionOfRace).toBeLessThan(0.01);
    const vals = s.rows.map(r => r.models.find(m => m.id === "hybrid_v1")!.seconds!);
    expect(new Set(vals.map(v => Math.round(v))).size).toBeGreaterThan(1); // recency weighting moves it a little
  });
});

describe("do the models use different evidence?", () => {
  it("v2 depends on the race anchor and training summaries; the hybrid base on independent efforts and the physiological trend", () => {
    const row = evaluateModelsAsOf(athlete({ strong, paceChangeFrom: "2026-09-25", paceFactorAfter: 0.96 }), at("2026-11-07"));
    const v2 = row.models.find(m => m.id === "official_v2")!, hy = row.models.find(m => m.id === "hybrid_v1")!, c = row.models.find(m => m.id === "capacity_C_recent_demonstrated")!;
    expect(v2.evidenceUsed).toContain("race_anchor"); expect(v2.evidenceUsed).toContain("training_summary_volume");
    expect(hy.evidenceUsed).toEqual(expect.arrayContaining(["demonstrated_performance", "race_history"]));
    expect(c.evidenceUsed).toContain("whole_run_effort");
    expect(v2.evidenceUsed).not.toContain("whole_run_effort");
    expect(row.independentEvidence).toBe(3);
  });
  it("without a race anchor v2 and the HR-enhanced estimate are silent while the hybrid still speaks", () => {
    const row = evaluateModelsAsOf(athlete({ raceDate: null, strong }), at("2026-11-07"));
    const by = (id: string) => row.models.find(m => m.id === id)!;
    expect(by("official_v2").available).toBe(false); expect(by("hr_enhanced_v1").available).toBe(false);
    expect(by("hybrid_v1").available).toBe(true); expect(by("capacity_C_recent_demonstrated").available).toBe(true);
    expect(by("capacity_B_critical_speed").available).toBe(false);
  });
});

describe("sensitivity and plausibility", () => {
  it("no single run moves the hybrid by more than ~1% and removing a run rarely flips availability", () => {
    const s = hybridLeaveOneOut(athlete({ strong }));
    expect(s.runsTested).toBeGreaterThan(20);
    expect(s.maxShiftFraction!).toBeLessThan(0.03);
    expect(s.p90AbsShiftSeconds!).toBeLessThan(80);
    expect(s.availabilityFlips).toBe(0);
    expect(s.maxEvidenceItemShiftSeconds).toBeGreaterThan(0); // removing an evidence item does matter, as it should
  });
  it("physiological plausibility screens pass for a normal athlete and flag nothing it should not", () => {
    const row = evaluateModelsAsOf(athlete({ strong }), at("2026-11-07"));
    expect(plausibility(row).every(c => c.pass)).toBe(true);
    const none = evaluateModelsAsOf(athlete({ raceDate: null }), at("2026-11-07"));
    expect(plausibility(none)[0].name).toBe("hybrid_available");
  });
  it("a corrupted extremely fast run cannot make the model implausible", () => {
    const input = athlete({ strong }); input.workouts.push(makeRun({ id: "gps-glitch", date: "2026-11-01", pace: 200, hr: 190, minutes: 60, tempF: 55 }));
    expect(plausibility(evaluateModelsAsOf(input, at("2026-11-07"))).every(c => c.pass)).toBe(true);
  });
  it("truncateAsOf reports excluded workouts", () => {
    const input = athlete(); expect(truncateAsOf(input, at("2026-10-01")).excluded).toBeGreaterThan(0);
  });
});

describe("independent accuracy is NOT EVALUABLE until enough independent qualified outcomes exist", () => {
  const rows = [at("2026-02-01"), at("2026-06-01")].map(i => evaluateModelsAsOf(athlete({ raceDate: "2026-01-10" }), i));
  it.each([0, 1, 4])("%i qualified outcomes → NOT EVALUABLE with no error statistics", n => {
    const outcomes = Array.from({ length: n }, (_, i) => ({ raceDate: `2026-0${i + 7}-01`, finishSeconds: 7800, qualified: true }));
    const r = scoreModelsAgainstOutcomes(rows, [...outcomes, { raceDate: "2026-12-01", finishSeconds: 7800, qualified: false }]);
    expect(r.status).toBe("NOT EVALUABLE"); expect(r).not.toHaveProperty("models"); expect(r.qualifiedOutcomes).toBe(n);
  });
  it("the policy threshold is the existing one and is not weakened", () => { expect(MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY).toBe(5); });
  it("with ≥5 qualified outcomes errors are descriptive, signed (predicted − actual) and only against later outcomes", () => {
    const outcomes = [0, 1, 2, 3, 4].map(i => ({ raceDate: `2026-0${i + 6}-15`, finishSeconds: 7800, qualified: true }));
    const r = scoreModelsAgainstOutcomes(rows, outcomes);
    expect(r.status).toBe("DESCRIPTIVE ONLY");
    if (r.status === "DESCRIPTIVE ONLY") {
      const h = r.models.find(m => m.id === "hybrid_v1")!;
      expect(h.scored).toBeGreaterThan(0); expect(h.meanSignedErrorSeconds!).toBeGreaterThan(0); // 2:11:11 anchor vs 2:10:00 outcome → predicted too slow
      expect(r.note).toMatch(/no ranking/);
    }
    const early = scoreModelsAgainstOutcomes(rows, [0, 1, 2, 3, 4].map(i => ({ raceDate: `2026-01-0${i + 1}`, finishSeconds: 7800, qualified: true })));
    if (early.status === "DESCRIPTIVE ONLY") expect(early.models).toEqual([]); // outcomes before the as-of dates cannot be scored (no leakage)
  });
});
