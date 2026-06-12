import { describe, it, expect } from "vitest";
import {
  selectRouteTrendRuns,
  paceTrendDirection,
  TREND_RECENT_COUNT,
} from "@/utils/routeTrendRuns";
import { type MatchedRunSummary } from "@/utils/routePerformance";

const NOW = new Date(2026, 5, 12); // 2026-06-12 local

function run(date: string, paceSeconds = 540): MatchedRunSummary {
  return { runId: `run-${date}-${paceSeconds}`, date, paceSeconds, distanceMiles: 9, load: null };
}

/** n runs spaced `stepDays` apart, ending at `end` (newest last). */
function series(n: number, end: Date, stepDays: number): MatchedRunSummary[] {
  const out: MatchedRunSummary[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - i * stepDays);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
    out.push(run(iso));
  }
  return out;
}

describe("selectRouteTrendRuns", () => {
  it("returns all runs (sorted ascending) when total ≤ 30", () => {
    const input = [run("2026-03-01"), run("2025-01-01"), run("2026-06-01")];
    const result = selectRouteTrendRuns(input, NOW);
    expect(result.map((r) => r.date)).toEqual([
      "2025-01-01",
      "2026-03-01",
      "2026-06-01",
    ]);
  });

  it("uses the 6-month window when total > 30 and last-6-months ≤ 20", () => {
    // 25 old runs (well before 6 months ago) + 10 recent (weekly) = 35 total.
    const old = series(25, new Date(2024, 0, 1), 7);
    const recent = series(10, NOW, 7);
    const result = selectRouteTrendRuns([...old, ...recent], NOW);
    expect(result).toHaveLength(10);
    const recentDatesAsc = recent.map((r) => r.date).sort();
    expect(result.map((r) => r.date)).toEqual(recentDatesAsc);
  });

  it("uses the last 10 runs when total > 30 and last-6-months > 20", () => {
    // 35 weekly runs ending now → ~26 fall inside 6 months.
    const input = series(35, NOW, 7);
    const result = selectRouteTrendRuns(input, NOW);
    expect(result).toHaveLength(TREND_RECENT_COUNT);
    // Last 10 chronologically = the 10 newest.
    const newestTenAsc = input
      .map((r) => r.date)
      .sort()
      .slice(-10);
    expect(result.map((r) => r.date)).toEqual(newestTenAsc);
  });

  it("returns at least 1 run (the most recent) when total > 30 but none in 6 months", () => {
    const input = series(31, new Date(2024, 0, 1), 7); // all ancient
    const result = selectRouteTrendRuns(input, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe(input.map((r) => r.date).sort().slice(-1)[0]);
  });

  it("returns empty for empty input", () => {
    expect(selectRouteTrendRuns([], NOW)).toEqual([]);
  });

  it("always sorts ascending by date", () => {
    const input = [run("2026-06-01"), run("2026-01-01"), run("2026-03-01")];
    const dates = selectRouteTrendRuns(input, NOW).map((r) => r.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("paceTrendDirection", () => {
  it("'improving' when the most recent pace is faster than the earliest", () => {
    expect(
      paceTrendDirection([run("2026-01-01", 600), run("2026-06-01", 540)])
    ).toBe("improving");
  });

  it("'steady' when the most recent pace is not faster (slower or equal)", () => {
    expect(
      paceTrendDirection([run("2026-01-01", 540), run("2026-06-01", 600)])
    ).toBe("steady");
    expect(
      paceTrendDirection([run("2026-01-01", 540), run("2026-06-01", 540)])
    ).toBe("steady");
  });

  it("null for a single run or empty input", () => {
    expect(paceTrendDirection([run("2026-01-01", 540)])).toBeNull();
    expect(paceTrendDirection([])).toBeNull();
  });

  it("sorts by date internally (input order doesn't matter)", () => {
    expect(
      paceTrendDirection([run("2026-06-01", 540), run("2026-01-01", 600)])
    ).toBe("improving");
  });
});
