/**
 * Hybrid Performance Model v1.1 — four-distance CURRENT-FITNESS estimates (5K, 10 miles, half marathon, marathon).
 * Invented data only. Owner race results (2:15:30 April, 2:11:11 September) are used as inputs; no owner records are committed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { distanceRace } from "../../__tests__/fixtures/hybridV11Fixture";
import {
  APRIL_RACE, FIT_TZ, SEPTEMBER_RACE, SEPTEMBER_SECONDS, addDays, cadenceRuns, fitnessWorld, makeRun, strongEffortWorld,
} from "../../__tests__/fixtures/currentFitnessFixture";
import { treatConfirmedRacesAsMaximal } from "../confirmedRaceAssumption";
import { computeCurrentFitness, estimateHybridCurrentFitness, type CurrentFitness } from "../hybridCurrentFitness";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { CROSS_DISTANCE_EXPONENT_BAND, HYBRID_TARGETS, TARGET_PROFILES } from "../hybridTargetProfiles";
import { confidenceLabel, formatAsOfDate, formatFinishTime, formatPacePerMile, rowNote } from "../currentFitnessFormat";

const MILE = 1609.344;
const D = "2026-10-30";            // 40 days after the September race, after its confirmation became available (2026-10-24)
const row = (f: CurrentFitness, id: string) => f.rows.find(r => r.id === id)!;
const plain = (o: Parameters<typeof fitnessWorld>[0]) => ({ ...fitnessWorld({ ...o, adapted: false }), assumeConfirmedRacesMaximal: true });
/** The world exactly as the app hands it to the estimators: races already re-read by the shared adapter (the baseline was captured this way). */
const adapted = (o: Parameters<typeof fitnessWorld>[0]) => fitnessWorld(o);
const LONG20 = { gaps: [1, 1, 2, 2], miles: [8, 6, 9, 20, 7, 6, 10] };
const LONG16 = { gaps: [1, 2, 2, 2], miles: [7, 8, 9, 16, 6, 8] };

describe("1 — race anchors: the owner's confirmed results are maximal PREDICTION anchors and the record stays truthful", () => {
  it("April (≈80 %) and September (≈90 %) confirmations are re-read as maximal in a COPY; the recorded effort is never modified", () => {
    const rs = [APRIL_RACE().race, SEPTEMBER_RACE().race];
    const before = structuredClone(rs);
    const efforts = (r: (typeof rs)[number]) => Object.values(r.confirmationHistory!.revisions).map(v => v.details.effort);
    const out = treatConfirmedRacesAsMaximal(rs);
    expect(out.map(efforts)).toEqual([["maximal"], ["maximal"]]);
    expect(rs).toEqual(before);
    expect([efforts(rs[0]), efforts(rs[1])]).toEqual([["nonmaximal"], ["hard"]]);
  });
  it("the pipeline never mutates its inputs and leaves the stored confirmations untouched", () => {
    const w = plain({ asOfDate: D, races: [APRIL_RACE(), SEPTEMBER_RACE()] });
    const before = structuredClone(w.races);
    computeCurrentFitness(w);
    expect(w.races).toEqual(before);
  });
  it("with the assumption, every distance is computed from the September race (nothing is lost to an effort classification)", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [APRIL_RACE(), SEPTEMBER_RACE()] }));
    for (const id of ["5k", "10mi", "half"]) expect(row(f, id).finishSeconds).not.toBeNull();
    expect(row(f, "half").estimate.demonstrated.basis).toBe("maximal_or_recorded_evidence");
    expect(row(f, "half").estimate.combination.items.some(i => i.kind === "confirmed_race")).toBe(true);
  });
  it("rollback (assumption off) falls back to the labelled demonstrated-race result for the half marathon, never to nothing", () => {
    const f = computeCurrentFitness({ ...fitnessWorld({ asOfDate: D, races: [SEPTEMBER_RACE()], adapted: false }), assumeConfirmedRacesMaximal: false });
    expect(row(f, "half").estimate.demonstrated.basis).toBe("demonstrated_performance_only");
    expect(row(f, "half").status).toBe("provisional");
    expect(row(f, "half").confidence).toBe("low");
  });
  it("hard, nonmaximal and maximal attestations give IDENTICAL numbers at every distance (one consistent assumption)", () => {
    const run = (effort: "hard" | "nonmaximal" | "maximal") => {
      const r = SEPTEMBER_RACE(); const rev = Object.values(r.race.confirmationHistory!.revisions)[0]; rev.details.effort = effort;
      return computeCurrentFitness(plain({ asOfDate: D, races: [r] })).rows.map(x => x.estimate.seconds);
    };
    expect(run("hard")).toEqual(run("maximal")); expect(run("nonmaximal")).toEqual(run("maximal"));
  });
  it("an UNKNOWN effort is still not admitted as a maximal anchor (the assumption only re-reads hard/nonmaximal)", () => {
    const r = SEPTEMBER_RACE(); Object.values(r.race.confirmationHistory!.revisions)[0].details.effort = "unknown";
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [r] }));
    expect(row(f, "half").estimate.combination.items.some(i => i.kind === "confirmed_race")).toBe(false);
  });
});

