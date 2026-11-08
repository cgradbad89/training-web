/**
 * Owner-approved, estimator-level assumption: confirmed `hard`/`nonmaximal` races anchor the estimators as MAXIMAL efforts for prediction only.
 * One shared adapter (`treatConfirmedRacesAsMaximal`); invented data only; confirmations use the real versioned `confirmationHistory` schema.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import { confirmedRaceFixture } from "../../__tests__/fixtures/raceConfirmationFixture";
import { cadenceRuns, halfRace } from "../../__tests__/fixtures/policyStudyFixture";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { evaluateRacePerformance, buildRaceEvidence } from "../../racePerformance";
import { estimateHybridHalfMarathon } from "../hybridPerformance";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { estimateRaceDayForecast } from "../raceDayForecast";
import { assumedMaximalRaceCount, treatConfirmedRacesAsMaximal } from "../confirmedRaceAssumption";

const TZ = "America/New_York";
type Effort = "maximal" | "hard" | "nonmaximal" | "unknown";
interface Spec { id: string; date: string; seconds: number; effort: Effort; availableAt?: string | null; elapsed?: number; reconciliation?: string }
type R = { race: Race; workout: HealthWorkout };

function historyRace(s: Spec): R {
  const f = confirmedRaceFixture({ id: s.id, date: s.date, seconds: s.seconds, elapsed: s.elapsed, availableAt: s.availableAt === null ? undefined : s.availableAt });
  f.revision.details.effort = s.effort;
  if (s.reconciliation) f.revision.details.timingReconciliation = s.reconciliation;
  if (s.availableAt === null) f.revision.availableAt = null;
  f.workout.avgHeartRate = 168; f.workout.hasRoute = true;
  return { race: f.race, workout: f.workout };
}
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const world = (rs: R[], asOfDate: string, runs: { gaps?: number[]; miles?: number[]; start?: string } = {}) => ({
  races: rs.map(r => r.race), overrides: {}, timeZone: TZ, asOf: `${asOfDate}T17:00:00.000Z`,
  workouts: [...cadenceRuns({ start: runs.start ?? "2025-08-04", end: addDay(asOfDate, -1), gaps: runs.gaps ?? [2, 2, 3], miles: runs.miles ?? [5, 6, 5, 8] }), ...rs.map(r => r.workout)] });

/** All five estimators on one world, optionally through the shared adapter (as the app does). */
function five(rs: R[], asOfDate: string, adapted: boolean, opts: { raceDate?: string; strictMaximalOnly?: boolean; runs?: { gaps?: number[]; miles?: number[]; start?: string } } = {}) {
  const w = world(rs, asOfDate, opts.runs);
  const input = { ...w, races: adapted ? treatConfirmedRacesAsMaximal(w.races) : w.races };
  const official = estimateCurrentHalfMarathon(input);
  const hr = estimateHrEnhancedHalfMarathon(input, { official });
  const v1 = estimateHybridHalfMarathon(input, { official, hrEnhanced: hr });
  const v11 = estimateHybridHalfMarathonV11(input, { official, hrEnhanced: hr, hybridV1: v1, strictMaximalOnly: opts.strictMaximalOnly });
  const forecast = estimateRaceDayForecast(input, { raceDate: opts.raceDate ?? addDay(asOfDate, 130), plan: null, hybrid: v11, official, hrEnhanced: hr, hybridV1: v1, strictMaximalOnly: opts.strictMaximalOnly });
  const sec = official.baselineSeconds === null || official.finishMinutes === null ? null : official.baselineSeconds + official.adjustmentSeconds;
  return { official, officialSeconds: sec, hrSeconds: hr.candidateSeconds ?? null, v1, v11, forecast };
}
const SEP = (effort: Effort, extra: Partial<Spec> = {}) => historyRace({ id: "sep", date: "2026-09-20", seconds: 7871, effort, ...extra });
const NOW = "2026-11-10";

