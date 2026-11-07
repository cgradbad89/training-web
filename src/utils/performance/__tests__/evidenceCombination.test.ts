import { describe, expect, it } from "vitest";
import type { EvidenceItemV11, EvidenceKindV11 } from "@/types/hybridPerformanceV11";
import { combineEvidence, COMBINATION_POLICY } from "../evidenceCombination";

const HM = 21097.5, AS_OF = "2026-11-07";
const dateOf = (age: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - age * 86_400_000).toISOString().slice(0, 10);
/** An item AT the target distance: its half-marathon equivalent is exactly `seconds`. */
const at = (id: string, kind: EvidenceKindV11, age: number, seconds: number, extra: Partial<EvidenceItemV11> = {}): EvidenceItemV11 => ({
  clusterId: id, workoutId: id, raceId: null, kind, tier: kind === "confirmed_race" ? "confirmed_maximal" : "strong_unconfirmed", date: dateOf(age), ageDays: age,
  distanceMeters: HM, seconds, avgHeartRate: 170, tempF: 55, weatherMissing: false, segment: null, reasons: [], ...extra });
const race = (age: number, seconds = 7860, kind: EvidenceKindV11 = "recorded_race") => at(`race-${age}`, kind, age, seconds);
const efforts = (n: number, seconds: number, firstAge = 8, step = 8, kind: EvidenceKindV11 = "whole_run_effort") =>
  Array.from({ length: n }, (_, i) => at(`eff-${seconds}-${i}`, kind, firstAge + i * step, seconds * (1 + 0.001 * ((i % 3) - 1))));
const base = (items: EvidenceItemV11[], params = {}) => combineEvidence(items, { targetDistanceMeters: HM, params }).baseSeconds!;
const combo = (items: EvidenceItemV11[]) => combineEvidence(items, { targetDistanceMeters: HM });

describe("aging without new information", () => {
  it("never makes a lone race faster or slower: the number is unchanged and only its uncertainty grows", () => {
    const young = combo([race(5)]), old = combo([race(150)]);
    expect(young.baseSeconds).toBeCloseTo(7860, 6); expect(old.baseSeconds).toBeCloseTo(7860, 6);
    expect(young.raceShare).toBe(1); expect(old.raceShare).toBe(1);
    expect(old.uncertaintyFraction!).toBeGreaterThan(young.uncertaintyFraction!);
    expect(old.flags).toContain("aging_evidence");
  });
  it("uncertainty grows continuously with age (no step at an arbitrary threshold)", () => {
    const u = [0, 30, 60, 90, 120, 150, 179].map(a => combo([race(a)]).uncertaintyFraction!);
    for (let i = 1; i < u.length; i++) expect(u[i]).toBeGreaterThan(u[i - 1]);
    const steps = u.slice(1).map((x, i) => x - u[i]);
    expect(Math.max(...steps)).toBeLessThan(0.003);
  });
});

describe("a race is displaced continuously by credible newer evidence — not by a decay constant", () => {
  const raceOld = race(100);
  it("race influence falls as independent, consistent newer efforts accumulate, and the estimate moves toward them", () => {
    const shares = [1, 2, 3, 4, 6].map(k => combo([raceOld, ...efforts(k, 7500)]));
    for (let i = 1; i < shares.length; i++) expect(shares[i].raceShare).toBeLessThanOrEqual(shares[i - 1].raceShare + 1e-12);
    expect(shares[4].raceShare).toBeLessThan(shares[0].raceShare);
    expect(shares[4].baseSeconds!).toBeLessThan(shares[0].baseSeconds!);
    for (const s of shares) { expect(s.baseSeconds!).toBeLessThan(7860); expect(s.baseSeconds!).toBeGreaterThan(7500 * 0.999); }
  });
  it("a 100-day-old race and a 5-day-old race do not play the same role against the same newer evidence", () => {
    const newer = efforts(3, 7500, 8);
    expect(combo([race(100), ...newer]).raceShare).toBeLessThan(combo([race(5), ...newer]).raceShare);
  });
  it("normalising a single race's raw weight does not matter: with no newer evidence the share stays 100 % at any age", () => {
    for (const a of [1, 60, 100, 170]) expect(combo([race(a)]).raceShare).toBe(1);
  });
  it("newer efforts can displace the race (majority) once enough corroborating evidence exists, with no race required", () => {
    const many = combo([race(150), ...efforts(6, 7500, 6, 7)]);
    expect(many.newerEvidenceMajority).toBe(true);
    expect(many.raceDominance === "shared" || many.raceDominance === "minor").toBe(true);
  });
  it("evidence mass saturates: even many efforts from one block cannot reach a 100 % share (common-mode term)", () => {
    const c = combo([race(5), ...efforts(30, 7500, 3, 1)]);
    expect(c.recentShare).toBeLessThan(0.7); expect(c.raceShare).toBeGreaterThan(0.3);
  });
  it("one fast effort cannot displace a race: it is flagged isolated and moves the estimate only slightly", () => {
    const c = combo([raceOld, ...efforts(1, 7860 * 0.94, 10)]);
    expect(c.items.find(i => i.group === "recent_effort")!.flags).toContain("isolated_uncorroborated");
    expect(Math.abs(c.baseSeconds! / 7860 - 1)).toBeLessThan(0.015);
    expect(c.raceDominance).toBe("dominant");
  });
  it("a corroborating second effort lifts the isolation flag and moves the estimate further", () => {
    const one = combo([raceOld, ...efforts(1, 7500, 10)]), two = combo([raceOld, ...efforts(2, 7500, 10, 9)]);
    expect(two.items.every(i => !i.flags.includes("isolated_uncorroborated"))).toBe(true);
    expect(two.baseSeconds!).toBeLessThan(one.baseSeconds!);
  });
});

