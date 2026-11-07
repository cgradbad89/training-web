import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import { researchRace, researchRun } from "../../__tests__/fixtures/workoutRaceResearchFixture";
import {
  MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY,
  assertChronological,
  evaluateSignalsAsOf,
  scoreAgainstOutcomes,
  type QualifiedOutcome,
} from "../signalEvaluation";

const TZ = "America/New_York";
const AS_OF = "2026-10-10T16:00:00.000Z";
const anchor = researchRace("anchor", "2026-08-30", 7871);
const BASELINE = ["2026-07-10", "2026-07-17", "2026-07-24", "2026-08-02", "2026-08-09", "2026-08-16"];
const RECENT = ["2026-09-17", "2026-09-19", "2026-09-25", "2026-09-27", "2026-10-02", "2026-10-04"];

function workouts(extra: Partial<HealthWorkout> = {}): HealthWorkout[] {
  return [
    anchor.workout,
    ...BASELINE.map((d, i) => researchRun(`b${i}`, d, 600, extra)),
    ...RECENT.map((d, i) => researchRun(`r${i}`, d, 576, extra)),
  ];
}
const vo2 = (days: number[], value = 48) => days.map((n) => ({ date: new Date(Date.UTC(2026, 9, 1) - n * 86_400_000).toISOString().slice(0, 10), value }));
const input = (over: Partial<Parameters<typeof evaluateSignalsAsOf>[0]> = {}) => ({
  asOf: AS_OF, timeZone: TZ, races: [anchor.race], workouts: workouts(), overrides: {}, vo2: vo2([1, 5, 9, 12]), ...over,
});
const byId = (row: ReturnType<typeof evaluateSignalsAsOf>, id: string) => row.candidates.find((c) => c.id === id)!;

describe("evaluateSignalsAsOf — availability", () => {
  const row = evaluateSignalsAsOf(input());

  it("reports every candidate with sample sizes and a reason", () => {
    expect(row.candidates.map((c) => c.id)).toEqual(["v2-baseline", "comparable-effort", "same-route-efficiency", "hr-drift-trend", "vo2-28d-median"]);
    for (const c of row.candidates) expect(c.status === "available" || c.reason.length > 0).toBe(true);
  });

  it("only the frozen v2 baseline yields a finish time", () => {
    expect(row.candidates.filter((c) => c.producesFinishTime).map((c) => c.id)).toEqual(["v2-baseline"]);
    expect(byId(row, "v2-baseline").value).toBeGreaterThan(0);
  });

  it("reports availability separately from any accuracy statement", () => {
    expect(JSON.stringify(row)).not.toMatch(/meanAbsoluteError|winner|rank/i);
  });

  it("marks insufficient candidates with reasons instead of values", () => {
    const sparse = evaluateSignalsAsOf(input({ vo2: [], workouts: [anchor.workout] }));
    expect(byId(sparse, "vo2-28d-median")).toMatchObject({ status: "insufficient", value: null });
    expect(byId(sparse, "same-route-efficiency").status).toBe("insufficient");
    expect(byId(sparse, "hr-drift-trend").status).toBe("insufficient");
  });

  it("same-route efficiency becomes available only with ≥3 steady runs in a cluster spanning ≥14 days", () => {
    const six = evaluateSignalsAsOf(input({ workouts: workouts() }));
    expect(byId(six, "same-route-efficiency").status).toBe("available");
    expect(byId(six, "same-route-efficiency").sample.qualifyingClusters).toBe(1);
    const short = evaluateSignalsAsOf(input({ workouts: [anchor.workout, ...RECENT.slice(0, 2).map((d, i) => researchRun(`x${i}`, d))] }));
    expect(byId(short, "same-route-efficiency").status).toBe("insufficient");
  });

  it("HR-drift candidate uses only usable drift from long runs", () => {
    const drifting = workouts().map((w, i) => ({ ...w, durationSeconds: 3000, hrDriftPct: 3 + (i % 3), distanceMiles: 5 }));
    expect(byId(evaluateSignalsAsOf(input({ workouts: drifting })), "hr-drift-trend").status).toBe("available");
    const artifacts = workouts().map((w) => ({ ...w, durationSeconds: 3000, hrDriftPct: 40 }));
    expect(byId(evaluateSignalsAsOf(input({ workouts: artifacts })), "hr-drift-trend").status).toBe("insufficient");
  });
});

