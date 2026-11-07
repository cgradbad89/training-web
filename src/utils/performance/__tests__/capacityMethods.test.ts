import { describe, expect, it } from "vitest";
import { estimatePerformanceCapacity, extrapolationReliability, fitCriticalSpeed, recencyWeight, CAPACITY_POLICY } from "../capacityMethods";
import { qualifyPerformanceEvidence, CURVE_DISTANCES_M } from "../evidenceQualification";
import { BEST_EFFORT_DISTANCES_M } from "@/utils/bestEfforts";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { HALF_MARATHON_METERS, researchRiegelSeconds } from "../../racePerformance";
import { hybridAthlete, addDays, makeRun, HYBRID_AS_OF } from "../../__tests__/fixtures/hybridFixture";

const strong = (date: string, miles = 6, pace = 560, hr = 172) => ({ date, miles, pace, hr });

describe("equivalence units and weights", () => {
  it("Riegel units: a 25:00 5K converts to a ~1:55 half marathon", () => {
    const hm = researchRiegelSeconds(1500, 5000, HALF_MARATHON_METERS)!;
    expect(hm / 60).toBeGreaterThan(113); expect(hm / 60).toBeLessThan(117);
  });
  it("extrapolation reliability falls with the distance ratio and is bounded", () => {
    expect(extrapolationReliability(HALF_MARATHON_METERS, HALF_MARATHON_METERS)).toBe(1);
    expect(extrapolationReliability(16093.44, HALF_MARATHON_METERS)).toBeGreaterThan(0.95);
    expect(extrapolationReliability(5000, HALF_MARATHON_METERS)).toBeGreaterThan(0.2);
    expect(extrapolationReliability(5000, HALF_MARATHON_METERS)).toBeLessThan(0.6);
    expect(extrapolationReliability(1609.344, HALF_MARATHON_METERS)).toBe(0);
    expect(extrapolationReliability(42195, HALF_MARATHON_METERS)).toBe(CAPACITY_POLICY.longerSourceReliability);
  });
  it("recency weight halves every half-life", () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(CAPACITY_POLICY.halfLifeDays)).toBeCloseTo(0.5, 10);
  });
});

