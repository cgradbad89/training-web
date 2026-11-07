import { describe, expect, it } from "vitest";
import { estimateHybridHalfMarathon, HYBRID_POLICY, HYBRID_VERSION } from "../hybridPerformance";
import { estimatePerformanceCapacity } from "../capacityMethods";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { addDays, hybridAthlete, makeRun } from "../../__tests__/fixtures/hybridFixture";
import { researchRace } from "../../__tests__/fixtures/workoutRaceResearchFixture";

const RACE = 7870.75;
const strong = (date: string, miles = 6, pace = 560, hr = 172) => ({ date, miles, pace, hr });
const base = (o = {}) => hybridAthlete({ longRunMiles: 8, ...o });
const est = (o = {}) => estimateHybridHalfMarathon(base(o));
const pct = (a: number, b: number) => (a / b - 1) * 100;

describe("hybrid contract", () => {
  it("returns a versioned, experimental, never-validated result with all four families and honest limits", () => {
    const e = est();
    expect(e.version).toBe(HYBRID_VERSION); expect(e.version).toBe("experimental-hybrid-hm-v1");
    expect(e.validated).toBe(false); expect(e.researchStatus).toBe("experimental_provisional");
    expect(e.contributions.map(c => c.family)).toEqual(["demonstrated_performance", "physiological_trend", "race_history", "endurance_readiness"]);
    expect(e.confidence === null || e.confidence === "low" || e.confidence === "moderate").toBe(true);
    expect(e.sensitivityRange!.basis).toMatch(/Not a statistical interval/);
    expect(e.assumptions.join(" ")).toMatch(/No calibrated confidence interval/);
    expect(e.asOf).toBe("2026-11-07T17:00:00.000Z"); expect(e.dataThrough).toBe("2026-09-20");
    expect(e.paceSecondsPerMile! % 5).toBe(0);
  });
  it("stable training and an unconfirmed race stay at the race baseline, provisionally, with a range around it", () => {
    const e = est();
    expect(Math.abs(pct(e.seconds!, RACE))).toBeLessThan(1);
    expect(e.status).toBe("provisional");
    expect(e.sensitivityRange!.fastSeconds).toBeLessThanOrEqual(e.seconds!); expect(e.sensitivityRange!.slowSeconds).toBeGreaterThanOrEqual(e.seconds!);
  });
  it("rejects an invalid cutoff", () => {
    expect(() => estimateHybridHalfMarathon({ ...base(), asOf: "x" })).toThrow(TypeError);
  });
});

