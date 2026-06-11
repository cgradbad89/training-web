import { describe, it, expect } from "vitest";
import {
  DEFAULT_GOALS,
  RING_METRICS,
  dailyRingProgress,
  eachDate,
  onPaceFraction,
  periodRingProgress,
  resolveGoalForDate,
  ringDailyAverage,
  shiftDate,
  weekdayKey,
  type DayOfWeekGoals,
  type HealthGoalDoc,
} from "@/lib/ringMath";

// Fixed dates for determinism. Verified weekdays (June 2026):
//   2026-06-08 = Monday … 2026-06-14 = Sunday.
const MON = "2026-06-08";
const WED = "2026-06-10";
const SUN = "2026-06-14";

function uniformWeek(value: number): DayOfWeekGoals {
  return {
    mon: value,
    tue: value,
    wed: value,
    thu: value,
    fri: value,
    sat: value,
    sun: value,
  };
}

/** Goal doc where every metric is `value` all week (per-metric overrides allowed). */
function goalDoc(
  effectiveFrom: string,
  value: number,
  createdAt = 1,
  overrides: Partial<HealthGoalDoc["metrics"]> = {}
): HealthGoalDoc {
  return {
    effectiveFrom,
    createdAt,
    metrics: {
      steps: uniformWeek(value),
      exercise_mins: uniformWeek(value),
      move_calories: uniformWeek(value),
      stand_hours: uniformWeek(value),
      sleep_total_hours: uniformWeek(value),
      ...overrides,
    },
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

describe("weekdayKey", () => {
  it("maps local dates to mon…sun keys", () => {
    expect(weekdayKey(MON)).toBe("mon");
    expect(weekdayKey(WED)).toBe("wed");
    expect(weekdayKey(SUN)).toBe("sun");
  });
});

describe("eachDate", () => {
  it("is inclusive of both bounds and crosses month boundaries", () => {
    expect(eachDate("2026-05-30", "2026-06-02")).toEqual([
      "2026-05-30",
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
    ]);
  });

  it("returns [] when start > end", () => {
    expect(eachDate("2026-06-10", "2026-06-09")).toEqual([]);
  });

  it("shiftDate handles month/year rollover", () => {
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});

// ── resolveGoalForDate ───────────────────────────────────────────────────────

describe("resolveGoalForDate", () => {
  it("falls back to DEFAULT_GOALS when no docs exist", () => {
    for (const metric of RING_METRICS) {
      expect(resolveGoalForDate([], metric, WED)).toBe(DEFAULT_GOALS[metric]);
    }
  });

  it("uses the single qualifying doc", () => {
    const goals = [goalDoc("2026-06-01", 12000)];
    expect(resolveGoalForDate(goals, "steps", WED)).toBe(12000);
  });

  it("applies on the effectiveFrom date itself (inclusive boundary)", () => {
    const goals = [goalDoc("2026-06-10", 9000)];
    expect(resolveGoalForDate(goals, "steps", "2026-06-10")).toBe(9000);
  });

  it("ignores docs dated after the target date", () => {
    const goals = [goalDoc("2026-06-11", 9999)];
    expect(resolveGoalForDate(goals, "steps", WED)).toBe(DEFAULT_GOALS.steps);
  });

  it("picks the LATEST effectiveFrom <= date among multiple versions", () => {
    const goals = [
      goalDoc("2026-01-01", 8000),
      goalDoc("2026-06-01", 11000),
      goalDoc("2026-07-01", 15000), // future — ignored
    ];
    expect(resolveGoalForDate(goals, "steps", WED)).toBe(11000);
    // A date before the second version still scores against the first.
    expect(resolveGoalForDate(goals, "steps", "2026-05-15")).toBe(8000);
  });

  it("breaks same-day effectiveFrom ties by createdAt (latest wins)", () => {
    const goals = [
      goalDoc("2026-06-01", 10000, 100),
      goalDoc("2026-06-01", 13000, 200),
    ];
    expect(resolveGoalForDate(goals, "steps", WED)).toBe(13000);
  });

  it("selects the weekday-specific value", () => {
    const goals = [
      goalDoc("2026-06-01", 10000, 1, {
        steps: { ...uniformWeek(10000), mon: 6000, sun: 4000 },
      }),
    ];
    expect(resolveGoalForDate(goals, "steps", MON)).toBe(6000);
    expect(resolveGoalForDate(goals, "steps", SUN)).toBe(4000);
    expect(resolveGoalForDate(goals, "steps", WED)).toBe(10000);
  });
});

// ── dailyRingProgress ────────────────────────────────────────────────────────

describe("dailyRingProgress", () => {
  it("computes normal progress", () => {
    expect(dailyRingProgress(5000, 10000)).toBe(0.5);
  });

  it("is uncapped past 100% (overfill)", () => {
    expect(dailyRingProgress(14200, 10000)).toBeCloseTo(1.42);
  });

  it("returns 0 for null/undefined/zero values", () => {
    expect(dailyRingProgress(null, 10000)).toBe(0);
    expect(dailyRingProgress(undefined, 10000)).toBe(0);
    expect(dailyRingProgress(0, 10000)).toBe(0);
  });

  it("guards against a non-positive goal", () => {
    expect(dailyRingProgress(5000, 0)).toBe(0);
    expect(dailyRingProgress(5000, -10)).toBe(0);
  });
});

// ── periodRingProgress ───────────────────────────────────────────────────────

describe("periodRingProgress", () => {
  // Mon 2026-06-08 .. Sun 2026-06-14, goal 1000/day → denominator 7000.
  const goals = [goalDoc("2026-01-01", 1000)];

  it("computes sum-vs-sum over a full week", () => {
    const days = eachDate(MON, SUN).map((date) => ({ date, value: 500 }));
    expect(periodRingProgress(days, goals, "steps", MON, SUN)).toBeCloseTo(
      3500 / 7000
    );
  });

  it("keeps missing days in the denominator (0 in the numerator)", () => {
    // Only 6 of 7 days have a doc, each exactly on goal → 6000/7000, not 1.0.
    const days = eachDate(MON, "2026-06-13").map((date) => ({
      date,
      value: 1000,
    }));
    expect(periodRingProgress(days, goals, "steps", MON, SUN)).toBeCloseTo(
      6000 / 7000
    );
  });

  it("treats null values like missing days", () => {
    const days = [
      { date: MON, value: 1000 },
      { date: "2026-06-09", value: null },
    ];
    expect(
      periodRingProgress(days, goals, "steps", MON, "2026-06-09")
    ).toBeCloseTo(1000 / 2000);
  });

  it("scores a partial to-date period over only the elapsed days", () => {
    // Week-to-date Mon..Wed: 3 days in the denominator.
    const days = [
      { date: MON, value: 1500 },
      { date: "2026-06-09", value: 1500 },
      { date: WED, value: 1500 },
    ];
    expect(periodRingProgress(days, goals, "steps", MON, WED)).toBeCloseTo(
      4500 / 3000
    );
  });

  it("ignores days outside [startDate..endDate]", () => {
    const days = [
      { date: "2026-06-07", value: 99999 }, // before range
      { date: MON, value: 1000 },
      { date: "2026-06-15", value: 99999 }, // after range
    ];
    expect(periodRingProgress(days, goals, "steps", MON, SUN)).toBeCloseTo(
      1000 / 7000
    );
  });

  it("applies a goal version change mid-period (history not re-scored)", () => {
    const versioned = [
      goalDoc("2026-01-01", 1000, 1),
      goalDoc("2026-06-11", 2000, 2), // Thu onward
    ];
    // Mon-Wed goal 1000 ×3 + Thu-Sun goal 2000 ×4 = 11000 denominator.
    const days = eachDate(MON, SUN).map((date) => ({ date, value: 1000 }));
    expect(
      periodRingProgress(days, versioned, "steps", MON, SUN)
    ).toBeCloseTo(7000 / 11000);
  });

  it("uses DEFAULT_GOALS in the denominator when no goal docs exist", () => {
    const days = [{ date: MON, value: DEFAULT_GOALS.steps }];
    expect(periodRingProgress(days, [], "steps", MON, "2026-06-09")).toBeCloseTo(
      0.5
    );
  });

  it("returns 0 for an empty range or an all-zero-goal denominator", () => {
    expect(periodRingProgress([], goals, "steps", SUN, MON)).toBe(0);
    const zeroGoals = [goalDoc("2026-01-01", 0)];
    const days = [{ date: MON, value: 1000 }];
    expect(periodRingProgress(days, zeroGoals, "steps", MON, SUN)).toBe(0);
  });
});

// ── onPaceFraction ───────────────────────────────────────────────────────────

describe("onPaceFraction", () => {
  it("returns 3/7 mid-week (Wednesday of a Mon–Sun week)", () => {
    expect(onPaceFraction(MON, SUN, WED)).toBeCloseTo(3 / 7);
  });

  it("returns 0 before the period starts (tick hidden)", () => {
    expect(onPaceFraction(MON, SUN, "2026-06-07")).toBe(0);
  });

  it("counts the first day inclusively (1/7 on the start date)", () => {
    expect(onPaceFraction(MON, SUN, MON)).toBeCloseTo(1 / 7);
  });

  it("returns 1 when today is the period end (tick hidden)", () => {
    expect(onPaceFraction(MON, SUN, SUN)).toBe(1);
  });

  it("clamps to 1 after the period ends (past weeks hide the tick)", () => {
    expect(onPaceFraction(MON, SUN, "2026-06-20")).toBe(1);
  });

  it("returns 1 for a single-day period (daily view never shows a tick)", () => {
    expect(onPaceFraction(WED, WED, WED)).toBe(1);
  });

  it("handles a partial YTD period", () => {
    // Jan 1 → Jun 11, 2026 = 162 elapsed days of a 365-day year.
    expect(onPaceFraction("2026-01-01", "2026-12-31", "2026-06-11")).toBeCloseTo(
      162 / 365
    );
  });

  it("returns 0 for a degenerate range (start > end)", () => {
    expect(onPaceFraction(SUN, MON, WED)).toBe(0);
  });
});

// ── ringDailyAverage ─────────────────────────────────────────────────────────

describe("ringDailyAverage", () => {
  // Local-midnight Date from a "YYYY-MM-DD" string (mirrors the page helpers).
  const d = (iso: string): Date => {
    const [y, m, dd] = iso.split("-").map(Number);
    return new Date(y, m - 1, dd);
  };

  it("uses an elapsed-days denominator mid-week (Thursday → 4)", () => {
    // Mon–Sun week, viewed on Thursday: 4 days elapsed.
    const THU = "2026-06-11";
    const result = ringDailyAverage({
      periodTotal: 40000,
      periodStart: d(MON),
      periodEnd: d(SUN),
      dailyGoals: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
      today: d(THU),
    });
    expect(result.daysElapsed).toBe(4);
    expect(result.avgValue).toBe(10000); // 40000 / 4
    // Only the first 4 per-day goals count toward the average.
    expect(result.avgGoal).toBe(10000); // (10000×4) / 4
  });

  it("divides by the full day count for a completed 30-day period", () => {
    // A fully-elapsed trailing 30-day window (today at/after the end).
    const start = "2026-05-13";
    const end = "2026-06-11"; // 30 inclusive days
    const result = ringDailyAverage({
      periodTotal: 150000,
      periodStart: d(start),
      periodEnd: d(end),
      dailyGoals: Array.from({ length: 30 }, () => 8000),
      today: d("2026-06-11"),
    });
    expect(result.daysElapsed).toBe(30);
    expect(result.avgValue).toBe(5000); // 150000 / 30
    expect(result.avgGoal).toBe(8000);
  });

  it("uses day-of-year as the denominator for YTD", () => {
    // YTD as of Jan 10 → 10 days elapsed (Jan 1 … Jan 10 inclusive).
    const result = ringDailyAverage({
      periodTotal: 1000,
      periodStart: d("2026-01-01"),
      periodEnd: d("2026-12-31"),
      dailyGoals: Array.from({ length: 365 }, () => 500),
      today: d("2026-01-10"),
    });
    expect(result.daysElapsed).toBe(10);
    expect(result.avgValue).toBe(100); // 1000 / 10
    // Only the first 10 of the 365 goals are summed.
    expect(result.avgGoal).toBe(500); // (500×10) / 10
  });

  it("respects per-day-of-week goals (non-flat avgGoal)", () => {
    // Mon=100, Tue=200, Wed=300, Thu=400 over a 4-day elapsed window.
    const THU = "2026-06-11";
    const result = ringDailyAverage({
      periodTotal: 800,
      periodStart: d(MON),
      periodEnd: d(SUN),
      dailyGoals: [100, 200, 300, 400, 999, 999, 999],
      today: d(THU),
    });
    expect(result.daysElapsed).toBe(4);
    // (100+200+300+400) / 4 = 250 — not a flat per-day goal.
    expect(result.avgGoal).toBe(250);
    expect(result.avgValue).toBe(200); // 800 / 4
  });

  it("caps daysElapsed at the period end when today is past it", () => {
    // Past completed week viewed later — denominator is the full 7 days,
    // never the days between the week end and today.
    const result = ringDailyAverage({
      periodTotal: 70,
      periodStart: d(MON),
      periodEnd: d(SUN),
      dailyGoals: [10, 10, 10, 10, 10, 10, 10],
      today: d("2026-06-30"),
    });
    expect(result.daysElapsed).toBe(7);
    expect(result.avgValue).toBe(10);
    expect(result.avgGoal).toBe(10);
  });

  it("returns zeros when the period starts in the future (no divide-by-zero)", () => {
    const result = ringDailyAverage({
      periodTotal: 0,
      periodStart: d("2026-07-06"),
      periodEnd: d("2026-07-12"),
      dailyGoals: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
      today: d("2026-06-11"),
    });
    expect(result.daysElapsed).toBe(0);
    expect(result.avgValue).toBe(0);
    expect(result.avgGoal).toBe(0);
    expect(Number.isNaN(result.avgGoal)).toBe(false);
  });

  it("single-day period (today only) → 1 day, avg equals the total", () => {
    const result = ringDailyAverage({
      periodTotal: 8432,
      periodStart: d(WED),
      periodEnd: d(WED),
      dailyGoals: [10000],
      today: d(WED),
    });
    expect(result.daysElapsed).toBe(1);
    expect(result.avgValue).toBe(8432);
    expect(result.avgGoal).toBe(10000);
  });

  it("ignores non-finite per-day goals when averaging", () => {
    const result = ringDailyAverage({
      periodTotal: 300,
      periodStart: d(MON),
      periodEnd: d("2026-06-10"), // Mon–Wed, 3 days
      dailyGoals: [100, Number.NaN, 200],
      today: d("2026-06-10"),
    });
    expect(result.daysElapsed).toBe(3);
    // NaN goal contributes 0; (100+0+200)/3 = 100.
    expect(result.avgGoal).toBe(100);
  });
});
