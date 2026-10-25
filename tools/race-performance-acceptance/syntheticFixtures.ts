import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";

export const SYNTHETIC_AS_OF = "2026-10-25T16:00:00.000Z";
export const SYNTHETIC_TIME_ZONE = "America/New_York";

/** Invented observations, deliberately distinct from real event names, IDs and times. */
export function createRaceConfirmationPreviewFixtures(): { races: Race[]; workouts: HealthWorkout[] } {
  const observations = [
    { id: "synthetic-spring-half", name: "Synthetic Spring Half", date: "2026-04-12", recorded: 7_680, elapsed: 8_220 },
    { id: "synthetic-autumn-half", name: "Synthetic Autumn Half", date: "2026-09-06", recorded: 7_440, elapsed: 7_440 },
  ];
  const workouts: HealthWorkout[] = observations.map(observation => {
    const startDate = new Date(`${observation.date}T12:00:00.000Z`);
    return {
      workoutId: `${observation.id}-workout`, name: "Synthetic run", activityType: "running", displayType: "Run",
      isRunLike: true, startDate, endDate: new Date(startDate.getTime() + observation.elapsed * 1_000),
      durationSeconds: observation.recorded, distanceMiles: 13.2, distanceMeters: 13.2 * 1609.344,
      sourceName: "Synthetic fixture", syncedAt: new Date(`${observation.date}T20:00:00.000Z`),
      hasRoute: false, hasHRStream: false, calories: 0, avgHeartRate: null, avgPaceSecPerMile: null,
      avgSpeedMPS: null, hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    };
  });
  const races: Race[] = observations.map((observation, index) => ({
    id: observation.id, name: observation.name, raceDate: observation.date, raceDistance: "halfMarathon",
    isActive: false, createdAt: `${observation.date}T20:00:00.000Z`, actualRunId: workouts[index].workoutId,
    actualRunDate: observation.date, actualRunDistanceMiles: workouts[index].distanceMiles,
    actualRunDurationSeconds: observation.recorded,
  }));
  return { races, workouts };
}
