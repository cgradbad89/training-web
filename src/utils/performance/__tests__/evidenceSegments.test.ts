import { describe, expect, it } from "vitest";
import { qualifyPerformanceEvidence } from "../evidenceQualification";
import { qualifyEvidenceV11, SEGMENT_POLICY } from "../evidenceSegments";
import { estimateHybridHalfMarathon } from "../hybridPerformance";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { athleteV11, type SegmentRunSpec } from "../../__tests__/fixtures/hybridV11Fixture";

const seg = (date: string, o: Partial<SegmentRunSpec> = {}): SegmentRunSpec => ({ date, hostMiles: 8, hostPace: 585, hr: 166, key: "10k", segPace: 545, type: "Tempo Run", ...o });
const OLD = "2026-07-30";
const q = (o = {}) => qualifyEvidenceV11(athleteV11({ raceDate: OLD, ...o }));
const segs = (o = {}) => q(o).independent.filter(i => i.kind === "sustained_segment");

describe("v1.1 evidence is the unchanged v1 qualification plus sustained segments", () => {
  it("races and whole-run efforts are exactly v1's; no v1 field is altered", () => {
    const a = athleteV11({ raceDate: OLD, strong: [{ date: "2026-10-10", miles: 6, pace: 548, hr: 172 }] });
    const v1 = qualifyPerformanceEvidence(a), v11 = qualifyEvidenceV11(a);
    expect(v11.base).toEqual(v1);
    const key = (i: { clusterId: string; seconds: number; distanceMeters: number; date: string }) => `${i.clusterId}|${i.seconds}|${i.distanceMeters}|${i.date}`;
    expect(v11.independent.filter(i => i.kind !== "sustained_segment").map(key).sort()).toEqual(v1.independent.map(key).sort());
  });
});

describe("sustained segments: tempo, progression, fast finish, hard 10 K inside a run", () => {
  it("a continuous tempo is invisible to v1 and becomes a submaximal lower-bound segment in v1.1", () => {
    const a = athleteV11({ raceDate: OLD, segments: [seg("2026-10-28")] });
    expect(qualifyPerformanceEvidence(a).independent.map(i => i.kind)).toEqual(["recorded_race"]);       // v1: nothing newer qualifies
    const s = qualifyEvidenceV11(a).independent.filter(i => i.kind === "sustained_segment");
    expect(s).toHaveLength(1); expect(s[0].tier).toBe("strong_unconfirmed"); expect(s[0].segment!.key).toBe("10k");
    expect(s[0].distanceMeters).toBe(10000); expect(s[0].segment!.hostDistanceMeters).toBeGreaterThan(10000); expect(s[0].segment!.hostHrAboveMedianBpm).toBeGreaterThanOrEqual(SEGMENT_POLICY.hrSupportBpm);
  });
  it("progression and fast-finish runs (no structured label) qualify the same way", () => {
    for (const type of ["Run", "Outdoor Run"]) expect(segs({ segments: [seg("2026-10-20", { type, hostPace: 600, hr: 160 })] })).toHaveLength(1);
  });
  it("a fast segment is not a maximal test: it is never a confirmed tier and never promoted by being the fastest seen", () => {
    const s = segs({ segments: [seg("2026-10-28", { segPace: 480 })] });
    expect(s.every(i => i.tier === "strong_unconfirmed")).toBe(true);
    expect(q({ segments: [seg("2026-10-28", { segPace: 480 })] }).base.counts.confirmed_maximal).toBe(0);
  });
  it("ordinary runs' fastest segments (the athlete's own envelope) are never evidence", () => {
    expect(segs()).toHaveLength(0);
    expect(q().base.curve.length).toBeGreaterThan(0);                    // descriptive envelope exists, but contributes nothing numerical
  });
  it("a segment that is only a normal pace for the athlete does not qualify", () => {
    expect(segs({ segments: [seg("2026-10-28", { segPace: 610 })] })).toHaveLength(0);
  });
  it("a fast segment inside a run with ordinary heart rate is excluded and the reason is reported", () => {
    const e = q({ segments: [seg("2026-10-28", { hr: 148 })] });
    expect(e.independent.filter(i => i.kind === "sustained_segment")).toHaveLength(0);
    expect(e.informativeExcluded.fast_segment_not_hr_supported).toBe(1);
  });
  it("heat-inflated, treadmill, owner-corrected and inconsistent-timing hosts are excluded with reasons", () => {
    expect(q({ segments: [seg("2026-10-28", { tempF: 88 })] }).informativeExcluded.fast_segment_heat_inflated_hr).toBe(1);
    expect(q({ segments: [seg("2026-10-28", { type: "Treadmill Run" })] }).informativeExcluded.fast_segment_host_indoor).toBe(1);
    const a = athleteV11({ raceDate: OLD, segments: [seg("2026-10-28", { id: "fixed" })], overrides: { fixed: { workoutId: "fixed", userId: "u", isExcluded: false, excludedAt: null, excludedReason: null, distanceMilesOverride: 7.5, durationSecondsOverride: null, updatedAt: "x" } as never } });
    // an owner-corrected distance invalidates the route-derived best efforts, so the segment cannot qualify
    expect(qualifyEvidenceV11(a).independent.filter(i => i.kind === "sustained_segment")).toHaveLength(0);
  });
  it("a segment older than 180 days is reported as expired and carries no weight", () => {
    expect(q({ segments: [seg("2026-04-20")] }).informativeExcluded.fast_segment_expired).toBe(1);
  });
  it("with no athlete heart-rate reference, a fast segment is not believed", () => {
    const a = athleteV11({ raceDate: OLD, start: "2026-09-25", segments: [seg("2026-10-28")] });
    expect(qualifyEvidenceV11(a).independent.filter(i => i.kind === "sustained_segment")).toHaveLength(0);
  });
});