describe("evidence tiers", () => {
  it("keeps the local curve distances identical to the GPS best-effort distances", () => {
    expect(CURVE_DISTANCES_M).toEqual(BEST_EFFORT_DISTANCES_M);
  });
  it("never treats ordinary running as demonstrated capacity", () => {
    const input = hybridAthlete({ raceDate: null });
    const q = qualifyPerformanceEvidence(input);
    expect(q.independent).toHaveLength(0);
    expect(q.counts.ordinary_training).toBeGreaterThan(50);
    const r = estimatePerformanceCapacity(input);
    expect(r.status).toBe("unavailable"); expect(r.seconds).toBeNull(); expect(r.unavailableCause).toBe("no_performance_evidence");
  });
  it("classifies a high-HR fast whole run as strong but unconfirmed", () => {
    const q = qualifyPerformanceEvidence(hybridAthlete({ raceDate: null, strong: [strong("2026-10-18")] }));
    expect(q.counts.strong_unconfirmed).toBe(1);
    expect(q.independent[0]).toMatchObject({ kind: "whole_run_effort", tier: "strong_unconfirmed" });
  });
  it("a fast run at an easy heart rate is ordinary, and a high-HR slow run is ordinary", () => {
    const q = qualifyPerformanceEvidence(hybridAthlete({ raceDate: null, strong: [
      { id: "fast-easy", date: "2026-10-18", miles: 6, pace: 560, hr: 140 }, { id: "slow-hard", date: "2026-10-25", miles: 5, pace: 700, hr: 175 }] }));
    expect(q.counts.strong_unconfirmed).toBe(0);
  });
  it.each([
    ["treadmill", { type: "Treadmill Run" }], ["no route", { route: false }],
  ])("a strong-looking %s effort is not strong", (_n, extra) => {
    const q = qualifyPerformanceEvidence(hybridAthlete({ raceDate: null, strong: [{ ...strong("2026-10-18"), ...extra }] }));
    expect(q.counts.strong_unconfirmed).toBe(0);
    expect(q.excludedByReason.treadmill_or_no_route).toBeGreaterThan(0);
  });
  it("heat-inflated heart rate is not a strong effort and missing weather lowers quality", () => {
    const hot = qualifyPerformanceEvidence(hybridAthlete({ raceDate: null, strong: [{ ...strong("2026-10-18"), tempF: 90 }] }));
    expect(hot.counts.strong_unconfirmed).toBe(0);
    const dry = qualifyPerformanceEvidence(hybridAthlete({ raceDate: null, strong: [{ ...strong("2026-10-18"), tempF: null }] }));
    expect(dry.independent[0].quality).toBeLessThan(0.45); expect(dry.independent[0].reasons).toContain("weather_missing");
  });
  it("rejects implausible pace, partial routes, timing discrepancies and owner-corrected efforts as unsuitable", () => {
    const base = hybridAthlete({ raceDate: null, strong: [strong("2026-10-18"), { ...strong("2026-10-20"), id: "partial" }, { ...strong("2026-10-22"), id: "timing" },
      { ...strong("2026-10-24"), id: "fixed" }, { id: "gps", date: "2026-10-26", miles: 6, pace: 150, hr: 180 }] });
    base.workouts.find(w => w.workoutId === "partial")!.routeComplete = false;
    const timing = base.workouts.find(w => w.workoutId === "timing")!; timing.endDate = new Date(timing.endDate.getTime() + 20 * 60000);
    base.overrides["fixed"] = { workoutId: "fixed", userId: "u", isExcluded: false, excludedAt: null, excludedReason: null, distanceMilesOverride: 6.1,
      durationSecondsOverride: null, runTypeOverride: null, updatedAt: "2026-10-27T00:00:00.000Z" };
    const q = qualifyPerformanceEvidence(base);
    expect(q.excludedByReason).toMatchObject({ partial_route: 1, timing_discrepancy: 1, owner_corrected_distance_or_duration: 1, implausible_pace_or_distance: 1 });
    expect(q.independent.map(i => i.workoutId)).toEqual(["strong-2026-10-18"]);
  });
  it("keeps one effort per day and counts correlated best-efforts of one workout once", () => {
    const input = hybridAthlete({ raceDate: null, strong: [strong("2026-10-18"), { ...strong("2026-10-18"), id: "second", pace: 575 }] });
    const host = input.workouts.find(w => w.workoutId === "strong-2026-10-18")!;
    host.bestEfforts = { "1mi": 480, "5k": 1500, "10k": 3300, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: 2 };
    const q = qualifyPerformanceEvidence(input);
    expect(q.independent.filter(i => i.date === "2026-10-18")).toHaveLength(1);
    expect(q.excludedByReason.same_day_duplicate_effort).toBe(1);
    expect(q.curve.find(c => c.distanceKey === "5k")).toMatchObject({ seconds: 1500, hostTier: "strong_unconfirmed" });
  });
  it("GPS best-effort segments from ordinary runs form a lower-bound curve only", () => {
    const input = hybridAthlete({ raceDate: null });
    input.workouts[40].bestEfforts = { "1mi": 400, "5k": 1450, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: 2 };
    input.workouts[41].bestEfforts = { "1mi": 100, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computationVersion: 2 };
    input.workouts[42].bestEfforts = { "1mi": 350, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: false, computationVersion: 2 };
    const q = qualifyPerformanceEvidence(input);
    expect(q.curve.find(c => c.distanceKey === "1mi")?.seconds).toBe(400); // abnormal GPS speed and incomplete route dropped
    expect(q.curve.every(c => c.hostTier === "ordinary_training")).toBe(true);
    expect(estimatePerformanceCapacity(input).seconds).toBeNull();
  });
  it("a recorded race with a clock discrepancy is unusable, not silently reconciled", () => {
    const input = hybridAthlete();
    const w = input.workouts.find(x => x.workoutId === "hm-run")!; w.endDate = new Date(w.endDate.getTime() + 20 * 60000);
    const q = qualifyPerformanceEvidence(input);
    expect(q.independent.filter(i => i.kind === "recorded_race")).toHaveLength(0);
    expect(q.counts.unsuitable).toBeGreaterThan(0);
  });
});

