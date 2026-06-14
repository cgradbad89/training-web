import { afterEach, describe, expect, it, vi } from "vitest";

// Guards the isRunLike trap: recomputeAllTrainingLoad must recompute EVERY
// HR-bearing workout — runs AND HIIT/OTF/strength/Pilates — and skip only docs
// with no HR basis. Firestore + the subcollection fetchers are mocked so the
// test exercises selection + the verbatim computeAndStoreTrainingLoad write
// (no live Firestore, real Banister math).

vi.mock("@/lib/firebase", () => ({ db: {} }));

// Workout docs keyed by id. getDocs lists them; getDoc resolves one by id.
let dataById: Record<string, Record<string, unknown>> = {};
const setDocMock = vi.fn(() => Promise.resolve());

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => ({ id: args[args.length - 1] as string }),
  getDoc: async (ref: { id: string }) => ({
    exists: () => dataById[ref.id] != null,
    data: () => dataById[ref.id],
  }),
  getDocs: async () => ({
    docs: Object.keys(dataById).map((id) => ({ id, data: () => dataById[id] })),
  }),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  collection: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

// Not reached by avg-HR fixtures, but the module imports them.
vi.mock("@/services/routes", () => ({ fetchRoutePoints: vi.fn() }));
vi.mock("@/services/hrStream", () => ({ fetchHRStream: vi.fn() }));

import { recomputeAllTrainingLoad } from "@/services/healthWorkouts";

const avgHrDoc = (activityType: string, avgHeartRate: number | null) => ({
  activityType,
  isRunLike: activityType === "running",
  hasRoute: false,
  hasHRStream: false,
  durationSeconds: 1800,
  avgHeartRate,
});

afterEach(() => {
  dataById = {};
  vi.clearAllMocks();
});

describe("recomputeAllTrainingLoad — selects ALL activity types (no isRunLike filter)", () => {
  it("processes runs, HIIT, and strength; skips no-HR docs", async () => {
    dataById = {
      run1: avgHrDoc("running", 150),
      hiit1: avgHrDoc("highIntensityIntervalTraining", 150),
      strength1: avgHrDoc("traditional_strength_training", 120),
      nohr1: avgHrDoc("walking", null), // no HR basis → skipped
    };

    const stats = await recomputeAllTrainingLoad("uid", {
      maxHeartRate: 164,
      restingHeartRate: 60,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(stats.processed).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.fallback).toBe(3); // all avg-HR fixtures
    expect(stats.streamed).toBe(0);

    // The non-run sessions (isRunLike === false) MUST have been written — this
    // is the regression guard against re-introducing the runs-only filter.
    const writtenIds = setDocMock.mock.calls.map(
      (call) => (call[0] as { id: string }).id
    );
    expect(writtenIds).toContain("hiit1");
    expect(writtenIds).toContain("strength1");
    expect(writtenIds).toContain("run1");
    expect(writtenIds).not.toContain("nohr1");
  });

  it("writes a finite trainingLoadV2 for a HIIT session at the given anchors", async () => {
    dataById = { hiit1: avgHrDoc("highIntensityIntervalTraining", 150) };

    await recomputeAllTrainingLoad("uid", {
      maxHeartRate: 164,
      restingHeartRate: 60,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const written = setDocMock.mock.calls[0][1] as {
      trainingLoadV2: number | null;
      trainingLoadMethod: string;
    };
    expect(written.trainingLoadMethod).toBe("avg-hr-fallback");
    expect(typeof written.trainingLoadV2).toBe("number");
    expect(written.trainingLoadV2).toBeGreaterThan(0);
  });
});
