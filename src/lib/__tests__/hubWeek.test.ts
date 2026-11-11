import { afterAll, describe, expect, it } from "vitest";
import {
  HUB_TIME_ZONE,
  addDaysToKey,
  formatWeekLabel,
  mondayOfKey,
  todayInZone,
  zonedDateKey,
  zonedMidnightInstant,
  zonedWeekFor,
} from "@/lib/hubWeek";

const HOURS = 60 * 60 * 1000;
const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("hubWeek: civil-date arithmetic", () => {
  it("finds the Monday of any weekday, including Sunday (Monday-start weeks)", () => {
    expect(mondayOfKey("2026-11-09")).toBe("2026-11-09"); // Monday
    expect(mondayOfKey("2026-11-11")).toBe("2026-11-09"); // Wednesday
    expect(mondayOfKey("2026-11-15")).toBe("2026-11-09"); // Sunday
    expect(mondayOfKey("2026-11-16")).toBe("2026-11-16"); // next Monday
  });

  it("adds days across month and year ends", () => {
    expect(addDaysToKey("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDaysToKey("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDaysToKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rejects malformed or impossible civil dates", () => {
    expect(() => mondayOfKey("2026-13-01")).toThrow(RangeError);
    expect(() => mondayOfKey("2026-02-30")).toThrow(RangeError);
    expect(() => mondayOfKey("11/09/2026")).toThrow(RangeError);
  });

  it("labels weeks within a month and across a month boundary", () => {
    expect(formatWeekLabel("2026-11-09")).toBe("Nov 9–15");
    expect(formatWeekLabel("2026-10-26")).toBe("Oct 26 – Nov 1");
    expect(formatWeekLabel("2026-12-28")).toBe("Dec 28 – Jan 3");
  });
});

describe("hubWeek: instant → Eastern civil date", () => {
  it("puts UTC-midnight instants on the PREVIOUS Eastern day", () => {
    // 00:00Z on Mon Nov 9 is 19:00 EST on Sun Nov 8.
    expect(zonedDateKey(new Date("2026-11-09T00:00:00.000Z"))).toBe("2026-11-08");
    // Summer: 00:00Z is 20:00 EDT the previous evening.
    expect(zonedDateKey(new Date("2026-07-15T00:00:00.000Z"))).toBe("2026-07-14");
  });

  it("flips exactly at Eastern midnight (Sunday 23:59:59.999 vs Monday 00:00:00)", () => {
    // Nov 9 2026 is EST (UTC-5): Eastern midnight Monday = 05:00Z.
    expect(zonedDateKey(new Date("2026-11-10T04:59:59.999Z"))).toBe("2026-11-09");
    expect(zonedDateKey(new Date("2026-11-09T04:59:59.999Z"))).toBe("2026-11-08");
    expect(zonedDateKey(new Date("2026-11-09T05:00:00.000Z"))).toBe("2026-11-09");
  });

  it("is independent of the host timezone", () => {
    const instants = [
      "2026-03-08T06:59:59.999Z",
      "2026-03-08T07:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-09T04:59:59.999Z",
    ].map((iso) => new Date(iso));
    const expected = instants.map((i) => withTZ("America/New_York", () => zonedDateKey(i)));
    for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Honolulu", "Europe/Berlin"]) {
      expect(instants.map((i) => withTZ(tz, () => zonedDateKey(i)))).toEqual(expected);
    }
  });

  it("reports today in the zone for an injected now", () => {
    expect(todayInZone(new Date("2026-11-09T03:00:00.000Z"))).toBe("2026-11-08");
    expect(todayInZone(new Date("2026-11-09T05:00:00.000Z"))).toBe("2026-11-09");
  });
});

describe("hubWeek: Eastern midnight instants", () => {
  it("uses -05:00 in winter and -04:00 in summer", () => {
    expect(zonedMidnightInstant("2026-11-09").toISOString()).toBe("2026-11-09T05:00:00.000Z");
    expect(zonedMidnightInstant("2026-07-13").toISOString()).toBe("2026-07-13T04:00:00.000Z");
  });

  it("is correct on the DST transition days themselves", () => {
    // Spring forward Sun Mar 8 2026: midnight is still EST (05:00Z); Mon Mar 9 is EDT (04:00Z).
    expect(zonedMidnightInstant("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedMidnightInstant("2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // Fall back Sun Nov 1 2026: midnight is still EDT (04:00Z); Mon Nov 2 is EST (05:00Z).
    expect(zonedMidnightInstant("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedMidnightInstant("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("round-trips through zonedDateKey in every host timezone", () => {
    for (const tz of ["America/New_York", "UTC", "Asia/Tokyo"]) {
      withTZ(tz, () => {
        for (const key of ["2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02", "2026-12-31"]) {
          const midnight = zonedMidnightInstant(key);
          expect(zonedDateKey(midnight)).toBe(key);
          expect(zonedDateKey(new Date(midnight.getTime() - 1))).toBe(addDaysToKey(key, -1));
        }
      });
    }
  });
});

describe("hubWeek: zonedWeekFor", () => {
  it("builds an ordinary winter week (168 h)", () => {
    const week = zonedWeekFor(new Date("2026-11-11T17:00:00.000Z"));
    expect(week.timeZone).toBe(HUB_TIME_ZONE);
    expect(week.weekStartKey).toBe("2026-11-09");
    expect(week.weekEndKey).toBe("2026-11-15");
    expect(week.dayKeys).toEqual([
      "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12",
      "2026-11-13", "2026-11-14", "2026-11-15",
    ]);
    expect(week.startInstant.toISOString()).toBe("2026-11-09T05:00:00.000Z");
    expect(week.endExclusiveInstant.toISOString()).toBe("2026-11-16T05:00:00.000Z");
    expect(week.endInclusiveInstant.toISOString()).toBe("2026-11-16T04:59:59.999Z");
    expect(week.endExclusiveInstant.getTime() - week.startInstant.getTime()).toBe(168 * HOURS);
  });

  it("DST-start week (Mon Mar 2 – Sun Mar 8 2026) is 167 h, not 168", () => {
    const week = zonedWeekFor(new Date("2026-03-05T15:00:00.000Z"));
    expect(week.weekStartKey).toBe("2026-03-02");
    expect(week.startInstant.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    expect(week.endExclusiveInstant.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(week.endExclusiveInstant.getTime() - week.startInstant.getTime()).toBe(167 * HOURS);
  });

  it("DST-end week (Mon Oct 26 – Sun Nov 1 2026) is 169 h, not 168, and spans a month end", () => {
    const week = zonedWeekFor(new Date("2026-10-28T15:00:00.000Z"));
    expect(week.weekStartKey).toBe("2026-10-26");
    expect(week.weekEndKey).toBe("2026-11-01");
    expect(week.startInstant.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(week.endExclusiveInstant.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(week.endExclusiveInstant.getTime() - week.startInstant.getTime()).toBe(169 * HOURS);
    expect(formatWeekLabel(week.weekStartKey)).toBe("Oct 26 – Nov 1");
  });

  it("assigns Sunday 23:59:59.999 ET to the ending week and Monday 00:00:00 ET to the next", () => {
    const sundayLastMs = new Date("2026-11-16T04:59:59.999Z"); // Sun Nov 15 23:59:59.999 EST
    const mondayFirstMs = new Date("2026-11-16T05:00:00.000Z"); // Mon Nov 16 00:00:00.000 EST
    expect(zonedWeekFor(sundayLastMs).weekStartKey).toBe("2026-11-09");
    expect(zonedWeekFor(mondayFirstMs).weekStartKey).toBe("2026-11-16");
    const week = zonedWeekFor(sundayLastMs);
    // Inclusive pair (dashboard isInWeek rule): the last ms is in, the next ms is out.
    expect(sundayLastMs >= week.startInstant && sundayLastMs <= week.endInclusiveInstant).toBe(true);
    expect(mondayFirstMs >= week.startInstant && mondayFirstMs <= week.endInclusiveInstant).toBe(false);
  });

  it("treats a UTC-Monday instant that is still Sunday evening in New York as the earlier week", () => {
    const week = zonedWeekFor(new Date("2026-11-09T03:00:00.000Z")); // Sun Nov 8 22:00 EST
    expect(week.weekStartKey).toBe("2026-11-02");
    expect(week.weekEndKey).toBe("2026-11-08");
  });

  it("returns identical weeks in every host timezone", () => {
    const now = new Date("2026-11-09T03:00:00.000Z");
    const expected = withTZ("America/New_York", () => JSON.stringify(zonedWeekFor(now)));
    for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Honolulu"]) {
      expect(withTZ(tz, () => JSON.stringify(zonedWeekFor(now)))).toBe(expected);
    }
  });
});