describe("2 — the half-marathon row preserves the pre-existing Hybrid v1.1 behaviour (golden values captured from origin/main f369e678 BEFORE this change)", () => {
  // seconds/minutes/pace/status/confidence/quality are the unmodified v1.1 outputs on these reproducible worlds.
  const GOLDEN: Record<string, { world: () => ReturnType<typeof adapted>; status: string; seconds: number | null; minutes: number | null; pace: number | null; confidence: string | null; quality: string; cause: string | null; flags: string[] }> = {
    sepOnly_1110: { world: () => adapted({ asOfDate: "2026-11-10", races: [SEPTEMBER_RACE()] }), status: "provisional", seconds: 7870.999999999994, minutes: 131, pace: 600, confidence: "low", quality: "adequate", cause: null, flags: [] },
    aprilSep_1110: { world: () => adapted({ asOfDate: "2026-11-10", races: [APRIL_RACE(), SEPTEMBER_RACE()] }), status: "provisional", seconds: 7870.999999999994, minutes: 131, pace: 600, confidence: "low", quality: "adequate", cause: null, flags: [] },
    aprilOnly_0601: { world: () => adapted({ asOfDate: "2026-06-01", races: [APRIL_RACE()] }), status: "provisional", seconds: 8129.999999999991, minutes: 135, pace: 620, confidence: "low", quality: "limited", cause: null, flags: [] },
    aprilSep_0925: { world: () => adapted({ asOfDate: "2026-09-25", races: [APRIL_RACE(), SEPTEMBER_RACE()] }), status: "provisional", seconds: 7934.526122148092, minutes: 132, pace: 605, confidence: "low", quality: "limited", cause: null, flags: ["aging_evidence"] },
    sepAged_0301: { world: () => adapted({ asOfDate: "2027-03-01", races: [SEPTEMBER_RACE()] }), status: "provisional", seconds: 7870.999999999994, minutes: 131, pace: 600, confidence: "low", quality: "limited", cause: null, flags: ["aging_evidence"] },
    noRace_1110: { world: () => adapted({ asOfDate: "2026-11-10", races: [] }), status: "unavailable", seconds: null, minutes: null, pace: null, confidence: null, quality: "insufficient", cause: "no_performance_evidence", flags: [] },
    sepLongRuns_1110: { world: () => adapted({ asOfDate: "2026-11-10", races: [SEPTEMBER_RACE()], gaps: [2, 2, 3], miles: [6, 7, 6, 14] }), status: "provisional", seconds: 7870.999999999994, minutes: 131, pace: 600, confidence: "low", quality: "adequate", cause: null, flags: [] },
    sepStrong_1110: { world: () => ({ ...strongEffortWorld() }), status: "provisional", seconds: 7882.2665956759765, minutes: 131, pace: 600, confidence: "low", quality: "adequate", cause: null, flags: ["slower_lower_bound_effort_down_weighted"] },
  };
  for (const [name, g] of Object.entries(GOLDEN)) {
    it(`${name}: the legacy entry point AND the half-marathon row equal the baseline`, () => {
      const w = g.world();
      const official = estimateCurrentHalfMarathon(w), hr = estimateHrEnhancedHalfMarathon(w, { official });
      const legacy = estimateHybridHalfMarathonV11(w, { official, hrEnhanced: hr, targetDistanceMeters: 21097.5 });
      const viaRow = row(computeCurrentFitness({ ...w, assumeConfirmedRacesMaximal: false }), "half");
      for (const e of [legacy, viaRow.estimate]) {
        expect(e.status).toBe(g.status); expect(e.minutes).toBe(g.minutes); expect(e.paceSecondsPerMile).toBe(g.pace);
        expect(e.confidence).toBe(g.confidence); expect(e.evidenceQuality).toBe(g.quality); expect(e.unavailableCause).toBe(g.cause);
        expect(e.flags).toEqual(g.flags);
        if (g.seconds === null) expect(e.seconds).toBeNull(); else expect(e.seconds).toBeCloseTo(g.seconds, 6);
      }
      expect(viaRow.status).toBe(g.status);
      expect(viaRow.finishSeconds).toBe(g.minutes === null ? null : g.minutes * 60);
    });
  }
  it("the half-marathon profile is bit-for-bit the unprofiled estimator (full numeric and diagnostic equality) across worlds", () => {
    for (const g of Object.values(GOLDEN)) {
      const w = g.world();
      const official = estimateCurrentHalfMarathon(w), hr = estimateHrEnhancedHalfMarathon(w, { official });
      const a = estimateHybridHalfMarathonV11(w, { official, hrEnhanced: hr, targetDistanceMeters: 21097.5 });
      const b = estimateHybridHalfMarathonV11(w, { official, hrEnhanced: hr, profile: TARGET_PROFILES.half });
      const without = (e: object, keys: string[]) => Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k)));
      expect(without(b, ["target", "assumptions"])).toEqual(without(a, ["assumptions"]));
      expect(b.sensitivityRange).toEqual(a.sensitivityRange);
    }
  });
  it("no profile fields leak into the legacy entry point (Plan Insights is untouched)", () => {
    const w = plain({ asOfDate: D, races: [SEPTEMBER_RACE()] });
    expect(estimateHybridHalfMarathonV11(w, { targetDistanceMeters: 21097.5 }).target).toBeUndefined();
  });
});

