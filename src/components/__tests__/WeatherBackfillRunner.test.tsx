import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  appData: { workouts: [] as unknown[], workoutsLoading: false, trainingActivated: true, overrides: {} },
  start: vi.fn(),
  fetchWeather: vi.fn(),
  save: vi.fn(),
  epochCurrent: true,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, sessionEpoch: 1, isSessionCurrent: () => h.epochCurrent }),
}));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => h.appData }));
vi.mock("@/utils/routeCache", () => ({ getRouteStartPoint: h.start }));
vi.mock("@/lib/weather", () => ({ fetchWeatherForRunDetailed: h.fetchWeather }));
vi.mock("@/services/healthWorkouts", () => ({ saveWeatherForWorkoutIfAbsent: h.save }));

import WeatherBackfillRunner from "@/components/WeatherBackfillRunner";

const NOW = Date.parse("2026-11-07T15:00:00Z");
const SNAP = { tempF: 50, feelsLikeF: 48, humidity: 70, windMph: 5, dewPointF: 40, conditionCode: 1, conditionText: "Mainly clear", fetchedAt: "x" };

function run(id: string, daysAgo: number, patch: Partial<HealthWorkout> = {}) {
  const s = NOW - daysAgo * 86_400_000;
  return { workoutId: id, displayType: "Run", isRunLike: true, hasRoute: true, startDate: new Date(s), endDate: new Date(s + 2_700_000), weather: null, ...patch } as unknown as HealthWorkout;
}

let container: HTMLDivElement;
let root: Root;
let store: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  Object.defineProperty(window, "localStorage", { value: globalThis.localStorage, configurable: true });
  h.appData = { workouts: [], workoutsLoading: false, trainingActivated: true, overrides: {} };
  h.start.mockReset().mockResolvedValue({ lat: 40.7, lng: -74 });
  h.fetchWeather.mockReset().mockResolvedValue({ status: "ok", weather: SNAP });
  h.save.mockReset().mockResolvedValue("saved");
  h.epochCurrent = true;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => { root.render(<WeatherBackfillRunner />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000 + 10_000); });
}

describe("WeatherBackfillRunner", () => {
  it("fetches and saves weather for a new GPS run with no Run Detail visit", async () => {
    h.appData.workouts = [run("new", 1)];
    await mount();
    expect(h.start).toHaveBeenCalledWith("u1", "new");
    expect(h.fetchWeather).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith("u1", "new", SNAP);
  });

  it("does nothing while workouts are still loading or training is not activated", async () => {
    h.appData.workouts = [run("a", 1)];
    h.appData.workoutsLoading = true;
    await mount();
    expect(h.fetchWeather).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(container);
    h.appData.workoutsLoading = false;
    h.appData.trainingActivated = false;
    await mount();
    expect(h.fetchWeather).not.toHaveBeenCalled();
  });

  it("makes no calls when every eligible run already has weather", async () => {
    h.appData.workouts = [run("a", 1, { weather: SNAP as never })];
    await mount();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.fetchWeather).not.toHaveBeenCalled();
  });

  it("persists a failure cooldown so a reload does not retry immediately", async () => {
    h.fetchWeather.mockResolvedValue({ status: "error" });
    h.appData.workouts = [run("a", 1)];
    await mount();
    expect(h.fetchWeather).toHaveBeenCalledTimes(1);
    expect([...store.keys()].some((k) => k.startsWith("tw:weather-ledger:v1:u1"))).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    expect(h.fetchWeather).toHaveBeenCalledTimes(1);
  });

  it("works when localStorage is unavailable", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => undefined });
    Object.defineProperty(window, "localStorage", { value: globalThis.localStorage, configurable: true });
    h.appData.workouts = [run("a", 1)];
    await mount();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("stops without writing when the auth session is retired", async () => {
    h.epochCurrent = false;
    h.appData.workouts = [run("a", 1)];
    await mount();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("never exceeds the per-pass bound", async () => {
    h.appData.workouts = [1, 2, 3, 4, 5, 6].map((d) => run(`r${d}`, d));
    await mount();
    expect(h.fetchWeather).toHaveBeenCalledTimes(3);
  });

  it("logs counts only (no coordinates or ids)", async () => {
    h.appData.workouts = [run("secret-workout-id", 1)];
    await mount();
    const logged = JSON.stringify((console.info as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain("secret-workout-id");
    expect(logged).not.toMatch(/40\.7|-74/);
  });
});
