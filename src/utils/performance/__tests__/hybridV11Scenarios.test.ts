import { describe, expect, it } from "vitest";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { estimateHybridHalfMarathon, HYBRID_VERSION } from "../hybridPerformance";
import { estimateHybridHalfMarathonV11, HYBRID_V11_VERSION } from "../hybridPerformanceV11";
import { estimateRaceDayForecast } from "../raceDayForecast";
import { athleteV11, distanceRace, type AthleteV11Options } from "../../__tests__/fixtures/hybridV11Fixture";
import type { Vo2Entry } from "@/utils/vo2History";
import type { RunningPlan } from "@/types/plan";

const PLAN: RunningPlan = { id: "p", name: "Spring HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "x", updatedAt: "x",
  weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 }, { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) }] })) };
const eff = (date: string, miles: number, pace: number, hr = 172) => ({ date, miles, pace, hr });
const OLD = "2026-07-30"; // 100 days before the fixture's as-of (2026-11-07)
const improved = [eff("2026-10-02", 6, 548), eff("2026-10-16", 7, 552), eff("2026-10-28", 6, 546)];
const slowerHard = [eff("2026-10-02", 6, 590, 172), eff("2026-10-16", 7, 594, 172), eff("2026-10-28", 6, 592, 172)];
const est = (o: AthleteV11Options = {}, extra = {}) => estimateHybridHalfMarathonV11(athleteV11(o), extra);
const v1 = (o: AthleteV11Options = {}) => estimateHybridHalfMarathon(athleteV11(o));
const pct = (a: number, b: number) => (a / b - 1) * 100;
const RACE = 7870.75;
const dayBefore = (n: number) => new Date(Date.parse("2026-11-06T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);
/** Apple Health VO₂ readings: six in the recent 28-day window and six in the prior one (the model's two comparison windows). */
const vo2Series = (recent: number, prior: number): Vo2Entry[] => [
  ...Array.from({ length: 6 }, (_, i) => ({ date: dayBefore(i * 4), value: recent })),
  ...Array.from({ length: 6 }, (_, i) => ({ date: dayBefore(30 + i * 4), value: prior })),
];

describe("contract and versioning", () => {
  it("v1.1 is a separate, experimental, never-validated model; v1 keeps its own version", () => {
    const e = est({ raceDate: OLD });
    expect(e.version).toBe(HYBRID_V11_VERSION); expect(e.version).toBe("experimental-hybrid-hm-v1.1");
    expect(HYBRID_VERSION).toBe("experimental-hybrid-hm-v1");
    expect(e.validated).toBe(false); expect(e.researchStatus).toBe("experimental_provisional");
    expect(e.contributions.map(c => c.family)).toEqual(["demonstrated_performance", "physiological_trend", "race_history", "endurance_readiness"]);
    expect(e.sensitivityRange!.basis).toMatch(/Not a statistical interval/); expect(e.assumptions.join(" ")).toMatch(/No calibrated confidence interval/);
    expect(e.paceSecondsPerMile! % 5).toBe(0); expect(e.confidence === "low" || e.confidence === "moderate").toBe(true);
  });
  it("rejects an invalid cutoff", () => { expect(() => estimateHybridHalfMarathonV11({ ...athleteV11(), asOf: "x" })).toThrow(TypeError); });
  it("v1 estimates are never relabelled: the comparison carries v1 separately", () => {
    const a = athleteV11({ raceDate: OLD, segments: [] });
    const one = estimateHybridHalfMarathon(a), two = estimateHybridHalfMarathonV11(a, { hybridV1: one });
    expect(one.version).toBe("experimental-hybrid-hm-v1"); expect(two.comparison.hybridV1Seconds).toBe(one.seconds);
    expect(two.comparison.differenceVsHybridV1Seconds).toBeCloseTo(two.seconds! - one.seconds!, 9);
  });
});

describe("existing models are numerically invariant (golden values captured from pristine origin/main before any change)", () => {
  const GOLDEN: Record<string, { o: AthleteV11Options; official: number; hr: number | null; hybrid: number; forecast: number }> = {
    baseline: { o: { envelope: false }, official: 7870.75, hr: 7870.75, hybrid: 7872.267930357137, forecast: 7969.2969321753635 },
    efforts: { o: { envelope: false, strong: [eff("2026-10-10", 6, 560), eff("2026-10-24", 6.5, 555)] }, official: 7870.75, hr: 7870.75, hybrid: 7814.161341495516, forecast: 7919.4603494362755 },
    faster_at_hr: { o: { envelope: false, paceChangeFrom: "2026-09-25", paceFactorAfter: 0.95 }, official: 7870.75, hr: 7792.052838586163, hybrid: 7787.808325954033, forecast: 7884.837327772258 },
  };
  for (const [name, g] of Object.entries(GOLDEN)) it(`${name}: official v2, HR-enhanced, hybrid v1 and forecast v1 are unchanged`, () => {
    const a = athleteV11(g.o);
    const official = estimateCurrentHalfMarathon(a), hr = estimateHrEnhancedHalfMarathon(a, { official });
    const hy = estimateHybridHalfMarathon(a, { official, hrEnhanced: hr });
    const fc = estimateRaceDayForecast(a, { raceDate: "2027-03-20", plan: PLAN, hybrid: hy, official, hrEnhanced: hr });
    expect(official.baselineSeconds! + official.adjustmentSeconds).toBeCloseTo(g.official, 9);
    expect(hr.candidateSeconds).toBe(g.hr === null ? null : hr.candidateSeconds); if (g.hr !== null) expect(hr.candidateSeconds!).toBeCloseTo(g.hr, 9);
    expect(hy.seconds!).toBeCloseTo(g.hybrid, 9); expect(fc.seconds!).toBeCloseTo(g.forecast, 9); expect(fc.version).toBe("experimental-raceday-forecast-v1");
    expect(fc.currentCapabilityModel).toBe("experimental-hybrid-hm-v1");
  });
  it("computing v1.1 never mutates its inputs or the other estimators' results", () => {
    const a = athleteV11({ raceDate: OLD, strong: improved }), before = JSON.stringify(estimateHybridHalfMarathon(a).seconds);
    estimateHybridHalfMarathonV11(a); estimateHybridHalfMarathonV11(a);
    expect(JSON.stringify(estimateHybridHalfMarathon(a).seconds)).toBe(before);
  });
});

describe("Scenario C — old race, only easy running: no fabricated change, uncertainty grows", () => {
  it("the race equivalent stays the point estimate at any age and the result stays provisional / low confidence", () => {
    const e = est({ raceDate: OLD });
    expect(e.combination.baseSeconds!).toBeCloseTo(RACE, 6); expect(e.combination.raceShare).toBe(1);
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(0.7); expect(e.status).toBe("provisional"); expect(e.confidence).toBe("low");
    expect(e.influence.raceDominance).toBe("dominant"); expect(e.influence.newerEvidenceDisplacedRace).toBe(false);
    expect(e.confidenceRestrictions).toContain("race_age");
    expect(e.influence.provisionalReasons).toContain("The estimate is dominated by a race over 42 days old.");
  });
  it("a 20-day-old and a 150-day-old race give the same evidence base; only the uncertainty differs", () => {
    const young = est({ raceDate: "2026-10-18" }), old = est({ raceDate: "2026-06-10" });
    expect(young.combination.baseSeconds!).toBeCloseTo(old.combination.baseSeconds!, 6);
    expect(old.combination.uncertaintyFraction!).toBeGreaterThan(young.combination.uncertaintyFraction!);
    expect(old.influence.latestRaceAgeDays!).toBeGreaterThan(young.influence.latestRaceAgeDays!);
  });
  it("race expiry at 180 days remains an explicit, documented state transition (no silent authority afterwards)", () => {
    const at = (days: number) => estimateHybridHalfMarathonV11(athleteV11({ raceDate: "2026-04-01", asOf: `${new Date(Date.parse("2026-04-01T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10)}T16:00:00.000Z` }));
    expect(at(180).seconds).not.toBeNull();
    const after = at(181);
    expect(after.status).toBe("unavailable"); expect(after.unavailableCause).toBe("anchor_expired_no_contemporary_evidence"); expect(after.seconds).toBeNull();
  });
});

describe("Scenario A — 100-day-old race, genuine improvement shown by several independent strong efforts", () => {
  const e = est({ raceDate: OLD, strong: improved });
  it("moves meaningfully toward the recent evidence rather than staying anchored at the race", () => {
    const c = e.combination, gap = c.raceOnlySeconds! - c.recentOnlySeconds!;
    expect(gap).toBeGreaterThan(0);
    const moved = (c.raceOnlySeconds! - c.baseSeconds!) / gap;
    expect(moved).toBeGreaterThan(0.3); expect(moved).toBeLessThan(0.8);               // partway, by evidence mass: not a jump to the efforts
    expect(e.seconds!).toBeLessThan(RACE - 60);
    expect(e.influence.displacementSeconds!).toBeLessThan(-60);
  });
  it("race influence is explicit, below the majority, and reconciles with the calculation", () => {
    const i = e.influence;
    expect(i.raceShare + i.recentShare).toBeCloseTo(1, 12); expect(i.raceShare).toBeLessThan(0.65); expect(i.independentObservations).toBe(4);
    expect(i.latestRaceAgeDays).toBe(100); expect(i.latestRaceDate).toBe(OLD);
    const rebuilt = Math.exp(e.combination.items.reduce((s, x) => s + x.effectiveShare * Math.log(x.equivalentSeconds), 0));
    expect(rebuilt).toBeCloseTo(e.combination.baseSeconds!, 6);
  });
  it("v1 would show the same ordering but v1.1 does not depend on a decay constant: it is evidence-mass driven", () => {
    const two = est({ raceDate: OLD, strong: improved.slice(0, 2) }), three = e;
    expect(three.combination.raceShare).toBeLessThan(two.combination.raceShare);
  });
  it("the illustrative 2:05 is not a target: the result is whatever the evidence supports", () => {
    expect(e.seconds!).toBeGreaterThan(7500); expect(e.seconds!).toBeLessThan(RACE);
  });
});

describe("Scenario D — old race plus ONE anomalous fast effort: no large unsupported jump", () => {
  it("is down-weighted as isolated and moves far less than v1 does", () => {
    const o = { raceDate: OLD, strong: [eff("2026-10-28", 6, 520)] } as AthleteV11Options;
    const e = est(o), old = v1(o);
    expect(e.flags).toContain("isolated_uncorroborated_effort");
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(1.6);
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(Math.abs(pct(old.seconds!, RACE)));
    expect(e.status).toBe("provisional"); expect(e.confidence).toBe("low");
  });
});

describe("Scenario B — 100-day-old race, genuine deterioration", () => {
  it("multiple independent slower hard efforts plus a sustained decline in pace at the same heart rate move the estimate slower", () => {
    const e = est({ raceDate: OLD, strong: slowerHard, paceChangeFrom: "2026-09-01", paceFactorAfter: 1.06 });
    expect(e.physiology!.classification).toBe("observed_decline"); expect(e.contributions[1].fraction).toBeGreaterThan(0);
    expect(e.seconds!).toBeGreaterThan(RACE * 1.02); expect(e.seconds!).toBeLessThan(RACE * 1.08);
    expect(e.combination.recentShare).toBeGreaterThan(0);
    expect(e.combination.items.filter(i => i.group === "recent_effort").every(i => i.flags.includes("slower_than_estimate_lower_bound"))).toBe(true);
  });
  it("is more responsive to genuine decline than v1, which ignored slower unconfirmed efforts altogether", () => {
    const o = { raceDate: OLD, strong: slowerHard, paceChangeFrom: "2026-09-01", paceFactorAfter: 1.06 } as AthleteV11Options;
    expect(est(o).seconds!).toBeGreaterThan(v1(o).seconds!);
  });
  it("slow EASY running (slower pace at proportionally lower heart rate) is not proof of deterioration", () => {
    const a = athleteV11({ raceDate: OLD });
    const slowEasy = { ...a, workouts: a.workouts.map(w => w.workoutId.startsWith("ord-") && w.startDate >= new Date("2026-09-01T00:00:00Z")
      ? { ...w, durationSeconds: w.durationSeconds, avgPaceSecPerMile: w.avgPaceSecPerMile! * 1.08, avgHeartRate: (w.avgHeartRate ?? 146) - 12 } : w) };
    const e = estimateHybridHalfMarathonV11(slowEasy);
    expect(e.physiology!.classification).not.toBe("observed_decline");
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(1);
  });
  it("a single slow hard effort is not proof of decline", () => {
    const e = est({ raceDate: OLD, strong: [slowerHard[1]] });
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(1);
  });
});

describe("Scenario E — consistent heart-rate efficiency improvement (physiological evidence) — never a new maximal effort", () => {
  const o = { raceDate: OLD, paceChangeFrom: "2026-09-10", paceFactorAfter: 0.96 } as AthleteV11Options;
  it("is considered, bounded and shrunk, with the demonstrated base untouched", () => {
    const e = est(o), plain = est({ raceDate: OLD });
    expect(e.physiology!.classification).toBe("observed_improvement");
    expect(e.combination.baseSeconds!).toBeCloseTo(plain.combination.baseSeconds!, 6);   // evidence base is untouched: physiology is not a performance observation
    expect(e.seconds!).toBeLessThan(plain.seconds!); expect(Math.abs(e.contributions[1].fraction)).toBeLessThanOrEqual(0.02);
    expect(e.contributions[1].influence).toBeLessThan(1);
    expect(e.influence.physiologicalTrendApplied).toBe(true);
  });
  it("VO₂ that agrees is disclosed but adds no numerical term and does not raise confidence", () => {
    const none = est(o), agree = est(o, { vo2Entries: vo2Series(47.8, 46.5) });
    expect(agree.inputs.vo2.direction).toBe("improving"); expect(agree.inputs.vo2.corroboration).toBe("agrees"); expect(agree.inputs.vo2.effect).toBe("corroboration_disclosed_only");
    expect(agree.seconds!).toBeCloseTo(none.seconds!, 9); expect(agree.confidence).toBe(none.confidence);
  });
  it("VO₂ that disagrees raises the physiological uncertainty (smaller influence, same sign) and is flagged", () => {
    const none = est(o), dis = est(o, { vo2Entries: vo2Series(46.5, 47.8) });
    expect(dis.inputs.vo2.corroboration).toBe("disagrees"); expect(dis.inputs.vo2.effect).toBe("raised_physiological_uncertainty"); expect(dis.flags).toContain("vo2_disagrees");
    expect(dis.contributions[1].influence).toBeLessThan(none.contributions[1].influence);
    expect(dis.seconds!).toBeGreaterThanOrEqual(none.seconds!); expect(dis.confidence).toBe("low");
  });
});

describe("Scenario F — 100-day-old race plus a new verified 10K", () => {
  it("influences current capacity according to recency, distance relevance and evidence quality", () => {
    const tenK = distanceRace("tenk", "2026-10-24", 10000, 3480, true, "10K");     // 58:00, owner-confirmed maximal
    const a = athleteV11({ raceDate: OLD });
    const input = { ...a, races: [...a.races, tenK.race], workouts: [...a.workouts, tenK.workout] };
    const e = estimateHybridHalfMarathonV11(input);
    const k = e.combination.items.find(i => i.kind === "confirmed_race")!, hm = e.combination.items.find(i => i.kind === "recorded_race")!;
    expect(k).toBeDefined(); expect(k.sourceDistanceMeters).toBe(10000); expect(k.extrapolationRatio).toBeCloseTo(2.11, 2);
    expect(k.equivalentSeconds).not.toBeCloseTo(hm.equivalentSeconds, -1);
    expect(k.ageDays).toBeLessThan(hm.ageDays);
    const lo = Math.min(k.equivalentSeconds, hm.equivalentSeconds), hi = Math.max(k.equivalentSeconds, hm.equivalentSeconds);
    expect(e.combination.baseSeconds!).toBeGreaterThan(lo); expect(e.combination.baseSeconds!).toBeLessThan(hi);
    expect(k.effectiveShare).toBeGreaterThan(0.2); expect(hm.effectiveShare).toBeGreaterThan(0.2);   // both matter; neither is ignored
    expect(e.combination.race!.count).toBe(2);
  });
});

describe("Scenario G — contradictory signals are reported, not hidden or blindly summed", () => {
  it("faster recent efforts but a worsening pace at heart rate → conflict reported, provisional, low confidence", () => {
    const e = est({ raceDate: OLD, strong: improved, paceChangeFrom: "2026-09-10", paceFactorAfter: 1.05 });
    expect(e.combination.displacementSeconds!).toBeLessThan(0); expect(e.physiology!.classification).toBe("observed_decline");
    expect(e.conflicts.map(c => c.id)).toContain("recent_performance_vs_aerobic_trend"); expect(e.flags).toContain("conflicting_signals");
    expect(e.status).toBe("provisional"); expect(e.confidence).toBe("low");
    expect(e.contributions[1].seconds).toBeGreaterThan(0);                     // both signals stay visible
    expect(e.combination.displacementSeconds!).toBeLessThan(0);
  });
  it("faster recent efforts but sharply lower endurance preparation → conflict reported", () => {
    const e = est({ raceDate: OLD, strong: improved }, { readinessOverride: 0.25 });
    expect(e.conflicts.map(c => c.id)).toContain("recent_speed_vs_endurance_preparation");
    expect(e.confidence).toBe("low");
  });
});

describe("Scenario H — no race anchor, several independent contemporary hard efforts", () => {
  it("can estimate capability when evidence is sufficient, provisionally, with no race influence", () => {
    const e = est({ raceDate: null, strong: improved });
    expect(e.seconds).not.toBeNull(); expect(e.flags).toContain("no_race_anchor"); expect(e.influence.raceDominance).toBe("none");
    expect(e.contributions[2].status).toBe("no_effect"); expect(e.status).toBe("provisional");
  });
  it("sustained segments (tempo / progression) alone can carry it, and one lone effort cannot", () => {
    const seg = (date: string, segPace: number) => ({ date, hostMiles: 8, hostPace: 585, hr: 166, key: "10k" as const, segPace, type: "Tempo Run" });
    expect(est({ raceDate: null, segments: [seg("2026-10-04", 545), seg("2026-10-17", 548), seg("2026-10-28", 543)] }).seconds).not.toBeNull();
    const one = est({ raceDate: null, strong: [improved[0]] });
    expect(one.status).toBe("unavailable"); expect(one.unavailableCause).toBe("insufficient_independent_evidence"); expect(one.seconds).toBeNull();
  });
});

describe("Scenario I — missing or failed VO₂ / HR streams: graceful degradation, correct disclosure, no numerical discontinuity", () => {
  const o = { raceDate: OLD, strong: improved, paceChangeFrom: "2026-09-10", paceFactorAfter: 0.97 } as AthleteV11Options;
  const none = est(o);
  it("failed loads give the identical number as never requesting them, with the failure disclosed", () => {
    const failed = est(o, { vo2Load: "failed", streamLoad: "failed" });
    expect(failed.seconds).toBe(none.seconds);
    expect(failed.inputs.vo2.availability).toBe("load_failed"); expect(failed.inputs.hrStreams.availability).toBe("load_failed");
    expect(failed.inputs.vo2.note).toMatch(/could not be loaded/); expect(failed.inputs.hrStreams.note).toMatch(/whole-workout average heart rate/);
  });
  it("unavailable is not the same as stable: no readings, sparse readings and stable readings are distinguished", () => {
    expect(est(o, { vo2Entries: [] }).inputs.vo2.availability).toBe("no_readings");
    const sparse = est(o, { vo2Entries: [{ date: "2026-11-01", value: 47 }, { date: "2026-10-20", value: 47 }] });
    expect(sparse.inputs.vo2.availability).toBe("sparse"); expect(sparse.inputs.vo2.corroboration).toBe("unavailable");
    const s = est(o, { vo2Entries: vo2Series(47, 47) });
    expect(s.inputs.vo2.availability).toBe("available"); expect(s.inputs.vo2.direction).toBe("inconclusive"); expect(s.inputs.vo2.note).toMatch(/stable/);
    for (const e of [sparse, s]) expect(e.seconds).toBe(none.seconds);                // no unexpected numerical discontinuity
  });
  it("a discontinuity in the readings (a device or sensor change) makes the direction inconclusive instead of a corroboration", () => {
    const e = est(o, { vo2Entries: vo2Series(49, 46) });
    expect(e.inputs.vo2.discontinuity).toBe(true); expect(e.inputs.vo2.corroboration).toBe("inconclusive"); expect(e.seconds).toBe(none.seconds);
  });
  it("implausible, future and invalid VO₂ readings are excluded and never create a corroboration", () => {
    const junk = [{ date: "2026-11-20", value: 70 }, { date: "2026-11-01", value: 5 }, { date: "2026-10-30", value: Number.NaN }, { date: "2027-01-01", value: 99 }];
    const e = est(o, { vo2Entries: junk });
    expect(e.inputs.vo2.availability).not.toBe("available"); expect(e.seconds).toBe(none.seconds);
  });
});

describe("Scenario J — forecast propagation without a hidden stale-race anchor", () => {
  const fc = (o: AthleteV11Options) => {
    const a = athleteV11(o);
    const h = estimateHybridHalfMarathonV11(a);
    return { h, f: estimateRaceDayForecast(a, { raceDate: "2027-03-20", plan: PLAN, hybrid: h }) };
  };
  it("starts from the v1.1 current capability and is versioned v2", () => {
    const { h, f } = fc({ raceDate: OLD, strong: improved });
    expect(f.version).toBe("experimental-raceday-forecast-v2"); expect(f.currentCapabilityModel).toBe("experimental-hybrid-hm-v1.1");
    expect(f.currentCapabilitySeconds).toBe(h.seconds); expect(f.assumptions.fitnessGainAssumed).toBe(0); expect(f.assumptions.plannedTrainingTreatedAs).toBe("planned_actions_not_adaptations");
    expect(Math.abs(f.seconds! / h.seconds! - 1)).toBeLessThan(0.05);                    // differs from current capability only by endurance preparation
  });
  it("a defensible change in current capability propagates into the forecast, proportionally", () => {
    const stale = fc({ raceDate: OLD }), fresh = fc({ raceDate: OLD, strong: improved });
    const dCurrent = fresh.h.seconds! / stale.h.seconds! - 1, dForecast = fresh.f.seconds! / stale.f.seconds! - 1;
    expect(dCurrent).toBeLessThan(-0.005);
    expect(dForecast).toBeLessThan(dCurrent / 2); expect(dForecast).toBeGreaterThan(dCurrent * 2);        // same direction, comparable size
  });
  it("re-evaluates the SAME estimator at every readiness scenario: the forecast cannot differ from current capability except through readiness", () => {
    const { h, f } = fc({ raceDate: OLD, strong: improved });
    for (const s of f.scenarios.filter(x => x.seconds !== null)) expect(Math.abs(s.seconds! / h.seconds! - 1)).toBeLessThan(0.06);   // bounded by the exponent range and the ±1.5 % endurance term
    expect(f.scenarios.find(s => s.id === "current_training_maintained")!.seconds).toBe(h.seconds);
  });
  it("without a race the forecast still has no race anchor to fall back on; it is withheld when current capability is", () => {
    const noRace = fc({ raceDate: null, strong: improved });
    expect(noRace.h.influence.raceDominance).toBe("none"); expect(noRace.f.status).toBe("provisional");
    const nothing = estimateRaceDayForecast(athleteV11({ raceDate: null }), { raceDate: "2027-03-20", plan: PLAN, model: "v1.1" });
    expect(nothing.status).toBe("withheld"); expect(nothing.withheldCause).toBe("current_capability_unavailable"); expect(nothing.version).toBe("experimental-raceday-forecast-v2");
  });
  it("planned runs never become completed performances: adding a plan does not change current capability", () => {
    const a = athleteV11({ raceDate: OLD, strong: improved });
    const h = estimateHybridHalfMarathonV11(a);
    estimateRaceDayForecast(a, { raceDate: "2027-03-20", plan: PLAN, hybrid: h });
    expect(estimateHybridHalfMarathonV11(a).seconds).toBe(h.seconds);
  });
  it("a temporary readiness drop changes the forecast through endurance only, not through a permanent speed change", () => {
    const a = athleteV11({ raceDate: OLD, strong: improved });
    const fast = estimateHybridHalfMarathonV11(a, { readinessOverride: 0.9 }), slow = estimateHybridHalfMarathonV11(a, { readinessOverride: 0.3 });
    expect(slow.seconds!).toBeGreaterThan(fast.seconds!);
    expect(slow.combination.raceOnlySeconds).toBe(fast.combination.raceOnlySeconds);                    // the race-at-target evidence is unaffected by readiness
    expect(slow.seconds! / fast.seconds! - 1).toBeLessThan(0.08);
  });
});

describe("historical as-of correctness and stability", () => {
  const full = athleteV11({ raceDate: OLD, strong: improved });
  it("no later workout can enter an earlier calculation (no future leakage)", () => {
    const asOf = "2026-10-20T16:00:00.000Z";
    const withFuture = estimateHybridHalfMarathonV11({ ...full, asOf }).seconds;
    const truncated = { ...full, asOf, workouts: full.workouts.filter(w => w.endDate.getTime() <= Date.parse(asOf)) };
    expect(estimateHybridHalfMarathonV11(truncated).seconds).toBe(withFuture);
    expect(estimateHybridHalfMarathonV11({ ...full, asOf }).qualification.independent.every(i => i.date <= "2026-10-20")).toBe(true);
  });
  it("the estimate moves when a real new effort appears and is otherwise smooth day to day", () => {
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-10-08T16:00:00Z") + i * 86_400_000).toISOString());
    const s = days.map(d => estimateHybridHalfMarathonV11({ ...full, asOf: d }).seconds);
    expect(s.every(x => x !== null)).toBe(true);
    const steps = s.slice(1).map((x, i) => Math.abs(x! - s[i]!) / s[i]!);
    expect(Math.max(...steps)).toBeLessThan(0.01);
    expect(s[0]! - s.at(-1)!).toBeGreaterThan(30);                                                    // it did learn from the newer efforts
  });
  it("leave-one-effort-out shifts are bounded (no unacceptable single-workout instability)", () => {
    const baseS = estimateHybridHalfMarathonV11(full).seconds!;
    for (const w of full.workouts.filter(w => w.workoutId.startsWith("strong-"))) {
      const s = estimateHybridHalfMarathonV11({ ...full, workouts: full.workouts.filter(x => x !== w) }).seconds!;
      expect(Math.abs(s / baseS - 1)).toBeLessThan(0.015);
    }
  });
  it("is deterministic and independent of workout order", () => {
    const a = estimateHybridHalfMarathonV11(full), b = estimateHybridHalfMarathonV11({ ...full, workouts: [...full.workouts].reverse() });
    expect(b.seconds).toBe(a.seconds); expect(JSON.stringify(b.combination.items)).toBe(JSON.stringify(a.combination.items));
  });
});

describe("physiological evidence is not double-counted with newer performances", () => {
  it("an improvement already contained in recent efforts is not added again through the aerobic trend", () => {
    const o = { raceDate: OLD, strong: improved } as AthleteV11Options;
    const withTrend = est({ ...o, paceChangeFrom: "2026-09-10", paceFactorAfter: 0.96 }), withoutTrend = est(o);
    const oldRaceOnlyTrend = est({ raceDate: OLD, paceChangeFrom: "2026-09-10", paceFactorAfter: 0.96 });
    // physiology moves the estimate less when newer efforts have already moved the evidence's effective date forward
    expect(Math.abs(withTrend.contributions[1].fraction)).toBeLessThan(Math.abs(oldRaceOnlyTrend.contributions[1].fraction));
    expect(withTrend.seconds!).toBeLessThan(withoutTrend.seconds!);
    expect(withTrend.seconds! / withoutTrend.seconds! - 1).toBeGreaterThan(-0.02);
  });
  it("correlated physiology and endurance terms combine under the same bounded rule as v1 (|total| ≤ 3 %)", () => {
    const e = est({ raceDate: OLD, strong: improved, paceChangeFrom: "2026-09-10", paceFactorAfter: 0.9 });
    expect(Math.abs(e.adjustmentFraction)).toBeLessThanOrEqual(0.03 + 1e-12);
  });
});
