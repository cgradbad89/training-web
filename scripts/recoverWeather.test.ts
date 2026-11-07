/**
 * Unit tests always run (fake dependencies, no network, no Firestore).
 * The live entry is SKIPPED unless RECOVER is set — see scripts/recoverWeather.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import {
  RECOVER_DEFAULT_MAX,
  RECOVER_HARD_MAX,
  createAdminRecoveryDeps,
  resolveRecoveryCap,
  runWeatherRecovery,
  type RecoveryDeps,
} from "./recoverWeather";

const NOW = Date.parse("2026-11-07T15:00:00Z");
const DAY = 86_400_000;
const SNAP = { tempF: 50, feelsLikeF: 48, humidity: 70, windMph: 5, dewPointF: 40, conditionCode: 1, conditionText: "x", fetchedAt: "2026-11-07T15:00:00.000Z" };

function run(id: string, daysAgo: number, patch: Partial<HealthWorkout> = {}): HealthWorkout {
  const s = NOW - daysAgo * DAY;
  return { workoutId: id, displayType: "Run", isRunLike: true, hasRoute: true, startDate: new Date(s), endDate: new Date(s + 2_700_000), weather: null, ...patch } as HealthWorkout;
}

function deps(workouts: HealthWorkout[], patch: Partial<RecoveryDeps> = {}) {
  const d = {
    loadWorkouts: vi.fn(async () => workouts),
    getStartPoint: vi.fn(async () => ({ lat: 40.7, lng: -74 })),
    fetchWeather: vi.fn(async () => ({ status: "ok" as const, weather: SNAP })),
    saveIfAbsent: vi.fn(async () => "saved" as const),
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    ...patch,
  };
  return d;
}

describe("weather recovery", () => {
  const history = [run("a", 100), run("b", 200), run("c", 300), run("has", 150, { weather: SNAP as never })];

  it("dry-run reads parents only: no route reads, no API calls, no writes", async () => {
    const d = deps(history);
    const report = await runWeatherRecovery(d, { commit: false });
    expect(report.mode).toBe("DRY-RUN");
    expect(report.plan).toMatchObject({ requiresExplicitRecovery: 3, alreadyHaveWeather: 1 });
    expect(report.attempted).toBe(0);
    expect(d.getStartPoint).not.toHaveBeenCalled();
    expect(d.fetchWeather).not.toHaveBeenCalled();
    expect(d.saveIfAbsent).not.toHaveBeenCalled();
  });

  it("commit is bounded by the cap and never touches runs that have weather", async () => {
    const d = deps(history);
    const report = await runWeatherRecovery(d, { commit: true, max: 2 });
    expect(report).toMatchObject({ attempted: 2, saved: 2 });
    expect(d.saveIfAbsent.mock.calls.map((c) => c[0])).toEqual(["a", "b"]); // newest first
  });

  it("an existing snapshot found at write time is preserved, not replaced", async () => {
    const d = deps(history, { saveIfAbsent: vi.fn(async () => "preserved" as const) });
    expect((await runWeatherRecovery(d, { commit: true })).preserved).toBe(3);
  });

  it("stops at the first rate limit", async () => {
    const d = deps(history, { fetchWeather: vi.fn(async () => ({ status: "rate-limited" as const })) });
    const report = await runWeatherRecovery(d, { commit: true });
    expect(report.stoppedForRateLimit).toBe(true);
    expect(d.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("counts missing GPS, unavailable slots and failures separately", async () => {
    const start = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ lat: 40, lng: -74 })
      .mockRejectedValueOnce(new Error("x"));
    const fetchWeather = vi.fn(async () => ({ status: "unavailable" as const }));
    const report = await runWeatherRecovery(deps(history, { getStartPoint: start, fetchWeather }), { commit: true });
    expect(report).toMatchObject({ attempted: 3, noStartPoint: 1, unavailable: 1, failed: 1, saved: 0 });
  });

  it("clamps the cap", () => {
    expect(resolveRecoveryCap(undefined)).toBe(RECOVER_DEFAULT_MAX);
    expect(resolveRecoveryCap(NaN)).toBe(RECOVER_DEFAULT_MAX);
    expect(resolveRecoveryCap(0)).toBe(RECOVER_DEFAULT_MAX);
    expect(resolveRecoveryCap(5000)).toBe(RECOVER_HARD_MAX);
    expect(resolveRecoveryCap(7.9)).toBe(7);
  });

  it("the report has no coordinates or workout ids", async () => {
    const report = await runWeatherRecovery(deps(history), { commit: true });
    expect(JSON.stringify(report)).not.toMatch(/40\.7|-74|"a"|lat|lng/);
  });
});

const MODE = process.env.RECOVER;
it.skipIf(!MODE)("LIVE: weather recovery (dry-run unless RECOVER=commit)", async () => {
  const live = await createAdminRecoveryDeps(process.env.RECOVER_UID);
  const report = await runWeatherRecovery(live, { commit: MODE === "commit", max: Number(process.env.RECOVER_MAX) || undefined });
  console.log("[recoverWeather]", JSON.stringify(report, null, 2));
}, 900_000);