describe("improvement and deterioration are tested in both directions", () => {
  const raceOld = race(60);
  const faster = base([raceOld, ...efforts(3, 7860 * 0.96)]) / 7860 - 1;
  const slower = base([raceOld, ...efforts(3, 7860 * 1.04)]) / 7860 - 1;
  it("faster and slower corroborated efforts move the estimate in opposite directions", () => { expect(faster).toBeLessThan(0); expect(slower).toBeGreaterThan(0); });
  it("a slower unconfirmed effort is weaker evidence than an equally faster one (a submaximal effort looks slow)", () => {
    expect(Math.abs(slower)).toBeLessThan(Math.abs(faster));
    const c = combo([raceOld, ...efforts(3, 7860 * 1.04)]);
    expect(c.items.filter(i => i.group === "recent_effort").every(i => i.flags.includes("slower_than_estimate_lower_bound"))).toBe(true);
  });
  it("a slower sustained SEGMENT is ignored entirely: it says nothing about capacity", () => {
    const c = combo([raceOld, ...efforts(3, 7860 * 1.04, 8, 8, "sustained_segment")]);
    expect(c.ignored.filter(i => i.reason === "segment_slower_than_estimate")).toHaveLength(3);
    expect(c.baseSeconds!).toBeCloseTo(7860, 6); expect(c.flags).toContain("slower_segment_ignored");
  });
  it("a single slower effort is not proof of decline (isolated and inflated)", () => {
    const c = combo([raceOld, ...efforts(1, 7860 * 1.08, 9)]);
    expect(Math.abs(c.baseSeconds! / 7860 - 1)).toBeLessThan(0.006);
  });
  it("even a modestly slower lone effort (inside the 4 % margin) needs corroboration: it is inflated and moves the estimate by well under 0.2 %", () => {
    const c = combo([raceOld, ...efforts(1, 7860 * 1.039, 9)]);
    expect(c.items.find(i => i.group === "recent_effort")!.flags).toEqual(expect.arrayContaining(["slower_than_estimate_lower_bound", "isolated_uncorroborated"]));
    expect(c.baseSeconds! / 7860 - 1).toBeLessThan(0.002); expect(c.baseSeconds!).toBeGreaterThanOrEqual(7860);
    const two = combo([raceOld, ...efforts(2, 7860 * 1.039, 9, 9)]);
    expect(two.items.every(i => !i.flags.includes("isolated_uncorroborated"))).toBe(true);        // corroborated: the second effort lifts the isolation
    expect(two.baseSeconds!).toBeGreaterThan(c.baseSeconds!);
  });
  it("a slower RACE is symmetric evidence (not down-weighted like an unconfirmed effort)", () => {
    const c = combo([race(100, 7860), race(10, 8300)]);
    expect(c.baseSeconds!).toBeGreaterThan(8000);
    expect(c.items.every(i => !i.flags.includes("slower_than_estimate_lower_bound"))).toBe(true);
  });
});

