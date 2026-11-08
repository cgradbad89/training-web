/**
 * Demonstrated-race policy for hybrid v1.1: a confirmed `hard`/`nonmaximal` race that passes every race-integrity check may carry a LABELLED,
 * provisional, low-confidence number; it can only make the strict estimate faster; it is never projected by the race-day forecast when it is
 * the only evidence. Invented data only; confirmations use the real versioned `confirmationHistory` schema.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import { confirmedRaceFixture } from "../../__tests__/fixtures/raceConfirmationFixture";
import { cadenceRuns, halfRace } from "../../__tests__/fixtures/policyStudyFixture";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { estimateRaceDayForecast } from "../raceDayForecast";
import { isDemonstratedRaceEvidence } from "../evidenceQualification";
import { buildRaceEvidence } from "../../racePerformance";

const TZ = "America/New_York";
type Effort = "maximal" | "hard" | "nonmaximal" | "unknown";
interface RaceSpec { id: string; date: string; seconds: number; effort: Effort; availableAt?: string | null; elapsed?: number; reconciliation?: string }

/** A race with a REAL versioned confirmation history (never the legacy `performanceEvidence`). */
function historyRace(s: RaceSpec): { race: Race; workout: HealthWorkout } {
  const f = confirmedRaceFixture({ id: s.id, date: s.date, seconds: s.seconds, elapsed: s.elapsed, availableAt: s.availableAt === null ? undefined : s.availableAt });
  f.revision.details.effort = s.effort;
  if (s.reconciliation) f.revision.details.timingReconciliation = s.reconciliation;
  if (s.availableAt === null) f.revision.availableAt = null;
  f.workout.avgHeartRate = 168; f.workout.hasRoute = true;
  return { race: f.race, workout: f.workout };
}
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const athlete = (races: { race: Race; workout: HealthWorkout }[], asOfDate: string) => ({
  races: races.map(r => r.race),
  workouts: [...cadenceRuns({ start: "2025-08-04", end: addDay(asOfDate, -1), gaps: [2, 2, 3], miles: [5, 6, 5, 8] }), ...races.map(r => r.workout)],
  overrides: {}, timeZone: TZ, asOf: `${asOfDate}T17:00:00.000Z` });
const est = (races: Parameters<typeof athlete>[0], asOfDate: string, strictMaximalOnly = false) => estimateHybridHalfMarathonV11(athlete(races, asOfDate), { strictMaximalOnly });

describe("September race (7,871 s, confirmed 2026-10-24), as of 2026-11-08", () => {
  const sep = (effort: Effort) => est([historyRace({ id: "sep", date: "2026-09-20", seconds: 7871, effort })], "2026-11-08");
  it("hard and nonmaximal are treated identically, and neither is a maximal prediction", () => {
    const hard = sep("hard"), non = sep("nonmaximal");
    expect(hard).toEqual(non);
    expect(hard).toMatchObject({ status: "provisional", confidence: "low" });
    expect(hard.demonstrated).toMatchObject({ basis: "demonstrated_performance_only", eligibleRaces: 1, usedRaces: 1, policyDisabled: false });
    expect(hard.flags).toContain("demonstrated_performance_only");
    expect(hard.demonstrated.note).toMatch(/demonstrated performance/);
    expect(hard.caveats[0]).toMatch(/not your maximal-performance limit/);
  });
  it("the number is the shipped treatment of that race, with no discount or effort scaling", () => {
    const maximal = sep("maximal");
    expect(maximal.demonstrated.basis).toBe("maximal_or_recorded_evidence");
    expect(sep("hard").seconds).toBeCloseTo(maximal.seconds!, 6);
    expect(maximal.seconds!).toBeGreaterThanOrEqual(7871 - 1); expect(maximal.seconds!).toBeLessThan(7871 * 1.01);
  });
  it("an effort that is `unknown` is never admitted, and the policy can be switched off bit for bit", () => {
    expect(sep("unknown").status).toBe("unavailable");
    const off = est([historyRace({ id: "sep", date: "2026-09-20", seconds: 7871, effort: "hard" })], "2026-11-08", true);
    expect(off.status).toBe("unavailable");
    expect(off.demonstrated).toMatchObject({ basis: "maximal_or_recorded_evidence", policyDisabled: true, eligibleRaces: 1, usedRaces: 0 });
  });
});