describe("3T.2 sensitivity: direction, magnitude, robustness and evidence-state transitions", () => {
  const baseline = est().seconds!;

  it("improved speed at comparable HR → faster, bounded by the 2% physiological cap, physiology 'used'", () => {
    const e = est({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.95 });
    expect(e.seconds!).toBeLessThan(baseline); expect(pct(e.seconds!, baseline)).toBeGreaterThan(-2.2);
    expect(e.contributions[1].status).toBe("used"); expect(e.contributions[1].fraction).toBeLessThan(0);
    expect(e.contributions[1].influence).toBeGreaterThan(0); expect(e.contributions[1].influence).toBeLessThanOrEqual(1);
    expect(Math.abs(e.contributions[1].fraction)).toBeLessThanOrEqual(HYBRID_POLICY.maximumPhysiologicalFraction);
  });
  it("slower pace at the same HR → slower (deteriorations are allowed)", () => {
    const e = est({ paceChangeFrom: "2026-09-25", paceFactorAfter: 1.05 });
    expect(e.seconds!).toBeGreaterThan(baseline);
  });
  it("the improvement is larger for a larger pace change (monotone)", () => {
    const a = est({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.98 }).seconds!, b = est({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.95 }).seconds!;
    expect(b).toBeLessThanOrEqual(a); expect(a).toBeLessThanOrEqual(baseline);
  });
  it("more training volume WITHOUT faster running does not create a large improvement", () => {
    const more = estimateHybridHalfMarathon(hybridAthlete({ runsPerWeek: 4, longRunMiles: 10, easyMiles: 6 })).seconds!;
    expect(more).toBeGreaterThan(baseline * 0.985); expect(more).toBeLessThanOrEqual(baseline * 1.001);
    expect(estimateHybridHalfMarathon(hybridAthlete({ runsPerWeek: 4, longRunMiles: 10, easyMiles: 6 })).physiology!.classification).toBe("no_detectable_change");
  });
  it("better short-distance speed with inadequate long-run preparation is slower than the same speed with long-run preparation", () => {
    const efforts = [strong("2026-10-10", 4.5, 520), strong("2026-10-24", 4.5, 520)];
    const lacking = estimateHybridHalfMarathon(hybridAthlete({ raceDate: null, strong: efforts, longRunMiles: 5, runsPerWeek: 3 }));
    const prepared = estimateHybridHalfMarathon(hybridAthlete({ raceDate: null, strong: efforts, longRunMiles: 11, runsPerWeek: 4, easyMiles: 6 }));
    expect(lacking.seconds).not.toBeNull(); expect(prepared.seconds).not.toBeNull();
    expect(lacking.seconds! / prepared.seconds!).toBeGreaterThan(1.01);
    expect(lacking.readiness!.score!).toBeLessThan(prepared.readiness!.score!);
    expect(lacking.confidence).toBe("low");
  });
  it("almost no long-run preparation withholds a half-marathon time but keeps demonstrated speed as capacity", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ raceDate: null, strong: [strong("2026-10-10", 4.5, 520), strong("2026-10-24", 4.5, 520)], longRunMiles: 3, easyMiles: 2.5, runsPerWeek: 2 }));
    expect(e.status).toBe("unavailable"); expect(e.unavailableCause).toBe("insufficient_endurance_preparation");
    expect(e.seconds).toBeNull(); expect(e.capacity.seconds).not.toBeNull(); expect(e.flags).toContain("endurance_unprepared");
  });
  it("more endurance without faster short efforts yields at most a bounded gain", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ raceDate: "2026-09-20", longRunMiles: 12, easyMiles: 6, runsPerWeek: 4, start: "2026-08-01" }));
    const low = estimateHybridHalfMarathon(hybridAthlete({ raceDate: "2026-09-20", longRunMiles: 6, easyMiles: 4, runsPerWeek: 3, start: "2026-08-01" }));
    expect(e.seconds!).toBeLessThanOrEqual(low.seconds!);
    expect(Math.abs(e.contributions[3].fraction)).toBeLessThanOrEqual(HYBRID_POLICY.maximumEnduranceFraction);
    expect(low.seconds! / e.seconds! - 1).toBeLessThan(0.04);
  });
  it("training that collapses after a race moves the estimate no faster, and withholds it when readiness is gone", () => {
    const collapsed = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, volumeChangeFrom: "2026-09-27", volumeFactorAfter: 0.3, runsPerWeek: 2 }));
    expect(collapsed.status === "unavailable" ? collapsed.unavailableCause : "numeric").toMatch(/insufficient_endurance_preparation|numeric/);
    if (collapsed.seconds !== null) expect(collapsed.seconds).toBeGreaterThanOrEqual(baseline * 0.999);
  });
  it("a taper (halved volume for the final days) does not register as deconditioning", () => {
    const taper = estimateHybridHalfMarathon(base({ volumeChangeFrom: "2026-11-01", volumeFactorAfter: 0.5 })).seconds!;
    expect(Math.abs(pct(taper, baseline))).toBeLessThan(0.5);
  });
  it("a new, faster qualifying race moves the estimate toward it", () => {
    const input = base();
    const r2 = researchRace("hm2", "2026-10-25", 7500); r2.workout.avgHeartRate = 170; r2.workout.hasRoute = true;
    input.races.push(r2.race); input.workouts.push(r2.workout);
    const e = estimateHybridHalfMarathon(input);
    expect(e.seconds!).toBeLessThan(baseline); expect(e.seconds!).toBeGreaterThan(7500 * 0.99);
    expect(e.capacity.qualification.independent.filter(i => i.kind === "recorded_race")).toHaveLength(2);
  });
  it("race-anchor expiry is a clean state transition at 180 days, with no silent authority afterwards", () => {
    const at = (daysAfter: number) => estimateHybridHalfMarathon(hybridAthlete({ raceDate: "2026-04-01", asOf: `${addDays("2026-04-01", daysAfter)}T16:00:00.000Z`, longRunMiles: 8 }));
    const before = at(180), after = at(181);
    expect(before.status).toBe("provisional"); expect(before.seconds).not.toBeNull();
    expect(after.status).toBe("unavailable"); expect(after.unavailableCause).toBe("anchor_expired_no_contemporary_evidence"); expect(after.seconds).toBeNull();
  });
  it("strong contemporary evidence carries the estimate after the anchor expires", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ raceDate: "2026-04-01", longRunMiles: 8, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] }));
    expect(e.seconds).not.toBeNull(); expect(e.flags).toContain("no_race_anchor"); expect(e.contributions[2].status).toBe("no_effect");
  });
  it("hot recent training with weather is NOT read as a fitness decline; the same pattern with weather MISSING is read as a flagged, capped decline", () => {
    const withWeather = est({ heat: { from: "2026-09-25", tempF: 84, effectPerF: 0.0035 } });
    expect(withWeather.physiology!.weatherAdjustment).toBe("estimated");
    expect(Math.abs(pct(withWeather.seconds!, baseline))).toBeLessThan(0.4);
    const blind = est({ tempF: null, heat: { from: "2026-09-25", tempF: null, actualTempF: 84, effectPerF: 0.0035 } });
    expect(blind.physiology!.flags).toContain("weather_unadjusted");
    expect(blind.physiology!.interpretation.notSupported.join(" ")).toMatch(/Heat correction/);
    expect(blind.missing.join(" ")).toMatch(/Weather/);
    expect(blind.seconds!).toBeGreaterThan(baseline);                                        // the slowdown IS seen (heat cannot be separated from fitness)…
    expect(pct(blind.seconds!, baseline)).toBeLessThan(HYBRID_POLICY.maximumPhysiologicalFraction * 100 + 0.01); // …but bounded,
  });
  it("heart-rate sensor artifacts in a few runs do not move the estimate", () => {
    const input = base();
    const ords = input.workouts.filter(w => w.workoutId.startsWith("ord-"));
    [60, 70, 80].forEach((k, j) => { ords[k].avgHeartRate = [250, 20, 205][j]; });
    expect(Math.abs(pct(estimateHybridHalfMarathon(input).seconds!, baseline))).toBeLessThan(0.3);
  });
  it("a single anomalously fast easy-HR run changes nothing; a single fast high-HR run cannot create adequate evidence", () => {
    const input = base();
    const ords = input.workouts.filter(w => w.workoutId.startsWith("ord-"));
    const odd = ords[ords.length - 3]; odd.durationSeconds = odd.durationSeconds * 0.7; odd.endDate = new Date(odd.startDate.getTime() + odd.durationSeconds * 1000);
    odd.syncedAt = new Date(odd.endDate.getTime() + 1000);
    expect(Math.abs(pct(estimateHybridHalfMarathon(input).seconds!, baseline))).toBeLessThan(0.3);
    const one = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, strong: [strong("2026-11-03", 6, 500, 182)] }));
    expect(one.seconds!).toBeLessThan(baseline); expect(one.seconds!).toBeGreaterThan(baseline * 0.96); expect(one.flags).toContain("isolated_fast_effort");
    expect(one.status).toBe("provisional");
  });
  it("correlated GPS segments from one workout add nothing", () => {
    const plain = hybridAthlete({ longRunMiles: 8, strong: [strong("2026-10-10"), strong("2026-10-24")] });
    const seg = hybridAthlete({ longRunMiles: 8, strong: [strong("2026-10-10"), strong("2026-10-24")] });
    seg.workouts.find(w => w.workoutId === "strong-2026-10-10")!.bestEfforts = { "1mi": 470, "5k": 1450, "10k": 3000, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: 2 };
    expect(estimateHybridHalfMarathon(seg).seconds).toBe(estimateHybridHalfMarathon(plain).seconds);
  });
  it("contradictory evidence (faster efforts than the race) lowers confidence and widens the range instead of hiding it", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, strong: [strong("2026-10-24", 6, 520, 178), strong("2026-10-10", 6, 520, 178)] }));
    expect(e.flags.some(f => f === "contradictory_evidence" || f === "contradictory_signals")).toBe(true);
    expect(e.confidence).toBe("low");
    expect(e.sensitivityRange!.slowSeconds - e.sensitivityRange!.fastSeconds).toBeGreaterThan(0);
  });
});

