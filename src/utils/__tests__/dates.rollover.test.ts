import { describe, it, expect } from "vitest";
import {
  localYearOf,
  startOfLocalYear,
  mondayKey,
  weeksBetweenMondays,
  elapsedWeeksIn,
  localDateCutoff,
  addMonthsClamped,
  toLocalIsoDate,
} from "@/utils/dates";

describe("localYearOf / startOfLocalYear", () => {
  it("uses local components (Dec 31 evening is still 2026)", () => {
    expect(localYearOf(new Date(2026, 11, 31, 23, 59))).toBe(2026);
    expect(localYearOf(new Date(2027, 0, 1, 0, 0))).toBe(2027);
  });
  it("startOfLocalYear is local midnight Jan 1", () => {
    const d = startOfLocalYear(2027);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2027, 0, 1, 0]);
  });
});

describe("mondayKey", () => {
  it("2026-W53 spans Mon 12-28 … Sun 01-03 and is one key", () => {
    expect(mondayKey(new Date(2026, 11, 28, 9))).toBe("2026-12-28");
    expect(mondayKey(new Date(2026, 11, 31, 20))).toBe("2026-12-28");
    expect(mondayKey(new Date(2027, 0, 1, 0, 30))).toBe("2026-12-28");
    expect(mondayKey(new Date(2027, 0, 3, 23, 59))).toBe("2026-12-28");
  });
  it("2027-W01 starts Mon 2027-01-04", () => {
    expect(mondayKey(new Date(2027, 0, 4, 9))).toBe("2027-01-04");
  });
  it("Sunday 12-27 belongs to the 12-21 week", () => {
    expect(mondayKey(new Date(2026, 11, 27, 23, 30))).toBe("2026-12-21");
  });
  it("mid-year control", () => {
    expect(mondayKey(new Date(2026, 5, 7))).toBe("2026-06-01");
  });
});

describe("weeksBetweenMondays", () => {
  it("W53 → W01 is +1, and the reverse is -1", () => {
    expect(weeksBetweenMondays(new Date(2026, 11, 28), new Date(2027, 0, 4))).toBe(1);
    expect(weeksBetweenMondays(new Date(2027, 0, 4), new Date(2026, 11, 28))).toBe(-1);
  });
  it("previous week is -1, same week is 0 regardless of weekday", () => {
    expect(weeksBetweenMondays(new Date(2026, 11, 28), new Date(2026, 11, 21))).toBe(-1);
    expect(weeksBetweenMondays(new Date(2026, 11, 28), new Date(2027, 0, 3))).toBe(0);
  });
  it("mid-year control", () => {
    expect(weeksBetweenMondays(new Date(2026, 5, 1), new Date(2026, 5, 8))).toBe(1);
  });
  it("is DST-safe across the March spring-forward (2027-03-14)", () => {
    expect(weeksBetweenMondays(new Date(2027, 2, 8), new Date(2027, 2, 15))).toBe(1);
    expect(weeksBetweenMondays(new Date(2027, 2, 1), new Date(2027, 2, 22))).toBe(3);
  });
  it("is DST-safe across the November fall-back (2026-11-01)", () => {
    expect(weeksBetweenMondays(new Date(2026, 9, 26), new Date(2026, 10, 2))).toBe(1);
    expect(weeksBetweenMondays(new Date(2026, 9, 26), new Date(2026, 10, 23))).toBe(4);
  });
});

describe("elapsedWeeksIn", () => {
  const jan1 = startOfLocalYear(2027);
  it("2027 windows: Jan 1 → 1, Jan 4 → 2, Jan 11 → 3", () => {
    expect(elapsedWeeksIn(jan1, new Date(2027, 0, 1))).toBe(1);
    expect(elapsedWeeksIn(jan1, new Date(2027, 0, 3))).toBe(1);
    expect(elapsedWeeksIn(jan1, new Date(2027, 0, 4))).toBe(2);
    expect(elapsedWeeksIn(jan1, new Date(2027, 0, 11))).toBe(3);
  });
  it("full 2026 touches 53 Monday-anchored weeks (starts Thu, ends Thu)", () => {
    // Mon 2025-12-29 … Mon 2026-12-28 = 52 weeks apart → 53 weeks touched.
    expect(elapsedWeeksIn(startOfLocalYear(2026), new Date(2026, 11, 31))).toBe(53);
  });
  it("end before start → 0", () => {
    expect(elapsedWeeksIn(new Date(2027, 0, 5), new Date(2027, 0, 4))).toBe(0);
  });
  it("same local day with different times → 1", () => {
    expect(elapsedWeeksIn(new Date(2027, 0, 5, 18), new Date(2027, 0, 5, 9))).toBe(1);
  });
});

describe("localDateCutoff", () => {
  it("at 2026-12-31 19:30 local returns the LOCAL date, not UTC-shifted", () => {
    const now = new Date(2026, 11, 31, 19, 30);
    expect(localDateCutoff(0, now)).toBe("2026-12-31");
    expect(localDateCutoff(7, now)).toBe("2026-12-24");
  });
  it("crosses the year boundary", () => {
    expect(localDateCutoff(3, new Date(2027, 0, 1, 0, 30))).toBe("2026-12-29");
  });
  it("defaults to now", () => {
    expect(localDateCutoff(0)).toBe(toLocalIsoDate(new Date()));
  });
});

describe("addMonthsClamped", () => {
  it("2028-02-29 −12 → 2027-02-28", () => {
    expect(toLocalIsoDate(addMonthsClamped(new Date(2028, 1, 29), -12))).toBe("2027-02-28");
  });
  it("2027-01-31 +1 → 2027-02-28", () => {
    expect(toLocalIsoDate(addMonthsClamped(new Date(2027, 0, 31), 1))).toBe("2027-02-28");
  });
  it("2026-03-31 −1 → 2026-02-28", () => {
    expect(toLocalIsoDate(addMonthsClamped(new Date(2026, 2, 31), -1))).toBe("2026-02-28");
  });
  it("leap target keeps Feb 29 (2027-01-31 → 2028-02 is +13)", () => {
    expect(toLocalIsoDate(addMonthsClamped(new Date(2027, 0, 31), 13))).toBe("2028-02-29");
  });
  it("preserves time of day and crosses years", () => {
    const d = addMonthsClamped(new Date(2026, 11, 15, 8, 30), 2);
    expect(toLocalIsoDate(d)).toBe("2027-02-15");
    expect([d.getHours(), d.getMinutes()]).toEqual([8, 30]);
  });
});
