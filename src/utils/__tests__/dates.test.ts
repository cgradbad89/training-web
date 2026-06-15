import { describe, it, expect } from "vitest";
import {
  formatMonthYear,
  parseLocalDate,
  daysUntil,
  weekStart,
  normalizeToMonday,
  weekToDateWindow,
} from "@/utils/dates";
import { ringDailyAverage } from "@/lib/ringMath";

describe("formatMonthYear", () => {
  it("formats as full month name + year", () => {
    // Local-time constructor (month is 0-indexed): March 11, 2027.
    expect(formatMonthYear(new Date(2027, 2, 11))).toBe("March 2027");
    expect(formatMonthYear(new Date(2026, 11, 1))).toBe("December 2026");
  });
});

describe("parseLocalDate", () => {
  it("parses 2026-09-06 as LOCAL Sep 6 (regression: UTC parse rendered Sep 5)", () => {
    const d = parseLocalDate("2026-09-06");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8); // September (0-indexed)
    expect(d.getDate()).toBe(6); // NOT the 5th, in every timezone
    expect(d.getHours()).toBe(0);
    expect(d.getDay()).toBe(0); // Sunday — "Sun, Sep 6", never "Sat, Sep 5"
    expect(
      d.toLocaleDateString("en-US", { weekday: "short" })
    ).toBe("Sun");
  });

  it("agrees with the local-midnight suffix idiom it replaces", () => {
    expect(parseLocalDate("2026-01-01").getTime()).toBe(
      new Date("2026-01-01T00:00:00").getTime()
    );
  });
});

describe("daysUntil", () => {
  it("counts whole local calendar days regardless of time of day (race regression)", () => {
    // Jun 11 2026 → Sep 6 2026 = 87 days, whether asked at 6 AM or 11 PM.
    expect(daysUntil("2026-09-06", new Date(2026, 5, 11, 6, 0))).toBe(87);
    expect(daysUntil("2026-09-06", new Date(2026, 5, 11, 23, 45))).toBe(87);
  });

  it("boundary cases: today → 0, tomorrow → 1, yesterday → -1", () => {
    const lateTonight = new Date(2026, 5, 11, 23, 59);
    expect(daysUntil("2026-06-11", lateTonight)).toBe(0);
    expect(daysUntil("2026-06-12", lateTonight)).toBe(1);
    expect(daysUntil("2026-06-10", lateTonight)).toBe(-1);
  });

  it("spans a DST transition without drifting a day", () => {
    // US DST ends Nov 1 2026; Oct 30 → Nov 2 is 3 calendar days even though
    // one of them is 25 hours long.
    expect(daysUntil("2026-11-02", new Date(2026, 9, 30, 12, 0))).toBe(3);
  });
});

// ── Monday-start week boundary + "This Week" week-to-date window ─────────────
// Reference week: Mon 2026-06-15 … Sun 2026-06-21 (2026-06-15 is a Monday).
const MON = "2026-06-15";
const WED = "2026-06-17";
const THU = "2026-06-18";
const SUN = "2026-06-21";

describe("weekStart / normalizeToMonday — Monday-start boundary", () => {
  it("a mid-week date resolves to that week's Monday", () => {
    expect(normalizeToMonday(parseLocalDate(WED))).toBe(MON);
    expect(normalizeToMonday(parseLocalDate(THU))).toBe(MON);
    const ws = weekStart(parseLocalDate(THU));
    expect(ws.getDay()).toBe(1); // Monday
    expect(ws.getDate()).toBe(15);
  });

  it("a Monday resolves to itself", () => {
    expect(normalizeToMonday(parseLocalDate(MON))).toBe(MON);
  });

  it("Sunday stays in the same week (its Monday is 6 days back, not next week)", () => {
    // Regression guard: a Sunday must NOT roll forward to the next Monday.
    expect(normalizeToMonday(parseLocalDate(SUN))).toBe(MON);
  });
});

describe("weekToDateWindow — Monday-start week-to-date", () => {
  it("a mid-week anchor: start=Monday, end=anchor, weekEnd=Sunday", () => {
    expect(weekToDateWindow(THU)).toEqual({
      start: MON,
      end: THU,
      weekEnd: SUN,
    });
  });

  it("excludes future days in the week (end < weekEnd mid-week)", () => {
    const { end, weekEnd } = weekToDateWindow(THU);
    expect(end < weekEnd).toBe(true); // Fri/Sat/Sun not yet in the window
  });

  it("Sunday edge: still this week — end and weekEnd both land on Sunday", () => {
    expect(weekToDateWindow(SUN)).toEqual({
      start: MON,
      end: SUN,
      weekEnd: SUN,
    });
  });

  it("full Mon–Sun span is always exactly 7 days (never a 30d/YTD window)", () => {
    for (const anchor of [MON, WED, THU, SUN]) {
      const { start, weekEnd } = weekToDateWindow(anchor);
      expect(daysUntil(weekEnd, parseLocalDate(start))).toBe(6); // 6 nights → 7 days
    }
  });

  it("daysElapsed feeding the avg toggle: Monday → 1, Thursday → 4", () => {
    const dailyGoals = [10, 10, 10, 10, 10, 10, 10];
    const monWindow = weekToDateWindow(MON);
    const mon = ringDailyAverage({
      periodTotal: 100,
      periodStart: parseLocalDate(monWindow.start),
      periodEnd: parseLocalDate(monWindow.end),
      dailyGoals,
      today: parseLocalDate(MON),
    });
    expect(mon.daysElapsed).toBe(1);

    const thuWindow = weekToDateWindow(THU);
    const thu = ringDailyAverage({
      periodTotal: 100,
      periodStart: parseLocalDate(thuWindow.start),
      periodEnd: parseLocalDate(thuWindow.end),
      dailyGoals,
      today: parseLocalDate(THU),
    });
    expect(thu.daysElapsed).toBe(4);
  });
});
