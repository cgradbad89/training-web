import { describe, expect, it } from "vitest";
import { estimateRaceDayForecast, FORECAST_POLICY, plannedRunsBetween } from "../raceDayForecast";
import { estimateHybridHalfMarathon } from "../hybridPerformance";
import { predictRaceTime, type PredictionRun } from "@/utils/racePrediction";
import { planEntryToSyntheticEffort } from "@/utils/riegelFit";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import { hybridAthlete, makeRun } from "../../__tests__/fixtures/hybridFixture";

const RACE_DATE = "2027-03-20";
const entry = (id: string, weekIndex: number, weekday: number, distanceMiles: number, extra: Partial<PlannedRunEntry> = {}): PlannedRunEntry =>
  ({ id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles, ...extra });
function plan(perWeek: { tue: number; thu: number; sat: (w: number) => number }, weeks = 19): RunningPlan {
  return { id: "p", name: "Spring HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "2026-11-01", updatedAt: "2026-11-01",
    weeks: Array.from({ length: weeks }, (_, w) => ({ weekNumber: w + 1, entries: [
      entry(`t${w}`, w, 2, perWeek.tue), entry(`th${w}`, w, 4, perWeek.thu), entry(`s${w}`, w, 6, perWeek.sat(w)),
      ...(w === weeks - 1 ? [entry("race", w, 6, 13.1, { workoutType: "race" })] : []), entry(`r${w}`, w, 7, 0, { runType: "rest" })] })) };
}
const PLAN = plan({ tue: 4, thu: 5, sat: w => Math.min(12, 8 + w * 0.3) });
const athlete = (o = {}) => hybridAthlete({ longRunMiles: 8, ...o });
const forecast = (o = {}, p: RunningPlan | null = PLAN, race = RACE_DATE) => estimateRaceDayForecast(athlete(o), { raceDate: race, plan: p });