describe("April race (8,130 s moving; 8,759 s elapsed; confirmed with a timing explanation)", () => {
  const APR = { id: "apr", date: "2026-04-26", seconds: 8130, effort: "nonmaximal" as Effort, elapsed: 8759, reconciliation: "The recording began about 10 minutes before the timed start." };
  it("counts while current: confirmed in April, evaluated in June", () => {
    const e = est([historyRace({ ...APR, availableAt: "2026-04-27T22:32:00.000Z" })], "2026-06-01");
    expect(e.demonstrated.basis).toBe("demonstrated_performance_only");
    expect(e.seconds!).toBeGreaterThanOrEqual(8130 - 1);
  });
  it("race integrity is preserved: without the timing explanation the clocks disagree and the race is not admitted", () => {
    const e = est([historyRace({ ...APR, reconciliation: undefined, availableAt: "2026-04-27T22:32:00.000Z" })], "2026-06-01");
    expect(e.status).toBe("unavailable");
    expect(e.demonstrated.eligibleRaces).toBe(0);
  });
  it("a confirmation entered in November is unknown before November and the race is expired (196 days) by then", () => {
    const early = est([historyRace({ ...APR, availableAt: "2026-11-08T16:00:00.000Z" })], "2026-09-20");
    expect(early.status).toBe("unavailable");                           // not yet confirmed: chronology respected
    const now = est([historyRace({ ...APR, availableAt: "2026-11-08T16:00:00.000Z" })], "2026-11-08");
    expect(now.status).toBe("unavailable");
    expect(now.unavailableCause).toBe("anchor_expired_no_contemporary_evidence");
    expect(now.demonstrated).toMatchObject({ eligibleRaces: 1, usedRaces: 0 });
    expect(now.demonstrated.note).toMatch(/180-day/);
  });
});

describe("confirmation timestamps and history validity", () => {
  const base: RaceSpec = { id: "r", date: "2026-09-20", seconds: 7871, effort: "hard" };
  it("a revision available after the cutoff, an unresolved revision and a corrupt history are not used", () => {
    // Not yet available: the confirmation is invisible, so no demonstrated race exists (the unchanged recorded-race path may still count the workout).
    const future = est([historyRace({ ...base, availableAt: "2026-11-20T16:00:00.000Z" })], "2026-11-08");
    expect(future.demonstrated).toMatchObject({ basis: "maximal_or_recorded_evidence", eligibleRaces: 0, usedRaces: 0 });
    const unresolved = est([historyRace({ ...base, availableAt: null })], "2026-11-08");
    expect(unresolved.demonstrated).toMatchObject({ eligibleRaces: 0, usedRaces: 0 });
    const bad = historyRace(base); bad.race.confirmationHistory = { ...bad.race.confirmationHistory!, currentRevisionId: "missing" };
    const corrupt = est([bad], "2026-11-08");
    expect(corrupt.status).toBe("unavailable");
    expect(corrupt.demonstrated.eligibleRaces).toBe(0);
  });
  it("strict historical replay (asOfMode historical) abstains exactly as before", () => {
    const e = estimateHybridHalfMarathonV11({ ...athlete([historyRace(base)], "2026-11-08"), asOfMode: "historical" } as never);
    expect(e.status).toBe("unavailable");
  });
  it("a later correction cannot leak backwards: the revision available at the cutoff decides", () => {
    const f = historyRace({ ...base, effort: "hard", availableAt: "2026-10-24T16:00:00.000Z" });
    const rev = Object.values(f.race.confirmationHistory!.revisions)[0];
    const later = { ...structuredClone(rev), revisionId: "22222222-2222-4222-8222-222222222222", requestId: "22222222-2222-4222-8222-222222222222", revisionNumber: 2,
      supersedesRevisionId: rev.revisionId, availableAt: "2026-11-20T16:00:00.000Z", correctionReason: "Synthetic", details: { ...rev.details, effort: "maximal" as const } };
    f.race.confirmationHistory = { ...f.race.confirmationHistory!, currentRevisionId: later.revisionId, revisions: { ...f.race.confirmationHistory!.revisions, [later.revisionId]: later } };
    expect(est([f], "2026-11-08").demonstrated.basis).toBe("demonstrated_performance_only");   // before the correction: demonstrated
    expect(est([f], "2026-11-25").demonstrated.basis).toBe("maximal_or_recorded_evidence");     // after it: maximal
  });
  it("the legacy performanceEvidence shape gives the same result as the versioned history", () => {
    const legacy = halfRace("hm", "2026-09-20", 7871, "nonmaximal");
    const viaLegacy = estimateHybridHalfMarathonV11(athlete([legacy], "2026-11-08"));
    const viaHistory = est([historyRace({ ...base, effort: "nonmaximal" })], "2026-11-08");
    expect(viaLegacy.demonstrated.basis).toBe("demonstrated_performance_only");
    expect(viaLegacy.seconds).toBeCloseTo(viaHistory.seconds!, 6);
  });
});

