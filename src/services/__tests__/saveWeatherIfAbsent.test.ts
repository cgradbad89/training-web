import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase", () => ({ db: {} }));

let stored: Record<string, unknown> | null = null;
const txSet = vi.fn();

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => ({ args }),
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: async () => ({ exists: () => stored !== null, data: () => stored }),
      set: (...args: unknown[]) => txSet(...args),
    }),
  collection: vi.fn(), getDocs: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(), onSnapshot: vi.fn(),
  query: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn(), writeBatch: vi.fn(),
}));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: vi.fn() }));
vi.mock("@/services/hrStream", () => ({ fetchHRStream: vi.fn() }));

import { saveWeatherForWorkoutIfAbsent } from "@/services/healthWorkouts";

const SNAP = {
  tempF: 50, feelsLikeF: 48, humidity: 70, windMph: 5, dewPointF: 40,
  conditionCode: 1, conditionText: "Mainly clear", fetchedAt: "2026-11-07T15:00:00.000Z",
};

afterEach(() => { stored = null; txSet.mockClear(); });

describe("saveWeatherForWorkoutIfAbsent", () => {
  it("writes when the workout exists with no weather", async () => {
    stored = { hasRoute: true };
    expect(await saveWeatherForWorkoutIfAbsent("u", "w", SNAP)).toBe("saved");
    expect(txSet).toHaveBeenCalledTimes(1);
    expect(txSet.mock.calls[0][1]).toEqual({ weather: SNAP });
    expect(txSet.mock.calls[0][2]).toEqual({ merge: true });
  });

  it("treats explicit null weather as absent", async () => {
    stored = { weather: null };
    expect(await saveWeatherForWorkoutIfAbsent("u", "w", SNAP)).toBe("saved");
  });

  it("preserves an existing observation and its original fetchedAt", async () => {
    stored = { weather: { ...SNAP, tempF: 12, fetchedAt: "2026-06-01T00:00:00.000Z" } };
    expect(await saveWeatherForWorkoutIfAbsent("u", "w", SNAP)).toBe("preserved");
    expect(txSet).not.toHaveBeenCalled();
  });

  it("never creates a workout document that does not exist", async () => {
    stored = null;
    expect(await saveWeatherForWorkoutIfAbsent("u", "w", SNAP)).toBe("missing");
    expect(txSet).not.toHaveBeenCalled();
  });
});
