import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeStreamedTrainingLoad,
  computeTrainingLoadV2,
} from "@/utils/trainingLoad";

// ─── Firestore layer mock ────────────────────────────────────────────────────
// fetchHRStream delegates ordering to Firestore's orderBy("chunkIndex","asc"),
// so the getDocs mock sorts the supplied chunk docs by chunkIndex to faithfully
// simulate the server-side order. This lets us feed chunks OUT OF ORDER and
// assert the concatenation comes back ascending — exactly the contract.

vi.mock("@/lib/firebase", () => ({ db: {} }));

let mockChunks: Array<Record<string, unknown>> = [];

vi.mock("firebase/firestore", () => ({
  collection: (...args: unknown[]) => ({ args }),
  orderBy: (field: string, dir: string) => ({ __orderBy: field, dir }),
  query: (ref: unknown, ...constraints: unknown[]) => ({ ref, constraints }),
  getDocs: async (q: { constraints: Array<{ __orderBy?: string }> }) => {
    const ob = q.constraints.find((c) => c && c.__orderBy);
    let docs = mockChunks.map((c) => ({ data: () => c }));
    if (ob?.__orderBy) {
      const field = ob.__orderBy;
      docs = [...docs].sort(
        (a, b) =>
          (a.data()[field] as number) - (b.data()[field] as number)
      );
    }
    return { docs };
  },
}));

import { fetchHRStream } from "@/services/hrStream";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

afterEach(() => {
  mockChunks = [];
  vi.clearAllMocks();
});

describe("fetchHRStream", () => {
  it("reads chunks ascending by chunkIndex and concatenates samples in order", async () => {
    // Supplied OUT OF ORDER (chunk 1 before chunk 0) — must come back ascending.
    mockChunks = [
      {
        chunkIndex: 1,
        samples: [
          { t: ts("2024-01-01T00:00:02Z"), hr: 150 },
          { t: ts("2024-01-01T00:00:03Z"), hr: 155 },
        ],
      },
      {
        chunkIndex: 0,
        samples: [
          { t: ts("2024-01-01T00:00:00Z"), hr: 120 },
          { t: ts("2024-01-01T00:00:01Z"), hr: 130 },
        ],
      },
    ];

    const out = await fetchHRStream("uid-1", "workout-1");

    expect(out).toEqual([
      { timestamp: "2024-01-01T00:00:00.000Z", hr: 120 },
      { timestamp: "2024-01-01T00:00:01.000Z", hr: 130 },
      { timestamp: "2024-01-01T00:00:02.000Z", hr: 150 },
      { timestamp: "2024-01-01T00:00:03.000Z", hr: 155 },
    ]);
  });

  it("returns [] when the subcollection is empty/absent", async () => {
    mockChunks = [];
    const out = await fetchHRStream("uid-1", "workout-1");
    expect(out).toEqual([]);
  });
});

// ─── Convexity gain (the motivation for streamed HIIT scoring) ───────────────
// A spiky HIIT session scored over its per-sample HR integral must read HIGHER
// than the same session's avg-HR Banister, because hrr·bannisterWeight(hrr) is
// convex (Jensen): mean of f(hr_i) > f(mean hr_i).

describe("streamed HIIT convexity vs avg-HR Banister", () => {
  const MAX_HR = 185;
  const RESTING_HR = 60;
  const ACTIVITY = "highIntensityIntervalTraining";

  it("spiky alternating-HR samples yield a higher load than the avg-HR baseline", () => {
    const START = Date.parse("2024-01-01T00:00:00Z");
    const COUNT = 600; // 10 min at 1 Hz
    // Alternating high/low spikes around a 140 bpm mean.
    const samples = Array.from({ length: COUNT }, (_, i) => ({
      timestamp: new Date(START + i * 1000).toISOString(),
      hr: i % 2 === 0 ? 180 : 100,
    }));
    const durationSeconds = COUNT; // 1 Hz
    const avgHeartRate = 140; // mean of 180/100

    const streamed = computeStreamedTrainingLoad(
      samples,
      durationSeconds,
      avgHeartRate,
      MAX_HR,
      RESTING_HR,
      ACTIVITY
    );
    const avgHr = computeTrainingLoadV2(
      durationSeconds,
      avgHeartRate,
      MAX_HR,
      RESTING_HR,
      ACTIVITY
    );

    expect(streamed.method).toBe("streamed");
    expect(streamed.load).not.toBeNull();
    expect(avgHr).not.toBeNull();
    // Convexity gain: the per-sample integral credits time at high HR.
    expect(streamed.load as number).toBeGreaterThan(avgHr as number);
  });
});