describe("180-day currency limit", () => {
  it("admitted through day 180, carries no weight from day 181 (unchanged limit)", () => {
    const race = () => historyRace({ id: "r", date: "2026-03-15", seconds: 8130, effort: "hard", availableAt: "2026-03-16T16:00:00.000Z" });
    const at = (n: number) => est([race()], addDay("2026-03-15", n));
    expect(at(180).demonstrated.basis).toBe("demonstrated_performance_only");
    expect(at(181).status).toBe("unavailable");
    expect(at(181).demonstrated.usedRaces).toBe(0);
  });
});

describe("strict evidence and contradictory evidence", () => {
  const maximalRace = (seconds: number, date: string) => historyRace({ id: "mx", date, seconds, effort: "maximal", availableAt: addDay(date, 1) + "T16:00:00.000Z" });
  const nonmaximalRace = (seconds: number, date: string, effort: Effort = "nonmaximal") => historyRace({ id: "nm", date, seconds, effort, availableAt: addDay(date, 1) + "T16:00:00.000Z" });
  it("identity: with no hard/nonmaximal race the result equals the strict estimate in every field except the switch flag", () => {
    for (const races of [[maximalRace(8000, "2026-07-01")], []] as const) {
      const on = est([...races], "2026-09-25"), off = est([...races], "2026-09-25", true);
      expect(on.seconds).toBe(off.seconds);
      expect({ ...on, demonstrated: null }).toEqual({ ...off, demonstrated: null });
      expect(on.demonstrated.basis).toBe("maximal_or_recorded_evidence");
    }
  });
  it("a slower nonmaximal race never changes a strict estimate that is faster", () => {
    const races = [maximalRace(8000, "2026-07-01"), nonmaximalRace(8300, "2026-09-10")];
    const on = est(races, "2026-09-25"), off = est(races, "2026-09-25", true);
    expect(on.seconds).toBe(off.seconds);
    expect(on.status).toBe(off.status);
    expect(on.demonstrated).toMatchObject({ basis: "maximal_or_recorded_evidence", eligibleRaces: 1, usedRaces: 0 });
    expect(on.demonstrated.note).toMatch(/does not make the estimate faster/);
  });
  it("a faster nonmaximal race moves a stale strict estimate faster, never past the demonstrated time, labelled provisional/low", () => {
    const races = [maximalRace(8400, "2026-04-20"), nonmaximalRace(8130, "2026-09-10")];
    const on = est(races, "2026-09-25"), off = est(races, "2026-09-25", true);
    expect(on.seconds!).toBeLessThan(off.seconds!);
    expect(on.seconds!).toBeGreaterThanOrEqual(8130 - 1);
    expect(on).toMatchObject({ status: "provisional", confidence: "low" });
    expect(on.demonstrated.basis).toBe("demonstrated_performance_included");
  });
  it("contradictory evidence (a faster nonmaximal race than a recent maximal one): never slower than strict, and monotone in the race time", () => {
    const series: number[] = [];
    for (let t = 7700; t <= 8500; t += 100) {
      const races = [maximalRace(8200, "2026-08-20"), nonmaximalRace(t, "2026-09-10")];
      const on = est(races, "2026-09-25"), off = est(races, "2026-09-25", true);
      expect(on.seconds!).toBeLessThanOrEqual(off.seconds! + 1e-9);
      series.push(on.seconds!);
    }
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] - 1e-9);
    expect(series[0]).toBeLessThan(series.at(-1)!);
  });
  it("hard and nonmaximal are interchangeable in every combination", () => {
    for (const [a, b] of [["hard", "nonmaximal"], ["nonmaximal", "hard"]] as const) {
      const x = est([maximalRace(8400, "2026-04-20"), nonmaximalRace(8130, "2026-09-10", a)], "2026-09-25");
      const y = est([maximalRace(8400, "2026-04-20"), nonmaximalRace(8130, "2026-09-10", b)], "2026-09-25");
      expect(x).toEqual(y);
    }
  });
});

