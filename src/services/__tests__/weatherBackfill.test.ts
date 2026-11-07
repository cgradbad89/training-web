import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WeatherSnapshot } from "@/types/weather";
import type { WeatherFetchResult } from "@/lib/weather";
import { runWeatherBackfillPass, type WeatherPassDeps } from "../weatherBackfill";
import {
  EMPTY_WEATHER_LEDGER,
  claimWeatherWork,
  recordWeatherFailure,
  releaseWeatherWork,
} from "@/utils/weatherBackfill";

const NOW = Date.parse("2026-11-07T15:00:00Z");
const DAY = 86_400_000;
const SNAP: WeatherSnapshot = {
  tempF: 50, feelsLikeF: 48, humidity: 70, windMph: 5, dewPointF: 40,
  conditionCode: 1, conditionText: "Mainly clear", fetchedAt: "2026-11-07T15:00:00.000Z",
};

function run(id: string, daysAgo: number, patch: Partial<HealthWorkout> = {}): HealthWorkout {
  const start = NOW - daysAgo * DAY;
  return {
    workoutId: id, name: "Run", activityType: "run", displayType: "Run",
    startDate: new Date(start), endDate: new Date(start + 2_700_000), durationSeconds: 2700,
    sourceName: "Watch", isRunLike: true, hasRoute: true, syncedAt: new Date(start), calories: 1,
    avgHeartRate: 150, distanceMiles: 5, distanceMeters: 8047, avgPaceSecPerMile: 540, avgSpeedMPS: 3,
    hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...patch,
  } as HealthWorkout;
}

function makeDeps(overrides: Partial<WeatherPassDeps> = {}) {
  const deps = {
    getStartPoint: vi.fn(async () => ({ lat: 40.7, lng: -74 })),
    fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => ({ status: "ok", weather: SNAP })),
    saveIfAbsent: vi.fn(async () => "saved" as const),
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return deps;
}

const base = () => ({ ledger: EMPTY_WEATHER_LEDGER, settled: new Set<string>(), isCurrent: () => true });

afterEach(() => vi.restoreAllMocks());

