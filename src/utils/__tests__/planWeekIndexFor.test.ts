import { describe, expect, it, afterAll } from "vitest";
import { planWeekIndexFor } from "@/utils/planMatching";

/**
 * `planWeekIndexFor` unifies three formerly-divergent "which plan week is
 * this" formulas (dashboard running-plan tiles, dashboard workout-plan tiles,
 * and the byte-identical duplicate in plans/page.tsx + PlanEditor.tsx).
 *
 * The bug it fixes is TIMEZONE-DEPENDENT, so these tests pin `process.env.TZ`
 * rather than trusting the runner's zone — Node re-reads TZ on every `Date`
 * construction, so this makes the regression deterministic on any machine.
 * Without the pin, the "returns 0, not -1" case would pass under the OLD
 * implementation on any US CI box and only fail in Europe/Asia.
 */

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = prev;
  }
}

/** The pre-fix formula, verbatim: date-only string parsed as UTC midnight. */
function buggyWeekIndex(startDate: string, referenceDate: Date): number {
  return Math.floor(
    (referenceDate.getTime() - new Date(startDate).getTime()) /
      (7 * 24 * 60 * 60 * 1000)
  );
}

/** The pre-fix formula at the call sites that were ALREADY parsing locally. */
function localWeekIndex(startDate: string, referenceDate: Date): number {
  return Math.floor(
    (referenceDate.getTime() - new Date(startDate + "T00:00:00").getTime()) /
      (7 * 24 * 60 * 60 * 1000)
  );
}

/** Local midnight of a "YYYY-MM-DD" — what every caller actually passes in
 *  (weekStart() returns local midnight; so does the /plans "today" clamp). */
function localMidnight(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Mondays. 2026-01-19 is a Monday; 2026-03-09 is the Monday after US DST start.
const PLAN_START = "2026-01-19";

describe("planWeekIndexFor — the plan's own first week is 0, never -1", () => {
  // UTC+1 and UTC+9: the offsets where the old UTC-midnight parse broke.
  for (const tz of ["Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"]) {
    it(`returns 0 for the start date itself in ${tz} (old formula returned -1)`, () => {
      withTZ(tz, () => {
        const ref = localMidnight(PLAN_START);
        // Pin the bug: the old implementation is wrong HERE, so this test
        // could not have passed before the fix.
        expect(buggyWeekIndex(PLAN_START, ref)).toBe(-1);
        expect(planWeekIndexFor(PLAN_START, ref)).toBe(0);
      });
    });
  }

  for (const tz of ["America/New_York", "America/Los_Angeles", "UTC"]) {
    it(`returns 0 for the start date itself in ${tz} (unchanged — was already 0)`, () => {
      withTZ(tz, () => {
        const ref = localMidnight(PLAN_START);
        expect(buggyWeekIndex(PLAN_START, ref)).toBe(0);
        expect(planWeekIndexFor(PLAN_START, ref)).toBe(0);
      });
    });
  }

  it("returns 0 for every day of the plan's first week, at a positive UTC offset", () => {
    withTZ("Europe/Berlin", () => {
      const days = [
        "2026-01-19", // Mon
        "2026-01-20",
        "2026-01-21",
        "2026-01-22",
        "2026-01-23",
        "2026-01-24",
        "2026-01-25", // Sun
      ];
      for (const d of days) {
        expect(planWeekIndexFor(PLAN_START, localMidnight(d))).toBe(0);
      }
    });
  });
});

describe("planWeekIndexFor — index advances one per calendar week", () => {
  it("counts forward from the start Monday", () => {
    withTZ("America/New_York", () => {
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-01-26"))).toBe(1);
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-02-02"))).toBe(2);
      // Pre-DST, so the raw-millisecond floor is exact.
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-02"))).toBe(6);
    });
  });

  it("returns a negative index for a reference date before the plan started", () => {
    withTZ("America/New_York", () => {
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-01-12"))).toBe(-1);
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-01-05"))).toBe(-2);
    });
  });

  // ── Pinned pre-existing limitation, NOT a fix (see PRD §6 #41) ───────────
  // `Math.floor` on a raw ms difference loses a week after a spring-forward.
  // These assertions lock in TODAY's behavior so the follow-up Math.round
  // decision is a deliberate, visible change rather than a silent one.
  it("under-counts by one week after a US spring-forward (documented limitation)", () => {
    // DST starts Sun 2026-03-08 in US zones. Mon 2026-03-09 is calendar week
    // 7 of a plan that started Mon 2026-01-19 (49 days), but the ms diff is
    // 49 days MINUS an hour, so the floor yields 6.
    withTZ("America/New_York", () => {
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-02"))).toBe(6);
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-09"))).toBe(6);
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-16"))).toBe(7);
    });
  });

  it("is exact across a FALL-BACK transition (the extra hour is harmless)", () => {
    // DST ends Sun 2026-11-01. A plan starting Mon 2026-10-19: Nov 2 is week 2.
    withTZ("America/New_York", () => {
      expect(planWeekIndexFor("2026-10-19", localMidnight("2026-10-26"))).toBe(1);
      expect(planWeekIndexFor("2026-10-19", localMidnight("2026-11-02"))).toBe(2);
      expect(planWeekIndexFor("2026-10-19", localMidnight("2026-11-09"))).toBe(3);
    });
  });

  it("is exact year-round in a zone with no DST at all", () => {
    withTZ("UTC", () => {
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-09"))).toBe(7);
      expect(planWeekIndexFor(PLAN_START, localMidnight("2026-03-23"))).toBe(9);
    });
  });
});

describe("planWeekIndexFor — regression: call sites already parsing locally are unchanged", () => {
  // The dashboard's workout-plan tiles, /plans currentWeekIndex, and
  // PlanEditor's defaultWeekForPlan all used `startDate + "T00:00:00"`.
  // Their output must be byte-identical after the refactor.
  const starts = ["2026-01-19", "2026-03-09", "2026-06-29", "2026-12-28"];
  const refs = [
    "2026-01-19",
    "2026-01-25",
    "2026-03-09",
    "2026-03-15",
    "2026-07-04",
    "2026-11-02",
    "2027-01-04",
  ];

  for (const tz of ["America/New_York", "Europe/Berlin", "UTC", "Asia/Tokyo"]) {
    it(`matches the previous local-parse formula for every start/reference pair in ${tz}`, () => {
      withTZ(tz, () => {
        for (const start of starts) {
          for (const ref of refs) {
            const at = localMidnight(ref);
            expect(planWeekIndexFor(start, at)).toBe(localWeekIndex(start, at));
          }
        }
      });
    });
  }

  it("accepts a non-midnight reference date (callers may pass 'now')", () => {
    withTZ("Europe/Berlin", () => {
      const [y, m, d] = PLAN_START.split("-").map(Number);
      const lateInDay = new Date(y, m - 1, d, 23, 59, 59);
      expect(planWeekIndexFor(PLAN_START, lateInDay)).toBe(0);
    });
  });
});