describe("capacity estimation", () => {
  it("a lone recorded race gives a provisional estimate equal to that race (same distance), with B unavailable", () => {
    const r = estimatePerformanceCapacity(hybridAthlete());
    expect(r.status).toBe("provisional"); expect(r.evidenceQuality).toBe("limited");
    expect(r.seconds).toBeCloseTo(7870.75, 1);
    expect(r.methods.map(m => m.status)).toEqual(["available", "unavailable", "available"]);
    expect(r.methods[0].seconds).toBeCloseTo(7870.75, 1);
    expect(r.validated).toBe(false); expect(r.researchStatus).toBe("experimental_provisional");
  });
  it("a confirmed race is adequate evidence", () => {
    const r = estimatePerformanceCapacity(hybridAthlete({ confirmedRace: true, raceDate: "2026-10-18" }));
    expect(r.evidenceQuality).toBe("adequate"); expect(r.status).toBe("available");
    expect(r.qualification.independent[0].tier).toBe("confirmed_maximal");
  });
  it("detects independently supported improvement that the race-anchored v2 heuristic overlooks", () => {
    const input = hybridAthlete({ strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] });
    const v2 = estimateCurrentHalfMarathon(input);
    const capacity = estimatePerformanceCapacity(input);
    expect(v2.adjustmentSeconds).toBeCloseTo(0, 6); // stable training: v2 stays on the race baseline
    const race = 7870.75;
    expect(capacity.seconds!).toBeLessThan(race * 0.985); // > 1.5% faster, from two strong efforts
    expect(capacity.dispersionFraction).toBeGreaterThan(0.01); // evidence disagrees, and the dispersion is reported
    expect(capacity.status).toBe("available"); // three independent unconfirmed items
    expect(capacity.qualification.independent.length).toBe(3);
  });
  it("does not depend on an unexpired race anchor: two strong contemporary efforts suffice", () => {
    const r = estimatePerformanceCapacity(hybridAthlete({ raceDate: null, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] }));
    expect(r.seconds).not.toBeNull(); expect(r.flags).toContain("no_race_anchor"); expect(r.status).toBe("provisional");
    expect(estimateCurrentHalfMarathon(hybridAthlete({ raceDate: null, strong: [strong("2026-10-10")] })).finishMinutes).toBeNull();
  });
  it("one strong effort alone is insufficient", () => {
    const r = estimatePerformanceCapacity(hybridAthlete({ raceDate: null, strong: [strong("2026-10-24")] }));
    expect(r.status).toBe("unavailable"); expect(r.unavailableCause).toBe("insufficient_independent_evidence");
    const sameWeek = estimatePerformanceCapacity(hybridAthlete({ raceDate: null, strong: [strong("2026-10-20"), strong("2026-10-22")] }));
    expect(sameWeek.status).toBe("unavailable");
  });
  it("an expired race never silently remains authoritative", () => {
    const expired = estimatePerformanceCapacity(hybridAthlete({ raceDate: "2026-04-26" }));
    expect(expired.status).toBe("unavailable"); expect(expired.unavailableCause).toBe("anchor_expired_no_contemporary_evidence");
    expect(expired.qualification.expired).toHaveLength(1); expect(expired.seconds).toBeNull();
    const withStrong = estimatePerformanceCapacity(hybridAthlete({ raceDate: "2026-04-26", strong: [strong("2026-10-10"), strong("2026-10-24")] }));
    expect(withStrong.seconds).not.toBeNull();
    expect(withStrong.methods[2].contributions.every(c => c.kind !== "recorded_race")).toBe(true);
  });
  it("recency: an old race weighs less than a newer one", () => {
    const old = estimatePerformanceCapacity(hybridAthlete({ raceDate: "2026-06-20", raceSeconds: 8100, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] }));
    const fresh = estimatePerformanceCapacity(hybridAthlete({ raceDate: "2026-10-18", raceSeconds: 8100, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] }));
    expect(old.seconds!).toBeLessThan(fresh.seconds!);
  });
  it("unsupported distances are explicit", () => {
    const r = estimatePerformanceCapacity(hybridAthlete(), { targetDistanceMeters: 42195 });
    expect(r.status).toBe("unavailable"); expect(r.unavailableCause).toBe("unsupported_distance"); expect(r.seconds).toBeNull();
    expect(estimatePerformanceCapacity(hybridAthlete(), { exponent: 1.5 }).unavailableCause).toBe("invalid_input");
  });
  it("converts the half-marathon race to 10K with units intact and rejects ratios beyond reliability", () => {
    const r = estimatePerformanceCapacity(hybridAthlete(), { targetDistanceMeters: 10000 });
    expect(r.seconds! / 60).toBeGreaterThan(55); expect(r.seconds! / 60).toBeLessThan(63);
  });
  it("a higher exponent slows sources shorter than the target but leaves same-distance times alone", () => {
    const input = hybridAthlete({ raceDate: null, strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] });
    expect(estimatePerformanceCapacity(input, { exponent: 1.1 }).seconds!).toBeGreaterThan(estimatePerformanceCapacity(input).seconds!);
    const race = hybridAthlete();
    expect(estimatePerformanceCapacity(race, { exponent: 1.12 }).seconds).toBeCloseTo(estimatePerformanceCapacity(race).seconds!, 6);
  });
});

