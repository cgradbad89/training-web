import { describe, expect, it } from "vitest";
import type { DeviceVo2Measurement, PerformanceQualityPolicy } from "@/types/performanceAnalysis";
import { summarizeDeviceVo2 } from "@/utils/deviceVo2Trend";

function measurement(date: string, value: number, overrides: Partial<DeviceVo2Measurement> = {}): DeviceVo2Measurement {
  return {
    measurementId: `synthetic-${date}-${value}`, date, value, unit: "ml/kg/min",
    sourceKind: "device_estimate", sourceName: "Synthetic Watch", availableAt: null,
    provenance: { source: "synthetic health export", sourceId: date, notes: [] }, ...overrides,
  };
}

function summarize(deviceVo2: readonly DeviceVo2Measurement[], options: Partial<Parameters<typeof summarizeDeviceVo2>[0]> = {}) {
  return summarizeDeviceVo2({
    deviceVo2, asOf: "2026-10-21T14:00:00Z", timeZone: "America/New_York", observationDays: 180, comparisonDays: 28,
    qualityPolicy: { minimumIndependentWorkouts: 3 } as PerformanceQualityPolicy, ...options,
  });
}

const comparableHistory = () => [
  measurement("2026-09-01", 45), measurement("2026-09-10", 46), measurement("2026-09-23", 47),
  measurement("2026-09-24", 46), measurement("2026-10-01", 47), measurement("2026-10-21", 48),
];