describe("3 — the four distances: definitions, order and units", () => {
  it("are 5K, 10 miles, half marathon and marathon, in that order, at the exact distances", () => {
    expect(HYBRID_TARGETS.map(t => t.id)).toEqual(["5k", "10mi", "half", "marathon"]);
    expect(HYBRID_TARGETS.map(t => t.label)).toEqual(["5K", "10 miles", "Half marathon", "Marathon"]);
    expect(HYBRID_TARGETS.map(t => t.distanceMeters)).toEqual([5000, 16093.44, 21097.5, 42195]);
    const miles = HYBRID_TARGETS.map(t => t.distanceMeters / MILE);
    expect(miles[0]).toBeCloseTo(3.10686, 4); expect(miles[1]).toBeCloseTo(10, 6); expect(miles[2]).toBeCloseTo(13.1094, 4); expect(miles[3]).toBeCloseTo(26.2188, 4);
  });
  it("rows come back in display order with the as-of timestamp, distance and label on each", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
    expect(f.rows.map(r => r.id)).toEqual(["5k", "10mi", "half", "marathon"]);
    for (const r of f.rows) { expect(r.asOf).toBe(`${D}T17:00:00.000Z`); expect(r.asOfDate).toBe(D); expect(r.estimate.targetDistanceMeters).toBe(r.distanceMeters); }
  });
  it("pace per mile is the finish time over the exact distance in MILES (to the 5 s presentation step)", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG20 }));
    for (const r of f.rows.filter(x => x.finishSeconds !== null)) expect(Math.abs(r.paceSecondsPerMile! - r.finishSeconds! / r.distanceMiles)).toBeLessThanOrEqual(2.5 + 1e-9);
  });
});

describe("4 — predictions by distance (September race 2:11:11, ordinary training)", () => {
  const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
  it("5K and 10 miles follow the Riegel conversion of the half marathon (exponent 1.06) to within rounding", () => {
    for (const [id, meters] of [["5k", 5000], ["10mi", 16093.44]] as const) {
      const riegel = SEPTEMBER_SECONDS * Math.pow(meters / 21097.5, 1.06);
      expect(Math.abs(row(f, id).estimate.seconds! / riegel - 1)).toBeLessThan(0.005);
    }
  });
  it("matches the reproducible fixture outputs: 5K 28:30 (9:10/mi), 10 miles 1:38:30 (9:50/mi), half 2:11:00 (10:00/mi)", () => {
    expect([row(f, "5k").finishSeconds, row(f, "5k").paceSecondsPerMile]).toEqual([28 * 60 + 30, 550]);
    expect([row(f, "10mi").finishSeconds, row(f, "10mi").paceSecondsPerMile]).toEqual([98 * 60 + 30, 590]);
    expect([row(f, "half").finishSeconds, row(f, "half").paceSecondsPerMile]).toEqual([131 * 60, 600]);
  });
  it("the half marathon is available with moderate confidence when the confirmed race is recent and endurance is supported", () => {
    expect(row(f, "half").status).toBe("available"); expect(row(f, "half").confidence).toBe("moderate");
  });
  it("finish times are shown to the profile's rounding increment (15 s / 30 s / 60 s / 60 s) while the exact value is kept", () => {
    expect(HYBRID_TARGETS.map(t => t.roundingSeconds)).toEqual([15, 30, 60, 60]);
    for (const r of f.rows.filter(x => x.finishSeconds !== null)) {
      const inc = TARGET_PROFILES[r.id].roundingSeconds;
      expect(r.finishSeconds! % inc).toBe(0);
      expect(Math.abs(r.finishSeconds! - r.estimate.seconds!)).toBeLessThanOrEqual(inc / 2 + 1e-6);
    }
  });
  it("each estimate carries a sensitivity range that contains its own value; the 5K's (a long conversion) is the widest relative range", () => {
    const rel = f.rows.filter(r => r.estimate.sensitivityRange).map(r => ({ id: r.id, w: (r.estimate.sensitivityRange!.slowSeconds - r.estimate.sensitivityRange!.fastSeconds) / r.estimate.seconds! }));
    for (const r of f.rows.filter(x => x.estimate.sensitivityRange)) {
      expect(r.estimate.sensitivityRange!.fastSeconds).toBeLessThanOrEqual(r.estimate.seconds! + 1e-6);
      expect(r.estimate.sensitivityRange!.slowSeconds).toBeGreaterThanOrEqual(r.estimate.seconds! - 1e-6);
    }
    expect(rel.find(x => x.id === "5k")!.w).toBeGreaterThan(rel.find(x => x.id === "half")!.w);
  });
});

