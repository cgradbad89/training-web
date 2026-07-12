import { describe, it, expect } from "vitest";
import {
  buildWeatherCorrelationData,
  computeLinearTrend,
} from "../weatherCorrelation";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WeatherSnapshot } from "@/types/weather";

// Fixed "now" so range-window math is deterministic.
const NOW = new Date("2026-07-11T12:00:00");

function weather(tempF: number): WeatherSnapshot {
  return {
    tempF,
    feelsLikeF: tempF,
    humidity: 50,
    windMph: 5,
    dewPointF: tempF - 10,
    conditionText: "Clear",
    conditionCode: 0,
    fetchedAt: "2026-07-11T12:00:00Z",
  };
}

// Minimal HealthWorkout factory — only the fields the builder reads matter;
// the rest are filled with inert defaults.
function makeWorkout(overrides: Partial<HealthWorkout>): HealthWorkout {
  return {
    workoutId: "w1",
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-07-01T08:00:00"),
    endDate: new Date("2026-07-01T09:00:00"),
    durationSeconds: 1800, // 30 min
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: true,
    syncedAt: NOW,
    calories: 300,
    avgHeartRate: 150,
    distanceMiles: 3, // → 600 sec/mi with 1800s
    distanceMeters: 4828,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    weather: weather(60),
    ...overrides,
  };
}

describe("buildWeatherCorrelationData", () => {
  it("includes a valid running workout with weather and computes pace = duration/miles", () => {
    const w = makeWorkout({ durationSeconds: 1800, distanceMiles: 3 });
    const pts = buildWeatherCorrelationData([w], 180, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].paceSecPerMile).toBe(600);
    expect(pts[0].tempF).toBe(60);
    expect(pts[0].date).toBe("2026-07-01");
    expect(pts[0].avgHeartRate).toBe(150);
  });

  it("excludes non-running (isRunLike=false) workouts", () => {
    const run = makeWorkout({ workoutId: "run", isRunLike: true });
    const strength = makeWorkout({
      workoutId: "strength",
      isRunLike: false,
      displayType: "Strength",
    });
    const pts = buildWeatherCorrelationData([run, strength], 180, NOW);
    expect(pts.map((p) => p.workoutId)).toEqual(["run"]);
  });

  it("excludes workouts with null/absent tempF", () => {
    const withWeather = makeWorkout({ workoutId: "a", weather: weather(72) });
    const noWeather = makeWorkout({ workoutId: "b", weather: null });
    const undef = makeWorkout({ workoutId: "c", weather: undefined });
    const pts = buildWeatherCorrelationData(
      [withWeather, noWeather, undef],
      180,
      NOW,
    );
    expect(pts.map((p) => p.workoutId)).toEqual(["a"]);
  });

  it("applies the 180-day range window", () => {
    const recent = makeWorkout({
      workoutId: "recent",
      startDate: new Date("2026-06-01T08:00:00"), // ~40 days back
    });
    const old = makeWorkout({
      workoutId: "old",
      startDate: new Date("2025-12-01T08:00:00"), // ~220 days back
    });
    const pts = buildWeatherCorrelationData([recent, old], 180, NOW);
    expect(pts.map((p) => p.workoutId)).toEqual(["recent"]);
  });

  it("365-day range includes runs excluded by the 180-day window", () => {
    const old = makeWorkout({
      workoutId: "old",
      startDate: new Date("2025-12-01T08:00:00"), // ~220 days back
    });
    expect(buildWeatherCorrelationData([old], 180, NOW)).toHaveLength(0);
    expect(buildWeatherCorrelationData([old], 365, NOW)).toHaveLength(1);
  });

  it("excludes workouts with no computable pace (zero distance or duration)", () => {
    const zeroDist = makeWorkout({ workoutId: "zd", distanceMiles: 0 });
    const zeroDur = makeWorkout({ workoutId: "zt", durationSeconds: 0 });
    const ok = makeWorkout({ workoutId: "ok" });
    const pts = buildWeatherCorrelationData([zeroDist, zeroDur, ok], 180, NOW);
    expect(pts.map((p) => p.workoutId)).toEqual(["ok"]);
  });

  it("keeps HR-null points (they belong in the pace chart) but marks HR null", () => {
    const nullHr = makeWorkout({ workoutId: "nohr", avgHeartRate: null });
    const pts = buildWeatherCorrelationData([nullHr], 180, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].avgHeartRate).toBeNull();
    // Downstream: the HR chart filters these out, the pace chart keeps them.
    const hrPoints = pts.filter((p) => p.avgHeartRate != null);
    expect(hrPoints).toHaveLength(0);
  });
});

describe("computeLinearTrend", () => {
  it("returns null for 0 points", () => {
    expect(computeLinearTrend([])).toBeNull();
  });

  it("returns null for 1 point", () => {
    expect(computeLinearTrend([{ x: 1, y: 2 }])).toBeNull();
  });

  it("returns null when all x are equal (zero x-variance)", () => {
    expect(
      computeLinearTrend([
        { x: 5, y: 1 },
        { x: 5, y: 9 },
      ]),
    ).toBeNull();
  });

  it("recovers slope=2, intercept=1 from a perfect line y = 2x + 1", () => {
    const pts = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ];
    const trend = computeLinearTrend(pts);
    expect(trend).not.toBeNull();
    expect(trend!.slope).toBeCloseTo(2, 10);
    expect(trend!.intercept).toBeCloseTo(1, 10);
  });

  it("fits a best-fit line through noisy data (least squares)", () => {
    // y ≈ x with a slight scatter; slope should be near 1.
    const pts = [
      { x: 1, y: 1 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
      { x: 4, y: 5 },
      { x: 5, y: 4 },
    ];
    const trend = computeLinearTrend(pts);
    expect(trend).not.toBeNull();
    expect(trend!.slope).toBeCloseTo(0.8, 6);
    expect(trend!.intercept).toBeCloseTo(0.6, 6);
  });
});