describe("as-of integrity and determinism", () => {
  it("later workouts and later races cannot leak into an earlier cutoff", () => {
    const base = hybridAthlete({ asOf: "2026-10-15T16:00:00.000Z", strong: [strong("2026-10-10"), strong("2026-10-12")] });
    const before = JSON.stringify(estimatePerformanceCapacity(base));
    const later = hybridAthlete({ asOf: "2026-10-15T16:00:00.000Z", strong: [strong("2026-10-10"), strong("2026-10-12"), strong("2026-10-16", 6, 500, 180), strong("2026-10-30", 6, 480, 185)] });
    expect(JSON.stringify(estimatePerformanceCapacity(later))).toBe(before);
  });
  it("is independent of workout order", () => {
    const input = hybridAthlete({ strong: [strong("2026-10-10"), strong("2026-10-24", 6.5, 555)] });
    const shuffled = { ...input, workouts: [...input.workouts].reverse() };
    expect(JSON.stringify(estimatePerformanceCapacity(shuffled))).toBe(JSON.stringify(estimatePerformanceCapacity(input)));
  });
  it("uses the local calendar day at midnight boundaries (not UTC)", () => {
    const late = makeRun({ id: "late", date: "2026-10-18", pace: 560, hr: 172, minutes: 56, tempF: 55 });
    late.startDate = new Date("2026-10-19T03:30:00Z"); // 23:30 on Oct 18 in New York
    late.endDate = new Date(late.startDate.getTime() + 56 * 60000); late.syncedAt = new Date(late.endDate.getTime() + 1000);
    const input = hybridAthlete({ raceDate: null }); input.workouts.push(late);
    expect(qualifyPerformanceEvidence(input).independent[0].date).toBe("2026-10-18");
  });
  it("rejects an invalid cutoff", () => {
    expect(() => estimatePerformanceCapacity({ ...hybridAthlete(), asOf: "yesterday" })).toThrow(TypeError);
    expect(HYBRID_AS_OF).toBeTruthy(); expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("critical speed (method B)", () => {
  const cs = 4, dp = 200;
  const pts = (ts: number[]) => ts.map(seconds => ({ seconds, meters: cs * seconds + dp }));
  it("recovers CS and D′ from exact distance–time data", () => {
    const fit = fitCriticalSpeed(pts([240, 480, 900]))!;
    expect(fit.speed).toBeCloseTo(4, 8); expect(fit.dPrime).toBeCloseTo(200, 6); expect(fit.r2).toBeCloseTo(1, 10);
  });
  it("needs three efforts and a non-degenerate time spread", () => {
    expect(fitCriticalSpeed(pts([240, 480]))).toBeNull();
    expect(fitCriticalSpeed(pts([300, 300, 300]))).toBeNull();
  });
  it("is unavailable when efforts are too few, narrowly spaced, or outside 2–20 minutes — never inferred from ordinary runs", () => {
    const ordinary = estimatePerformanceCapacity(hybridAthlete({ raceDate: null }));
    expect(ordinary.methods.find(m => m.id === "B_critical_speed")!.status).toBe("unavailable");
    const hm = estimatePerformanceCapacity(hybridAthlete());
    expect(hm.methods.find(m => m.id === "B_critical_speed")!.reasons[0]).toMatch(/Fewer than 3/);
  });
  it("accepts a well-conditioned set of strong 3.5–19 minute efforts but still returns no half-marathon time", () => {
    const eff = [{ d: "2026-10-04", min: 3.5 }, { d: "2026-10-11", min: 9 }, { d: "2026-10-18", min: 19 }].map(({ d, min }) => {
      const seconds = min * 60, meters = 4 * seconds + 200;
      return { id: `cs-${d}`, date: d, miles: meters / 1609.344, pace: seconds / (meters / 1609.344), hr: 176 };
    });
    // each effort covers ≥ 1 km, so it meets the whole-run effort screen
    const input = hybridAthlete({ raceDate: null, strong: eff });
    const B = estimatePerformanceCapacity(input).methods.find(m => m.id === "B_critical_speed")!;
    expect(B.status).toBe("fit_only"); expect(B.seconds).toBeNull();
    expect(B.criticalSpeed!.speedMetersPerSecond).toBeCloseTo(4, 3); expect(B.criticalSpeed!.dPrimeMeters).toBeCloseTo(200, 0);
  });
});