describe("summarizeDeviceVo2", () => {
  it("compares independent dates within one known source and unit", () => {
    const result = summarize(comparableHistory());
    expect(result.status).toBe("descriptive");
    expect(result.measurementDateCount).toBe(6);
    expect(result.groups).toEqual([{
      unit: "ml/kg/min", sourceKind: "device_estimate", sourceName: "Synthetic Watch",
      currentDates: 3, referenceDates: 3, currentMedian: 47, referenceMedian: 46, change: 1, status: "descriptive",
    }]);
    expect(result.latest?.date).toBe("2026-10-21");
    expect(result.latest?.provenance.source).toBe("synthetic health export");
    expect(result.limitations.join(" ")).toMatch(/not.*race VDOT/);
    expect(result.limitations.join(" ")).toMatch(/not independent validation/);
    expect(result).not.toHaveProperty("estimatedSeconds");
  });

  it("retains dated values with insufficient counts without fabricating a trend", () => {
    const result = summarize([measurement("2026-10-20", 45), measurement("2026-09-01", 47)]);
    expect(result.status).toBe("insufficient");
    expect(result.groups[0]).toMatchObject({ currentDates: 1, referenceDates: 1, currentMedian: 45, referenceMedian: 47, change: null });
    expect(result.measurements).toHaveLength(2);
  });

  it("counts duplicate same-day measurements once per compatible source", () => {
    const current = measurement("2026-10-20", 45);
    const result = summarize([current, { ...current }, { ...current, measurementId: "duplicate-copy" }]);
    expect(result.measurementDateCount).toBe(1);
    expect(result.groups[0].currentDates).toBe(1);
    expect(result.groups[0].change).toBeNull();
    expect(result.measurements).toHaveLength(1);
  });

  it("keeps source and unit groups separate instead of creating an artificial pooled trend", () => {
    const result = summarize(comparableHistory().map((entry, index) => ({
      ...entry, sourceName: index < 3 ? "Old Watch" : "New Watch",
    })));
    expect(result.status).toBe("insufficient");
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) => group.change === null)).toBe(true);
    const sameDateOtherSource = summarize([
      measurement("2026-10-20", 45), measurement("2026-10-20", 46, { sourceName: "Other Watch" }),
      measurement("2026-10-20", 47, { unit: "unknown" }),
    ]);
    expect(sameDateOtherSource.measurementDateCount).toBe(1);
    expect(sameDateOtherSource.groups).toHaveLength(3);
  });

  it.each([
    { unit: "unknown" as const },
    { sourceKind: "unknown" as const },
    { sourceName: null },
    { sourceName: " " },
  ])("retains unknown provenance as descriptive values without certifying comparability: %j", (overrides) => {
    const result = summarize(comparableHistory().map((entry) => ({ ...entry, ...overrides })));
    expect(result.measurementDateCount).toBe(6);
    expect(result.groups[0].currentMedian).toBe(47);
    expect(result.groups[0].change).toBeNull();
    expect(result.status).toBe("insufficient");
    expect(result.limitations.join(" ")).toMatch(/Unknown units or source identity/);
  });

  it("resolves same-date corrections only by known availability before the cutoff", () => {
    const result = summarize([
      measurement("2026-10-20", 45, { availableAt: "2026-10-20T12:00:00Z" }),
      measurement("2026-10-20", 46, { availableAt: "2026-10-21T13:00:00Z" }),
      measurement("2026-10-20", 50, { availableAt: "2026-10-21T15:00:00Z" }),
    ]);
    expect(result.measurements).toHaveLength(1);
    expect(result.latest?.value).toBe(46);
    expect(result.latest?.availableAt).toBe("2026-10-21T13:00:00Z");
    expect(result.limitations.join(" ")).toMatch(/known availability order/);
  });

  it("keeps unordered and equally dated conflicting corrections unresolved", () => {
    const result = summarize([
      measurement("2026-10-20", 45), measurement("2026-10-20", 46, { availableAt: "2026-10-20T12:00:00Z" }),
      measurement("2026-10-19", 45, { availableAt: "2026-10-20T12:00:00Z" }),
      measurement("2026-10-19", 46, { availableAt: "2026-10-20T12:00:00Z" }),
    ]);
    expect(result.measurements).toEqual([]);
    expect(result.status).toBe("insufficient");
    expect(result.limitations.join(" ")).toMatch(/unresolved correction order/);
  });

  it("makes a same-date corrected value visible in returned evidence", () => {
    const previous = summarize([measurement("2026-10-20", 45)]);
    const corrected = summarize([measurement("2026-10-20", 46)]);
    expect(corrected.measurementDateCount).toBe(previous.measurementDateCount);
    expect(corrected.measurements).not.toEqual(previous.measurements);
    expect(corrected.latest?.value).toBe(46);
  });

  it("excludes future dates, known later availability, invalid timestamps and invalid values", () => {
    const result = summarize([
      measurement("2026-10-22", 45), measurement("2026-10-20", 46, { availableAt: "2026-10-21T14:00:00.001Z" }),
      measurement("2026-10-19", 47, { availableAt: "invalid" }), measurement("2026-02-30", 45),
      measurement("2026-10-18", NaN), measurement("2026-10-17", Infinity),
      measurement("2026-10-16", 0), measurement("2026-10-15", -1),
      measurement("2026-10-21", 48, { availableAt: "2026-10-21T14:00:00Z" }),
    ]);
    expect(result.measurements.map((entry) => entry.value)).toEqual([48]);
  });

  it("retains unknown availability with an explicit historical limitation", () => {
    const result = summarize([measurement("2026-10-20", 45)]);
    expect(result.measurements[0].availableAt).toBeNull();
    expect(result.limitations.join(" ")).toMatch(/historical calculation cannot be verified/);
  });

  it("uses the explicit local date at an as-of midnight boundary", () => {
    const measurements = [measurement("2026-10-20", 45), measurement("2026-10-21", 46)];
    const newYork = summarize(measurements, { asOf: "2026-10-21T02:00:00Z" });
    expect(newYork.latest?.date).toBe("2026-10-20");
    expect(newYork.currentWindow.endDate).toBe("2026-10-20");
    const tokyo = summarize(measurements, { asOf: "2026-10-21T02:00:00Z", timeZone: "Asia/Tokyo" });
    expect(tokyo.latest?.date).toBe("2026-10-21");
  });

  it.each([
    ["2026-03-09T14:00:00Z", "2026-02-10", "2026-02-09"],
    ["2026-11-02T14:00:00Z", "2026-10-06", "2026-10-05"],
  ])("keeps adjacent local-day comparison windows through DST at %s", (asOf, currentStart, referenceEnd) => {
    const result = summarize([], { asOf });
    expect(result.currentWindow.startDate).toBe(currentStart);
    expect(result.referenceWindow.endDate).toBe(referenceEnd);
  });

  it("retains bounded history outside the comparison periods without putting it into a comparison", () => {
    const result = summarize([measurement("2026-04-24", 40), measurement("2026-04-25", 41)]);
    expect(result.measurementDateCount).toBe(1);
    expect(result.measurements[0].date).toBe("2026-04-25");
    expect(result.groups[0]).toMatchObject({ currentDates: 0, referenceDates: 0, currentMedian: null, referenceMedian: null });
  });

  it("reports missing VO2 independently as insufficient evidence", () => {
    const result = summarize([]);
    expect(result).toMatchObject({ status: "insufficient", measurementDateCount: 0, latest: null, groups: [], measurements: [] });
    expect(result.limitations.join(" ")).toMatch(/No eligible device VO2/);
  });

  it("is deterministic under source order changes and does not mutate supplied evidence", () => {
    const history = comparableHistory();
    history.push({ ...history[0], measurementId: "copy", availableAt: "2026-09-01T15:00:00Z" });
    const before = JSON.stringify(history);
    const result = summarize(Object.freeze(history));
    expect(summarize([...history].reverse())).toEqual(result);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("preserves provenance deterministically when identical same-day evidence has differently ordered object keys", () => {
    const first = measurement("2026-10-20", 45, {
      provenance: { source: "Health export", sourceId: "daily-record", notes: ["Device label retained."] },
    });
    const duplicate = {
      ...first,
      provenance: { notes: ["Device label retained."], sourceId: "daily-record", source: "Health export" },
    };
    const forward = summarize([first, duplicate]);
    const reversed = summarize([duplicate, first]);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(forward.measurements[0].provenance).toEqual(first.provenance);
    expect(forward.limitations).toContain("Device label retained.");
  });

  it("orders groups and distinct limitations independently of query order", () => {
    const inputs = [
      measurement("2026-10-20", 45, { sourceName: "é watch", provenance: { source: null, sourceId: "A", notes: ["First note."] } }),
      measurement("2026-10-20", 46, { sourceName: "Z watch", availableAt: "2026-10-20T16:00:00Z" }),
      measurement("2026-10-19", 47, { unit: "unknown" }),
      measurement("2026-10-18", NaN),
      measurement("2026-10-17", 48, { availableAt: "2026-10-21T16:00:00Z" }),
    ];
    const forward = summarize(inputs);
    expect(summarize([...inputs].reverse())).toEqual(forward);
    expect(forward.groups.map((group) => group.sourceName)).toEqual(["Z watch", "é watch", "Synthetic Watch"]);
    expect(forward.limitations).toEqual([...forward.limitations].sort());
  });

  it("rejects invalid bounds and independent-date policy thresholds", () => {
    expect(() => summarize([], { observationDays: 181 })).toThrow(/observationDays/);
    expect(() => summarize([], { qualityPolicy: { minimumIndependentWorkouts: 0 } as PerformanceQualityPolicy })).toThrow(/minimumIndependentWorkouts/);
  });
});
