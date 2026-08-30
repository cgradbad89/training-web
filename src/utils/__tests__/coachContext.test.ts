import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCoachContext } from "@/utils/coachContext";
import * as racePrediction from "@/utils/racePrediction";
import { predictRaceTime } from "@/utils/racePrediction";
import { formatRaceTime } from "@/utils/riegelFit";
import { buildBestEffortSegments } from "@/utils/bestEffortExtraction";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";
import {
  buildPlanAdherence,
  weekHitsMileageTarget,
} from "@/utils/planAdherence";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type PlannedRunEntry, type RunningPlan } from "@/types/plan";
import { type Race } from "@/types/race";

function entry(
  id: string,
  distanceMiles: number,
  weekday = 1
): PlannedRunEntry {
  return {
    id,
    weekIndex: 0,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType: "outdoor",
  };
}

function plan(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "coach-adherence-plan",
    name: "Coach Adherence Plan",
    planType: "running",
    startDate: "2026-08-03",
    status: "active",
    isActive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    weeks: [
      { weekNumber: 1, entries },
      { weekNumber: 2, entries: [] },
    ],
  };
}

function run(
  workoutId: string,
  day: number,
  distanceMiles: number,
  paceSecPerMile = 600,
  avgHeartRate: number | null = null
): HealthWorkout {
  return {
    workoutId,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date(2026, 7, day, 12),
    endDate: new Date(2026, 7, day, 13),
    durationSeconds: distanceMiles * paceSecPerMile,
    sourceName: "Test",
    isRunLike: true,
    hasRoute: false,
    syncedAt: new Date(2026, 7, day, 13),
    calories: 0,
    avgHeartRate,
    distanceMiles,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: null,
  };
}

function race(overrides: Partial<Race> = {}): Race {
  return {
    id: "race-1",
    name: "Goal Race",
    raceDate: "2026-08-30",
    raceDistance: "5K",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function expectedPredictionTime(
  runs: HealthWorkout[],
  activeRace: Race,
  asOf: Date,
  bestEffortSegments = buildBestEffortSegments([], asOf, 185, 60)
): string | null {
  const raceDistanceMiles =
    activeRace.raceDistance === "custom"
      ? activeRace.customDistanceMiles ?? 0
      : activeRace.raceDistance === "5K"
        ? 3.107
        : activeRace.raceDistance === "10K"
          ? 6.214
          : activeRace.raceDistance === "halfMarathon"
            ? 13.109
            : 26.219;
  const result = predictRaceTime(
    runs,
    {
      raceDistanceMiles,
      races: [{ raceDate: activeRace.raceDate, distanceMiles: raceDistanceMiles }],
      bestEffortSegments,
    },
    asOf
  );
  return result.predictedSeconds == null
    ? null
    : formatRaceTime(result.predictedSeconds);
}

function coachAdherence(plannedMiles: number, actualMiles: number) {
  const context = buildCoachContext(
    actualMiles > 0 ? [run("threshold-run", 3, actualMiles)] : [],
    plan(plannedMiles > 0 ? [entry("planned-run", plannedMiles)] : []),
    null
  );
  return context.activePlan;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildCoachContext — canonical weekly mileage target", () => {
  it.each([
    { actual: 8, expected: 0, label: "80%" },
    { actual: 8.49, expected: 0, label: "just below 85%" },
    { actual: 8.5, expected: 1, label: "exactly 85%" },
    { actual: 9, expected: 1, label: "above 85%" },
  ])("counts $label through the canonical rule", ({ actual, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));

    const coach = coachAdherence(10, actual);

    expect(coach?.weeksHitTarget).toBe(expected);
    expect(coach?.adherencePct).toBe(expected * 100);
  });

  it("preserves canonical zero-planned-mileage behavior", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));

    const coach = coachAdherence(0, 0);

    expect(weekHitsMileageTarget(0, 0)).toBe(false);
    expect(coach?.weeksHitTarget).toBe(0);
  });

  it("matches Plan Insights at 82% while completed sessions remain independent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));
    const fixturePlan = plan([
      entry("monday", 5, 1),
      entry("tuesday", 5, 2),
    ]);
    const runs = [
      run("monday-run", 3, 4.25),
      run("tuesday-partial", 4, 3.95),
    ];

    const planInsights = buildPlanAdherence(fixturePlan, runs, { maxHr: 185 });
    const coach = buildCoachContext(runs, fixturePlan, null).activePlan;

    expect(planInsights.weeks[0]).toMatchObject({
      plannedMiles: 10,
      actualMiles: 8.2,
      plannedRuns: 2,
      completedRuns: 2,
    });
    expect(planInsights.weeksHitTarget).toBe(0);
    expect(coach).toMatchObject({
      weeksHitTarget: planInsights.weeksHitTarget,
      weeksCompleted: 1,
      adherencePct: 0,
    });
  });
});

