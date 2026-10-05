import { describe, expect, it } from "vitest";
import {
  getUncoveredGaps,
  mergeCoveredRange,
  emptyHealthMetricsCache,
  getMissingOrStaleRanges,
  healthDateStatus,
  healthRetentionRange,
  healthRollingRange,
  metricsInCacheRange,
  recordRangeFailure,
  retainHealthRange,
  type HealthMetricsCache,
} from "../healthMetricsCache";
import { healthMetricsCutoffISO } from "@/services/healthMetrics";

function cache(
  coveredRanges: HealthMetricsCache["coveredRanges"] = []
): HealthMetricsCache {
  return { entries: new Map(), coveredRanges, coverage: new Map() };
}

describe("getUncoveredGaps", () => {
  it("returns no gaps when the requested range is fully covered", () => {
    expect(
      getUncoveredGaps(cache([{ start: "2026-05-01", end: "2026-05-31" }]), {
        start: "2026-05-10",
        end: "2026-05-20",
      })
    ).toEqual([]);
  });

  it("returns only the uncovered tail of a partially covered range", () => {
    expect(
      getUncoveredGaps(cache([{ start: "2026-05-10", end: "2026-05-31" }]), {
        start: "2026-05-01",
        end: "2026-05-31",
      })
    ).toEqual([{ start: "2026-05-01", end: "2026-05-09" }]);
  });

  it("returns a gap spanning two existing covered ranges", () => {
    expect(
      getUncoveredGaps(
        cache([
          { start: "2026-05-01", end: "2026-05-05" },
          { start: "2026-05-20", end: "2026-05-31" },
        ]),
        { start: "2026-05-01", end: "2026-05-31" }
      )
    ).toEqual([{ start: "2026-05-06", end: "2026-05-19" }]);
  });

  it("returns the whole request when the cache is empty", () => {
    expect(
      getUncoveredGaps(cache(), {
        start: "2026-05-01",
        end: "2026-05-31",
      })
    ).toEqual([{ start: "2026-05-01", end: "2026-05-31" }]);
  });
});

describe("mergeCoveredRange", () => {
  it("extends an adjacent range and stores entries by date", () => {
    const result = mergeCoveredRange(
      cache([{ start: "2026-05-01", end: "2026-05-10" }]),
      { start: "2026-05-11", end: "2026-05-20" },
      [{ date: "2026-05-11", metrics: { date: "2026-05-11", steps: 10 } }]
    );

    expect(result.coveredRanges).toEqual([
      { start: "2026-05-01", end: "2026-05-20" },
    ]);
    expect(result.entries.get("2026-05-11")?.metrics.steps).toBe(10);
  });

  it("merges overlapping ranges", () => {
    const result = mergeCoveredRange(
      cache([
        { start: "2026-05-01", end: "2026-05-10" },
        { start: "2026-05-20", end: "2026-05-31" },
      ]),
      { start: "2026-05-08", end: "2026-05-22" },
      []
    );

    expect(result.coveredRanges).toEqual([
      { start: "2026-05-01", end: "2026-05-31" },
    ]);
  });

  it("keeps a disjoint range sorted and separate", () => {
    const result = mergeCoveredRange(
      cache([{ start: "2026-07-01", end: "2026-07-31" }]),
      { start: "2026-05-01", end: "2026-05-31" },
      []
    );

    expect(result.coveredRanges).toEqual([
      { start: "2026-05-01", end: "2026-05-31" },
      { start: "2026-07-01", end: "2026-07-31" },
    ]);
  });
});

describe("healthMetricsCutoffISO", () => {
  it("uses local calendar arithmetic across a year boundary", () => {
    expect(healthMetricsCutoffISO(1, new Date(2026, 0, 1, 23, 30))).toBe(
      "2025-12-31"
    );
  });
});

