import { describe, expect, it } from "vitest";
import {
  getUncoveredGaps,
  mergeCoveredRange,
  type HealthMetricsCache,
} from "../healthMetricsCache";
import { healthMetricsCutoffISO } from "@/services/healthMetrics";

function cache(
  coveredRanges: HealthMetricsCache["coveredRanges"] = []
): HealthMetricsCache {
  return { entries: new Map(), coveredRanges };
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