describe("lessons from the first real-data evaluation", () => {
  it("a slower UNCONFIRMED effort cannot drag a race-based estimate slower (a submaximal effort looks exactly like that)", () => {
    const slowEfforts = [strong("2026-10-10", 6, 580, 170), strong("2026-10-24", 6, 580, 170)];
    const withSlow = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, strong: slowEfforts }));
    expect(withSlow.capacity.qualification.independent.length).toBe(3); expect(withSlow.flags).toContain("slower_unconfirmed_effort_ignored");
    expect(withSlow.capacity.seconds!).toBeCloseTo(estimatePerformanceCapacity(hybridAthlete({ longRunMiles: 8 })).seconds!, 6);
  });
  it("…but without a race anchor the same slower efforts ARE the estimate", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ raceDate: null, longRunMiles: 8, strong: [strong("2026-10-10", 6, 580, 170), strong("2026-10-24", 6, 580, 170)] }));
    expect(e.seconds).not.toBeNull(); expect(e.seconds!).toBeGreaterThan(RACE);
  });
  it("a post-race lull in training does not flip availability from day to day", () => {
    const input = hybridAthlete({ longRunMiles: 8, volumeChangeFrom: "2026-09-21", volumeFactorAfter: 0.45, runsPerWeek: 3 });
    const statuses = Array.from({ length: 48 }, (_, i) => estimateHybridHalfMarathon({ ...input, asOf: `${addDays("2026-09-21", i)}T17:00:00.000Z` }).seconds !== null);
    const flips = statuses.slice(1).filter((v, i) => v !== statuses[i]).length;
    expect(flips).toBeLessThanOrEqual(1);
  });
  it("endurance demonstrated by a recent race-distance performance counts as support even when recent volume is low", () => {
    const e = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 3, easyMiles: 2.5, runsPerWeek: 2 }));
    expect(e.status === "unavailable" ? e.unavailableCause : "numeric").toBe("numeric");
    expect(e.readiness!.score!).toBeLessThan(0.2); expect(e.confidence).toBe("low");
  });
  it("readiness is smoothed: one added run changes it gradually", () => {
    const a = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8 })).readiness!.score!;
    const b = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, asOf: "2026-11-08T17:00:00.000Z" })).readiness!.score!;
    expect(Math.abs(a - b)).toBeLessThan(0.06);
  });
});