describe("the shared adapter", () => {
  it("re-reads hard and nonmaximal as maximal in a COPY (history and legacy shapes); maximal, unknown and unconfirmed are untouched", () => {
    const rs = [SEP("hard").race, SEP("nonmaximal").race, SEP("maximal").race, SEP("unknown").race, halfRace("u", "2026-09-20", 7871, "none").race, halfRace("l", "2026-09-20", 7871, "hard" as never).race];
    const before = structuredClone(rs);
    const out = treatConfirmedRacesAsMaximal(rs);
    const effort = (r: Race) => { const h = r.confirmationHistory; return h ? Object.values(h.revisions).map(v => v.details.effort) : r.performanceEvidence ? [r.performanceEvidence.effort] : []; };
    expect(out.map(effort)).toEqual([["maximal"], ["maximal"], ["maximal"], ["unknown"], [], ["maximal"]]);
    expect(rs).toEqual(before);                                           // the stored/input records are never mutated
    expect(effort(rs[0])).toEqual(["hard"]); expect(effort(rs[1])).toEqual(["nonmaximal"]);
    expect(out[2]).toBe(rs[2]); expect(out[3]).toBe(rs[3]); expect(out[4]).toBe(rs[4]);   // unchanged races keep their identity
    expect(assumedMaximalRaceCount(rs)).toBe(3);
  });
  it("keeps every other field byte for byte (times, notes, timestamps, history chain) and tolerates malformed history", () => {
    const r = SEP("hard", { availableAt: "2026-11-08T19:08:25.016Z" }).race;
    const [out] = treatConfirmedRacesAsMaximal([r]);
    const a = r.confirmationHistory!, b = out.confirmationHistory!;
    const rev = (h: typeof a) => Object.values(h.revisions)[0];
    expect({ ...rev(b), details: { ...rev(b).details, effort: "x" } }).toEqual({ ...rev(a), details: { ...rev(a).details, effort: "x" } });
    expect(b.currentRevisionId).toBe(a.currentRevisionId);
    expect(treatConfirmedRacesAsMaximal([{ ...r, confirmationHistory: null }])[0].confirmationHistory).toBeNull();
    expect(() => treatConfirmedRacesAsMaximal([{ ...r, confirmationHistory: { revisions: null } as never }])).not.toThrow();
  });
});

describe("all five estimators with a confirmed September race (7,871 s) as of 2026-11-10", () => {
  it("without the assumption a hard/nonmaximal confirmation removes the anchor from v2, HR-enhanced and v1; with it every model is restored", () => {
    for (const effort of ["hard", "nonmaximal"] as const) {
      const off = five([SEP(effort)], NOW, false), on = five([SEP(effort)], NOW, true);
      expect(off.official.status).toBe("insufficient_evidence"); expect(off.officialSeconds).toBeNull(); expect(off.hrSeconds).toBeNull(); expect(off.v1.seconds).toBeNull();
      expect(off.v11.demonstrated.basis).toBe("demonstrated_performance_only");
      expect(off.forecast.withheldCause).toBe("demonstrated_performance_only");
      expect(on.official.status).toBe("experimental"); expect(on.officialSeconds).not.toBeNull(); expect(on.hrSeconds).not.toBeNull(); expect(on.v1.seconds).not.toBeNull();
      expect(on.v11.seconds).not.toBeNull(); expect(on.forecast.status).toBe("provisional"); expect(on.forecast.seconds).not.toBeNull();
    }
  });
  it("hard, nonmaximal and truly maximal produce IDENTICAL numbers in every model: one consistent assumption", () => {
    const m = five([SEP("maximal")], NOW, true);
    for (const effort of ["hard", "nonmaximal"] as const) {
      const x = five([SEP(effort)], NOW, true);
      expect(x.officialSeconds).toBe(m.officialSeconds); expect(x.hrSeconds).toBe(m.hrSeconds); expect(x.v1.seconds).toBe(m.v1.seconds);
      expect(x.v11.seconds).toBe(m.v11.seconds); expect(x.forecast.seconds).toBe(m.forecast.seconds);
    }
  });
  it("hybrid v1.1 uses its NORMAL path (confirmed race, maximal evidence basis), not a demonstrated-only label", () => {
    const x = five([SEP("hard")], NOW, true);
    expect(x.v11.demonstrated.basis).toBe("maximal_or_recorded_evidence");
    expect(x.v11.flags).not.toContain("demonstrated_performance_only");
    expect(x.v11.combination.items.some(i => i.kind === "confirmed_race")).toBe(true);
    expect(x.officialSeconds!).toBeGreaterThan(7871 * 0.98); expect(x.officialSeconds!).toBeLessThan(7871 * 1.02);
  });
  it("an unconfirmed race is unaffected: the adapter returns the very same records and the same numbers", () => {
    const u = halfRace("u", "2026-09-20", 7871, "none");
    const rs = [u.race];
    expect(treatConfirmedRacesAsMaximal(rs)[0]).toBe(rs[0]);
    const off = five([u], NOW, false), on = five([u], NOW, true);
    expect(on.officialSeconds).toBe(off.officialSeconds); expect(on.v11.seconds).toBe(off.v11.seconds); expect(on.forecast.seconds).toBe(off.forecast.seconds);
    expect(on.official.anchor?.status).toBe("recorded_unverified");
  });
  it("the demonstrated-race policy does not conflict: with the assumption on, switching it off changes nothing; with the assumption off it still rescues v1.1", () => {
    const a = five([SEP("hard")], NOW, true), b = five([SEP("hard")], NOW, true, { strictMaximalOnly: true });
    expect(b.v11.seconds).toBe(a.v11.seconds); expect(b.forecast.seconds).toBe(a.forecast.seconds);
    const rollback = five([SEP("hard")], NOW, false);
    expect(rollback.v11.seconds).not.toBeNull();
    expect(rollback.v11.demonstrated.basis).toBe("demonstrated_performance_only");
  });
});

