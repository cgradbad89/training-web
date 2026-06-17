import { afterEach, describe, expect, it, vi } from "vitest";

// Verifies the 3-tier method-selection in computeAndStoreTrainingLoad:
//   1. hasRoute                 → route path (UNCHANGED)   → method "streamed"
//   2. !hasRoute && hasHRStream → hrStream path            → method "streamed"
//   3. neither                  → avg-HR baseline          → method "avg-hr-fallback"
//
// Firestore reads/writes and the two subcollection fetchers are mocked so the
// test exercises only the branch selection (no live Firestore).

vi.mock("@/lib/firebase", () => ({ db: {} }));

let workoutData: Record<string, unknown> = {};
const setDocMock = vi.fn(() => Promise.resolve());

vi.mock("firebase/firestore", () => ({
  doc: (...args: unknown[]) => ({ args }),
  getDoc: async () => ({ exists: () => true, data: () => workoutData }),
  setDoc: (...args: unknown[]) => setDocMock(...args),
  // Unused by computeAndStoreTrainingLoad but imported by the module.
  collection: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const fetchRoutePointsMock = vi.fn();
const fetchHRStreamMock = vi.fn();

vi.mock("@/services/routes", () => ({
  fetchRoutePoints: (...args: unknown[]) => fetchRoutePointsMock(...args),
}));
vi.mock("@/services/hrStream", () => ({
  fetchHRStream: (...args: unknown[]) => fetchHRStreamMock(...args),
}));

import { computeAndStoreTrainingLoad } from "@/services/healthWorkouts";

const START = Date.parse("2024-01-01T00:00:00Z");
// Spiky 1 Hz HR stream — dense + long enough (20 min) to integrate to a healthy
// streamed load well above STREAMED_LOAD_COLLAPSE_THRESHOLD, so these tier-
// selection tests exercise the "streamed" path, not the collapse fallback.
const spikyStream = Array.from({ length: 1200 }, (_, i) => ({
  timestamp: new Date(START + i * 1000).toISOString(),
  hr: i % 2 === 0 ? 180 : 110,
}));

afterEach(() => {
  workoutData = {};
  vi.clearAllMocks();
});

describe("computeAndStoreTrainingLoad — 3-tier method selection", () => {
  it("tier 1: hasRoute → route path, method 'streamed' (run path unchanged)", async () => {
    workoutData = {
      hasRoute: true,
      hasHRStream: false,
      durationSeconds: 1200,
      avgHeartRate: 145,
      activityType: "running",
    };
    fetchRoutePointsMock.mockResolvedValue(
      spikyStream.map((s) => ({ timestamp: s.timestamp, hr: s.hr }))
    );

    const result = await computeAndStoreTrainingLoad("uid", "w1", null);

    expect(result?.method).toBe("streamed");
    expect(fetchRoutePointsMock).toHaveBeenCalledTimes(1);
    expect(fetchHRStreamMock).not.toHaveBeenCalled();
    // Stored method matches; route not flagged partial → basis recorded complete.
    expect(setDocMock.mock.calls[0][1]).toMatchObject({
      trainingLoadMethod: "streamed",
      trainingLoadBasisComplete: true,
    });
  });

  it("tier 2: !hasRoute && hasHRStream → hrStream path, method 'streamed'", async () => {
    workoutData = {
      hasRoute: false,
      hasHRStream: true,
      durationSeconds: 1200,
      avgHeartRate: 145,
      activityType: "highIntensityIntervalTraining",
    };
    fetchHRStreamMock.mockResolvedValue(spikyStream);

    const result = await computeAndStoreTrainingLoad("uid", "w2", null);

    expect(result?.method).toBe("streamed");
    expect(fetchHRStreamMock).toHaveBeenCalledTimes(1);
    expect(fetchRoutePointsMock).not.toHaveBeenCalled();
    expect(setDocMock.mock.calls[0][1]).toMatchObject({
      trainingLoadMethod: "streamed",
    });
  });

  it("tier 3: neither flag → avg-HR baseline, method 'avg-hr-fallback'", async () => {
    workoutData = {
      hasRoute: false,
      hasHRStream: false,
      durationSeconds: 1800,
      avgHeartRate: 150,
      activityType: "running",
    };

    const result = await computeAndStoreTrainingLoad("uid", "w3", null);

    expect(result?.method).toBe("avg-hr-fallback");
    expect(fetchRoutePointsMock).not.toHaveBeenCalled();
    expect(fetchHRStreamMock).not.toHaveBeenCalled();
    expect(setDocMock.mock.calls[0][1]).toMatchObject({
      trainingLoadMethod: "avg-hr-fallback",
    });
  });

  it("records trainingLoadBasisComplete=false for a still-syncing partial route", async () => {
    workoutData = {
      hasRoute: true,
      hasHRStream: false,
      routeComplete: false, // iOS partial route, resume pending
      durationSeconds: 5400,
      avgHeartRate: 145,
      activityType: "running",
    };
    // Mid-sync: a partial-but-SUBSTANTIAL route prefix (60 min of a 90-min run)
    // has landed. It must be substantial enough to clear the relative collapse
    // floor (PRD §6 #26: streamed ≥ 0.35× the avg-HR ref), so it stays "streamed"
    // (NOT rescued to avg-HR) and is recomputed later via the basisComplete=false
    // RECOMPUTE path. (A SEVERE partial would now be rescued to avg-hr-fallback by
    // the relative guard and ride the UPGRADE path instead — see shouldEnrichLoad.)
    fetchRoutePointsMock.mockResolvedValue(
      Array.from({ length: 3600 }, (_, i) => ({
        timestamp: new Date(START + i * 1000).toISOString(),
        hr: 145,
      }))
    );

    await computeAndStoreTrainingLoad("uid", "w5", null);

    // The basis is recorded as INCOMPLETE so a later completion recomputes once.
    expect(setDocMock.mock.calls[0][1]).toMatchObject({
      trainingLoadMethod: "streamed",
      trainingLoadBasisComplete: false,
    });
  });

  it("defensive: hasHRStream but empty stream → avg-HR fallback, no error", async () => {
    workoutData = {
      hasRoute: false,
      hasHRStream: true,
      durationSeconds: 1800,
      avgHeartRate: 150,
      activityType: "highIntensityIntervalTraining",
    };
    fetchHRStreamMock.mockResolvedValue([]); // empty despite the flag

    const result = await computeAndStoreTrainingLoad("uid", "w4", null);

    expect(result?.method).toBe("avg-hr-fallback");
    expect(fetchHRStreamMock).toHaveBeenCalledTimes(1);
    expect(setDocMock.mock.calls[0][1]).toMatchObject({
      trainingLoadMethod: "avg-hr-fallback",
    });
  });
});
