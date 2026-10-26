import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { shiftPerformanceDate } from "../performanceEvidence";
import { researchRace, researchRun, workoutResearchFixture } from "./fixtures/workoutRaceResearchFixture";

type Input = Parameters<typeof estimateCurrentHalfMarathon>[0];
import { currentFixture } from "./fixtures/currentPerformanceFixture";

const estimate = (input: Input) => estimateCurrentHalfMarathon(input);
const recentOnly = (input: Input, predicate: (w: HealthWorkout) => boolean): Input => ({ ...input,
  workouts: input.workouts.filter(w => !w.workoutId.startsWith("current-") || predicate(w)) });

describe("experimental current HM / completed parent evidence", () => {
  it("returns a numeric minute-rounded current estimate from a provisional race and summary-only training", () => {
    const r = estimate(currentFixture());
    expect(r.status).toBe("experimental"); expect(r.validated).toBe(false);
    expect(r.anchor?.status).toBe("recorded_unverified"); expect(r.baselineSeconds).toBe(7871);
    expect(r.finishMinutes).toBe(131); expect(r.paceSecondsPerMile).toBe(600);
    expect(r.adjustmentMethod).toBe("summary"); expect(r.adjustmentSeconds).toBe(0);
    expect(r.gaps.join(" ")).toContain("maximal effort remain unverified");
    expect(r.currentTraining?.observedWeeks).toBeGreaterThanOrEqual(4);
    expect(r.reason).toContain("deadbands");
  });
  it("prefers verified same-distance evidence over a newer provisional result", () => {
    const input = currentFixture(), verified = researchRace("verified", "2026-08-10", 8000, true);
    verified.race.performanceEvidence!.status = "verified"; verified.race.performanceEvidence!.kind = "official_race";
    expect(estimate({ ...input, races: [...input.races, verified.race], workouts: [...input.workouts, verified.workout] }).anchor?.raceId).toBe("verified");
  });
  it("prefers owner-confirmed same-distance evidence to provisional evidence", () => {
    const input = currentFixture(), owner = researchRace("owner", "2026-08-10", 8000, true);
    expect(estimate({ ...input, races: [...input.races, owner.race], workouts: [...input.workouts, owner.workout] }).anchor?.raceId).toBe("owner");
  });
  it("rejects the April clock discrepancy without choosing its shorter duration", () => {
    const input = currentFixture(), april = researchRace("april-clock-conflict", "2026-04-26", 8130);
    april.workout.endDate = new Date(april.workout.startDate.getTime() + 8759 * 1000);
    const r = estimate({ ...input, races: [april.race], workouts: [...input.workouts, april.workout], asOf: "2026-06-01T16:00:00Z" });
    expect(r.anchor).toBeNull(); expect(r.finishMinutes).toBeNull();
  });
  it("rejects a recent clock conflict independently of freshness", () => {
    const input = currentFixture(); input.workouts[0].endDate = new Date(input.workouts[0].endDate.getTime() + 629000);
    expect(estimate(input).anchor).toBeNull();
  });
  it.each([true, false])("does not fabricate a race anchor from ordinary fast running (explicit nonmaximal=%s)", nonmaximal => {
    const input = currentFixture();
    if (nonmaximal) input.races[0].performanceEvidence = { status: "owner_confirmed", kind: "race", knownAt: "2026-09-01T00:00:00Z",
      raceDate: "2026-08-30", distanceMeters: 21097.5, finishSeconds: 7871, effort: "nonmaximal", conditions: "Easy effort", source: "Invented" };
    else input.races = [];
    expect(estimate(input).finishMinutes).toBeNull();
  });
  it("uses fixed 1.06 equivalence for eligible confirmed different-distance evidence", () => {
    const input = currentFixture(), anchor = researchRace("ten-k", "2026-08-30", 3600, true);
    anchor.race.raceDistance = "10K"; anchor.race.performanceEvidence!.distanceMeters = 10000;
    anchor.workout.distanceMiles = 10000 / 1609.344; anchor.workout.distanceMeters = 10000;
    const r = estimate({ ...input, races: [anchor.race], workouts: [...input.workouts.slice(1), anchor.workout] });
    expect(r.baselineSeconds).toBeCloseTo(3600 * (21097.5 / 10000) ** 1.06);
    expect(r.finishMinutes).not.toBeNull();
  });
  it("abstains outside the numerical domain with a consistent explanation", () => {
    const input = currentFixture(), implausible = researchRace("implausible-half", "2026-08-30", 1800, true);
    const r = estimate({ ...input, races: [implausible.race], workouts: [...input.workouts.slice(1), implausible.workout] });
    expect(r.finishMinutes).toBeNull(); expect(r.reason).toContain("outside");
    expect(r.contributions.reduce((s, c) => s + c.seconds, 0)).toBe(r.adjustmentSeconds);
  });
  it("removes an owner-excluded race anchor", () => {
    const input = currentFixture(), id = input.workouts[0].workoutId;
    input.overrides = { [id]: { workoutId: id, isExcluded: true, updatedAt: "2026-10-26T15:00:00Z" } };
    expect(estimate(input).anchor).toBeNull();
  });
  it("requires minimum completed training support", () => {
    const input = currentFixture(); expect(estimate({ ...input, workouts: input.workouts.slice(0, 2) }).finishMinutes).toBeNull();
  });
  it("evaluates sustained increased consistent training with a bounded explained improvement", () => {
    const baseline = estimate(currentFixture()), increased = estimate(currentFixture(1.5, 4, 9));
    expect(increased.finishMinutes).toBeLessThan(baseline.finishMinutes!);
    expect(increased.adjustmentSeconds).toBeLessThan(-60);
    expect(increased.adjustmentSeconds).toBeGreaterThanOrEqual(-7871 * .025);
    expect(increased.reason).toContain("stronger");
  });
  it("responds to long-term frequency changes, without cumulative-mile credits", () => {
    const a = estimate(currentFixture()), b = estimate(currentFixture(1, 4));
    expect(b.adjustmentSeconds).toBeLessThan(a.adjustmentSeconds);
    const input = currentFixture(); input.workouts.push(researchRun("ancient", "2019-01-01", 600));
    expect(estimate(input).finishMinutes).toBe(a.finishMinutes);
  });
  it("considers sustained long-run development at maintained frequency without automatic per-run speed credit", () => {
    const a = estimate(currentFixture()), b = estimate(currentFixture(1, 3, 10));
    expect(b.adjustmentSeconds).toBeLessThan(a.adjustmentSeconds);
    expect(b.contributions.find(c => c.feature === "Endurance preparation")?.seconds).toBeLessThan(0);
    expect(b.finishMinutes).toBeGreaterThanOrEqual(a.finishMinutes! - 3);
  });
  it("permits a slower estimate for sustained reduced training", () => {
    const a = estimate(currentFixture()), b = estimate(currentFixture(.5, 2, 4));
    expect(b.finishMinutes).toBeGreaterThan(a.finishMinutes!); expect(b.reason).toContain("reduced");
  });
  it("does not infer inactivity from several missing weeks", () => {
    const r = estimate(recentOnly(currentFixture(), w => w.startDate < new Date("2026-09-15")));
    expect(r.finishMinutes).not.toBeNull(); expect(r.adjustmentSeconds).toBe(0);
    expect(r.gaps.join(" ")).toContain("Interruption versus missing coverage");
    expect(r.adjustmentMethod).toBe("withheld");
  });
  it("does not materially change after one ordinary easy run; today's run enters totals before adjustment", () => {
    const input = currentFixture(), a = estimate(input);
    input.workouts.push(researchRun("ordinary-today", "2026-10-26", 569));
    const b = estimate(input); expect(b.finishMinutes).toBe(a.finishMinutes); expect(b.adjustmentSeconds).toBe(a.adjustmentSeconds);
    expect(b.training.recentFourWeeks.sessions).toBe(a.training.recentFourWeeks.sessions + 1);
    input.asOf = "2026-10-27T16:00:00Z";
    expect(Math.abs(estimate(input).adjustmentSeconds - a.adjustmentSeconds)).toBeLessThan(20);
  });
  it("does not extrapolate fitness from faster substantially higher HR", () => {
    const input = workoutResearchFixture(); input.workouts = input.workouts.map(w => w.workoutId.startsWith("after-") ? { ...w, avgHeartRate: 175 } : w);
    const r = estimate(input); expect(r.adjustmentMethod).not.toBe("matched_effort"); expect(r.adjustmentSeconds).toBe(0);
  });
  it("lets qualified comparable-effort observations affect the number with half-strength capped transfer", () => {
    const r = estimate(workoutResearchFixture());
    expect(r.adjustmentMethod).toBe("matched_effort"); expect(r.adjustmentSeconds).toBeCloseTo(-156);
    expect(r.contributions).toHaveLength(1); expect(r.finishMinutes).toBe(127);
  });
  it.each([.88, .90, .96, 1, 1.04, 1.10, 1.14])("bounds sensitivity to qualified matched pace ratio %s", ratio => {
    const input = workoutResearchFixture();
    input.workouts = input.workouts.map(w => {
      if (!w.workoutId.startsWith("after-")) return w;
      const durationSeconds = 3000 * ratio;
      return { ...w, durationSeconds, endDate: new Date(w.startDate.getTime() + durationSeconds * 1000) };
    });
    const r = estimate(input);
    expect(r.adjustmentSeconds).toBeCloseTo(7800 * Math.max(-.03, Math.min(.03, (ratio - 1) * .5)));
  });
  it("refreshes with a new faster confirmed race", () => {
    const input = currentFixture(), next = researchRace("new-confirmed", "2026-10-18", 7400, true);
    const r = estimate({ ...input, races: [...input.races, next.race], workouts: [...input.workouts, next.workout] });
    expect(r.anchor?.raceId).toBe("new-confirmed"); expect(r.finishMinutes).toBe(123); expect(r.adjustmentSeconds).toBe(0);
  });
  it("permits a new slower maximal race to establish a slower baseline", () => {
    const input = currentFixture(), next = researchRace("slower-confirmed", "2026-10-18", 8400, true);
    expect(estimate({ ...input, races: [...input.races, next.race], workouts: [...input.workouts, next.workout] }).finishMinutes).toBe(140);
  });
  it("is independent of workout ordering and identical duplicate records", () => {
    const input = currentFixture(1.5, 4, 9), r = estimate(input);
    expect(estimate({ ...input, workouts: [...input.workouts].reverse() }).finishMinutes).toBe(r.finishMinutes);
    expect(estimate({ ...input, workouts: [...input.workouts, ...input.workouts] }).finishMinutes).toBe(r.finishMinutes);
    expect(estimate({ ...input, workouts: [...input.workouts, { ...input.workouts.at(-1)!, workoutId: "duplicate" }] }).adjustmentSeconds).toBe(r.adjustmentSeconds);
  });
  it("rejects conflicting identities before applying overrides", () => {
    const input = currentFixture(), w = input.workouts.at(-1)!;
    input.workouts.push({ ...w, distanceMiles: 1 });
    expect(estimate(input).eligibleRuns).toBe(input.workouts.length - 2);
  });
  it("removes owner-excluded runs and applies distance overrides", () => {
    const input = currentFixture(1.5, 4, 9), before = estimate(input);
    input.overrides = Object.fromEntries(input.workouts.filter(w => w.workoutId.startsWith("current-")).map(w => [w.workoutId,
      { workoutId: w.workoutId, isExcluded: true, updatedAt: "2026-10-26T15:00:00Z" }]));
    const after = estimate(input); expect(after.sinceAnchor.sessions).toBe(0); expect(after.adjustmentSeconds).toBe(0);
    expect(after.eligibleRuns).toBeLessThan(before.eligibleRuns);
    input.overrides = { "current-7-0": { workoutId: "current-7-0", isExcluded: false, distanceMilesOverride: 8, updatedAt: "2026-10-26T15:00:00Z" } };
    expect(estimate(input).sinceAnchor.miles).toBeCloseTo(before.sinceAnchor.miles + 2);
  });
  it("does not lose valid mileage or numerical summary response without HR, weather or route", () => {
    const r = estimate(currentFixture(1.5, 4, 9)); expect(r.training.recentFourWeeks.miles).toBeGreaterThan(80);
    expect(r.adjustmentMethod).toBe("summary"); expect(r.adjustmentSeconds).toBeLessThan(0);
  });
  it("includes treadmill training in the summary fallback", () => {
    const input = currentFixture(1.5, 4, 9); input.workouts = input.workouts.map(w => ({ ...w, displayType: "Treadmill Run" }));
    expect(estimate(input).adjustmentSeconds).toBe(estimate(currentFixture(1.5, 4, 9)).adjustmentSeconds);
  });
  it("suppresses isolated long-run outliers", () => {
    const input = currentFixture(), before = estimate(input);
    input.workouts.push(researchRun("long-outlier", "2026-10-20", 620, { distanceMiles: 25, durationSeconds: 15500,
      endDate: new Date("2026-10-20T16:18:20Z"), syncedAt: new Date("2026-10-20T17:00:00Z") }));
    expect(estimate(input).finishMinutes).toBe(before.finishMinutes);
    expect(Math.abs(estimate(input).adjustmentSeconds)).toBeLessThan(20);
  });
  it("ignores a sudden isolated frequency spike", () => {
    const input = currentFixture(), a = estimate(input);
    for (let i = 0; i < 6; i++) input.workouts.push(researchRun(`spike-${i}`, shiftPerformanceDate("2026-10-19", i), 600));
    expect(Math.abs(estimate(input).adjustmentSeconds - a.adjustmentSeconds)).toBeLessThan(30);
  });
  it("does not mistake the final race taper for a weaker baseline", () => {
    const input = currentFixture(), a = estimate(input);
    input.workouts = input.workouts.filter(w => w.workoutId.includes("half") || w.startDate < new Date("2026-08-23") || w.startDate > new Date("2026-08-30"));
    expect(estimate(input).baselineTraining).toEqual(a.baselineTraining);
  });
  it("keeps rolling date-boundary changes small on a stable history", () => {
    const input = currentFixture(1.5, 4, 9), values = [];
    for (let d = 0; d < 7; d++) values.push(estimate({ ...input, asOf: shiftPerformanceDate("2026-10-23", d) + "T16:00:00Z" }).adjustmentSeconds);
    for (let i = 1; i < values.length; i++) expect(Math.abs(values[i] - values[i - 1])).toBeLessThan(30);
  });
  it("fades matched-effort contributions across rolling boundaries instead of dropping the transfer at one expiry", () => {
    const input = workoutResearchFixture(), values = [];
    for (let d = 0; d < 20; d++) values.push(estimate({ ...input, asOf: shiftPerformanceDate("2026-10-25", d) + "T16:00:00Z" }).adjustmentSeconds);
    for (let i = 1; i < values.length; i++) expect(Math.abs(values[i] - values[i - 1])).toBeLessThan(40);
  });
  it("handles local midnight and DST without invented completions", () => {
    const input = currentFixture(); input.workouts.push(researchRun("later", "2026-11-01", 600));
    const before = estimate({ ...input, asOf: "2026-11-01T04:00:00Z" });
    const after = estimate({ ...input, asOf: "2026-11-01T06:00:00Z" });
    expect(before.eligibleRuns).toBe(after.eligibleRuns);
    expect(before.eligibleRuns).toBe(input.workouts.length - 1);
  });
  it("explains staleness when advancing time and expires anchors after 180 days", () => {
    const input = currentFixture(1.5, 4, 9);
    const r = estimate({ ...input, asOf: "2026-12-01T16:00:00Z" });
    expect(r.gaps.join(" ")).toContain("days since"); expect(r.gaps.join(" ")).toContain("older than 90");
    expect(estimate({ ...input, asOf: "2027-03-01T16:00:00Z" }).finishMinutes).toBeNull();
  });
  it("does not leak future, incomplete, or not-yet-synced workouts", () => {
    const input = currentFixture(), a = estimate(input);
    input.workouts.push(researchRun("future", "2027-03-01", 400),
      researchRun("unfinished", "2026-10-26", 600, { endDate: new Date("2026-10-27T16:00:00Z") }),
      researchRun("not-synced", "2026-10-24", 600, { syncedAt: new Date("2026-10-27T16:00:00Z") }));
    expect(estimate(input).finishMinutes).toBe(a.finishMinutes); expect(estimate(input).eligibleRuns).toBe(a.eligibleRuns);
  });
  it("does not accept goal pace, plans or validated interval/forecast output", () => {
    const input = currentFixture(1.5, 4, 9), a = estimate(input);
    input.races.push({ ...input.races[0], id: "future-goal", raceDate: "2027-03-20", actualRunId: undefined, targetPaceSecondsPerMile: 300 });
    const b = estimate(input); expect(b.finishMinutes).toBe(a.finishMinutes);
    expect(b).not.toHaveProperty("confidenceInterval"); expect(b).not.toHaveProperty("raceDayForecast"); expect(b.validated).toBe(false);
  });
  it("reconciles every accepted feature contribution with the actual numerical adjustment", () => {
    for (const input of [currentFixture(), currentFixture(1.5, 4, 9), currentFixture(.5, 2, 4), workoutResearchFixture()]) {
      const r = estimate(input);
      expect(r.contributions.reduce((s, c) => s + c.seconds, 0)).toBeCloseTo(r.adjustmentSeconds);
      expect(r.finishMinutes).toBe(Math.round((r.baselineSeconds! + r.adjustmentSeconds) / 60));
      expect(r.contributions.every(c => c.explanation.length > 20)).toBe(true);
    }
  });
  it("records explicit engineering coefficients", () => {
    expect(CURRENT_HALF_POLICY.volumeCoefficient).toBe(.02); expect(CURRENT_HALF_POLICY.enduranceCoefficient).toBe(.005);
    expect(CURRENT_HALF_POLICY.maximumSummaryFraction).toBe(.025); expect(CURRENT_HALF_POLICY.maximumPaceFraction).toBe(.03);
  });
});
