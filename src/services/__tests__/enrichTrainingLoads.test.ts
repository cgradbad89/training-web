import { afterEach, describe, expect, it, vi } from "vitest";

// enrichTrainingLoads must select EXACTLY the workouts shouldEnrichLoad flags
// (store-when-missing + upgrade-avg-to-streamed), call the writer once per match
// regardless of isRunLike (HIIT + strength included), and skip the rest. Firestore
// and the two subcollection fetchers are mocked; the REAL computeAndStoreTrainingLoad
// writer runs against the mocked per-id doc data (verbatim — no new math).

let docData: Record<string, Record<string, unknown>> = {};
let streamData: Record<string, { timestamp: string; hr: number }[]> = {};
const setDocMock = vi.fn(() => Promise.resolve());

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => ({ id: args[args.length - 1] as string }),
  getDoc: async (ref: { id: string }) => ({
    exists: () => docData[ref.id] !== undefined,
    data: () => docData[ref.id],
  }),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  collection: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@/services/routes", () => ({
  fetchRoutePoints: async () => [],
}));
vi.mock("@/services/hrStream", () => ({
  fetchHRStream: async (_uid: string, id: string) => streamData[id] ?? [],
}));

import { enrichTrainingLoads } from "@/services/healthWorkouts";
import { type HealthWorkout } from "@/types/healthWorkout";

const mk = (p: Partial<HealthWorkout>): HealthWorkout => p as HealthWorkout;

const START = Date.parse("2024-01-01T00:00:00Z");
// Dense 1 Hz stream — enough to engage the streamed integral (→ "streamed").
const denseStream = Array.from({ length: 120 }, (_, i) => ({
  timestamp: new Date(START + i * 1000).toISOString(),
  hr: i % 2 === 0 ? 180 : 110,
}));

afterEach(() => {
  docData = {};
  streamData = {};
  vi.clearAllMocks();
});

/** A mixed run + non-run list spanning every shouldEnrichLoad outcome. */
function seedMixedList(): HealthWorkout[] {
  docData = {
    "store-route-run": {
      hasRoute: true,
      durationSeconds: 1800,
      avgHeartRate: 150,
      activityType: "running",
    },
    "store-hiit-stream": {
      hasHRStream: true,
      durationSeconds: 1800,
      avgHeartRate: 160,
      activityType: "high_intensity_interval_training",
    },
    "store-strength-avg": {
      durationSeconds: 1800,
      avgHeartRate: 120,
      activityType: "traditional_strength_training",
    },
    "upgrade-to-stream": {
      hasHRStream: true,
      durationSeconds: 1800,
      avgHeartRate: 150,
      activityType: "high_intensity_interval_training",
    },
  };
  streamData = { "upgrade-to-stream": denseStream };

  return [
    // skip — already streamed
    mk({
      workoutId: "stored-streamed",
      isRunLike: true,
      hasRoute: true,
      trainingLoadV2: 100,
      trainingLoadMethod: "streamed",
    }),
    // STORE — run with a route, no stored load
    mk({ workoutId: "store-route-run", isRunLike: true, hasRoute: true }),
    // STORE — HIIT (non-run) with a stream, no stored load
    mk({ workoutId: "store-hiit-stream", isRunLike: false, hasHRStream: true }),
    // STORE — strength (non-run) with only an avg HR
    mk({ workoutId: "store-strength-avg", isRunLike: false, avgHeartRate: 120 }),
    // skip — no HR basis yet (settling → stays "—")
    mk({ workoutId: "pending-no-hr", isRunLike: false, avgHeartRate: null }),
    // UPGRADE — stored avg-HR, stream has since arrived
    mk({
      workoutId: "upgrade-to-stream",
      isRunLike: false,
      hasHRStream: true,
      trainingLoadV2: 30,
      trainingLoadMethod: "avg-hr-fallback",
    }),
  ];
}

describe("enrichTrainingLoads — selects and writes only the matching subset", () => {
  it("writes exactly the store + upgrade matches; skips streamed and no-HR", async () => {
    const count = await enrichTrainingLoads("uid", seedMixedList(), null);

    expect(count).toBe(4);
    expect(setDocMock).toHaveBeenCalledTimes(4);

    const writtenIds = setDocMock.mock.calls.map(
      (c) => (c[0] as { id: string }).id
    );
    expect(new Set(writtenIds)).toEqual(
      new Set([
        "store-route-run",
        "store-hiit-stream",
        "store-strength-avg",
        "upgrade-to-stream",
      ])
    );
    expect(writtenIds).not.toContain("stored-streamed");
    expect(writtenIds).not.toContain("pending-no-hr");
  });

  it("includes HIIT and strength — no isRunLike filter", async () => {
    await enrichTrainingLoads("uid", seedMixedList(), null);
    const writtenIds = setDocMock.mock.calls.map(
      (c) => (c[0] as { id: string }).id
    );
    expect(writtenIds).toContain("store-hiit-stream");
    expect(writtenIds).toContain("store-strength-avg");
  });

  it("upgrade: avg-hr-fallback + arrived hrStream → re-stored as 'streamed'", async () => {
    await enrichTrainingLoads("uid", seedMixedList(), null);
    const call = setDocMock.mock.calls.find(
      (c) => (c[0] as { id: string }).id === "upgrade-to-stream"
    );
    expect(call?.[1]).toMatchObject({ trainingLoadMethod: "streamed" });
  });

  it("returns 0 and writes nothing for an empty or all-converged list", async () => {
    expect(await enrichTrainingLoads("uid", [], null)).toBe(0);

    const converged = [
      mk({
        workoutId: "a",
        trainingLoadV2: 50,
        trainingLoadMethod: "streamed",
        hasHRStream: true,
      }),
      mk({
        workoutId: "b",
        trainingLoadV2: 20,
        trainingLoadMethod: "avg-hr-fallback",
        avgHeartRate: 130,
      }),
      mk({ workoutId: "c", avgHeartRate: null }),
    ];
    expect(await enrichTrainingLoads("uid", converged, null)).toBe(0);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});