describe("5 — limited shorter-distance evidence", () => {
  it("a 5K converted from a half marathon alone is provisional and low confidence, says why, and a slow training run is never read as a maximal 5K", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
    const r = row(f, "5k");
    expect(r.status).toBe("provisional"); expect(r.confidence).toBe("low");
    expect(r.estimate.target!.directShare).toBe(0);
    expect(r.provisionalReasons.join(" ")).toMatch(/mostly converted from longer-distance evidence/);
    expect(rowNote(r)).toBe("Evidence is not precise enough for Moderate. Much of the estimate is converted from a distant race distance.");
    // ordinary easy runs (any number of them) never become 5K evidence
    expect(r.estimate.combination.items.map(i => i.kind)).toEqual(["confirmed_race"]);
  });
  it("a 5K race within the athlete's range is DIRECT evidence: it carries the 5K estimate and removes the directness caveat", () => {
    const base = adapted({ asOfDate: D, races: [SEPTEMBER_RACE()] });
    const fk = distanceRace("fivek", "2026-10-18", 5000, 27 * 60 + 40, true, "5K");
    const w = { ...base, races: [...base.races, ...treatConfirmedRacesAsMaximal([fk.race])], workouts: [...base.workouts, fk.workout] };
    const f = computeCurrentFitness({ ...w, assumeConfirmedRacesMaximal: false });
    const r = row(f, "5k");
    expect(r.estimate.target!.directShare).toBeGreaterThan(0.5);
    expect(r.provisionalReasons.join(" ")).not.toMatch(/mostly converted from longer-distance/);
    expect(Math.abs(r.estimate.seconds! - (27 * 60 + 40))).toBeLessThan(60);
  });
  it("the 5K has no endurance gate; 10 miles needs endurance support, which a recent LONGER (half-marathon) performance provides", () => {
    const light = { start: addDays(D, -60), gaps: [3, 3, 4], miles: [2.5, 3, 2.5] };
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...light }));
    expect(row(f, "5k").status).toBe("provisional");
    expect(row(f, "10mi").status).not.toBe("unavailable");            // the half marathon already demonstrates 10-mile endurance
    // with no race at all and light training, nothing is invented
    const none = computeCurrentFitness(plain({ asOfDate: D, races: [], ...light }));
    expect(none.rows.every(r => r.status === "unavailable")).toBe(true);
  });
  it("a 5K without any qualifying evidence is unavailable with the cause, not an invented number", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [] }));
    for (const r of f.rows) { expect(r.status).toBe("unavailable"); expect(r.finishSeconds).toBeNull(); expect(r.paceSecondsPerMile).toBeNull(); expect(r.confidence).toBeNull(); expect(r.unavailableCause).toBe("no_performance_evidence"); expect(r.reason).toMatch(/No qualifying race/); }
  });
});