describe("buildCoachContext — canonical race prediction parity", () => {
  const asOf = new Date(2026, 7, 29, 12);
  const fixture = [
    run("p1", 3, 2, 500),
    run("p2", 10, 3, 510),
    run("p3", 17, 4, 520),
    run("p4", 24, 5, 525),
  ];

  function coachPrediction(
    runs: HealthWorkout[],
    activeRace: Race,
    bestEffortSegments: ReturnType<typeof buildBestEffortSegments> = []
  ): string | null {
    return buildCoachContext(
      runs,
      null,
      activeRace,
      [],
      185,
      60,
      {
        races: [
          {
            raceDate: activeRace.raceDate,
            distanceMiles:
              activeRace.raceDistance === "halfMarathon" ? 13.109 : 3.107,
          },
        ],
        bestEffortSegments,
        asOf,
      }
    ).activeRace?.predictedTime ?? null;
  }

  it("equals predictRaceTime on the same fixture and routes through that entry point", () => {
    const activeRace = race();
    const canonicalSpy = vi.spyOn(racePrediction, "predictRaceTime");

    const coach = coachPrediction(fixture, activeRace);

    expect(coach).toBe(expectedPredictionTime(fixture, activeRace, asOf, []));
    expect(canonicalSpy).toHaveBeenCalled();
    canonicalSpy.mockRestore();
  });

  it("stays equal after a distance/duration override", () => {
    const activeRace = race();
    const override: WorkoutOverride = {
      workoutId: "p4",
      userId: "u1",
      isExcluded: false,
      excludedAt: null,
      excludedReason: null,
      distanceMilesOverride: 5.4,
      durationSecondsOverride: 2700,
      runTypeOverride: null,
      updatedAt: asOf.toISOString(),
    };
    const effective = fixture.map((workout) =>
      workout.workoutId === "p4" ? applyOverride(workout, override) : workout
    );

    expect(coachPrediction(effective, activeRace)).toBe(
      expectedPredictionTime(effective, activeRace, asOf, [])
    );
  });

  it("uses the same excluded-workout population", () => {
    const activeRace = race();
    const excluded = selectEffectiveWorkouts(fixture, {
      p4: {
        workoutId: "p4",
        userId: "u1",
        isExcluded: true,
        excludedAt: asOf.toISOString(),
        excludedReason: null,
        distanceMilesOverride: null,
        durationSecondsOverride: null,
        runTypeOverride: null,
        updatedAt: asOf.toISOString(),
      },
    });

    expect(coachPrediction(excluded, activeRace)).toBe(
      expectedPredictionTime(excluded, activeRace, asOf, [])
    );
    expect(coachPrediction(excluded, activeRace)).toBeNull();
  });

  it("matches canonical insufficient-history behavior", () => {
    const activeRace = race();
    expect(coachPrediction(fixture.slice(0, 3), activeRace)).toBe(
      expectedPredictionTime(fixture.slice(0, 3), activeRace, asOf, [])
    );
    expect(coachPrediction(fixture.slice(0, 3), activeRace)).toBeNull();
  });

  it("matches canonical race-anchor behavior", () => {
    const anchoredRace = race({ raceDate: "2026-08-24" });
    expect(coachPrediction(fixture, anchoredRace)).toBe(
      expectedPredictionTime(fixture, anchoredRace, asOf, [])
    );
  });

  it("uses identical best-effort evidence and resolved HR-anchor effects", () => {
    const halfRace = race({ raceDistance: "halfMarathon" });
    const halfRuns = [
      run("h1", 3, 4, 610, 155),
      run("h2", 10, 5, 600, 155),
      run("h3", 17, 6, 590, 155),
      run("h4", 24, 7, 580, 155),
    ];
    const highHrrEvidence = buildBestEffortSegments(halfRuns, asOf, 175, 65);
    const lowHrrEvidence = buildBestEffortSegments(halfRuns, asOf, 190, 50);

    const highCoach = buildCoachContext(
      halfRuns,
      null,
      halfRace,
      [],
      175,
      65,
      {
        races: [{ raceDate: halfRace.raceDate, distanceMiles: 13.109 }],
        bestEffortSegments: highHrrEvidence,
        asOf,
      }
    ).activeRace?.predictedTime ?? null;
    const lowCoach = buildCoachContext(
      halfRuns,
      null,
      halfRace,
      [],
      190,
      50,
      {
        races: [{ raceDate: halfRace.raceDate, distanceMiles: 13.109 }],
        bestEffortSegments: lowHrrEvidence,
        asOf,
      }
    ).activeRace?.predictedTime ?? null;

    expect(highCoach).toBe(
      expectedPredictionTime(halfRuns, halfRace, asOf, highHrrEvidence)
    );
    expect(lowCoach).toBe(
      expectedPredictionTime(halfRuns, halfRace, asOf, lowHrrEvidence)
    );
    expect(highHrrEvidence.length).toBeGreaterThan(lowHrrEvidence.length);
    expect(highCoach).not.toBe(lowCoach);
  });
});
