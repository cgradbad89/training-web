import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AGGREGATED_STATS_VERSION,
  buildFastestMileFromBestEfforts,
  buildAggregatedStats,
  computeFreshnessFingerprint,
  computeWorkoutAggregationRevision,
  computeVo2FreshnessKey,
  isFingerprintStale,
  isVo2Stale,
  reviveAggregatedStatsDates,
  type AggregatedStatsFreshnessFingerprint,
  type AggregatedStatsDoc,
} from "./aggregatedStats";
import { type HealthWorkout } from "@/types/healthWorkout";
import { findBestFastestMileAcrossRuns } from "./fastestMileSegment";

describe("aggregatedStats", () => {
  const fingerprintInputs = {
    latestWorkoutId: "workout1",
    computationVersion: AGGREGATED_STATS_VERSION,
    maxHr: 185,
    restingHr: 50,
    activeRaceId: "race-1",
    activeRaceDate: "2026-10-04",
    overrides: {
      workout1: { updatedAt: "2026-08-20T10:00:00Z", isExcluded: false },
    },
  };

  function fingerprint(): AggregatedStatsFreshnessFingerprint {
    return computeFreshnessFingerprint(fingerprintInputs);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("freshness domains", () => {
    it("does not report stale for an unrelated rerender or object key order", () => {
      const cached = fingerprint();
      const current = computeFreshnessFingerprint({
        ...fingerprintInputs,
        overrides: {
          workout1: { isExcluded: false, updatedAt: "2026-08-20T10:00:00Z" },
        },
      });
      expect(isFingerprintStale(cached, current)).toBe(false);
    });

    it("detects max-HR changes", () => {
      expect(
        isFingerprintStale(
          fingerprint(),
          computeFreshnessFingerprint({ ...fingerprintInputs, maxHr: 190 })
        )
      ).toBe(true);
    });

    it("detects resting-HR changes", () => {
      expect(
        isFingerprintStale(
          fingerprint(),
          computeFreshnessFingerprint({ ...fingerprintInputs, restingHr: 47 })
        )
      ).toBe(true);
    });

    it("detects aggregation computation-version changes", () => {
      expect(
        isFingerprintStale(
          fingerprint(),
          computeFreshnessFingerprint({
            ...fingerprintInputs,
            computationVersion: AGGREGATED_STATS_VERSION + 1,
          })
        )
      ).toBe(true);
    });

    it("detects active race identity and date changes", () => {
      const cached = fingerprint();
      expect(
        isFingerprintStale(
          cached,
          computeFreshnessFingerprint({ ...fingerprintInputs, activeRaceId: "race-2" })
        )
      ).toBe(true);
      expect(
        isFingerprintStale(
          cached,
          computeFreshnessFingerprint({ ...fingerprintInputs, activeRaceDate: "2026-10-11" })
        )
      ).toBe(true);
    });

    it("detects override changes without reading Firestore", () => {
      expect(
        isFingerprintStale(
          fingerprint(),
          computeFreshnessFingerprint({
            ...fingerprintInputs,
            overrides: {
              workout1: { updatedAt: "2026-08-20T10:00:00Z", isExcluded: true },
            },
          })
        )
      ).toBe(true);
    });

    it("revises same-ID workouts when persisted best efforts or load changes", () => {
      const workout = {
        workoutId: "workout1",
        startDate: new Date("2026-08-20T10:00:00Z"),
        endDate: new Date("2026-08-20T11:00:00Z"),
        syncedAt: new Date("2026-08-20T11:01:00Z"),
        durationSeconds: 3600,
        distanceMiles: 6,
        activityType: "Running",
        sourceName: "Apple Watch",
        isRunLike: true,
        hasRoute: true,
        avgHeartRate: 150,
        bestEfforts: { "1mi": 420 },
        trainingLoadV2: 72,
      } as HealthWorkout;
      const cached = computeWorkoutAggregationRevision([workout]);

      expect(computeWorkoutAggregationRevision([{ ...workout }])).toBe(cached);
      expect(
        computeWorkoutAggregationRevision([
          { ...workout, bestEfforts: { ...workout.bestEfforts!, "1mi": 410 } },
        ])
      ).not.toBe(cached);
      expect(
        computeWorkoutAggregationRevision([{ ...workout, trainingLoadV2: 80 }])
      ).not.toBe(cached);
    });

    it("detects a local day rollover", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 20, 23, 59));
      const cached = fingerprint();
      vi.setSystemTime(new Date(2026, 7, 21, 0, 1));
      expect(isFingerprintStale(cached, fingerprint())).toBe(true);
    });

    it("detects a local year rollover", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
      const cached = fingerprint();
      vi.setSystemTime(new Date(2027, 0, 1, 0, 1));
      const current = fingerprint();
      expect(current.localCalendarYear).toBe(2027);
      expect(isFingerprintStale(cached, current)).toBe(true);
    });

    it("keeps VO2 freshness independent when the latest sample is unchanged", () => {
      expect(
        isVo2Stale(
          computeVo2FreshnessKey("2026-08-19"),
          computeVo2FreshnessKey("2026-08-19")
        )
      ).toBe(false);
    });

    it("marks only the VO2 domain stale when its latest sample date changes", () => {
      const main = fingerprint();
      expect(isFingerprintStale(main, fingerprint())).toBe(false);
      expect(
        isVo2Stale(
          computeVo2FreshnessKey("2026-08-19"),
          computeVo2FreshnessKey("2026-08-20")
        )
      ).toBe(true);
    });

    it("creates pure serializable keys without invoking any data source", () => {
      expect(fingerprint()).toEqual(
        expect.objectContaining({
          latestWorkoutId: "workout1",
          overridesRevision: expect.any(String),
        })
      );
      expect(computeVo2FreshnessKey(null)).toEqual({ latestVo2SampleDate: null });
    });
  });

  describe("buildAggregatedStats", () => {
    it("returns safe defaults for empty workouts", () => {
      const result = buildAggregatedStats({
        workouts: [],
        mileSplitsByWorkoutId: {},
        healthMetrics: [],
        maxHr: 185,
        restingHr: 50,
        now: new Date("2024-01-01T12:00:00Z"),
        races: [],
        freshnessFingerprint: fingerprint(),
        vo2FreshnessKey: computeVo2FreshnessKey(null),
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
        mileSplitsByWorkoutId: {},
        healthMetrics: [
          { id: "metric1", data: { date: "2024-01-01", vo2_max: 50 } },
        ],
        maxHr: 185,
        restingHr: 50,
        now,
        races: [{ raceDate: "2024-01-10T10:00:00Z", distanceMiles: 13.1 }],
        freshnessFingerprint: fingerprint(),
        vo2FreshnessKey: computeVo2FreshnessKey("2024-01-01"),
      });

      expect(result.latestWorkoutId).toBe("workout1");
      expect(result.vo2History).toEqual([{ date: "2024-01-01", value: 50 }]);
      expect(result.personalRecordsByYear.specificPrs.length).toBeGreaterThan(0);
      expect(result.racePredictions.modelFit).toBeNull(); // not enough for riegel fit
      expect(result.paceTrends).toBeDefined();
    });
  });

  describe("buildFastestMileFromBestEfforts", () => {
    function run(
      id: string,
      date: Date,
      oneMile: number | null | undefined,
      isRunLike = true
    ): HealthWorkout {
      return {
        workoutId: id,
        startDate: date,
        isRunLike,
        bestEfforts:
          oneMile === undefined
            ? undefined
            : {
                "1mi": oneMile,
                "5k": null,
                "10k": null,
                "10mi": null,
                half: null,
              },
      } as unknown as HealthWorkout;
    }

    it("is equivalent to the old route-result reducer on fixture values", () => {
      const workouts = [
        run("slower", new Date(2026, 2, 1, 12), 480),
        run("fastest", new Date(2026, 3, 1, 12), 420),
      ];
      expect(buildFastestMileFromBestEfforts(workouts, 2026)).toEqual(
        findBestFastestMileAcrossRuns([
          { seconds: 480, date: workouts[0].startDate },
          { seconds: 420, date: workouts[1].startDate },
        ])
      );
    });

    it("filters to the selected local calendar year", () => {
      const prior = run("prior", new Date(2025, 11, 31, 12), 350);
      const current = run("current", new Date(2026, 0, 2, 12), 430);
      expect(buildFastestMileFromBestEfforts([prior, current], 2026)).toEqual({
        seconds: 430,
        date: current.startDate,
      });
    });

    it("skips null, missing, and non-run values without crashing", () => {
      const valid = run("valid", new Date(2026, 1, 1, 12), 440);
      expect(
        buildFastestMileFromBestEfforts(
          [
            run("null", new Date(2026, 1, 2, 12), null),
            run("missing", new Date(2026, 1, 3, 12), undefined),
            run("walk", new Date(2026, 1, 4, 12), 300, false),
            valid,
          ],
          2026
        )
      ).toEqual({ seconds: 440, date: valid.startDate });
    });

    it("preserves the 180 < seconds < 1200 validity window", () => {
      expect(
        buildFastestMileFromBestEfforts(
          [
            run("too-fast", new Date(2026, 1, 1, 12), 180),
            run("too-slow", new Date(2026, 1, 2, 12), 1200),
          ],
          2026
        )
      ).toBeNull();
    });
  });

  describe("reviveAggregatedStatsDates", () => {
    // Shaped like what Firestore actually returns on a cache-hit read: the
    // write path (JSON.parse(JSON.stringify(...))) has turned every Date into
    // an ISO string, even though the TS type still says Date.
    function firestoreShapedDoc(): AggregatedStatsDoc {
      return {
        computationVersion: AGGREGATED_STATS_VERSION,
        freshnessFingerprint: fingerprint(),
        vo2FreshnessKey: computeVo2FreshnessKey(null),
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