describe("6 — marathon durability: half-marathon ability is not proof of marathon readiness", () => {
  it("withholds the marathon (insufficient endurance preparation) when the longest recent run is under 12 miles, while the half still shows", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
    const m = row(f, "marathon");
    expect(m.status).toBe("unavailable"); expect(m.unavailableCause).toBe("insufficient_endurance_preparation"); expect(m.finishSeconds).toBeNull();
    expect(m.flags).toContain("durability_unsupported"); expect(m.reason).toMatch(/longest recent run is 8\.0 miles/); expect(rowNote(m)).toMatch(/Needs recent long runs/);
    expect(row(f, "half").finishSeconds).not.toBeNull();
  });
  it("withholds the marathon when there are too few recent weeks to know long-run history (unknown is not unprepared, but is not evidence either)", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], start: addDays(D, -10), gaps: [2, 2, 3], miles: [5, 6, 20] }));
    const m = row(f, "marathon");
    expect(m.status).toBe("unavailable"); expect(m.reason).toMatch(/Fewer than four recent weeks/);
  });
  it("is provisional and low confidence with 12–16 mile long runs, and says durability is not demonstrated", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], gaps: [2, 2, 3], miles: [5, 6, 5, 14] }));
    const m = row(f, "marathon");
    expect(m.status).toBe("provisional"); expect(m.confidence).toBe("low");
    expect(m.provisionalReasons.join(" ")).toMatch(/durability is not demonstrated/);
    expect(m.estimate.target!.durability!.satisfied).toBe(false);
  });
  it("with 16–20 mile long runs and weekly volume the durability checks pass, yet a half-marathon-only base is still provisional (limited conversion evidence)", () => {
    const m = row(computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG20 })), "marathon");
    expect(m.estimate.target!.durability!.satisfied).toBe(true);
    expect(m.provisionalReasons.join(" ")).not.toMatch(/durability/);
    expect(m.status).toBe("provisional"); expect(m.confidence).toBe("low");
  });
  it("is always slower than the half marathon by a plausible factor (2.05–2.30×), never the naive 2×", () => {
    for (const o of [LONG20, LONG16, { gaps: [2, 2, 3], miles: [5, 6, 5, 14] }]) {
      const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...o }));
      const h = row(f, "half").estimate.seconds!, m = row(f, "marathon").estimate.seconds!;
      expect(m / h).toBeGreaterThan(2.05); expect(m / h).toBeLessThan(2.3);
    }
  });
  it("a LESS prepared athlete gets a slower marathon than a better prepared one from the same half-marathon result", () => {
    const hi = row(computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG20 })), "marathon").estimate.seconds!;
    const lo = row(computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()], gaps: [2, 2, 3], miles: [5, 6, 5, 14] })), "marathon").estimate.seconds!;
    expect(lo).toBeGreaterThan(hi);
  });
  it("a recent marathon-distance performance demonstrates durability directly: the gates are waived and the result is that performance", () => {
    const base = adapted({ asOfDate: D, races: [] });
    const m = distanceRace("marathon", "2026-10-11", 42195, 4 * 3600 + 20 * 60, true, "marathon");
    const w = { ...base, races: m.race ? [m.race] : [], workouts: [...base.workouts, m.workout] };
    const f = computeCurrentFitness({ ...w, assumeConfirmedRacesMaximal: false });
    const r = row(f, "marathon");
    expect(r.status).not.toBe("unavailable");
    expect(r.estimate.target!.durability!.demonstratedAtTarget).toBe(true);
    expect(Math.abs(r.estimate.seconds! - (4 * 3600 + 20 * 60))).toBeLessThan(5 * 60);
  });
  it("marathon evidence is never used to make a half or shorter faster than their own evidence without a directness caveat on the 5K", () => {
    const base = adapted({ asOfDate: D, races: [] });
    const m = distanceRace("marathon", "2026-10-11", 42195, 4 * 3600 + 20 * 60, true, "marathon");
    const f = computeCurrentFitness({ ...base, races: [m.race], workouts: [...base.workouts, m.workout], assumeConfirmedRacesMaximal: false });
    expect(row(f, "5k").provisionalReasons.join(" ")).toMatch(/mostly converted from longer-distance/);
  });
});

describe("7 — cross-distance consistency and plausible relative pacing", () => {
  const worlds: [string, Parameters<typeof plain>[0]][] = [
    ["recent race, ordinary training", { asOfDate: D, races: [SEPTEMBER_RACE()] }],
    ["well trained", { asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG20 }],
    ["low volume long run", { asOfDate: D, races: [SEPTEMBER_RACE()], gaps: [2, 2, 3], miles: [5, 6, 5, 14] }],
    ["slower April race", { asOfDate: "2026-06-01", races: [APRIL_RACE()], ...LONG16 }],
  ];
  for (const [name, o] of worlds) {
    it(`${name}: times strictly increase, pace never decreases with distance, implied exponents stay in ${CROSS_DISTANCE_EXPONENT_BAND.min}–${CROSS_DISTANCE_EXPONENT_BAND.max}`, () => {
      const f = computeCurrentFitness(plain(o));
      const av = f.rows.filter(r => r.estimate.seconds !== null);
      expect(av.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < av.length; i++) {
        expect(av[i].estimate.seconds!).toBeGreaterThan(av[i - 1].estimate.seconds!);
        expect(av[i].estimate.seconds! / av[i].distanceMiles).toBeGreaterThanOrEqual(av[i - 1].estimate.seconds! / av[i - 1].distanceMiles - 1e-9);
      }
      expect(f.consistency.consistent).toBe(true);
      for (const p of f.consistency.pairs) { expect(p.impliedExponent).toBeGreaterThanOrEqual(1.0); expect(p.impliedExponent).toBeLessThanOrEqual(1.2); }
    });
  }
  it("an internally inconsistent pair (very fast 5K race beside a slow half) is FLAGGED and downgraded, never silently clamped", () => {
    const base = adapted({ asOfDate: D, races: [SEPTEMBER_RACE()] });
    const fk = distanceRace("fast5k", "2026-10-20", 5000, 20 * 60, true, "5K");
    const f = computeCurrentFitness({ ...base, races: [...base.races, ...treatConfirmedRacesAsMaximal([fk.race])], workouts: [...base.workouts, fk.workout], assumeConfirmedRacesMaximal: false });
    const bad = f.consistency.pairs.filter(p => !p.plausible);
    expect(bad.length).toBeGreaterThan(0);
    for (const p of bad) for (const id of [p.from, p.to]) {
      const r = row(f, id); expect(r.flags).toContain("inconsistent_with_adjacent_distance"); expect(r.status).toBe("provisional"); expect(r.confidence).toBe("low");
      expect(r.provisionalReasons.join(" ")).toMatch(/implausible distance-scaling exponent/);
      expect(r.finishSeconds).toBe(Math.round(r.estimate.seconds! / TARGET_PROFILES[r.id].roundingSeconds) * TARGET_PROFILES[r.id].roundingSeconds);   // number untouched
    }
  });
  it("no distance is implausibly optimistic: every estimate is slower than the unadjusted Riegel (1.06) conversion of the half only when readiness is below full", () => {
    for (const [, o] of worlds) {
      const f = computeCurrentFitness(plain(o));
      const half = row(f, "half").estimate.seconds!;
      for (const r of f.rows.filter(x => x.estimate.seconds !== null && (x.id === "marathon"))) {
        expect(r.estimate.seconds!).toBeGreaterThanOrEqual(half * Math.pow(r.distanceMeters / 21097.5, 1.06) * 0.999);
      }
    }
  });
});