describe("runWeatherBackfillPass", () => {
  it("acquires weather for new eligible runs with no Run Detail involvement", async () => {
    const deps = makeDeps();
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1), run("b", 2)] }, deps);
    expect(summary).toMatchObject({ selected: 2, saved: 2, failed: 0 });
    expect(deps.saveIfAbsent).toHaveBeenCalledTimes(2);
    // The provider is queried with the run's START instant, not "now".
    expect(deps.fetchWeather.mock.calls[0][2]).toEqual(new Date(NOW - DAY));
    // Calls are spaced: one sleep between two provider calls, none before the first.
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: runs that already have weather are never fetched", async () => {
    const deps = makeDeps();
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1, { weather: SNAP })] }, deps);
    expect(summary.selected).toBe(0);
    expect(deps.getStartPoint).not.toHaveBeenCalled();
    expect(deps.fetchWeather).not.toHaveBeenCalled();
  });

  it("a rerun after success does not repeat work (settled ids)", async () => {
    const deps = makeDeps();
    const input = { ...base(), workouts: [run("a", 1)] };
    await runWeatherBackfillPass(input, deps);
    const second = await runWeatherBackfillPass(input, deps);
    expect(second.summary.selected).toBe(0);
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("is bounded by the pass limit, newest first", async () => {
    const deps = makeDeps();
    const workouts = [1, 2, 3, 4, 5].map((d) => run(`r${d}`, d));
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts, limit: 2 }, deps);
    expect(summary.selected).toBe(2);
    expect(deps.fetchWeather.mock.calls.map((c) => c[2])).toEqual([new Date(NOW - DAY), new Date(NOW - 2 * DAY)]);
  });

  it("skips indoor, no-GPS, excluded and too-recent runs", async () => {
    const deps = makeDeps();
    const workouts = [
      run("indoor", 1, { displayType: "Treadmill Run" }),
      run("nogps", 1, { hasRoute: false }),
      run("excluded", 1),
      run("fresh", 0.01),
    ];
    const overrides = { excluded: { workoutId: "excluded", userId: "u", isExcluded: true, excludedAt: null, excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "" } };
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts, overrides }, deps);
    expect(summary.selected).toBe(0);
  });

  it("records a missing start point as a slow-retry failure and fabricates nothing", async () => {
    const deps = makeDeps({ getStartPoint: vi.fn(async () => null) });
    const { summary, ledger } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary.noStartPoint).toBe(1);
    expect(deps.fetchWeather).not.toHaveBeenCalled();
    expect(deps.saveIfAbsent).not.toHaveBeenCalled();
    expect(ledger.entries.a).toMatchObject({ kind: "no-start-point", failures: 1 });
  });

  it("treats a (0,0) coordinate as missing GPS", async () => {
    const deps = makeDeps({ getStartPoint: vi.fn(async () => ({ lat: 0, lng: 0 })) });
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary.noStartPoint).toBe(1);
    expect(deps.fetchWeather).not.toHaveBeenCalled();
  });

  it("an unavailable provider slot is not saved and backs off", async () => {
    const deps = makeDeps({ fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => ({ status: "unavailable" })) });
    const { summary, ledger } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary.unavailable).toBe(1);
    expect(deps.saveIfAbsent).not.toHaveBeenCalled();
    expect(ledger.entries.a.failures).toBe(1);
  });

  it("a failed request backs off; the next pass honors the cooldown", async () => {
    const deps = makeDeps({ fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => ({ status: "error" })) });
    const first = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(first.summary.failed).toBe(1);
    const again = await runWeatherBackfillPass({ ...base(), ledger: first.ledger, workouts: [run("a", 1)] }, deps);
    expect(again.summary.selected).toBe(0);
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 stops the pass immediately and pauses the provider", async () => {
    const deps = makeDeps({ fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => ({ status: "rate-limited" })) });
    const workouts = [run("a", 1), run("b", 2), run("c", 3)];
    const { summary, ledger } = await runWeatherBackfillPass({ ...base(), workouts }, deps);
    expect(summary.rateLimited).toBe(true);
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
    expect(ledger.pausedUntil).toBeGreaterThan(NOW);
    const next = await runWeatherBackfillPass({ ...base(), ledger, workouts }, deps);
    expect(next.summary.selected).toBe(0);
  });

  it("never replaces existing weather: a snapshot that appeared meanwhile is preserved", async () => {
    const deps = makeDeps({ saveIfAbsent: vi.fn(async () => "preserved" as const) });
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary).toMatchObject({ preserved: 1, saved: 0 });
  });

  it("a failed write backs off instead of throwing", async () => {
    const deps = makeDeps({ saveIfAbsent: vi.fn(async () => { throw new Error("permission-denied"); }) });
    const { summary, ledger } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary.failed).toBe(1);
    expect(ledger.entries.a).toBeDefined();
  });

  it("a thrown route read is contained", async () => {
    const deps = makeDeps({ getStartPoint: vi.fn(async () => { throw new Error("boom"); }) });
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, deps);
    expect(summary.failed).toBe(1);
  });

  it("stops without writing when the session is retired mid-pass (cancellation)", async () => {
    let current = true;
    const deps = makeDeps({
      fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => { current = false; return { status: "ok", weather: SNAP }; }),
    });
    const { summary } = await runWeatherBackfillPass({ ...base(), isCurrent: () => current, workouts: [run("a", 1), run("b", 2)] }, deps);
    expect(summary.cancelled).toBe(true);
    expect(deps.saveIfAbsent).not.toHaveBeenCalled();
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("stops on an aborted signal and treats an aborted fetch as cancellation, not failure", async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      fetchWeather: vi.fn(async (): Promise<WeatherFetchResult> => ({ status: "aborted" })),
    });
    const { summary, ledger } = await runWeatherBackfillPass({ ...base(), signal: controller.signal, workouts: [run("a", 1)] }, deps);
    expect(summary.cancelled).toBe(true);
    expect(Object.keys(ledger.entries)).toHaveLength(0);

    controller.abort();
    const afterAbort = await runWeatherBackfillPass({ ...base(), signal: controller.signal, workouts: [run("a", 1)] }, makeDeps());
    expect(afterAbort.summary.cancelled).toBe(true);
    expect(afterAbort.summary.selected).toBe(0);
  });

  it("skips a workout another caller (Run Detail) already owns, then releases claims", async () => {
    expect(claimWeatherWork("owned")).toBe(true);
    const deps = makeDeps();
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("owned", 1), run("free", 2)] }, deps);
    expect(summary.selected).toBe(1);
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
    expect(claimWeatherWork("free")).toBe(true); // released after the pass
    releaseWeatherWork("free");
    releaseWeatherWork("owned");
  });

  it("concurrent passes never fetch the same workout twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps = makeDeps({
      getStartPoint: vi.fn(async () => { await gate; return { lat: 40.7, lng: -74 }; }),
    });
    const workouts = [run("dup", 1)];
    const a = runWeatherBackfillPass({ ...base(), workouts }, deps);
    const b = runWeatherBackfillPass({ ...base(), workouts }, deps);
    release();
    await Promise.all([a, b]);
    expect(deps.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("ledger entries survive across the cooldown boundary", async () => {
    const ledger = recordWeatherFailure(EMPTY_WEATHER_LEDGER, "a", "transient", NOW - 2 * 3_600_000);
    const deps = makeDeps();
    const { summary } = await runWeatherBackfillPass({ ...base(), ledger, workouts: [run("a", 1)] }, deps);
    expect(summary.saved).toBe(1); // 1h cooldown elapsed
  });

  it("output contains counts only — no coordinates", async () => {
    const { summary } = await runWeatherBackfillPass({ ...base(), workouts: [run("a", 1)] }, makeDeps());
    expect(JSON.stringify(summary)).not.toMatch(/40\.7|-74|lat|lng/);
  });
});
