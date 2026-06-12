import { describe, it, expect } from "vitest";
import { formatMonthYear, parseLocalDate, daysUntil } from "@/utils/dates";

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