describe("independence from, and invariance of, the other estimators", () => {
  it("never modifies the official or HR-enhanced estimates it is compared with", () => {
    const input = base({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.96 });
    const official = estimateCurrentHalfMarathon(input), hr = estimateHrEnhancedHalfMarathon(input, { official });
    const before = JSON.stringify([official, hr]);
    const e = estimateHybridHalfMarathon(input, { official, hrEnhanced: hr });
    expect(JSON.stringify([official, hr])).toBe(before);
    expect(JSON.stringify(estimateCurrentHalfMarathon(input))).toBe(JSON.stringify(official));
    expect(e.comparison.officialSeconds).toBeCloseTo(official.baselineSeconds! + official.adjustmentSeconds, 6);
    expect(e.comparison.differenceVsOfficialSeconds).toBeCloseTo(e.seconds! - e.comparison.officialSeconds!, 6);
  });
  it("answers where v2 cannot: no unexpired race, but strong contemporary efforts", () => {
    const input = hybridAthlete({ raceDate: "2026-04-01", longRunMiles: 8, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] });
    expect(estimateCurrentHalfMarathon(input).finishMinutes).toBeNull();
    expect(estimateHybridHalfMarathon(input).seconds).not.toBeNull();
  });
  it("does not stack on v2: identical results whether or not v2 is supplied", () => {
    const input = base({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.96 });
    const a = estimateHybridHalfMarathon(input), b = estimateHybridHalfMarathon(input, { official: estimateCurrentHalfMarathon(input) });
    expect(b.seconds).toBe(a.seconds);
  });
  it("physiological disagreement lowers influence instead of being added", () => {
    const input = base({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.95 });
    const agree = estimateHybridHalfMarathon(input);
    const vo2 = [51, 45, 39, 33, 21, 15, 9, 3].map((d, i) => ({ date: addDays("2026-11-07", -d), value: 48 - i * 0.6 }));
    const disagree = estimateHybridHalfMarathon(input, { vo2Entries: vo2 });
    expect(disagree.physiology!.vo2Corroboration).toBe("disagrees");
    expect(disagree.contributions[1].influence).toBeLessThanOrEqual(agree.contributions[1].influence);
    expect(disagree.flags).toContain("vo2_disagrees");
  });
});

describe("as-of integrity", () => {
  it("later workouts, races and VO₂ readings cannot change an earlier estimate", () => {
    const asOf = "2026-10-10T16:00:00.000Z";
    const a = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, asOf, trainingEnd: "2026-10-09" }));
    const later = hybridAthlete({ longRunMiles: 8, asOf, trainingEnd: "2026-11-05", strong: [strong("2026-10-20", 6, 480, 185)] });
    const r2 = researchRace("late", "2026-10-30", 7000); later.races.push(r2.race); later.workouts.push(r2.workout);
    later.workouts.push(makeRun({ id: "future", date: "2026-10-15", pace: 400, hr: 190, minutes: 60, tempF: 50 }));
    expect(JSON.stringify(estimateHybridHalfMarathon(later, { vo2Entries: [{ date: "2026-10-20", value: 80 }] }).contributions))
      .toBe(JSON.stringify(a.contributions));
    expect(estimateHybridHalfMarathon(later).seconds).toBe(a.seconds);
  });
  it("is deterministic and order independent", () => {
    const input = base({ paceChangeFrom: "2026-09-25", paceFactorAfter: 0.96 });
    expect(JSON.stringify(estimateHybridHalfMarathon({ ...input, workouts: [...input.workouts].reverse() }))).toBe(JSON.stringify(estimateHybridHalfMarathon(input)));
  });
  it("capacity independent of the hybrid layer stays reproducible", () => {
    const input = base();
    expect(estimateHybridHalfMarathon(input).capacity.seconds).toBe(estimatePerformanceCapacity(input, { exponent: estimateHybridHalfMarathon(input).capacity.exponent }).seconds);
  });
});