describe("8 — formatting and unit accuracy", () => {
  it("formats finish times", () => {
    expect([formatFinishTime(1710), formatFinishTime(3600), formatFinishTime(7871), formatFinishTime(16740), formatFinishTime(59.6)]).toEqual(["28:30", "1:00:00", "2:11:11", "4:39:00", "1:00"]);
    expect([formatFinishTime(null), formatFinishTime(undefined), formatFinishTime(NaN), formatFinishTime(0), formatFinishTime(-5), formatFinishTime(Infinity)]).toEqual(Array(6).fill("—"));
  });
  it("formats pace per mile", () => {
    expect([formatPacePerMile(600), formatPacePerMile(551.4), formatPacePerMile(659.6), formatPacePerMile(null), formatPacePerMile(NaN), formatPacePerMile(0)]).toEqual(["10:00", "9:11", "11:00", "—", "—", "—"]);
  });
  it("formats the as-of date without a time-zone shift", () => {
    expect(formatAsOfDate("2026-11-10")).toBe("Nov 10, 2026"); expect(formatAsOfDate("2027-01-01")).toBe("Jan 1, 2027"); expect(formatAsOfDate("garbage")).toBe("garbage");
  });
  it("labels confidence and notes without inventing states", () => {
    const f = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
    expect(f.rows.map(confidenceLabel)).toEqual(["Low", "Moderate", "Moderate", "Insufficient evidence"]);
    expect(rowNote(row(f, "half"))).toBe(""); expect(rowNote(row(f, "10mi"))).toBe("");
  });
  it("a finish time over the exact distance gives the reported pace for the owner's own result (7,871 s over 13.1094 mi = 10:00/mi)", () => {
    expect(formatPacePerMile(7871 / (21097.5 / MILE))).toBe("10:00");
  });
});

describe("9 — no future data in historical snapshots", () => {
  const full = (() => {
    const w = adapted({ asOfDate: "2026-12-20", races: [APRIL_RACE(), SEPTEMBER_RACE()], ...LONG16 });
    const late = distanceRace("late-fast", "2026-12-05", 21097.5, 7000, true, "halfMarathon");   // a FASTER race after the snapshot date
    return { ...w, races: [...w.races, late.race], workouts: [...w.workouts, late.workout] };
  })();
  it("a snapshot at 2026-11-20 is identical whether or not later races, confirmations and runs exist in the data", () => {
    const asOf = "2026-11-20T17:00:00.000Z";
    const truncated = { ...full, races: full.races.filter(r => r.raceDate <= "2026-11-20"), workouts: full.workouts.filter(w => w.endDate.getTime() <= Date.parse(asOf)), asOf };
    const a = computeCurrentFitness({ ...full, asOf, assumeConfirmedRacesMaximal: false }), b = computeCurrentFitness({ ...truncated, assumeConfirmedRacesMaximal: false });
    expect(a.rows.map(r => r.estimate.seconds)).toEqual(b.rows.map(r => r.estimate.seconds));
    expect(a.rows.map(r => r.status)).toEqual(b.rows.map(r => r.status));
    expect(a.rows.map(r => r.confidence)).toEqual(b.rows.map(r => r.confidence));
  });
  it("a confirmation that became available AFTER the snapshot does not upgrade the race inside it (strict historical availability)", () => {
    const before = computeCurrentFitness({ ...full, asOf: "2026-10-12T17:00:00.000Z", assumeConfirmedRacesMaximal: false });
    const after = computeCurrentFitness({ ...full, asOf: "2026-10-30T17:00:00.000Z", assumeConfirmedRacesMaximal: false });
    expect(row(before, "half").estimate.combination.items.some(i => i.kind === "confirmed_race")).toBe(false);
    expect(row(after, "half").estimate.combination.items.some(i => i.kind === "confirmed_race")).toBe(true);
  });
  it("the later, faster race changes nothing before it exists and everything after it does", () => {
    const pre = computeCurrentFitness({ ...full, asOf: "2026-12-04T17:00:00.000Z", assumeConfirmedRacesMaximal: false });
    const post = computeCurrentFitness({ ...full, asOf: "2026-12-20T17:00:00.000Z", assumeConfirmedRacesMaximal: false });
    expect(row(post, "half").estimate.seconds!).toBeLessThan(row(pre, "half").estimate.seconds!);
  });
});