describe("integrity protections are unchanged", () => {
  const APR = (over: Partial<Spec> = {}) => historyRace({ id: "apr", date: "2026-04-26", seconds: 8130, effort: "nonmaximal", elapsed: 8759, availableAt: "2026-04-27T22:32:00.000Z", ...over });
  it("an unexplained timing discrepancy is still inconsistent and anchors nothing; the explained one anchors while current", () => {
    const bad = five([APR()], "2026-06-01", true);
    expect(bad.official.status).toBe("insufficient_evidence"); expect(bad.v11.seconds).toBeNull();
    const ok = five([APR({ reconciliation: "The recording began about 10 minutes 29 seconds before the timed start." })], "2026-06-01", true);
    expect(ok.official.status).toBe("experimental"); expect(ok.officialSeconds!).toBeGreaterThan(8130 * 0.98); expect(ok.officialSeconds!).toBeLessThan(8130 * 1.03);
  });
  it("a corrupt history, a revision not yet available, an unresolved receipt and a strict historical replay all abstain", () => {
    const corrupt = SEP("hard"); corrupt.race.confirmationHistory = { ...corrupt.race.confirmationHistory!, currentRevisionId: "missing" };
    expect(five([corrupt], NOW, true).official.status).toBe("insufficient_evidence");
    expect(five([SEP("hard", { availableAt: "2026-12-01T16:00:00.000Z" })], NOW, true).official.anchor?.status).toBe("recorded_unverified");   // confirmation invisible; only the unchanged recorded path
    expect(five([SEP("hard", { availableAt: null })], NOW, true).official.anchor?.status).not.toBe("verified");
    const w = world([SEP("hard")], NOW);
    const hist = estimateHybridHalfMarathonV11({ ...w, races: treatConfirmedRacesAsMaximal(w.races), asOfMode: "historical" } as never);
    expect(hist.status).toBe("unavailable");
  });
  it("historical availability: the confirmation anchors only from its receipt time", () => {
    const sep = SEP("hard", { availableAt: "2026-11-08T19:08:25.016Z" });
    expect(estimateCurrentHalfMarathon({ ...world([sep], "2026-11-08"), asOf: "2026-11-08T12:00:00.000Z", races: treatConfirmedRacesAsMaximal([sep.race]) }).anchor?.status).toBe("recorded_unverified");
    expect(estimateCurrentHalfMarathon({ ...world([sep], "2026-11-08"), asOf: "2026-11-08T20:00:00.000Z", races: treatConfirmedRacesAsMaximal([sep.race]) }).anchor?.status).toBe("verified");
  });
  it("the 180-day limit is unchanged: anchors through day 180, expired from day 181; April is expired for current capability while September anchors", () => {
    const race = () => historyRace({ id: "r", date: "2026-03-15", seconds: 8130, effort: "hard", availableAt: "2026-03-16T16:00:00.000Z" });
    expect(five([race()], addDay("2026-03-15", 180), true).official.anchor?.status).toBe("verified");
    const late = five([race()], addDay("2026-03-15", 181), true);
    expect(late.official.anchor).toBeNull(); expect(late.v11.status).toBe("unavailable"); expect(late.v11.unavailableCause).toBe("anchor_expired_no_contemporary_evidence");
    const both = five([historyRace({ id: "apr", date: "2026-04-26", seconds: 8130, effort: "nonmaximal", elapsed: 8759, reconciliation: "Recording began before the timed start.", availableAt: "2026-11-08T19:08:32.269Z" }), SEP("hard", { availableAt: "2026-11-08T19:08:25.016Z" })], NOW, true);
    expect(both.official.anchor?.raceDate).toBe("2026-09-20");
    expect(both.v11.qualification.base.expired.some(e => e.date === "2026-04-26")).toBe(true);
    expect(both.v11.combination.items.some(i => i.date === "2026-04-26")).toBe(false);
  });
});