describe("authoritative bounded Health history", () => {
  const range = { start: "2026-10-01", end: "2026-10-03" };
  const entries = (dates: string[]) => dates.map(date => ({ date, metrics: { date, steps: 10 } }));
  const initial = () => mergeCoveredRange(emptyHealthMetricsCache(), { start: "2026-09-30", end: "2026-10-04" }, entries(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]), 100);

  it("removes authoritative omissions and preserves both sides of the range", () => {
    const result = mergeCoveredRange(initial(), range, entries(["2026-10-03", "2026-10-01"]), 200);
    expect([...result.entries.keys()].sort()).toEqual(["2026-09-30", "2026-10-01", "2026-10-03", "2026-10-04"]);
    expect(initial().entries.has("2026-10-02")).toBe(true);
  });
  it("deduplicates dated results, excludes out-of-range results and sorts derivations", () => {
    const result = mergeCoveredRange(initial(), range, [
      ...entries(["2026-10-03", "2026-10-01", "2025-01-01"]),
      { date: "2026-10-01", metrics: { date: "2026-10-01", steps: 20 } },
    ], 200);
    expect(metricsInCacheRange(result, range)).toEqual([{ date: "2026-10-01", steps: 20 }, { date: "2026-10-03", steps: 10 }]);
    expect(result.entries.has("2025-01-01")).toBe(false);
  });
  it("distinguishes never requested, covered, covered empty, stale and failed", () => {
    const result = mergeCoveredRange(emptyHealthMetricsCache(), range, entries(["2026-10-01"]), 100);
    expect(healthDateStatus(result, "2026-09-30", 100)).toBe("never-requested");
    expect(healthDateStatus(result, "2026-10-01", 100)).toBe("covered");
    expect(healthDateStatus(result, "2026-10-02", 100)).toBe("covered-empty");
    expect(healthDateStatus(result, "2026-10-02", 30100)).toBe("stale");
    expect(healthDateStatus(recordRangeFailure(result, range, "offline"), "2026-10-02", 100)).toBe("error");
  });
  it("records entirely empty successful intervals and revalidates at the freshness boundary", () => {
    const result = mergeCoveredRange(initial(), range, [], 200);
    expect(metricsInCacheRange(result, range)).toEqual([]);
    expect(getUncoveredGaps(result, range)).toEqual([]);
    expect(getMissingOrStaleRanges(result, range, 30199)).toEqual([]);
    expect(getMissingOrStaleRanges(result, range, 30200)).toEqual([range]);
  });
  it("queries exact missing/stale gaps without rereading a fresh middle interval", () => {
    const result = mergeCoveredRange(initial(), { start: "2026-10-02", end: "2026-10-02" }, [], 30100);
    expect(getMissingOrStaleRanges(result, range, 30100)).toEqual([
      { start: "2026-10-01", end: "2026-10-01" }, { start: "2026-10-03", end: "2026-10-03" },
    ]);
  });
  it("a failed extension is not covered and failure preserves old values/coverage", () => {
    const before = initial();
    const result = recordRangeFailure(before, { start: "2026-10-03", end: "2026-10-06" }, "offline");
    expect(result.entries).toBe(before.entries);
    expect(result.entries.get("2026-10-03")?.metrics.steps).toBe(10);
    expect(result.coverage.get("2026-10-03")?.lastSuccessAt).toBe(100);
    expect(result.coverage.get("2026-10-05")?.lastSuccessAt).toBeNull();
    expect(getUncoveredGaps(result, { start: "2026-10-05", end: "2026-10-06" })).toEqual([{ start: "2026-10-05", end: "2026-10-06" }]);
  });
  it("YTD derives edits and deletions from the same current dated entries", () => {
    const before = initial();
    const ytd = { start: "2026-01-01", end: "2026-10-05" };
    expect(metricsInCacheRange(before, ytd)).toHaveLength(5);
    const after = mergeCoveredRange(before, range, [{ date: "2026-10-01", metrics: { date: "2026-10-01", steps: 99 } }], 200);
    expect(metricsInCacheRange(after, ytd)).toEqual([
      { date: "2026-09-30", steps: 10 }, { date: "2026-10-01", steps: 99 }, { date: "2026-10-04", steps: 10 },
    ]);
  });
  it("retains only the useful rolling/YTD dates and prunes coverage with rows", () => {
    const result = retainHealthRange(initial(), range);
    expect([...result.entries.keys()]).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect([...result.coverage.keys()]).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(result.coveredRanges).toEqual([range]);
  });
  it("retains previous-year YTD reachable by January's 30-day navigator, then prunes it", () => {
    expect(healthRetentionRange("2027-01-01")).toEqual({ start: "2026-01-01", end: "2027-01-01" });
    expect(healthRetentionRange("2027-01-30").start).toBe("2026-01-01");
    expect(healthRetentionRange("2027-01-31").start).toBe("2026-11-02");
    expect(healthRollingRange("2027-01-01")).toEqual({ start: "2026-10-03", end: "2027-01-01" });
  });
});
