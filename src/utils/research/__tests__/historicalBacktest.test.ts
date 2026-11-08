import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHybridHalfMarathonV11 } from "../../performance/hybridPerformanceV11";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "../../performance/hybridPerformance";
import { researchRace } from "../../__tests__/fixtures/workoutRaceResearchFixture";
import { athleteV11 } from "../../__tests__/fixtures/hybridV11Fixture";
import {
  buildAsOfState, evaluateCheckpoint, explainChange, holdoutAssessment, localInstant, predictionError, type BacktestSource, type OwnerConfirmationSpec,
} from "../historicalBacktest";

/** Invented data only. Two races (an "early" one whose two clocks disagree, and a later "target"), a bulk back-fill import,
 * a later override and later weather — the owner-record shapes the case study had to cope with. */
const TZ = "America/New_York";
const EARLY = "2026-04-26", TARGET = "2026-09-20";
const IMPORT_AT = "2026-04-02T01:00:00.000Z";

function source(opts: { earlyElapsedExtra?: number; targetSeconds?: number } = {}): BacktestSource {
  const a = athleteV11({ raceDate: EARLY, raceSeconds: 8130, start: "2026-01-05", trainingEnd: "2026-09-19", asOf: "2026-09-21T12:00:00Z",
    strong: [{ date: "2026-02-20", miles: 5, pace: 560, hr: 172 }, { date: "2026-03-14", miles: 6, pace: 556, hr: 172 }] });
  const early = a.races[0], earlyRun = a.workouts.find(w => w.workoutId === early.actualRunId)!;
  const extra = opts.earlyElapsedExtra ?? 629;
  const earlyFixed: HealthWorkout = { ...earlyRun, endDate: new Date(earlyRun.startDate.getTime() + (8130 + extra) * 1000) };
  earlyFixed.syncedAt = new Date(earlyFixed.endDate.getTime() + 1000);
  const target = researchRace("dc", TARGET, opts.targetSeconds ?? 7871, false);
  target.race.createdAt = "2026-04-02T19:54:00.000Z"; early.createdAt = "2026-04-02T18:04:00.000Z";
  // The device back-fill: everything that ended before the import was only synced in bulk.
  const workouts = [...a.workouts.filter(w => w.workoutId !== earlyRun.workoutId), earlyFixed, target.workout].map(w =>
    w.endDate.getTime() < Date.parse(IMPORT_AT) ? { ...w, syncedAt: new Date(IMPORT_AT) } : w);
  return { races: [early, target.race], workouts, overrides: a.overrides, plans: [], vo2: [], timeZone: TZ };
}
const at = (date: string, time = "06:00") => localInstant(date, time, TZ);
const earlyRaceId = (s: BacktestSource) => s.races.find(r => r.raceDate === EARLY)!.id;

describe("localInstant", () => {
  it("is DST-correct and America/New_York based", () => {
    expect(localInstant("2026-04-26", "05:00", TZ)).toBe("2026-04-26T09:00:00.000Z");      // EDT
    expect(localInstant("2026-01-15", "06:00", TZ)).toBe("2026-01-15T11:00:00.000Z");      // EST
    expect(localInstant("2026-03-08", "06:00", TZ)).toBe("2026-03-08T10:00:00.000Z");      // the spring-forward day, after the jump
    expect(localInstant("2026-11-01", "06:00", TZ)).toBe("2026-11-01T11:00:00.000Z");      // the fall-back day, after the jump
  });
});

