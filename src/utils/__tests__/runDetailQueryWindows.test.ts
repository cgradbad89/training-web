import { describe, it, expect } from "vitest";
import {
  recentImpactWindowStart,
  ctlSeedWindowStart,
  planTitleWindow,
  PLAN_TITLE_WINDOW_DAYS,
} from "@/utils/runDetailQueryWindows";
import { BEST_EFFORT_RECENCY_DAYS } from "@/utils/bestEffortExtraction";
import { CTL_IMPACT_SEED_DAYS } from "@/utils/runImpact";

/** Whole-day gap between two Dates (both taken at the same wall-clock time). */
function dayGap(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

const NOW = new Date("2026-07-18T09:30:00");
// A viewed run far in the past — the anchoring-bug regression case.
const OLD_RUN_DATE = new Date("2024-11-03T07:15:00");

describe("recentImpactWindowStart (Phase 2 — Race Prediction Impact)", () => {
  it("is anchored to TODAY and spans BEST_EFFORT_RECENCY_DAYS (56)", () => {
    const start = recentImpactWindowStart(NOW);
    expect(dayGap(NOW, start)).toBe(BEST_EFFORT_RECENCY_DAYS);
    expect(BEST_EFFORT_RECENCY_DAYS).toBe(56);
    expect(start.getTime()).toBeLessThan(NOW.getTime());
  });
});

describe("ctlSeedWindowStart (Phase 1 fallback — CTL live seed)", () => {
  it("is anchored to TODAY and spans a 180-day inclusive window", () => {
    const start = ctlSeedWindowStart(NOW);
    expect(dayGap(NOW, start)).toBe(CTL_IMPACT_SEED_DAYS - 1);
    expect(CTL_IMPACT_SEED_DAYS).toBe(180);
  });

  it("reaches further back than the 56-day impact window (keeps the EWMA seed alive)", () => {
    expect(ctlSeedWindowStart(NOW).getTime()).toBeLessThan(
      recentImpactWindowStart(NOW).getTime()
    );
  });
});

describe("planTitleWindow (Phase 3 — plan-title mapping)", () => {
  it("is anchored to the VIEWED RUN's date, not today, spanning ±2 days", () => {
    const { start, end } = planTitleWindow(OLD_RUN_DATE);
    // Symmetric ±2 around the run date (NOT today).
    expect(dayGap(OLD_RUN_DATE, start)).toBe(PLAN_TITLE_WINDOW_DAYS);
    expect(dayGap(end, OLD_RUN_DATE)).toBe(PLAN_TITLE_WINDOW_DAYS);
    expect(PLAN_TITLE_WINDOW_DAYS).toBe(2);
  });

  it("brackets the run date (start < run < end)", () => {
    const { start, end } = planTitleWindow(OLD_RUN_DATE);
    expect(start.getTime()).toBeLessThan(OLD_RUN_DATE.getTime());
    expect(end.getTime()).toBeGreaterThan(OLD_RUN_DATE.getTime());
  });

  it("does NOT anchor to today — an old run's window stays in the past", () => {
    // Regression guard: getting the anchor backwards (using today) would put the
    // window near NOW and silently drop the old run's plan entry again.
    const { start, end } = planTitleWindow(OLD_RUN_DATE);
    expect(end.getTime()).toBeLessThan(NOW.getTime());
    expect(start.getFullYear()).toBe(2024);
  });
});
