import { describe, it, expect } from "vitest";
import {
  AGGREGATED_STATS_VERSION,
  isAggregatedStatsStale,
  buildAggregatedStats,
  reviveAggregatedStatsDates,
  type AggregatedStatsDoc,
} from "./aggregatedStats";
import { type HealthWorkout } from "@/types/healthWorkout";

describe("aggregatedStats", () => {
  describe("isAggregatedStatsStale", () => {
    it("returns true for null cache", () => {
      expect(isAggregatedStatsStale(null, "workout1")).toBe(true);
    });

    it("returns true for version mismatch", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION - 1,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout1")).toBe(true);
    });

    it("returns true for different latestWorkoutId", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout2")).toBe(true);
    });

    it("returns false for same version and latestWorkoutId", () => {
      const cached = {
        computationVersion: AGGREGATED_STATS_VERSION,
        latestWorkoutId: "workout1",
      } as AggregatedStatsDoc;
      expect(isAggregatedStatsStale(cached, "workout1")).toBe(false);
    });
  });

  describe("buildAggregatedStats", () => {
    it("returns safe defaults for empty workouts", () => {
      const result = buildAggregatedStats({
        workouts: [],
        routePointsByWorkoutId: {},
        mileSplitsByWorkoutId: {},
        healthMetrics: [],
        maxHr: 185,
        restingHr: 50,
        now: new Date("2024-01-01T12:00:00Z"),
        races: [],
      });

      expect(result.computationVersion).toBe(AGGREGATED_STATS_VERSION);
      expect(result.latestWorkoutId).toBe("");
      expect(result.trainingLoad.series).toEqual([]);
      expect(result.racePredictions.t5k).toBeNull();
      expect(result.racePredictions.confidenceLevel).toBe("low");
      expect(result.personalRecordsByYear.prs).toEqual([]);
    });

    it("wires dependencies correctly for populated inputs", () => {
      const now = new Date("2024-01-01T12:00:00Z");
      const mockWorkout: HealthWorkout = {
        workoutId: "workout1",
        startDate: new Date("2024-01-01T10:00:00Z"),
        endDate: new Date("2024-01-01T10:20:00Z"),
        distanceMiles: 3.1,
        durationSeconds: 1200,
        activityType: "Running",
        sourceName: "Apple Watch",
        basalEnergyBurned: 100,
        activeEnergyBurned: 200,
        sourceVersion: "1",
        device: "Apple Watch",
      };

      const result = buildAggregatedStats({
        workouts: [mockWorkout],
        routePointsByWorkoutId: {},
        mileSplitsByWorkoutId: {},
        healthMetrics: [
          { id: "metric1", data: { date: "2024-01-01", vo2_max: 50 } },
        ],
        maxHr: 185,
        restingHr: 50,
        now,
        races: [{ raceDate: "2024-01-10T10:00:00Z", distanceMiles: 13.1 }],
      });

      expect(result.latestWorkoutId).toBe("workout1");
      expect(result.vo2History).toEqual([{ date: "2024-01-01", value: 50 }]);
      expect(result.personalRecordsByYear.specificPrs.length).toBeGreaterThan(0);
      expect(result.racePredictions.modelFit).toBeNull(); // not enough for riegel fit
      expect(result.paceTrends).toBeDefined();
    });
  });

  describe("reviveAggregatedStatsDates", () => {
    // Shaped like what Firestore actually returns on a cache-hit read: the
    // write path (JSON.parse(JSON.stringify(...))) has turned every Date into
    // an ISO string, even though the TS type still says Date.
    function firestoreShapedDoc(): AggregatedStatsDoc {
      return {
        computationVersion: AGGREGATED_STATS_VERSION,
        computedAt: "2024-01-01T12:00:00.000Z",
        latestWorkoutId: "workout1",
        latestWorkoutStartDate: "2024-01-01T10:00:00.000Z",
        trainingLoad: { series: [] },
        vo2History: [],
        racePredictions: {
          t5k: null,
          t10: null,
          tHalf: null,
          tMar: null,
          confidenceLevel: "low",
          modelFit: null,
        },
        personalRecordsByYear: {
          prs: [
            { pace: 480, miles: 2, date: "2024-01-05T10:00:00.000Z" },
            null,
          ],
          specificPrs: [
            {
              pace: 420,
              miles: 3.1,
              totalSeconds: 1302,
              date: "2024-01-06T10:00:00.000Z",
            },
            null,
          ],
        },
        paceTrends: [],
        hrZoneDistribution: {
          runsCounted: 0,
          totalMiles: 0,
          zoneMiles: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        },
        fastestMileSegment: {
          seconds: 360,
          date: "2024-01-07T10:00:00.000Z",
        },
        // Firestore stores string dates but the TS type says Date; cast through
        // unknown to mirror the real (statsSnap.data() as AggregatedStatsDoc).
      } as unknown as AggregatedStatsDoc;
    }

    it("revives all three Date-typed leaves into real Date instances", () => {
      const result = reviveAggregatedStatsDates(firestoreShapedDoc());

      expect(result.fastestMileSegment!.date instanceof Date).toBe(true);
      expect(result.fastestMileSegment!.date.toISOString()).toBe(
        "2024-01-07T10:00:00.000Z"
      );

      expect(result.personalRecordsByYear.prs[0]!.date instanceof Date).toBe(
        true
      );
      expect(
        result.personalRecordsByYear.specificPrs[0]!.date instanceof Date
      ).toBe(true);
      // Reviving does not corrupt the other numeric fields.
      expect(result.personalRecordsByYear.prs[0]!.pace).toBe(480);
      expect(result.personalRecordsByYear.specificPrs[0]!.totalSeconds).toBe(
        1302
      );
    });

    it("preserves null entries without fabricating a date", () => {
      const result = reviveAggregatedStatsDates(firestoreShapedDoc());
      expect(result.personalRecordsByYear.prs[1]).toBeNull();
      expect(result.personalRecordsByYear.specificPrs[1]).toBeNull();
    });

    it("does not throw when fastestMileSegment is null", () => {
      const doc = firestoreShapedDoc();
      (doc as { fastestMileSegment: unknown }).fastestMileSegment = null;
      const result = reviveAggregatedStatsDates(doc);
      expect(result.fastestMileSegment).toBeNull();
    });

    it("does not throw on empty PR arrays (new user, no qualifying runs)", () => {
      const doc = firestoreShapedDoc();
      doc.personalRecordsByYear = { prs: [], specificPrs: [] };
      const result = reviveAggregatedStatsDates(doc);
      expect(result.personalRecordsByYear.prs).toEqual([]);
      expect(result.personalRecordsByYear.specificPrs).toEqual([]);
    });

    it("does not mutate its input", () => {
      const input = firestoreShapedDoc();
      const before = JSON.parse(JSON.stringify(input));
      reviveAggregatedStatsDates(input);
      // Input's string dates remain strings — no in-place conversion.
      expect(JSON.parse(JSON.stringify(input))).toEqual(before);
      expect(typeof (input.fastestMileSegment!.date as unknown)).toBe("string");
    });
  });
});
