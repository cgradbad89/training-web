import { describe, it, expect, vi, afterEach } from "vitest";
import { vo2HistoryCutoffISO, VO2_HISTORY_DAYS } from "@/utils/vo2History";
import { normalizePurchaseDate } from "@/services/shoes";
import { computeAllPRs } from "@/utils/prComputation";
import { buildAggregatedStats, AGGREGATED_STATS_VERSION } from "@/utils/aggregatedStats";
import { toLocalIsoDate } from "@/utils/dates";
import type { HealthWorkout } from "@/types/healthWorkout";

vi.mock("@/services/shoes", async (importOriginal) => {
  // shoes.ts imports Firebase; only the pure helper is under test.
  vi.doMock("@/lib/firebase", () => ({ db: {} }));
  return importOriginal<typeof import("@/services/shoes")>();
});

function run(id: string, start: Date, miles = 4, secs = 2400): HealthWorkout {
  return {
    workoutId: id, name: "Run", displayType: "Run", activityType: "HKWorkoutActivityTypeRunning",
    startDate: start, endDate: new Date(start.getTime() + secs * 1000), durationSeconds: secs,
    distanceMiles: miles, isRunLike: true, sourceName: "Watch", calories: 400,
  } as unknown as HealthWorkout;
}
afterEach(() => vi.restoreAllMocks());

describe("F7 — vo2HistoryCutoffISO is a LOCAL date", () => {
  it("at 2026-12-31 19:30 local the 7-day cutoff is 2026-12-24 (UTC date would be 12-25)", () => {
    expect(vo2HistoryCutoffISO(new Date(2026, 11, 31, 19, 30), 7)).toBe("2026-12-24");
  });
  it("at 23:59 local on Dec 31 and 00:30 on Jan 1 the cutoff advances exactly one day", () => {
    const a = vo2HistoryCutoffISO(new Date(2026, 11, 31, 23, 59), 7);
    const b = vo2HistoryCutoffISO(new Date(2027, 0, 1, 0, 30), 7);
    expect([a, b]).toEqual(["2026-12-24", "2026-12-25"]);
  });
  it("the default 180-day window crosses the year boundary correctly", () => {
    expect(vo2HistoryCutoffISO(new Date(2027, 0, 1, 20, 0), VO2_HISTORY_DAYS)).toBe("2026-07-05");
  });
});

describe("F8 — other UTC-derived keys", () => {
  it("shoe purchaseDate strings are kept verbatim (no one-day shift)", () => {
    expect(normalizePurchaseDate("2026-12-31")).toBe("2026-12-31");
    expect(normalizePurchaseDate("2027-01-01")).toBe("2027-01-01");
  });
  it("shoe purchaseDate Timestamp-like values use the LOCAL date", () => {
    const ts = { toDate: () => new Date(2026, 11, 31, 20, 0) }; // UTC date would be 2027-01-01 in US Eastern
    expect(normalizePurchaseDate(ts)).toBe("2026-12-31");
  });

  it("computeAllPRs logs the local date of the winning run (Dec 31 20:00 local)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    computeAllPRs([run("late", new Date(2026, 11, 31, 20, 0), 4, 2000)]);
    const dates = log.mock.calls
      .map((c) => (c[1] as { date?: string } | undefined)?.date)
      .filter(Boolean);
    expect(dates.length).toBeGreaterThan(0);
    expect(new Set(dates)).toEqual(new Set(["2026-12-31"]));
  });

  it("training-load display window starts on the LOCAL date 111 days before now", () => {
    const now = new Date(2026, 11, 31, 19, 30);
    const fingerprint = {
      latestWorkoutId: "a", computationVersion: AGGREGATED_STATS_VERSION, maxHr: 175, restingHr: 65,
      activeRaceId: null, activeRaceDate: null, overridesRevision: "0:0",
      localCalendarDate: "2026-12-31", localCalendarYear: 2026,
    };
    const doc = buildAggregatedStats({
      workouts: [run("a", new Date(2026, 5, 1, 8)), run("b", new Date(2026, 11, 30, 8))], mileSplitsByWorkoutId: {}, healthMetrics: [],
      maxHr: 175, restingHr: 65, now, races: [], freshnessFingerprint: fingerprint,
      vo2FreshnessKey: { latestVo2SampleDate: null },
    });
    const expectedStart = toLocalIsoDate(new Date(2026, 11, 31 - 111));
    expect(doc.trainingLoad.series[0].date).toBe(expectedStart);
    expect(doc.trainingLoad.series.at(-1)?.date).toBe("2026-12-31");
  });
});