describe("race-day forecast keeps its ordinary safeguards", () => {
  it("is available when ordinary evidence and planning requirements hold, and still withheld for the unrelated reasons", () => {
    expect(five([SEP("hard")], NOW, true).forecast.status).toBe("provisional");
    expect(five([SEP("hard")], NOW, true, { raceDate: "2026-11-01" }).forecast.withheldCause).toBe("race_date_invalid_or_past");
    expect(five([SEP("hard")], NOW, true, { raceDate: "2027-09-01" }).forecast.withheldCause).toBe("horizon_too_long");
    // Fewer than four recent weeks with runs: endurance preparation is unknown, so the forecast has no basis (an unrelated safeguard, not bypassed).
    const thin = five([SEP("hard")], NOW, true, { runs: { start: "2026-10-28" } });
    expect(thin.v11.seconds).not.toBeNull();
    expect(thin.forecast).toMatchObject({ status: "withheld", withheldCause: "insufficient_endurance_basis" });
  });
});

describe("source evidence and subjective effort information are preserved", () => {
  it("evidence reporting and validation keep the TRUE classification; the assumption never reaches them", () => {
    const hard = SEP("hard"), non = SEP("nonmaximal");
    const ev = (r: R) => buildRaceEvidence({ races: [r.race], workouts: [r.workout], overrides: {}, asOf: `${NOW}T17:00:00.000Z`, timeZone: TZ })[0];
    expect(ev(hard).effort).toBe("hard"); expect(ev(non).effort).toBe("nonmaximal");
    expect(ev(hard).eligibleForEquivalence).toBe(false); expect(ev(hard).reasons).toContain("maximal_effort_not_confirmed");
    const w = world([hard], NOW);
    const performance = evaluateRacePerformance({ races: w.races, workouts: w.workouts, overrides: {}, asOf: w.asOf, timeZone: TZ });
    expect(performance.evidence.find(e => e.raceDate === "2026-09-20")?.effort).toBe("hard");
    expect(performance.evidence.find(e => e.raceDate === "2026-09-20")?.eligibleForEquivalence).toBe(false);
  });
  it("running the estimators never mutates the stored races, and a subjective-effort note has no numerical effect", () => {
    const text = (t: string) => { const r = SEP("hard"); Object.values(r.race.confirmationHistory!.revisions)[0].details.conditions = t; return r; };
    const base = text("Owner-described effort approximately 90% (subjective, not a physiological measurement).");
    const snapshot = structuredClone(base.race);
    const a = five([base], NOW, true);
    expect(base.race).toEqual(snapshot);
    for (const t of ["Owner-described effort approximately 50% (subjective).", "Easy long run pace.", "Owner note."]) {
      const b = five([text(t)], NOW, true);
      expect([b.officialSeconds, b.hrSeconds, b.v1.seconds, b.v11.seconds, b.forecast.seconds]).toEqual([a.officialSeconds, a.hrSeconds, a.v1.seconds, a.v11.seconds, a.forecast.seconds]);
    }
  });
});

describe("one shared assumption across every current-estimate surface", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
  it("every app surface that feeds races to an estimator goes through the adapter (and research/validation code never does)", () => {
    const calls = /\b(estimateCurrentHalfMarathon|estimateHrEnhancedHalfMarathon|estimateHybridHalfMarathon|estimateHybridHalfMarathonV11|estimateRaceDayForecast|computeCurrentHalfRunImpact|computeHrEnhancedRunImpact)\(/;
    const surfaces = [...walk("src/components"), ...walk("src/hooks"), ...walk("src/app")].filter(f => calls.test(readFileSync(f, "utf8")));
    expect(surfaces.length).toBeGreaterThanOrEqual(3);
    for (const f of surfaces) expect(readFileSync(f, "utf8"), f).toMatch(/treatConfirmedRacesAsMaximal/);
    const research = [...walk("src/utils/research"), "scripts/researchHybrid.ts"].filter(f => { try { return statSync(f).isFile(); } catch { return false; } });
    for (const f of research) expect(readFileSync(f, "utf8"), f).not.toMatch(/treatConfirmedRacesAsMaximal/);
  });
});
