import { describe, it, expect } from "vitest";
import { VO2_HISTORY_DAYS, vo2HistoryCutoffISO } from "@/utils/vo2History";

describe("vo2HistoryCutoffISO", () => {
  it("defaults to a 180-day trailing window", () => {
    expect(VO2_HISTORY_DAYS).toBe(180);
  });

  it("returns a YYYY-MM-DD string `days` before `now`", () => {
    // 2026-07-11 minus 180 days = 2026-01-12
    const now = new Date("2026-07-11T12:00:00Z");
    expect(vo2HistoryCutoffISO(now, 180)).toBe("2026-01-12");
  });

  it("honors a custom window length", () => {
    const now = new Date("2026-07-11T12:00:00Z");
    // minus 30 days = 2026-06-11
    expect(vo2HistoryCutoffISO(now, 30)).toBe("2026-06-11");
  });

  it("does not mutate the passed-in date", () => {
    const now = new Date("2026-07-11T12:00:00Z");
    const before = now.getTime();
    vo2HistoryCutoffISO(now, 180);
    expect(now.getTime()).toBe(before);
  });

  it("crosses year boundaries correctly", () => {
    const now = new Date("2026-02-01T12:00:00Z");
    // minus 180 days lands in 2025
    expect(vo2HistoryCutoffISO(now, 180)).toBe("2025-08-05");
  });
});
