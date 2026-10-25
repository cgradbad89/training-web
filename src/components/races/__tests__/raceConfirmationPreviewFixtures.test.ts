import { describe, expect, it } from "vitest";
import { evaluateRacePerformance } from "@/utils/racePerformance";
import { createRaceConfirmationPreviewFixtures, SYNTHETIC_AS_OF, SYNTHETIC_TIME_ZONE } from "../raceConfirmationPreviewFixtures";

describe("invented preview observations", () => {
  it("starts with an excluded timing conflict and an unverified consistent result", () => {
    const fixtures = createRaceConfirmationPreviewFixtures();
    const result = evaluateRacePerformance({ ...fixtures, asOf: SYNTHETIC_AS_OF, timeZone: SYNTHETIC_TIME_ZONE });
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({ status: "inconsistent", timingAgreement: "discrepant", eligibleSameDistanceBenchmark: false, durationSeconds: 7_680, elapsedSeconds: 8_220 });
    expect(result.evidence[1]).toMatchObject({ status: "recorded_unverified", timingAgreement: "consistent", eligibleSameDistanceBenchmark: false, durationSeconds: 7_440, elapsedSeconds: 7_440 });
    expect(result.currentCapability.estimatedSeconds).toBeNull();
    expect(result.raceDayForecast.estimatedSeconds).toBeNull();
  });

  it("uses explicitly synthetic identities without any child telemetry", () => {
    const fixtures = createRaceConfirmationPreviewFixtures();
    expect(fixtures.races.every(race => race.id.startsWith("synthetic-") && race.name.startsWith("Synthetic "))).toBe(true);
    expect(fixtures.workouts.every(workout => workout.workoutId.startsWith("synthetic-") && !workout.hasRoute && !workout.hasHRStream)).toBe(true);
  });

  it("creates fresh observations so resetting cannot retain prior edits", () => {
    const first = createRaceConfirmationPreviewFixtures();
    first.races[0].name = "Edited sample";
    first.workouts[0].startDate.setFullYear(2030);
    const second = createRaceConfirmationPreviewFixtures();
    expect(second.races[0].name).toBe("Synthetic Spring Half");
    expect(second.workouts[0].startDate.getUTCFullYear()).toBe(2026);
  });
});
