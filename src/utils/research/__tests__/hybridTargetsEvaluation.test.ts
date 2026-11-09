import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEPTEMBER_RACE, addDays, fitnessWorld, FIT_TZ } from "../../__tests__/fixtures/currentFitnessFixture";
import { distanceRace } from "../../__tests__/fixtures/hybridV11Fixture";
import { computeCurrentFitness } from "../../performance/hybridCurrentFitness";
import { evaluateFitnessAsOf, replayFitness, riegelBaselineSeconds, scoreFitnessAgainstOutcomes, stabilityMetrics, type DistanceOutcome } from "../hybridTargetsEvaluation";

const world = fitnessWorld({ asOfDate: "2026-12-10", races: [SEPTEMBER_RACE()], gaps: [1, 2, 2, 2], miles: [7, 8, 9, 16, 6, 8] });
const input = { races: world.races, workouts: world.workouts, overrides: world.overrides, asOf: world.asOf, timeZone: FIT_TZ };
const instants = Array.from({ length: 28 }, (_, i) => `${addDays("2026-10-27", i)}T17:00:00.000Z`);

describe("as-of replay of the four-distance estimator", () => {
  const rows = replayFitness(input, instants);
  it("evaluates every instant for all four distances in order", () => {
    expect(rows).toHaveLength(28);
    for (const r of rows) expect(r.targets.map(t => t.id)).toEqual(["5k", "10mi", "half", "marathon"]);
  });
  it("matches a direct computation on data truncated at the instant (later workouts are excluded and counted)", () => {
    const asOf = "2026-11-12T17:00:00.000Z";
    const { row, fitness } = evaluateFitnessAsOf(input, asOf);
    const known = input.workouts.filter(w => w.endDate.getTime() <= Date.parse(asOf) && w.syncedAt.getTime() <= Date.parse(asOf));
    const direct = computeCurrentFitness({ ...input, workouts: known, asOf });
    expect(fitness.rows.map(r => r.estimate.seconds)).toEqual(direct.rows.map(r => r.estimate.seconds));
    expect(row.leakageExcluded).toBe(input.workouts.length - known.length);
    expect(row.leakageExcluded).toBeGreaterThan(0);
  });
  it("coverage and day-to-day stability are reported per distance; a routine-training month moves no estimate by more than 1 %", () => {
    const m = stabilityMetrics(rows);
    expect(m.map(x => x.id)).toEqual(["5k", "10mi", "half", "marathon"]);
    for (const x of m) {
      expect(x.days).toBe(28);
      if (x.available > 1) { expect(x.maxStepFraction!).toBeLessThan(0.01); expect(x.meanStepFraction!).toBeLessThanOrEqual(x.maxStepFraction!); }
    }
    expect(m.find(x => x.id === "half")!.availabilityShare).toBe(1);
  });
  it("implied cross-distance exponents stay plausible on every replayed day", () => {
    for (const r of rows) { expect(r.consistent).toBe(true); for (const k of r.impliedExponents) { expect(k).toBeGreaterThanOrEqual(1); expect(k).toBeLessThanOrEqual(1.2); } }
  });
});

describe("accuracy scoring is NOT EVALUABLE below five qualified outcomes of the SAME distance, and never claims proof above it", () => {
  const rows = replayFitness(input, instants);
  const out = (distanceId: DistanceOutcome["distanceId"], raceDate: string, finishSeconds: number, qualified = true): DistanceOutcome => ({ distanceId, raceDate, finishSeconds, qualified });
  it("one qualified half-marathon outcome (the owner's September result) is a sanity check, not validation", () => {
    const s = scoreFitnessAgainstOutcomes(rows, [out("half", "2026-12-20", 7871)]);
    expect(s.map(x => x.status)).toEqual(["NOT EVALUABLE", "NOT EVALUABLE", "NOT EVALUABLE", "NOT EVALUABLE"]);
    for (const x of s) { expect(x).not.toHaveProperty("meanAbsoluteErrorFraction"); expect(x.required).toBe(5); }
  });
  it("unqualified outcomes and outcomes of other distances do not count", () => {
    const outs = [...Array(6)].map((_, i) => out("half", `2026-12-${20 + i}`, 7871, false)).concat([...Array(6)].map((_, i) => out("5k", `2026-12-${20 + i}`, 1700)));
    const s = scoreFitnessAgainstOutcomes(rows, outs);
    expect(s.find(x => x.id === "half")!.status).toBe("NOT EVALUABLE");
    expect(s.find(x => x.id === "5k")!.status).toBe("DESCRIPTIVE ONLY");
  });
  it("with five qualified outcomes it reports DESCRIPTIVE errors only, scoring each row against a strictly later outcome", () => {
    const outs = [...Array(5)].map((_, i) => out("half", `2026-11-${10 + i * 5}`, 7900));
    const s = scoreFitnessAgainstOutcomes(rows, outs).find(x => x.id === "half")!;
    expect(s.status).toBe("DESCRIPTIVE ONLY");
    if (s.status === "DESCRIPTIVE ONLY") { expect(s.scored).toBeGreaterThan(0); expect(Number.isFinite(s.meanAbsoluteErrorFraction)).toBe(true); expect(s.note).toMatch(/no ranking, winner or significance claim/); }
    // rows dated after the last outcome score nothing
    const late = rows.filter(r => r.asOfDate > "2026-11-30");
    const s2 = scoreFitnessAgainstOutcomes(late, outs).find(x => x.id === "half")!;
    expect(s2.status === "DESCRIPTIVE ONLY" && s2.scored).toBe(0);
  });
});

describe("simple baseline for context", () => {
  it("the unadjusted Riegel conversion of the latest earlier race", () => {
    const races = [{ date: "2026-04-26", distanceMeters: 21097.5, seconds: 8130 }, { date: "2026-09-20", distanceMeters: 21097.5, seconds: 7871 }];
    expect(riegelBaselineSeconds(races, "2026-11-10", 5000)).toBeCloseTo(7871 * Math.pow(5000 / 21097.5, 1.06), 6);
    expect(riegelBaselineSeconds(races, "2026-09-20", 21097.5)).toBeCloseTo(8130, 6);   // strictly earlier races only
    expect(riegelBaselineSeconds(races, "2026-01-01", 21097.5)).toBeNull();
    const m = distanceRace("m", "2026-10-01", 42195, 16000, true, "marathon");
    expect(m.race.raceDistance).toBe("marathon");
  });
});

describe("isolation", () => {
  it("no live source imports the research module", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
    expect(walk("src").filter(f => /research\/hybridTargetsEvaluation/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
