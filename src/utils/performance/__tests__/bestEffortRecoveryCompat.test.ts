import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RunningPlan } from "@/types/plan";
import { assessBestEffortsCache, withBestEffortsFreshness, EMPTY_BEST_EFFORTS } from "@/utils/bestEfforts";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";
import { athleteV11, type AthleteV11Options } from "../../__tests__/fixtures/hybridV11Fixture";
import { estimateHybridHalfMarathonV11 } from "../hybridPerformanceV11";
import { estimateRaceDayForecast } from "../raceDayForecast";
import { qualifyEvidenceV11, SEGMENT_POLICY } from "../evidenceSegments";

const OLD = "2026-07-30";
const PLAN: RunningPlan = { id: "p", name: "HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "x", updatedAt: "x",
  weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [{ id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 }, { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: 8 }] })) };
const seg = (date: string, segPace: number, hr = 166, id = `seg-${date}`) => ({ id, date, hostMiles: 8, hostPace: 585, hr, key: "10k" as const, segPace, type: "Tempo Run" });
/** The observed failure: a v2 'complete' record computed from 400 points of a long run → every distance null. */
const truncated = (): HealthWorkout["bestEfforts"] => withBestEffortsFreshness({ ...EMPTY_BEST_EFFORTS }, true, 400) as HealthWorkout["bestEfforts"];
function withTruncated(o: AthleteV11Options, id: string) {
  const a = athleteV11(o);
  const original = a.workouts.find(w => w.workoutId === id)!;
  return { repaired: a, broken: { ...a, workouts: a.workouts.map(w => (w.workoutId === id ? { ...w, bestEfforts: truncated() } : w)) }, original };
}
const est = (a: ReturnType<typeof athleteV11>) => estimateHybridHalfMarathonV11(a);

describe("a repaired best-effort record reaches the unchanged Hybrid v1.1 evidence pipeline", () => {
  const three = [seg("2026-10-04", 545), seg("2026-10-17", 548), seg("2026-10-28", 543)];
  const { repaired, broken, original } = withTruncated({ raceDate: OLD, segments: three }, "seg-2026-10-28");

  it("the broken record is recognised as recoverable from the workout's own facts", () => {
    const a = assessBestEffortsCache(broken.workouts.find(w => w.workoutId === "seg-2026-10-28")!.bestEfforts, true,
      { distanceMiles: original.distanceMiles, durationSeconds: original.durationSeconds });
    expect(a).toMatchObject({ state: "suspicious_recoverable", recompute: true });
  });
  it("outcome 1–2 (data repaired, evidence evaluated): the segment is invisible while broken and evaluated once repaired", () => {
    expect(qualifyEvidenceV11(broken).segments.qualified).toBe(2);
    expect(qualifyEvidenceV11(repaired).segments.qualified).toBe(3);
    expect(qualifyEvidenceV11(repaired).independent.filter(i => i.kind === "sustained_segment").map(i => i.date)).toContain("2026-10-28");
  });
  it("outcome 3–4 (qualifies, estimate moves): a qualifying repaired segment changes the estimate through the existing weighting only", () => {
    const a = est(broken), b = est(repaired);
    expect(b.seconds).not.toBe(a.seconds); expect(b.seconds!).toBeLessThan(a.seconds!);
    expect(b.combination.recent!.count).toBe(a.combination.recent!.count + 1);
  });
  it("the forecast v2 follows only through its hybrid dependency", () => {
    const fa = estimateRaceDayForecast(broken, { raceDate: "2027-03-20", plan: PLAN, hybrid: est(broken) });
    const fb = estimateRaceDayForecast(repaired, { raceDate: "2027-03-20", plan: PLAN, hybrid: est(repaired) });
    expect(fa.currentCapabilityModel).toBe("experimental-hybrid-hm-v1.1"); expect(fb.currentCapabilitySeconds).toBe(est(repaired).seconds);
    expect(fb.seconds).not.toBe(fa.seconds);
  });
});

describe("a repaired record may still fail qualification — and nothing is forced", () => {
  it("an easy run's recovered best efforts are evaluated, rejected (HR / pace thresholds unchanged) and leave the estimate untouched", () => {
    const easy = seg("2026-10-28", 600, 140);                                           // slow segment at easy HR
    const { repaired, broken } = withTruncated({ raceDate: OLD, segments: [easy] }, "seg-2026-10-28");
    expect(qualifyEvidenceV11(repaired).segments.qualified).toBe(0);
    // the run itself still counts for preparation either way; the best-effort repair changes nothing numerical
    expect(est(repaired).seconds).toBe(est(broken).seconds);
  });
  it("a fast segment inside a run with ordinary HR is evaluated and rejected with a reason, not promoted", () => {
    const { repaired } = withTruncated({ raceDate: OLD, segments: [seg("2026-10-28", 545, 148)] }, "seg-2026-10-28");
    const q = qualifyEvidenceV11(repaired);
    expect(q.segments.qualified).toBe(0); expect(q.informativeExcluded.fast_segment_not_hr_supported).toBe(1);
  });
  it("a repaired segment SLOWER than the estimate qualifies as evidence but is ignored by the weighting (a slow segment is not lost capacity)", () => {
    // a confirmed-fast recent race (run well inside what the segment implies) plus a qualifying segment slower than it
    const a = athleteV11({ raceDate: "2026-10-20", raceSeconds: 7100, segments: [seg("2026-10-28", 545)] });
    const e = est(a);
    expect(e.qualification.segments.qualified).toBe(1);                                    // evaluated and qualified as evidence…
    expect(e.combination.ignored.map(i => i.reason)).toContain("segment_slower_than_estimate");   // …but a slow segment is not lost capacity
    expect(e.combination.items.some(i => i.kind === "sustained_segment")).toBe(false);
    expect(e.combination.baseSeconds!).toBeCloseTo(e.combination.raceOnlySeconds!, 6);
  });
});

describe("the hybrid's scientific safeguards are untouched", () => {
  it("segment thresholds are exactly the documented engineering assumptions", () => {
    expect(SEGMENT_POLICY).toMatchObject({ maximumHostShare: 0.92, referenceMinimumRuns: 20, speedPercentile: 0.1, speedMargin: 0.05, hrSupportBpm: 5, minimumSegmentSeconds: 480 });
    expect(BEST_EFFORTS_COMPUTATION_VERSION).toBe(2);
  });
  it("one workout can never contribute more than one segment, however many keys its recovered record carries", () => {
    const a = athleteV11({ raceDate: OLD, segments: [seg("2026-10-28", 545)] });
    const items = qualifyEvidenceV11(a).independent.filter(i => i.clusterId === "seg-2026-10-28");
    expect(items).toHaveLength(1);
  });
});