describe("separate race-day forecast (3T.3/3T.4)", () => {
  it("produces a provisional, labelled, non-validated number kept apart from current capability", () => {
    const f = forecast(), h = estimateHybridHalfMarathon(athlete());
    expect(f.version).toBe("experimental-raceday-forecast-v1"); expect(f.status).toBe("provisional"); expect(f.validated).toBe(false);
    expect(f.currentCapabilitySeconds).toBe(h.seconds); expect(f.seconds).not.toBeNull();
    expect(f.daysToRace).toBe(133); expect(f.minutes).toBe(Math.round(f.seconds! / 60));
    expect(f.scenarios.find(s => s.central)!.id).toBe("plan_at_historical_adherence");
    expect(f.scenarioRange!.fastSeconds).toBeLessThanOrEqual(f.seconds!); expect(f.scenarioRange!.slowSeconds).toBeGreaterThanOrEqual(f.seconds!);
    expect(f.scenarioRange!.basis).toMatch(/not a statistical interval/);
  });
  it("states its assumptions: planned work is not adaptation, no fitness gain, taper is context only, weather and course unknown", () => {
    const f = forecast();
    expect(f.assumptions).toEqual({ plannedTrainingTreatedAs: "planned_actions_not_adaptations", fitnessGainAssumed: 0, taper: "context_only_no_numeric_credit",
      weather: "climatology_unavailable", course: "unknown" });
    const taper = f.scenarios.find(s => s.id === "population_taper_context")!;
    expect(taper.seconds).toBeNull(); expect(taper.fraction).toBe(0); expect(taper.basis).toMatch(/standardized/);
    expect(f.caveats.join(" ")).toMatch(/Weather and course conditions are unknown/);
    expect(forecast({}, PLAN, "2026-11-12").assumptions.weather).toBe("forecast_unavailable");
  });
  it("widens with the horizon by a documented allowance and discloses that the evidence will be stale on race day", () => {
    const f = forecast();
    expect(f.horizonAllowanceFraction).toBeCloseTo(FORECAST_POLICY.driftPerSqrtMonth * Math.sqrt(133 / 30), 10);
    expect(f.evidenceAgeAtRaceDays!).toBeGreaterThan(180);
    expect(f.uncertainty.join(" ")).toMatch(/older than the 180-day currency limit/);
    const near = forecast({}, PLAN, "2026-12-12");
    expect(near.horizonAllowanceFraction).toBeLessThan(f.horizonAllowanceFraction);
  });
  it("does not assume speed gains from planned training: the forecast never beats current capability by more than the bounded endurance effect", () => {
    const f = forecast();
    expect(f.seconds!).toBeGreaterThan(f.currentCapabilitySeconds! * (1 - 0.0151)); expect(f.seconds!).toBeLessThan(f.currentCapabilitySeconds! * 1.0151);
  });
  it("planned easy volume does not drag the forecast slower (unlike the legacy synthetic-effort projection)", () => {
    const light = forecast({}, plan({ tue: 4, thu: 4, sat: () => 8 })), heavy = forecast({}, plan({ tue: 6, thu: 6, sat: () => 8 }));
    expect(heavy.seconds!).toBeLessThanOrEqual(light.seconds!);
    expect(Math.abs(heavy.seconds! / light.seconds! - 1)).toBeLessThan(0.015);
  });
  it("evaluation of the existing path: planned easy sessions make the legacy projection steadily slower with no change in the athlete", () => {
    const a = athlete();
    const runs: PredictionRun[] = a.workouts.map(w => ({ workoutId: w.workoutId, distanceMiles: w.distanceMiles, durationSeconds: w.durationSeconds, startDate: w.startDate, activityType: "running", sourceName: "Apple Watch" }));
    const races = a.races.map(r => ({ raceDate: r.raceDate, distanceMiles: 13.109 }));
    const now = new Date("2026-11-07T12:00:00");
    const at = (weeks: number) => {
      const asOf = new Date(now.getTime() + weeks * 7 * 86_400_000), extra = [];
      for (let w = 0; w < weeks; w++) for (const [dow, miles] of [[1, 4], [3, 5], [5, 10]] as const) {
        const e = planEntryToSyntheticEffort({ id: "x", weekIndex: 0, weekday: 1, dayOfWeek: 0, distanceMiles: miles, targetPaceSecondsPerMile: miles === 10 ? 690 : 650 },
          new Date(now.getTime() + (w * 7 + dow) * 86_400_000), asOf, 650);
        if (e) extra.push(e);
      }
      return predictRaceTime(runs, { raceDistanceMiles: 13.109, races, extraEfforts: extra }, asOf).predictedSeconds!;
    };
    const series = [0, 2, 6, 10, 16].map(at);
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThan(series[i - 1]);
    expect(series[4] / series[0]).toBeGreaterThan(1.05);
    // The new forecast for the same athlete is independent of planned easy entries beyond bounded endurance preparation.
    const flat = [forecast({}, plan({ tue: 4, thu: 5, sat: () => 8 }, 4)).seconds!, forecast({}, plan({ tue: 4, thu: 5, sat: () => 8 }, 19)).seconds!];
    expect(Math.abs(flat[1] / flat[0] - 1)).toBeLessThan(0.015);
  });
  it("with no plan, an incomplete plan or unknown adherence it still forecasts conservatively and says so", () => {
    const none = forecast({}, null);
    expect(none.status).toBe("provisional"); expect(none.plan).toBeNull();
    expect(none.scenarios.find(s => s.id === "plan_completed_as_planned")!.seconds).toBeNull();
    expect(Math.abs(none.seconds! / none.currentCapabilitySeconds! - 1)).toBeLessThan(1e-9);
    const sparse = forecast({}, plan({ tue: 3, thu: 3, sat: () => 5 }, 3));
    expect(sparse.plan!.usedAdherence).toBe(FORECAST_POLICY.unknownAdherence);
    expect(sparse.uncertainty.join(" ")).toMatch(/no matched history; default/);
  });
  it("a plan that completes less is worth less: lapsing never beats completing, and adherence is capped at 85%", () => {
    const f = forecast({ longRunMiles: 6, runsPerWeek: 3 });
    const full = f.scenarios.find(s => s.id === "plan_completed_as_planned")!.seconds!, lapse = f.scenarios.find(s => s.id === "training_lapses")?.seconds ?? null;
    if (lapse !== null) expect(lapse).toBeGreaterThanOrEqual(full);
    expect(f.plan!.usedAdherence!).toBeLessThanOrEqual(FORECAST_POLICY.maximumAdherence);
  });
  it("withholds, with the precise cause, when it cannot be supported", () => {
    expect(forecast({}, PLAN, "2026-11-01")).toMatchObject({ status: "withheld", withheldCause: "race_date_invalid_or_past", seconds: null });
    expect(forecast({}, PLAN, "not-a-date")).toMatchObject({ status: "withheld", withheldCause: "race_date_invalid_or_past" });
    expect(forecast({}, PLAN, "2027-12-01")).toMatchObject({ status: "withheld", withheldCause: "horizon_too_long" });
    const none = estimateRaceDayForecast(hybridAthlete({ raceDate: null, longRunMiles: 8 }), { raceDate: RACE_DATE, plan: PLAN });
    expect(none).toMatchObject({ status: "withheld", withheldCause: "current_capability_unavailable", seconds: null, currentCapabilityStatus: "unavailable" });
    const unprepared = estimateRaceDayForecast(hybridAthlete({ raceDate: null, strong: [{ date: "2026-10-10", miles: 4.5, pace: 520, hr: 172 }, { date: "2026-10-24", miles: 4.5, pace: 520, hr: 172 }], longRunMiles: 3, easyMiles: 2.5, runsPerWeek: 2 }), { raceDate: RACE_DATE, plan: PLAN });
    expect(unprepared).toMatchObject({ status: "withheld", withheldCause: "insufficient_endurance_basis" });
  });
  it("unknown endurance preparation (too few recent weeks) withholds the forecast instead of projecting from nothing", () => {
    const f = estimateRaceDayForecast(hybridAthlete({ longRunMiles: 8, trainingEnd: "2026-09-25" }), { raceDate: RACE_DATE, plan: PLAN });
    expect(f).toMatchObject({ status: "withheld", withheldCause: "insufficient_endurance_basis", seconds: null });
    expect(f.currentCapabilityStatus).toBe("provisional");
  });
  it("an expired race leaves no forecast; strong contemporary efforts restore one", () => {
    const expired = estimateRaceDayForecast(hybridAthlete({ raceDate: "2026-04-01", longRunMiles: 8 }), { raceDate: RACE_DATE, plan: PLAN });
    expect(expired.status).toBe("withheld");
    const strong = estimateRaceDayForecast(hybridAthlete({ raceDate: "2026-04-01", longRunMiles: 8, strong: [{ date: "2026-10-10", miles: 6, pace: 560, hr: 172 }, { date: "2026-10-24", miles: 6.5, pace: 555, hr: 172 }] }), { raceDate: RACE_DATE, plan: PLAN });
    expect(strong.status).toBe("provisional");
  });
  it("plan extraction excludes rest days, the race itself, zero distances and entries outside the window", () => {
    const runs = plannedRunsBetween(PLAN, "2026-11-07", RACE_DATE);
    expect(runs.every(r => r.date > "2026-11-07" && r.date < RACE_DATE)).toBe(true);
    expect(runs.some(r => r.entry.workoutType === "race" || r.entry.runType === "rest")).toBe(false);
    expect(plannedRunsBetween(null, "2026-11-07", RACE_DATE)).toEqual([]);
  });
  it("later workouts and a changed plan after the cutoff cannot leak into an earlier forecast; results are deterministic", () => {
    const asOf = "2026-11-07T17:00:00.000Z";
    const a = estimateRaceDayForecast(hybridAthlete({ longRunMiles: 8, asOf }), { raceDate: RACE_DATE, plan: PLAN });
    const withLater = hybridAthlete({ longRunMiles: 8, asOf }); withLater.workouts.push(makeRun({ id: "later", date: "2026-11-09", pace: 400, hr: 190, minutes: 60, tempF: 50 }));
    expect(estimateRaceDayForecast(withLater, { raceDate: RACE_DATE, plan: PLAN })).toEqual(a);
    expect(() => estimateRaceDayForecast({ ...athlete(), asOf: "nope" }, { raceDate: RACE_DATE, plan: PLAN })).toThrow(TypeError);
  });
});