describe("reconciliation, determinism and independence", () => {
  const items = [race(90), ...efforts(4, 7600, 7, 6), at("seg", "sustained_segment", 12, 7550, { distanceMeters: 10000 })];
  it("effective shares sum to one and exactly reproduce the base", () => {
    const c = combo(items);
    expect(c.items.reduce((s, i) => s + i.effectiveShare, 0)).toBeCloseTo(1, 12);
    const rebuilt = Math.exp(c.items.reduce((s, i) => s + i.effectiveShare * Math.log(i.equivalentSeconds), 0));
    // pooled group means are precision-weighted within group; shares are group share × within-group share
    expect(rebuilt).toBeCloseTo(c.baseSeconds!, 6);
    expect(c.raceShare + c.recentShare).toBeCloseTo(1, 12);
  });
  it("is order-independent", () => {
    const a = combo(items).baseSeconds!, b = combo([...items].reverse()).baseSeconds!, c = combo([...items].sort((x, y) => x.clusterId.localeCompare(y.clusterId))).baseSeconds!;
    expect(b).toBeCloseTo(a, 9); expect(c).toBeCloseTo(a, 9);
  });
  it("reports the counterfactual: what the race alone implies, and how far newer evidence displaced it", () => {
    const c = combo(items);
    expect(c.raceOnlySeconds).toBeCloseTo(7860, 6);
    expect(c.displacementSeconds!).toBeCloseTo(c.baseSeconds! - 7860, 6);
    expect(c.displacementSeconds!).toBeLessThan(0);
  });
  it("counts each workout once (a duplicate cluster in the input is a caller error, but equal items do not change shares ordering)", () => {
    const c = combo(items);
    expect(new Set(c.items.map(i => i.clusterId)).size).toBe(c.items.length);
  });
});

describe("sufficiency without a race", () => {
  it("two efforts in the same week are not enough; two in different weeks are", () => {
    const sameWeek = combo([at("a", "whole_run_effort", 8, 7600, { date: "2026-10-26" }), at("b", "whole_run_effort", 9, 7600, { date: "2026-10-27" })]);
    expect(sameWeek.status).toBe("unavailable"); expect(sameWeek.unavailableCause).toBe("insufficient_independent_evidence");
    const apart = combo([at("a", "whole_run_effort", 8, 7600), at("b", "whole_run_effort", 20, 7600)]);
    expect(apart.status).toBe("available"); expect(apart.flags).toContain("no_race_anchor"); expect(apart.raceDominance).toBe("none"); expect(apart.race).toBeNull();
    expect(apart.quality).toBe("limited");
  });
  it("one effort alone is insufficient; nothing at all is 'no evidence'; expired-only is reported as expired", () => {
    expect(combo([at("a", "whole_run_effort", 8, 7600)]).unavailableCause).toBe("insufficient_independent_evidence");
    expect(combo([]).unavailableCause).toBe("no_performance_evidence");
    expect(combineEvidence([], { expiredItems: 2 }).unavailableCause).toBe("anchor_expired_no_contemporary_evidence");
  });
  it("efforts that convert unreliably to the target distance (a 1 km effort) cannot carry a half marathon", () => {
    const c = combo([at("a", "whole_run_effort", 8, 200, { distanceMeters: 1000 }), at("b", "whole_run_effort", 20, 205, { distanceMeters: 1000 })]);
    expect(c.status).toBe("unavailable");
  });
});

describe("quality and conflicts", () => {
  it("a confirmed fresh race is adequate; a lone recorded race is limited", () => {
    expect(combo([race(10, 7860, "confirmed_race")]).quality).toBe("adequate");
    expect(combo([race(10)]).quality).toBe("limited");
  });
  it("two disagreeing races are contradictory; recent efforts that differ from a race are reported as a difference, not as noise", () => {
    expect(combo([race(20, 7600), race(30, 8200)]).flags).toContain("contradictory_evidence");
    const diff = combo([race(60, 7860, "confirmed_race"), ...efforts(4, 7860 * 0.95, 6, 6)]);
    expect(diff.flags).toContain("recent_evidence_faster_than_race"); expect(diff.flags).not.toContain("contradictory_evidence");
  });
});

describe("assumption sensitivity parameters", () => {
  const items = [race(100), ...efforts(3, 7500, 8)];
  it("excluding a kind, scaling measurement noise or common-mode terms moves the estimate in the expected direction", () => {
    const b = base(items);
    expect(base(items, { excludeKinds: ["whole_run_effort"] })).toBeCloseTo(7860, 6);
    expect(base(items, { commonModeRecent: 0.005 })).toBeLessThan(b);
    expect(base(items, { commonModeRecent: 0.04 })).toBeGreaterThan(b);
    expect(base(items, { driftPerSqrtMonth: 0.02 })).toBeLessThan(b);
    expect(base(items, { measurementScale: 0.5 })).toBeLessThan(b);
  });
  it("policy constants are the documented engineering assumptions", () => {
    expect(COMBINATION_POLICY.commonMode).toEqual({ race: 0.01, recent_effort: 0.015 });
    expect(COMBINATION_POLICY.driftPerSqrtMonth).toBe(0.01);
  });
});
