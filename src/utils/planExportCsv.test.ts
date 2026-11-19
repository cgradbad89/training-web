import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import { generateRunningPlanCsv } from "@/utils/planExportCsv";

function entry(overrides: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id: "e",
    weekIndex: 0,
    weekday: 1,
    dayOfWeek: 0,
    distanceMiles: 5,
    runType: "outdoor",
    ...overrides,
  };
}

function plan(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "p",
    name: "Test",
    startDate: "2026-09-28",
    weeks: [{ weekNumber: 1, entries }],
    status: "active",
    isActive: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** The "Target HR (bpm)" column (index 6) of each data row. */
function hrColumn(csv: string): string[] {
  return csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[6]);
}

describe("generateRunningPlanCsv — Target HR column", () => {
  it("keeps the header text", () => {
    const csv = generateRunningPlanCsv(plan([entry({})]));
    expect(csv.split("\n")[0].split(",")[6]).toBe("Target HR (bpm)");
  });

  it("formats a cap as ≤ N and a range as min–max", () => {
    const csv = generateRunningPlanCsv(
      plan([
        entry({ id: "a", weekday: 1, targetHr: { minBpm: null, maxBpm: 135 } }),
        entry({ id: "b", weekday: 2, targetHr: { minBpm: 146, maxBpm: 155 } }),
      ])
    );
    expect(hrColumn(csv)).toEqual(["≤ 135", "146–155"]);
  });

  it("falls back to the legacy cap and is empty when there is no target", () => {
    const csv = generateRunningPlanCsv(
      plan([
        entry({ id: "a", weekday: 1, targetHeartRate: 135 }),
        entry({ id: "b", weekday: 2 }),
        entry({ id: "c", weekday: 3, targetHeartRate: null }),
      ])
    );
    expect(hrColumn(csv)).toEqual(["≤ 135", "", ""]);
  });
});