describe("strict historical state", () => {
  const src = source();
  it("excludes back-filled workouts until they were actually synced, withholds untimestamped physiology and applies historical race rules", () => {
    const before = buildAsOfState(src, at("2026-03-29"), "strict_historical");
    expect(before.provenance.workoutsKnown).toBe(0);
    expect(before.provenance.workoutsExcludedNotSynced).toBeGreaterThan(0);
    const after = buildAsOfState(src, at("2026-04-12"), "strict_historical");
    expect(after.provenance.workoutsKnown).toBeGreaterThan(0);
    expect(after.provenance.vo2Entries).toBe(0); expect(after.provenance.hrStreamsWithheld).toBe(true);
    expect(after.input.asOfMode).toBe("historical");
    expect(after.provenance.workoutsAvailabilityAssumed).toBe(0);
  });
  it("never accepts an unconfirmed legacy race as evidence, so every estimator abstains", () => {
    const state = buildAsOfState(src, at("2026-09-19"), "strict_historical");
    const row = evaluateCheckpoint(state, src, {});
    expect(row.official.seconds).toBeNull(); expect(row.hybridV1.seconds).toBeNull(); expect(row.hybridV11.seconds).toBeNull();
    expect(row.raceEvidence.every(e => e.availableAsOf === false)).toBe(true);
  });
  it("drops weather, overrides and race records that only became known after the cutoff", () => {
    const base = source();
    const w = base.workouts.find(x => x.workoutId.startsWith("ord-") && x.endDate.getTime() > Date.parse("2026-05-01"))!;
    const later: BacktestSource = { ...base,
      workouts: base.workouts.map(x => x.workoutId === w.workoutId ? { ...x, weather: { ...(x.weather ?? { tempF: 60, feelsLikeF: 60, humidity: 50, windMph: 2, dewPointF: 40, conditionCode: 1, conditionText: "Clear" }), fetchedAt: "2026-11-01T00:00:00.000Z" } } : x),
      overrides: { [w.workoutId]: { workoutId: w.workoutId, userId: "u", isExcluded: true, excludedAt: "2026-10-01T00:00:00.000Z", excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "2026-10-01T00:00:00.000Z" } as WorkoutOverride },
      races: [...base.races, { id: "future", name: "later", raceDate: "2026-12-01", raceDistance: "halfMarathon", isActive: false, createdAt: "2026-10-15T00:00:00.000Z" } as Race] };
    const strict = buildAsOfState(later, at("2026-09-19"), "strict_historical");
    expect(strict.provenance.overridesDroppedLater).toBe(1); expect(strict.provenance.overridesApplied).toBe(0);
    expect(strict.provenance.weatherDroppedAfterCutoff).toBe(1);
    expect(strict.input.races.some(r => r.id === "future")).toBe(false); expect(strict.provenance.racesDroppedLater).toBe(1);
    expect(strict.input.workouts.find(x => x.workoutId === w.workoutId)!.weather).toBeUndefined();
    // Reconstruction also refuses to apply a later correction, but cannot prove weather timing, so it keeps the snapshot.
    const recon = buildAsOfState(later, at("2026-09-19"), "retrospective_reconstruction");
    expect(recon.provenance.overridesDroppedLater).toBe(1);
    expect(recon.input.races.find(r => r.id === "future")!.actualRunId).toBeUndefined();
  });
});

describe("retrospective reconstruction state", () => {
  const src = source();
  it("assumes back-filled workouts were available at completion, and says how many", () => {
    const state = buildAsOfState(src, at("2026-04-12"), "retrospective_reconstruction");
    expect(state.provenance.workoutsAvailabilityAssumed).toBeGreaterThan(0);
    expect(state.provenance.workoutsKnown).toBeGreaterThan(state.provenance.workoutsAvailabilityAssumed - 1);
    expect(state.input.asOfMode).toBeUndefined();
    expect(state.provenance.limitations.join(" ")).toMatch(/cannot be proven/);
  });
  it("keeps the early race out of evidence before its date and strips a future race's outcome and confirmations", () => {
    const s2 = { ...src, races: src.races.map(r => r.raceDate === TARGET ? { ...r, performanceEvidence: { status: "owner_confirmed" as const, kind: "race" as const, knownAt: "2026-10-01T00:00:00.000Z", raceDate: TARGET, distanceMeters: 21097.5, finishSeconds: 7871, effort: "maximal" as const, conditions: "x", source: "owner" } } : r) };
    const state = buildAsOfState(s2, at("2026-09-19"), "retrospective_reconstruction");
    const target = state.input.races.find(r => r.raceDate === TARGET)!;
    expect(target.actualRunId).toBeUndefined(); expect(target.actualRunDurationSeconds).toBeUndefined(); expect(target.performanceEvidence).toBeUndefined();
    expect(state.provenance.raceLinksStripped).toBeGreaterThan(0);
    expect(state.input.workouts.some(w => w.workoutId === "dc-run")).toBe(false);
  });
  it("windows VO₂ readings to the production window and never includes later ones", () => {
    const withVo2: BacktestSource = { ...src, vo2: [{ date: "2026-06-01", value: 49 }, { date: "2026-09-10", value: 50 }, { date: "2026-09-25", value: 52 }, { date: "2026-03-01", value: 47 }] };
    const state = buildAsOfState(withVo2, at("2026-09-19"), "retrospective_reconstruction");
    expect(state.vo2Entries.map(e => e.date)).toEqual(["2026-09-10"]);
  });
});