describe("race-day forecast", () => {
  const input = (races: { race: Race; workout: HealthWorkout }[]) => athlete(races, "2026-11-08");
  const forecast = (races: { race: Race; workout: HealthWorkout }[], extra = {}) => estimateRaceDayForecast(input(races), { raceDate: "2026-12-20", plan: null, model: "v1.1", ...extra });
  const sep = (effort: Effort) => historyRace({ id: "sep", date: "2026-09-20", seconds: 7871, effort });
  it("a demonstrated-only capability is never silently projected: the forecast is withheld with an explicit cause", () => {
    const f = forecast([sep("hard")]);
    expect(f).toMatchObject({ status: "withheld", withheldCause: "demonstrated_performance_only", seconds: null });
    expect(f.reasons[0]).toMatch(/not run at maximal effort/);
    const hybrid = estimateHybridHalfMarathonV11(input([sep("hard")]));
    expect(estimateRaceDayForecast(input([sep("hard")]), { raceDate: "2026-12-20", plan: null, hybrid }).withheldCause).toBe("demonstrated_performance_only");
  });
  it("with the policy off the forecast behaves as before (no capability, so withheld for that reason)", () => {
    const f = forecast([sep("hard")], { strictMaximalOnly: true });
    expect(f.withheldCause).toBe("current_capability_unavailable");
  });
  it("a maximal-evidence capability still forecasts, unchanged", () => {
    const f = forecast([sep("maximal")]);
    expect(f.status).toBe("provisional");
    expect(f.seconds).toBeGreaterThan(7000);
  });
  it("a capability that merely INCLUDES a faster nonmaximal race forecasts, with the label in its uncertainty", () => {
    const stale = historyRace({ id: "mx", date: "2026-06-15", seconds: 8400, effort: "maximal", availableAt: "2026-06-16T16:00:00.000Z" });
    const f = forecast([stale, sep("nonmaximal")]);
    expect(f.status).toBe("provisional");
    expect(f.uncertainty.some(u => /not run at maximal effort/.test(u))).toBe(true);
  });
});

describe("minimal logic", () => {
  it("admission reuses the integrity-checked race evidence; `unknown`, recorded and maximal races are not demonstrated races", () => {
    const ev = (effort: Effort) => buildRaceEvidence(athlete([historyRace({ id: "r", date: "2026-09-20", seconds: 7871, effort })], "2026-11-08"));
    expect(ev("hard").some(isDemonstratedRaceEvidence)).toBe(true);
    expect(ev("nonmaximal").some(isDemonstratedRaceEvidence)).toBe(true);
    expect(ev("maximal").some(isDemonstratedRaceEvidence)).toBe(false);
    expect(ev("unknown").some(isDemonstratedRaceEvidence)).toBe(false);
  });
  it("no effort percentage, slider, coefficient or discount exists in the policy code", () => {
    for (const f of ["src/utils/performance/hybridPerformanceV11.ts", "src/utils/performance/evidenceQualification.ts"]) {
      const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(text).not.toMatch(/effortPercent|effortScale|effortCoefficient|effortSlider|effortDiscount|perceived/i);
    }
  });
});