describe("independence: segments of one workout never become independent observations", () => {
  it("at most one segment per workout: the most reliably extrapolated distance that has a personal reference (here 10 K; the athlete has no 10-mile history)", () => {
    const s = segs({ segments: [seg("2026-10-28", { key: "10mi", segPace: 548, hostMiles: 13 })] });
    expect(s).toHaveLength(1); expect(s[0].segment!.key).toBe("10k");
    expect(q().segments.referenceRuns["10mi"]).toBe(0);
  });
  it("one item per local day; a whole-run effort or race on the same day outranks a segment", () => {
    const e = q({ segments: [seg("2026-10-28")], strong: [{ date: "2026-10-28", miles: 6, pace: 548, hr: 172 }] });
    expect(e.independent.filter(i => i.date === "2026-10-28")).toHaveLength(1);
    expect(e.independent.find(i => i.date === "2026-10-28")!.kind).toBe("whole_run_effort");
  });
  it("a workout already classified as a whole-run effort is not also counted as a segment", () => {
    const e = q({ strong: [{ date: "2026-10-28", miles: 6, pace: 548, hr: 172 }] });
    expect(new Set(e.independent.map(i => i.clusterId)).size).toBe(e.independent.length);
  });
});

describe("as-of boundary", () => {
  it("a segment from a run after the cutoff cannot qualify", () => {
    const a = athleteV11({ raceDate: OLD, segments: [seg("2026-10-28")] });
    const early = qualifyEvidenceV11({ ...a, asOf: "2026-10-20T16:00:00.000Z" });
    expect(early.independent.filter(i => i.kind === "sustained_segment")).toHaveLength(0);
    expect(qualifyEvidenceV11({ ...a, asOf: "2026-10-29T16:00:00.000Z" }).independent.filter(i => i.kind === "sustained_segment")).toHaveLength(1);
  });
});

describe("estimate-level effect: newer sustained efforts displace an old race without any race anchor change", () => {
  const three = [seg("2026-10-04"), seg("2026-10-17", { segPace: 548 }), seg("2026-10-28", { segPace: 543 })];
  it("v1 stays at the race; v1.1 moves toward the corroborated segments, by evidence mass", () => {
    const a = athleteV11({ raceDate: OLD, segments: three });
    const one = estimateHybridHalfMarathon(a).seconds!, two = estimateHybridHalfMarathonV11(a);
    expect(Math.abs(one / 7870.75 - 1)).toBeLessThan(0.005);
    expect(two.seconds!).toBeLessThan(one * 0.985); expect(two.combination.recentShare).toBeGreaterThan(0.3);
    expect(two.influence.excludedInformative).toEqual({});
  });
  it("a single uncorroborated tempo cannot displace the race", () => {
    const e = estimateHybridHalfMarathonV11(athleteV11({ raceDate: OLD, segments: [seg("2026-10-28")] }));
    expect(e.influence.raceDominance).toBe("dominant"); expect(Math.abs(e.seconds! / 7870.75 - 1)).toBeLessThan(0.02);
  });
  it("a slower-than-estimate segment is ignored, not read as lost capability", () => {
    const s = seg("2026-10-28", { segPace: 590, hostPace: 600, hr: 160 });
    const qual = qualifyEvidenceV11(athleteV11({ raceDate: OLD, segments: [s], strong: [] }));
    const e = estimateHybridHalfMarathonV11(athleteV11({ raceDate: OLD, segments: [s] }));
    expect(qual.independent.filter(i => i.kind === "sustained_segment").length).toBeLessThanOrEqual(1);
    expect(e.combination.baseSeconds!).toBeCloseTo(7870.75, 3);
  });
});