describe("10 — stability under routine training and responsiveness to real evidence", () => {
  const base = adapted({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG16 });
  const baseline = computeCurrentFitness(base);
  it("one routine easy run does not move any estimate beyond rounding", () => {
    const easy = makeRun({ id: "easy-new", date: addDays(D, -1), pace: 640, hr: 140, minutes: 40, tempF: 60, climbPerMile: 8 });
    const f = computeCurrentFitness({ ...base, workouts: [...base.workouts, easy] });
    for (const r of f.rows) {
      const b = row(baseline, r.id);
      if (b.estimate.seconds === null) { expect(r.estimate.seconds).toBeNull(); continue; }
      expect(Math.abs(r.estimate.seconds! / b.estimate.seconds - 1)).toBeLessThan(0.003);
    }
  });
  it("a month of slightly slower ordinary running does not collapse or inflate any estimate (≤ 1.5 %)", () => {
    const slower = cadenceRuns({ start: addDays(D, -28), end: addDays(D, -1), gaps: [2, 2, 3], miles: [5, 6, 5, 8], basePace: 650, baseHr: 146, idPrefix: "slow" });
    const f = computeCurrentFitness({ ...base, workouts: [...base.workouts, ...slower] });
    for (const r of f.rows.filter(x => row(baseline, x.id).estimate.seconds !== null && x.estimate.seconds !== null)) expect(Math.abs(r.estimate.seconds! / row(baseline, r.id).estimate.seconds! - 1)).toBeLessThan(0.015);
  });
  it("two strong, corroborating efforts DO improve the shorter estimates (responsive, bounded)", () => {
    const strong = strongEffortWorld(D, 520);
    const f = computeCurrentFitness({ ...strong, assumeConfirmedRacesMaximal: true });
    const plainSep = computeCurrentFitness(plain({ asOfDate: D, races: [SEPTEMBER_RACE()] }));
    for (const id of ["5k", "10mi", "half"]) expect(row(f, id).estimate.seconds!).toBeLessThan(row(plainSep, id).estimate.seconds!);
    expect(1 - row(f, "5k").estimate.seconds! / row(plainSep, "5k").estimate.seconds!).toBeGreaterThan(0.03);
    expect(1 - row(f, "half").estimate.seconds! / row(plainSep, "half").estimate.seconds!).toBeLessThan(0.1);   // a lone newer pair never replaces the race outright
  });
  it("a new, genuinely faster confirmed race improves EVERY available distance", () => {
    const fast = distanceRace("fast-half", "2026-10-25", 21097.5, 7400, true, "halfMarathon");
    const f = computeCurrentFitness({ ...base, races: [...base.races, ...treatConfirmedRacesAsMaximal([fast.race])], workouts: [...base.workouts, fast.workout], assumeConfirmedRacesMaximal: false });
    for (const r of f.rows) if (row(baseline, r.id).estimate.seconds !== null) expect(r.estimate.seconds!).toBeLessThan(row(baseline, r.id).estimate.seconds!);
  });
  it("a slower, UNCONFIRMED effort never makes a race-based estimate slower by more than 1 % (a submaximal run looks slow)", () => {
    const slowEffort = makeRun({ id: "slowish", date: addDays(D, -6), pace: 640, hr: 172, minutes: 5 * 640 / 60, tempF: 55, climbPerMile: 8 });
    const f = computeCurrentFitness({ ...base, workouts: [...base.workouts, slowEffort] });
    for (const r of f.rows) if (row(baseline, r.id).estimate.seconds !== null && r.estimate.seconds !== null) expect(r.estimate.seconds / row(baseline, r.id).estimate.seconds!).toBeLessThan(1.01);
  });
});

