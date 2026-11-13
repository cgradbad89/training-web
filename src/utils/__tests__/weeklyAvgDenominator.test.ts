import { describe, it, expect } from "vitest";
import { weeklyAvgDenominator, weeklyAvgWindow } from "@/utils/weeklyAvgDenominator";
import { weekStart } from "@/utils/dates";

/** VERBATIM pre-change Runs-page logic (runs/page.tsx avgWeeklyLoad denominator). */
function legacyRunsWeeksSpanned(selectedYear: number, selectedMonth: number | null, now: Date): number | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let windowStart: Date;
  let windowEnd: Date;
  if (selectedMonth !== null) {
    windowStart = new Date(selectedYear, selectedMonth, 1);
    windowEnd = new Date(selectedYear, selectedMonth + 1, 0);
  } else {
    windowStart = new Date(selectedYear, 0, 1);
    windowEnd = new Date(selectedYear, 11, 31);
  }
  if (windowEnd > today) windowEnd = today;
  if (windowStart > today) return null;
  const startMonday = weekStart(windowStart);
  const endMonday = weekStart(windowEnd);
  return (
    Math.max(0, Math.round((endMonday.getTime() - startMonday.getTime()) / (7 * 86400 * 1000))) + 1
  );
}

describe("weeklyAvgDenominator — year view (both pages)", () => {
  it("2027: Jan 1 → 1, Jan 4 → 2, Jan 11 → 3", () => {
    expect(weeklyAvgDenominator(2027, null, new Date(2027, 0, 1, 0, 30))).toBe(1);
    expect(weeklyAvgDenominator(2027, null, new Date(2027, 0, 3, 20))).toBe(1);
    expect(weeklyAvgDenominator(2027, null, new Date(2027, 0, 4, 9))).toBe(2);
    expect(weeklyAvgDenominator(2027, null, new Date(2027, 0, 11, 9))).toBe(3);
  });

  it("full 2026 viewed in 2027 is the true Monday-anchored count (53) — not 52", () => {
    const now = new Date(2027, 0, 11);
    expect(weeklyAvgDenominator(2026, null, now)).toBe(53);
    expect(weeklyAvgDenominator(2026, null, new Date(2027, 5, 1))).toBe(53);
  });

  it("the final day of 2026 is still 53 (W53 touched once)", () => {
    expect(weeklyAvgDenominator(2026, null, new Date(2026, 11, 31, 23, 59))).toBe(53);
  });

  it("a future year has not started → 0 (callers show '—')", () => {
    expect(weeklyAvgDenominator(2028, null, new Date(2027, 0, 11))).toBe(0);
    expect(weeklyAvgWindow(2028, null, new Date(2027, 0, 11))).toBeNull();
  });
});

describe("weeklyAvgDenominator — month view (Runs page)", () => {
  it("January 2027 viewed on Jan 11 → weeks Dec 28, Jan 4, Jan 11", () => {
    expect(weeklyAvgDenominator(2027, 0, new Date(2027, 0, 11))).toBe(3);
  });
  it("a completed month spans its touched weeks (Jan 2026: Dec 29 … Jan 26 → 5)", () => {
    expect(weeklyAvgDenominator(2026, 0, new Date(2026, 5, 1))).toBe(5);
  });
  it("a future month → 0", () => {
    expect(weeklyAvgDenominator(2027, 5, new Date(2027, 0, 11))).toBe(0);
  });
});

describe("identical to the pre-change Runs-page logic for current-year dates", () => {
  it("sweeps every day of 2026 and 2027 (year view) and every month view", () => {
    let checked = 0;
    for (const year of [2026, 2027]) {
      for (let day = 0; day < 365; day += 1) {
        const now = new Date(year, 0, 1 + day, 13, 15);
        expect(weeklyAvgDenominator(year, null, now)).toBe(legacyRunsWeeksSpanned(year, null, now) ?? 0);
        for (let m = 0; m < 12; m += 1) {
          expect(weeklyAvgDenominator(year, m, now)).toBe(legacyRunsWeeksSpanned(year, m, now) ?? 0);
        }
        checked += 1;
      }
    }
    expect(checked).toBe(730);
  });

  it("a June 2026 current-year date equals the legacy value", () => {
    const now = new Date(2026, 5, 17, 10);
    expect(weeklyAvgDenominator(2026, null, now)).toBe(legacyRunsWeeksSpanned(2026, null, now));
  });

  it("matches across both DST transitions", () => {
    for (const now of [new Date(2026, 2, 8, 12), new Date(2026, 2, 9, 12), new Date(2026, 10, 1, 12), new Date(2026, 10, 2, 12), new Date(2027, 2, 14, 12), new Date(2027, 2, 15, 12)]) {
      expect(weeklyAvgDenominator(now.getFullYear(), null, now)).toBe(legacyRunsWeeksSpanned(now.getFullYear(), null, now));
    }
  });
});

describe("Workouts-page parity (year view, no month filter)", () => {
  it("equals the Runs year-view value on every date, replacing ceil(dayOfYear/7)", () => {
    for (const now of [new Date(2027, 0, 1), new Date(2027, 0, 4), new Date(2027, 0, 11), new Date(2026, 5, 17), new Date(2026, 11, 31)]) {
      const year = now.getFullYear();
      expect(weeklyAvgDenominator(year, null, now)).toBe(legacyRunsWeeksSpanned(year, null, now));
    }
  });
});
