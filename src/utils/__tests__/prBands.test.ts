import { describe, expect, it, vi } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  PR_BAND_RANGES,
  buildPersonalRecordsByYear,
  distanceInPrBand,
} from "@/utils/personalRecords";
import { computeAllPRs } from "@/utils/prComputation";

vi.spyOn(console, "log").mockImplementation(() => {});

function run(id: string, miles: number, pace = 540): HealthWorkout {
  const start = new Date(2026, 5, 1, 7);
  return {
    workoutId: id,
    startDate: start,
    endDate: start,
    durationSeconds: miles * pace,
    distanceMiles: miles,
    activityType: "running",
    sourceName: "Apple Watch",
    isRunLike: true,
  } as unknown as HealthWorkout;
}

describe("shared PR distance bands", () => {
  it("band 7–10 ends at 10.0 inclusive; 10+ is strictly above 10.0", () => {
    expect(distanceInPrBand("band_7_10", 10.0)).toBe(true);
    expect(distanceInPrBand("band_10p", 10.0)).toBe(false);
    expect(distanceInPrBand("band_7_10", 10.01)).toBe(false);
    expect(distanceInPrBand("band_10p", 10.01)).toBe(true);
  });

  it("keeps lower-inclusive / upper-exclusive for the other bands", () => {
    expect(distanceInPrBand("band_1_3", 1.0)).toBe(true);
    expect(distanceInPrBand("band_1_3", 3.0)).toBe(false);
    expect(distanceInPrBand("band_3_6", 3.0)).toBe(true);
    expect(distanceInPrBand("band_6_7", 6.0)).toBe(true);
    expect(distanceInPrBand("band_6_7", 7.0)).toBe(false);
    expect(distanceInPrBand("band_7_10", 7.0)).toBe(true);
  });

  it("covers every distance from 1.0 up exactly once", () => {
    const ids = Object.keys(PR_BAND_RANGES) as (keyof typeof PR_BAND_RANGES)[];
    for (const miles of [1, 2.99, 3, 5.99, 6, 6.99, 7, 9.99, 10, 10.01, 13.1, 26.2]) {
      expect(ids.filter((id) => distanceInPrBand(id, miles))).toHaveLength(1);
    }
  });

  describe("buildPersonalRecordsByYear (Personal Insights)", () => {
    it("puts a 10.0 mi run in 7–10 mi and not 10+ mi", () => {
      const { prs } = buildPersonalRecordsByYear([run("ten", 10.0)], 2026);
      expect(prs[3]?.miles).toBe(10.0);
      expect(prs[4]).toBeNull();
    });

    it("puts a 10.01 mi run in 10+ mi and not 7–10 mi", () => {
      const { prs } = buildPersonalRecordsByYear([run("ten01", 10.01)], 2026);
      expect(prs[3]).toBeNull();
      expect(prs[4]?.miles).toBe(10.01);
    });
  });

  describe("computeAllPRs (run-list badges)", () => {
    const winners = (ws: HealthWorkout[]) =>
      Object.fromEntries(computeAllPRs(ws).map((r) => [r.categoryId, r.workoutId]));

    it("puts a 10.0 mi run in band_7_10 and not band_10p", () => {
      const w = winners([run("ten", 10.0)]);
      expect(w.band_7_10).toBe("ten");
      expect(w.band_10p).toBeUndefined();
    });

    it("puts a 10.01 mi run in band_10p and not band_7_10", () => {
      const w = winners([run("ten01", 10.01)]);
      expect(w.band_7_10).toBeUndefined();
      expect(w.band_10p).toBe("ten01");
    });

    it("a GPS-rounded 10.10 mi run no longer competes in 7–10", () => {
      const w = winners([run("slow10", 10.0, 600), run("gps", 10.1, 500)]);
      expect(w.band_7_10).toBe("slow10");
      expect(w.band_10p).toBe("gps");
    });

    it("agrees with Personal Insights on which run owns each shared band", () => {
      const ws = [
        run("a", 2, 500), run("b", 4, 520), run("c", 6.5, 540),
        run("d", 9, 560), run("e", 10.0, 580), run("f", 10.01, 560), run("g", 12, 600),
      ];
      const badge = winners(ws);
      const { prs } = buildPersonalRecordsByYear(ws, 2026);
      const ids = ["band_1_3", "band_3_6", "band_6_7", "band_7_10", "band_10p"];
      ids.forEach((id, i) => {
        const owner = ws.find((w) => w.workoutId === badge[id]);
        expect(owner?.distanceMiles).toBe(prs[i]?.miles);
      });
    });

    it("keeps the badge-only 1 Mile band", () => {
      expect(winners([run("mile", 1.0)]).band_1mi).toBe("mile");
    });
  });
});