describe("evaluateSignalsAsOf — no future leakage", () => {
  const base = evaluateSignalsAsOf(input());

  it("appending data from after the instant changes nothing", () => {
    const future = [researchRun("f1", "2026-10-20"), researchRun("f2", "2026-10-25", 500)];
    const row = evaluateSignalsAsOf(input({ workouts: [...workouts(), ...future], vo2: [...vo2([1, 5, 9, 12]), { date: "2026-10-15", value: 70 }] }));
    expect(row.candidates).toEqual(base.candidates);
    expect(row.leakageExcluded.workouts).toBe(2);
    expect(row.leakageExcluded.vo2).toBe(1);
  });

  it("treats weather fetched after the instant as absent (retrospective recovery is invisible earlier)", () => {
    const recovered = workouts({ weather: { tempF: 60, feelsLikeF: 60, humidity: 50, windMph: 3, dewPointF: 45, conditionCode: 1, conditionText: "Clear", fetchedAt: "2026-10-11T00:00:00.000Z" } });
    const earlier = evaluateSignalsAsOf(input({ workouts: recovered }));
    expect(byId(earlier, "comparable-effort").status).toBe("insufficient");
    expect(earlier.leakageExcluded.weatherFetchedAfter).toBe(BASELINE.length + RECENT.length);
    const later = evaluateSignalsAsOf(input({ workouts: recovered, asOf: "2026-10-12T16:00:00.000Z" }));
    expect(byId(later, "comparable-effort").status).toBe("available");
  });

  it("rejects an invalid instant", () => {
    expect(() => evaluateSignalsAsOf(input({ asOf: "yesterday" }))).toThrow(TypeError);
  });

  it("VO₂ older than 30 days is unavailable, not carried forward", () => {
    const stale = evaluateSignalsAsOf(input({ vo2: vo2([60, 63, 66, 69]) }));
    expect(byId(stale, "vo2-28d-median")).toMatchObject({ status: "insufficient", value: null });
  });
});

describe("scoreAgainstOutcomes — accuracy gate", () => {
  const rows = [evaluateSignalsAsOf(input())];
  const outcome = (date: string, qualified = true): QualifiedOutcome => ({ raceDate: date, finishSeconds: 7800, qualified });

  it("is NOT EVALUABLE with no outcomes and carries no statistics", () => {
    const report = scoreAgainstOutcomes(rows, [], TZ);
    expect(report.status).toBe("NOT EVALUABLE");
    expect(report).not.toHaveProperty("candidates");
    expect(report).not.toHaveProperty("winner");
  });

  it("a single qualified outcome is a sanity check, not an evaluation", () => {
    const report = scoreAgainstOutcomes(rows, [outcome("2027-03-20")], TZ);
    expect(report.status).toBe("NOT EVALUABLE");
    expect(report.status === "NOT EVALUABLE" && report.reason).toMatch(/sanity check, not model selection/);
  });

  it("unqualified outcomes do not count", () => {
    const many = Array.from({ length: 8 }, (_, i) => outcome(`2027-0${(i % 8) + 1}-15`, false));
    expect(scoreAgainstOutcomes(rows, many, TZ).status).toBe("NOT EVALUABLE");
  });

  it("with enough outcomes stays descriptive: no ranking, non-prediction candidates are 'not assessed'", () => {
    const outcomes = Array.from({ length: MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY }, (_, i) => outcome(`2026-1${i}-20`.replace("2026-10", "2026-11").replace("2026-1", "2026-1")));
    const report = scoreAgainstOutcomes(rows, [outcome("2026-11-20"), outcome("2027-01-20"), outcome("2027-02-20"), outcome("2027-03-20"), outcome("2027-04-20")], TZ);
    expect(outcomes).toHaveLength(MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY);
    expect(report.status).toBe("DESCRIPTIVE ONLY");
    if (report.status !== "DESCRIPTIVE ONLY") return;
    expect(report).not.toHaveProperty("winner");
    const v2 = report.candidates.find((c) => c.id === "v2-baseline")!;
    expect(v2.scoredRows).toBe(1);
    expect(v2.meanAbsoluteErrorSeconds).not.toBeNull();
    const vo2c = report.candidates.find((c) => c.id === "vo2-28d-median")!;
    expect(vo2c.meanAbsoluteErrorSeconds).toBeNull();
    expect(vo2c.note).toMatch(/not zero error/);
  });

  it("only scores against outcomes strictly later than the instant", () => {
    const outcomes = [outcome("2026-10-10"), outcome("2026-10-09"), outcome("2026-10-01"), outcome("2026-09-01"), outcome("2026-08-01")];
    const report = scoreAgainstOutcomes(rows, outcomes, TZ);
    expect(report.status === "DESCRIPTIVE ONLY" && report.candidates.find((c) => c.id === "v2-baseline")!.scoredRows).toBe(0);
  });

  it("assertChronological refuses same-day and earlier outcomes", () => {
    expect(() => assertChronological(AS_OF, TZ, outcome("2026-10-10"))).toThrow(RangeError);
    expect(() => assertChronological(AS_OF, TZ, outcome("2026-10-11"))).not.toThrow();
  });
});