describe("11 — missing, malformed, duplicated and incomplete inputs", () => {
  const base = adapted({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG16 });
  const baseline = computeCurrentFitness(base);
  const same = (f: CurrentFitness) => expect(f.rows.map(r => [r.estimate.seconds, r.status, r.confidence])).toEqual(baseline.rows.map(r => [r.estimate.seconds, r.status, r.confidence]));
  it("no data at all returns four explicit unavailable rows and does not throw", () => {
    const f = computeCurrentFitness({ races: [], workouts: [], overrides: {}, asOf: `${D}T17:00:00.000Z`, timeZone: FIT_TZ });
    expect(f.rows.map(r => r.status)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
  });
  it("duplicated workout records (same id twice) change nothing", () => {
    same(computeCurrentFitness({ ...base, workouts: [...base.workouts, ...base.workouts.slice(0, 20)] }));
  });
  it("incomplete runs (partial route, no distance, no duration, NaN values) are excluded without throwing", () => {
    const bad = [
      { ...makeRun({ id: "partial", date: addDays(D, -3), pace: 450, hr: 175, minutes: 40, tempF: 55 }), routeComplete: false },
      { ...makeRun({ id: "nodist", date: addDays(D, -4), pace: 500, hr: 170, minutes: 40, tempF: 55 }), distanceMiles: 0, distanceMeters: 0 },
      { ...makeRun({ id: "nodur", date: addDays(D, -5), pace: 500, hr: 170, minutes: 40, tempF: 55 }), durationSeconds: 0 },
      { ...makeRun({ id: "nan", date: addDays(D, -6), pace: 500, hr: 170, minutes: 40, tempF: 55 }), distanceMiles: NaN, durationSeconds: NaN },
      { ...makeRun({ id: "nohr", date: addDays(D, -7), pace: 450, hr: 175, minutes: 40, tempF: 55 }), avgHeartRate: null },
    ];
    expect(() => computeCurrentFitness({ ...base, workouts: [...base.workouts, ...bad] })).not.toThrow();
    same(computeCurrentFitness({ ...base, workouts: [...base.workouts, ...bad] }));
  });
  it("optional inputs (heart rate, GPS route, weather, VO₂ max, streams) may all be absent", () => {
    const stripped = base.workouts.map(w => ({ ...w, avgHeartRate: null, hasRoute: false, weather: null, elevationGainM: null }));
    const f = computeCurrentFitness({ ...base, workouts: stripped }, { vo2Entries: [], vo2Load: "loaded", streamLoad: "failed" });
    expect(f.rows.find(r => r.id === "half")!.estimate.seconds).not.toBeNull();
    expect(f.rows.map(r => r.id)).toEqual(["5k", "10mi", "half", "marathon"]);
  });
  it("an invalid cutoff is rejected, never silently replaced by the current time", () => {
    expect(() => estimateHybridCurrentFitness({ races: [], workouts: [], overrides: {}, asOf: "not-a-date", timeZone: FIT_TZ })).toThrow(TypeError);
  });
});

describe("12 — official estimates and the race-day forecast inputs are untouched", () => {
  it("the official v2 and HR-enhanced estimates do not depend on this module (identical with and without computing the four distances)", () => {
    const w = plain({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG16 });
    const a = estimateCurrentHalfMarathon(w), ha = estimateHrEnhancedHalfMarathon(w, { official: a });
    computeCurrentFitness(w);
    const b = estimateCurrentHalfMarathon(w), hb = estimateHrEnhancedHalfMarathon(w, { official: b });
    expect(b).toEqual(a); expect(hb).toEqual(ha);
  });
  it("the same-distance estimator used by Plan Insights (no profile) yields the same half-marathon number as the table row", () => {
    const w = adapted({ asOfDate: D, races: [SEPTEMBER_RACE()], ...LONG16 });
    const official = estimateCurrentHalfMarathon(w), hr = estimateHrEnhancedHalfMarathon(w, { official });
    const planInsights = estimateHybridHalfMarathonV11(w, { official, hrEnhanced: hr, targetDistanceMeters: 21097.5 });
    expect(row(computeCurrentFitness(w), "half").estimate.seconds).toBe(planInsights.seconds);
    expect(row(computeCurrentFitness(w), "half").estimate.confidence).toBe(planInsights.confidence);
  });
  it("live code never imports the research module", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
    expect(walk("src").filter(f => /research\/hybridTargetsEvaluation/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("13 — module hygiene", () => {
  it("the table component never fetches, persists or reaches Firestore", () => {
    const src = readFileSync("src/components/insights/CurrentFitnessTable.tsx", "utf8");
    expect(src).not.toMatch(/firebase|firestore|fetch\(|localStorage|sessionStorage|setDoc|addDoc/i);
  });
});