describe("no later outcome leaks into an earlier prediction", () => {
  it("is numerically invariant to the target race result, its link and any workout after the cutoff", () => {
    const a = source(), b = source({ targetSeconds: 6500 });
    const extra: HealthWorkout = { ...b.workouts.find(w => w.workoutId.startsWith("ord-"))!, workoutId: "heroic", startDate: new Date("2026-09-20T15:00:00Z"), endDate: new Date("2026-09-20T17:00:00Z"), syncedAt: new Date("2026-09-20T17:01:00Z"), durationSeconds: 3000, avgPaceSecPerMile: 300 };
    const b2: BacktestSource = { ...b, workouts: [...b.workouts, extra] };
    const cp = at("2026-09-19");
    const id = earlyRaceId(a);
    const rowA = evaluateCheckpoint(buildAsOfState(a, cp, "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } }), a, { forecastRaceId: a.races.find(r => r.raceDate === TARGET)!.id });
    const rowB = evaluateCheckpoint(buildAsOfState(b2, cp, "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } }), b2, { forecastRaceId: b2.races.find(r => r.raceDate === TARGET)!.id });
    const strip = (r: typeof rowA) => JSON.stringify({ ...r, provenance: undefined });
    expect(strip(rowB)).toBe(strip(rowA));
    expect(rowA.hybridV11.seconds).not.toBeNull();
  });
  it("does not use a confirmation revision that only became known after the instant", () => {
    const s = source();
    const early = s.races.find(r => r.raceDate === EARLY)!;
    const confirmed: BacktestSource = { ...s, races: s.races.map(r => r.id === early.id ? { ...r, performanceEvidence: { status: "verified" as const, kind: "official_race" as const, knownAt: "2026-10-15T00:00:00.000Z", raceDate: EARLY,
      distanceMeters: 21097.5, finishSeconds: 8130, effort: "maximal" as const, conditions: "cool", source: "official", timingReconciliation: "paused" } } : r) };
    const before = evaluateCheckpoint(buildAsOfState(confirmed, at("2026-09-19"), "retrospective_reconstruction"), confirmed, {});
    expect(before.official.seconds).toBeNull();
    expect(before.raceEvidence.find(e => e.raceDate === EARLY)!.reasons).toContain("confirmation_not_available_as_of");
    const after = evaluateCheckpoint(buildAsOfState(confirmed, "2026-10-20T10:00:00.000Z", "retrospective_reconstruction"), confirmed, {});
    expect(after.raceEvidence.find(e => e.raceDate === EARLY)!.status).toBe("verified");
  });
});

describe("early-race acceptance and rejection (clock counterfactuals)", () => {
  const src = source();
  const cp = at("2026-06-01"), id = earlyRaceId(src);
  it("rejects the early race under production rules because its recorded clocks disagree", () => {
    const row = evaluateCheckpoint(buildAsOfState(src, cp, "retrospective_reconstruction"), src, {});
    const evidence = row.raceEvidence.find(e => e.raceDate === EARLY)!;
    expect(evidence.status).toBe("inconsistent"); expect(evidence.timingAgreement).toBe("discrepant");
    expect(evidence.reasons).toContain("duration_elapsed_discrepancy");
    // The official estimator has no other anchor, so it abstains. v1.1 may still estimate from independent recent efforts, but the rejected race carries no weight.
    expect(row.official.seconds).toBeNull(); expect(row.hybridV11.raceShare).toBe(0);
    expect(row.provenance.counterfactual).toBeNull();
  });
  it.each([["moving_time" as const, 8130], ["elapsed_time" as const, 8759]])("labels and applies the %s counterfactual without touching the source", (basis, expected) => {
    const snapshot = JSON.stringify(src.workouts.find(w => w.workoutId === "hm-run"));
    const state = buildAsOfState(src, cp, "retrospective_reconstruction", { raceClock: { raceId: id, basis } });
    expect(state.provenance.counterfactual).toMatch(/counterfactual_research_only/);
    const row = evaluateCheckpoint(state, src, {});
    expect(row.official.seconds).not.toBeNull();
    expect(Math.abs(row.official.seconds! - expected)).toBeLessThan(expected * 0.03);
    expect(row.hybridV11.seconds).not.toBeNull();
    expect(JSON.stringify(src.workouts.find(w => w.workoutId === "hm-run"))).toBe(snapshot);
  });
  it("can exclude the early race entirely", () => {
    const state = buildAsOfState(src, cp, "retrospective_reconstruction", { excludeRaceIds: [id] });
    expect(state.input.races.find(r => r.id === id)!.actualRunId).toBeUndefined();
    expect(evaluateCheckpoint(state, src, {}).official.seconds).toBeNull();
  });
  it("can align ordinary-run elapsed time to moving time without touching the race run", () => {
    const withStops: BacktestSource = { ...src, workouts: src.workouts.map(w => w.workoutId.startsWith("ord-") ? { ...w, endDate: new Date(w.endDate.getTime() + 120_000) } : w) };
    const plain = buildAsOfState(withStops, cp, "retrospective_reconstruction");
    const aligned = buildAsOfState(withStops, cp, "retrospective_reconstruction", { alignElapsedToMovingForOrdinaryRuns: true });
    const elapsed = (w: { startDate: Date; endDate: Date }) => (w.endDate.getTime() - w.startDate.getTime()) / 1000;
    const ordinary = (st: typeof plain) => st.input.workouts.find(w => w.workoutId.startsWith("ord-"))!;
    expect(elapsed(ordinary(plain)) - ordinary(plain).durationSeconds).toBeCloseTo(120, 0);
    expect(elapsed(ordinary(aligned))).toBeCloseTo(ordinary(aligned).durationSeconds, 3);
    const race = (st: typeof plain) => st.input.workouts.find(w => w.workoutId === "hm-run")!;
    expect(elapsed(race(aligned))).toBe(elapsed(race(plain)));
  });
  it("never lets a counterfactual run in strict mode", () => {
    const state = buildAsOfState(src, cp, "strict_historical", { raceClock: { raceId: id, basis: "moving_time" } });
    expect(state.provenance.counterfactual).toBeNull();
  });
});

describe("owner-attested official result (research-only confirmation)", () => {
  const src = source(), id = earlyRaceId(src);
  const spec = (effort: "maximal" | "unknown" = "maximal"): OwnerConfirmationSpec => ({ raceId: id, finishSeconds: 8130, confirmedAt: "2026-05-20T12:00:00.000Z",
    retrospectiveKnownAt: "2026-04-27T01:00:00.000Z", effort, conditions: "cool, overcast", source: "owner attestation (no official URL checked)",
    timingReconciliation: "Recording began before the timed start; moving time equals the official finish." });
  const row = (instant: string, mode: "strict_historical" | "retrospective_reconstruction", effort: "maximal" | "unknown" = "maximal") =>
    evaluateCheckpoint(buildAsOfState(src, instant, mode, { ownerConfirmation: spec(effort) }), src, {});
  it("resolves the clock discrepancy through the supported official-race reconciliation without editing the workout", () => {
    const before = JSON.stringify(src.workouts.find(w => w.workoutId === "hm-run"));
    const r = row(at("2026-06-01"), "retrospective_reconstruction");
    const e = r.raceEvidence.find(x => x.raceDate === EARLY)!;
    expect(e.status).toBe("owner_confirmed"); expect(e.timingAgreement).toBe("reconciled");
    expect(e.finishSeconds).toBe(8130);
    expect(e.durationSeconds).toBeCloseTo(8130, 0); expect(e.elapsedSeconds).toBeCloseTo(8759, 0);   // original measurements preserved
    expect(r.official.seconds).not.toBeNull(); expect(r.provenance.counterfactual).toMatch(/retrospective_owner_confirmation_research_only/);
    expect(JSON.stringify(src.workouts.find(w => w.workoutId === "hm-run"))).toBe(before);
  });
  it("is unknown before its real confirmation instant in strict mode and known afterwards", () => {
    const early = row(at("2026-05-10"), "strict_historical");
    expect(early.official.seconds).toBeNull();
    expect(early.raceEvidence.find(x => x.raceDate === EARLY)!.reasons).toContain("confirmation_not_available_as_of");
    const late = row(at("2026-06-01"), "strict_historical");
    expect(late.official.seconds).not.toBeNull(); expect(late.provenance.counterfactual).toMatch(/^owner_confirmation: strict/);
  });
  it("is unknown before its assumed retrospective instant", () => {
    expect(row(at("2026-04-26", "05:00"), "retrospective_reconstruction").official.seconds).toBeNull();
  });
  it("does not make an anchor from the finish time alone: effort must be attested", () => {
    const r = row(at("2026-06-01"), "retrospective_reconstruction", "unknown");
    expect(r.official.seconds).toBeNull();
    expect(r.raceEvidence.find(x => x.raceDate === EARLY)!.reasons).toContain("maximal_effort_not_confirmed");
  });
  it("is overridden by an explicit exclusion and never applies to a future race", () => {
    const state = buildAsOfState(src, at("2026-06-01"), "retrospective_reconstruction", { ownerConfirmation: spec(), excludeRaceIds: [id] });
    expect(state.input.races.find(r => r.id === id)!.performanceEvidence).toBeUndefined();
    const target = src.races.find(r => r.raceDate === TARGET)!;
    const future = buildAsOfState(src, at("2026-06-01"), "retrospective_reconstruction", { ownerConfirmation: { ...spec(), raceId: target.id } });
    expect(future.input.races.find(r => r.id === target.id)!.performanceEvidence).toBeUndefined();
  });
  it("leaves the official-time anchor and every later checkpoint independent of the September result", () => {
    const b = source({ targetSeconds: 6500 });
    const cp = at("2026-09-19");
    const a = evaluateCheckpoint(buildAsOfState(src, cp, "retrospective_reconstruction", { ownerConfirmation: spec() }), src, {});
    const c = evaluateCheckpoint(buildAsOfState(b, cp, "retrospective_reconstruction", { ownerConfirmation: spec() }), b, {});
    expect(JSON.stringify({ ...c, provenance: undefined })).toBe(JSON.stringify({ ...a, provenance: undefined }));
  });
});

describe("checkpoint evaluation", () => {
  const src = source(), id = earlyRaceId(src);
  it("equals the shipped estimators called directly (no tuning, no formula change)", () => {
    const state = buildAsOfState(src, at("2026-08-01"), "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } });
    const row = evaluateCheckpoint(state, src, {});
    const official = estimateCurrentHalfMarathon(state.input), hr = estimateHrEnhancedHalfMarathon(state.input, { official });
    const v1 = estimateHybridHalfMarathon(state.input, { official, hrEnhanced: hr });
    const v11 = estimateHybridHalfMarathonV11(state.input, { official, hrEnhanced: hr, hybridV1: v1 });
    expect(row.official.seconds).toBeCloseTo(Math.round((official.baselineSeconds! + official.adjustmentSeconds) * 10) / 10, 1);
    expect(row.hybridV11.seconds).toBeCloseTo(Math.round(v11.seconds! * 10) / 10, 1);
    expect(row.hybridV1.seconds).toBeCloseTo(Math.round(v1.seconds! * 10) / 10, 1);
  });
  it("is deterministic and carries no workout identifiers", () => {
    const state = buildAsOfState(src, at("2026-08-01"), "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } });
    const one = JSON.stringify(evaluateCheckpoint(state, src, {})), two = JSON.stringify(evaluateCheckpoint(state, src, {}));
    expect(two).toBe(one);
    expect(one).not.toMatch(/ord-\d|strong-2026|hm-run|dc-run|"workoutId"/);
  });
  it("tolerates missing physiology and route-derived inputs", () => {
    const stripped: BacktestSource = { ...src, workouts: src.workouts.map(w => ({ ...w, hasRoute: false, hasHRStream: false, weather: undefined, bestEfforts: undefined })) };
    const state = buildAsOfState(stripped, at("2026-08-01"), "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } });
    expect(() => evaluateCheckpoint(state, stripped, { noVo2: true, noStreams: true })).not.toThrow();
    const row = evaluateCheckpoint(state, stripped, {});
    expect(row.hybridV11.missing.length).toBeGreaterThan(0);
  });
  it("reports forecast availability: absent after the race date, present (plan-less) before it", () => {
    const targetId = src.races.find(r => r.raceDate === TARGET)!.id;
    const opts = { raceClock: { raceId: id, basis: "moving_time" as const } };
    const before = evaluateCheckpoint(buildAsOfState(src, at("2026-09-01"), "retrospective_reconstruction", opts), src, { forecastRaceId: targetId });
    expect(before.forecast).not.toBeNull(); expect(before.forecast!.plan).toBe("no_plan_created_by_cutoff"); expect(before.forecast!.planStateProvable).toBe(false);
    const raceDay = evaluateCheckpoint(buildAsOfState(src, at(TARGET, "05:00"), "retrospective_reconstruction", opts), src, { forecastRaceId: targetId });
    expect(raceDay.forecast).toBeNull();
  });
});

describe("outcome conventions and calibration status", () => {
  it("uses predicted − actual and returns null rather than a zero for an unavailable prediction", () => {
    expect(predictionError(7871 + 300, 7871)).toBe(300); expect(predictionError(7871 - 120, 7871)).toBe(-120);
    expect(predictionError(null, 7871)).toBeNull(); expect(predictionError(8000, null)).toBeNull();
  });
  it("never reports two unqualified outcomes as evaluable and keeps the five-outcome requirement", () => {
    const h = holdoutAssessment([{ raceDate: EARLY, qualified: false, reasons: ["a"] }, { raceDate: TARGET, qualified: false, reasons: ["b"] }]);
    expect(h.evaluable).toBe(false); expect(h.required).toBe(5); expect(h.qualified).toBe(0);
    expect(h.label).toBe("Historical case study — insufficient independent outcomes for scientific validation.");
    expect(holdoutAssessment(Array.from({ length: 4 }, (_, i) => ({ raceDate: `2026-0${i + 1}-01`, qualified: true, reasons: [] }))).evaluable).toBe(false);
    expect(holdoutAssessment(Array.from({ length: 5 }, (_, i) => ({ raceDate: `2026-0${i + 1}-01`, qualified: true, reasons: [] }))).evaluable).toBe(true);
  });
  it("explains a change from the model's own decomposition and handles unavailable rows", () => {
    const src = source(), id = earlyRaceId(src);
    const rows = ["2026-06-01", "2026-06-15"].map(d => evaluateCheckpoint(buildAsOfState(src, at(d), "retrospective_reconstruction", { raceClock: { raceId: id, basis: "moving_time" } }), src, {}));
    expect(explainChange(null, rows[0])).toBe("first checkpoint");
    expect(explainChange(rows[0], rows[1])).toMatch(/faster by|slower by|no material change/);
    const none = evaluateCheckpoint(buildAsOfState(src, at("2026-03-29"), "strict_historical"), src, {}); // nothing synced yet
    expect(explainChange(none, none)).toMatch(/still unavailable/);
  });
});

describe("research isolation", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  it("no live source imports the historical backtest toolkit", () => {
    expect(walk("src").filter(f => /research\/historicalBacktest/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("the toolkit never writes: no Firestore, fs or network client is imported", () => {
    expect(readFileSync("src/utils/research/historicalBacktest.ts", "utf8")).not.toMatch(/from "(firebase|firebase-admin|node:fs|fs)/);
  });
});
