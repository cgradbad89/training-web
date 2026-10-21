import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectivePerformanceWorkout, PerformanceVersions } from "@/types/performanceAnalysis";
import { DEFAULT_PERFORMANCE_QUALITY_POLICY as policy } from "@/utils/aerobicPerformance";

const state = vi.hoisted(() => ({
  route: [] as Record<string, unknown>[],
  hr: [] as Record<string, unknown>[],
  reads: [] as { channel: string; size: number; start: number }[],
  afterRead: null as (() => void) | null,
  failure: null as Error | null,
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: (...path: unknown[]) => ({ channel: path[path.length - 1] }),
  documentId: () => "__name__",
  orderBy: (field: string) => ({ field }),
  limit: (size: number) => ({ size }),
  startAfter: (doc: { ordinal: number }) => ({ start: doc.ordinal + 1 }),
  query: (ref: { channel: string }, ...constraints: { size?: number; start?: number }[]) => ({ ref, constraints }),
  getDocsFromServer: async (q: { ref: { channel: string }; constraints: { size?: number; start?: number }[] }) => {
    const channel = q.ref.channel;
    const size = q.constraints.find(value => value.size !== undefined)!.size!;
    const start = q.constraints.find(value => value.start !== undefined)?.start ?? 0;
    state.reads.push({ channel, size, start });
    if (state.failure) throw state.failure;
    const source = channel === "route" ? state.route : state.hr;
    const docs = source.slice(start, start + size).map((value, index) => ({ ordinal: start + index, data: () => value }));
    state.afterRead?.();
    return { docs };
  },
  // If extraction accidentally enters an existing UI/cache path, fail visibly.
  getDocs: () => { throw new Error("Cached/default getDocs must not be used"); },
}));

import {
  createPerformanceReadBudget, extractFreshWorkoutPerformance, PerformanceReadBudgetExceededError,
  type PerformanceTelemetrySource,
} from "@/services/performanceTelemetry";

const started = Date.parse("2026-10-18T12:00:00Z");
const asOf = "2026-10-21T14:00:00Z";
const versions: PerformanceVersions = { schema: 1, model: "manual-performance-v1", extractor: "steady-interval-v1", qualityPolicy: policy.version };
const ts = (seconds: number) => ({ toDate: () => new Date(started + seconds * 1000) });
function route(count = 361, hr: number | null = 147): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    index, lat: 0, lng: (index * 15 / 6_371_000) * 180 / Math.PI,
    timestamp: ts(index * 5), hr, speed: 3,
  }));
}
function workout(overrides: Partial<EffectivePerformanceWorkout> = {}): EffectivePerformanceWorkout {
  return {
    workoutId: "run-1", startedAt: new Date(started).toISOString(), endedAt: new Date(started + 1800_000).toISOString(),
    availableAt: null, completion: "completed", excluded: false, isRun: true, runKind: "outdoor", distanceMeters: 5400,
    durationSeconds: 1800, averageHrBpm: 190, ascentMeters: 20,
    environment: { temperatureF: 60, dewPointF: 45, windMph: 3 }, parentDigest: "parent-1",
    telemetry: { state: "unknown", verification: "unverified", contentDigest: null },
    provenance: { source: "synthetic", sourceId: "run-1", notes: [] }, limitations: [], ...overrides,
  };
}
function extract(options: {
  workout?: Partial<EffectivePerformanceWorkout>; source?: Partial<PerformanceTelemetrySource>;
  budget?: ReturnType<typeof createPerformanceReadBudget>; assertSession?: () => void;
} = {}) {
  return extractFreshWorkoutPerformance({
    uid: "owner", workout: workout(options.workout), source: { hasRoute: true, routeComplete: true, routePointCount: state.route.length, ...options.source },
    asOf, extractedAt: asOf, versions, policy, budget: options.budget ?? createPerformanceReadBudget(), assertSession: options.assertSession ?? (() => {}),
  });
}
afterEach(() => { state.route = []; state.hr = []; state.reads = []; state.afterRead = null; state.failure = null; });

describe("manual fresh performance telemetry", () => {
  it("paginates fresh server reads and emits deterministic compact position-derived features", async () => {
    state.route = route();
    const first = await extract();
    const second = await extract();
    expect(first).toEqual(second);
    expect(first.feature.status).toBe("accepted");
    expect(first.feature.observations).toHaveLength(1);
    expect(first.feature.observations[0]).toMatchObject({ medianHrBpm: 147, windowCount: 2 });
    expect(first.feature.observations[0].medianSpeedMps).toBeCloseTo(3);
    expect(first.reads).toEqual({ routeDocuments: 361, hrDocuments: 0, totalDocuments: 361 });
    expect(state.reads.slice(0, 2)).toEqual([{ channel: "route", size: 250, start: 0 }, { channel: "route", size: 250, start: 250 }]);
    expect(first.feature.quality.sourceSampleCount).toBe(361);
    expect(JSON.stringify(first.feature)).not.toMatch(/"lat"|"lng"|"samples"|"intervals"|"timestamp"/);
    expect(first.feature.limitations).toContain("fresh_server_reads_verify_supplied_content_not_an_immutable_source_generation");
  });

  it("always rereads child evidence for forced extraction even when parent inputs did not change", async () => {
    state.route = route();
    const first = await extract();
    state.route = route(361, 162);
    const reprocessed = await extract();
    expect(reprocessed.workout.parentDigest).toBe(first.workout.parentDigest);
    expect(reprocessed.feature.telemetryDigest).not.toBe(first.feature.telemetryDigest);
    expect(reprocessed.feature.observations[0].medianHrBpm).toBe(162);
    expect(state.reads).toHaveLength(4);
  });

  it("uses route HR without reading duplicate HR chunks", async () => {
    state.route = route();
    state.hr = [{ chunkIndex: 0, samples: [{ t: ts(0), hr: 190 }] }];
    const result = await extract({ source: { hasHRStream: true } });
    expect(result.source.hrSource).toBe("route");
    expect(state.reads.every(value => value.channel === "route")).toBe(true);
  });

  it("fills missing route HR only from time-nearby fresh chunks even with a missing availability flag", async () => {
    state.route = route(361, null);
    state.hr = [{ chunkIndex: 0, samples: Array.from({ length: 361 }, (_, index) => ({ t: ts(index * 5), hr: 147 })) }];
    const result = await extract({ source: { hasHRStream: false } });
    expect(result.feature.status).toBe("accepted");
    expect(result.source).toMatchObject({ hrSource: "hrStream", hrSampleCount: 361 });
    expect(result.reads).toEqual({ routeDocuments: 361, hrDocuments: 1, totalDocuments: 362 });
  });

  it("does not extrapolate an isolated HR reading across the workout", async () => {
    state.route = route(361, null);
    state.hr = [{ chunkIndex: 0, samples: [{ t: ts(900), hr: 147 }] }];
    const result = await extract();
    expect(result.feature.status).toBe("unresolved");
    expect(result.feature.observations).toEqual([]);
    expect(result.feature.reasons).toContain("insufficient_measured_hr_coverage");
  });

  it("keeps an absent HR stream unresolved rather than treating route completion as HR completeness", async () => {
    state.route = route(361, null);
    const result = await extract();
    expect(result.feature.status).toBe("unresolved");
    expect(result.source.measuredHrCoverageFraction).toBe(0);
    expect(state.reads.at(-1)?.channel).toBe("hrStream");
  });

  it("skips raw reads for explicitly pending, invalid, excluded and unsupported workouts", async () => {
    state.route = route();
    const pending = await extract({ source: { routeComplete: false } });
    expect(pending.workout.telemetry.state).toBe("pending");
    expect(pending.feature.status).toBe("unresolved");
    for (const changes of [{ runKind: "treadmill" as const }, { excluded: true }, { durationSeconds: 1200 }, { distanceMeters: 10 }, { completion: "unknown" as const }]) {
      const result = await extract({ workout: changes });
      expect(result.feature.status).not.toBe("accepted");
    }
    expect(state.reads).toEqual([]);
  });

  it("checks actual count and measured coverage, while preserving missing legacy-marker limitations", async () => {
    state.route = route();
    const mismatch = await extract({ source: { routePointCount: 362 } });
    expect(mismatch.feature.status).toBe("unresolved");
    expect(mismatch.feature.limitations).toContain("route_point_count_mismatch");
    const legacy = await extract({ source: { routeComplete: undefined, routePointCount: undefined } });
    expect(legacy.feature.status).toBe("accepted");
    expect(legacy.feature.limitations).toContain("legacy_route_completion_marker_absent_measured_coverage_only");
    state.route = route(200);
    expect((await extract()).feature.status).toBe("unresolved");
  });

  it.each([
    ["nonfinite coordinates", { lat: NaN }],
    ["nonfinite reported speed", { speed: Infinity }],
    ["invalid timestamp", { timestamp: { toDate: () => new Date(NaN) } }],
    ["duplicate route index", { index: 0 }],
    ["duplicate timestamp", { timestamp: ts(0) }],
  ])("rejects %s without hashing nonfinite evidence or publishing observations", async (_name, patch) => {
    state.route = route();
    state.route[1] = { ...state.route[1], ...patch };
    const result = await extract();
    expect(result.feature.status).not.toBe("accepted");
    expect(result.feature.observations).toEqual([]);
    expect(result.workout.telemetry.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps segments grouped under one independent workout identifier", async () => {
    state.route = route(481);
    const result = await extract({ workout: { endedAt: new Date(started + 2400_000).toISOString(), durationSeconds: 2400, distanceMeters: 7200 } });
    expect(result.feature.workoutId).toBe("run-1");
    expect(result.feature.observations).toHaveLength(1);
    expect(result.feature.observations[0].windowCount).toBe(3);
  });

  it("counts returned documents across workouts and throws with an explicit higher-budget retry", async () => {
    state.route = route();
    const budget = createPerformanceReadBudget(500);
    await extract({ budget });
    await expect(extract({ budget })).rejects.toMatchObject({
      code: "performance/read-budget-exceeded", limit: 500, documentsRead: 500, workoutId: "run-1", suggestedLimit: 1000,
    });
    expect(budget.documentsRead).toBe(500);
    expect(state.reads.at(-1)).toEqual({ channel: "route", size: 139, start: 0 });
  });

  it("stops conservatively on an exactly full last budget page without silently truncating", async () => {
    state.route = route(250);
    const budget = createPerformanceReadBudget(250);
    await expect(extract({ budget })).rejects.toBeInstanceOf(PerformanceReadBudgetExceededError);
    expect(state.reads).toHaveLength(1);
    expect(budget.documentsRead).toBe(250);
  });

  it("handles a full page followed by an empty exhaustion proof without charging query count as documents", async () => {
    state.route = route(250);
    const budget = createPerformanceReadBudget(251);
    const result = await extract({ budget });
    expect(result.reads.totalDocuments).toBe(250);
    expect(budget.documentsRead).toBe(250);
    expect(state.reads).toHaveLength(2);
  });

  it("counts completed reads and aborts before the next page when session ownership changes", async () => {
    state.route = route();
    let active = true;
    const budget = createPerformanceReadBudget();
    state.afterRead = () => { active = false; };
    await expect(extract({ budget, assertSession: () => { if (!active) throw new Error("Session changed"); } })).rejects.toThrow("Session changed");
    expect(budget.documentsRead).toBe(250);
    expect(state.reads).toHaveLength(1);
  });

  it("propagates network and permission failures without manufacturing absent evidence", async () => {
    for (const failure of [new Error("permission-denied"), new Error("unavailable")]) {
      state.failure = failure;
      await expect(extract()).rejects.toBe(failure);
    }
  });

  it("validates budgets and authenticated path segments before reads", async () => {
    expect(createPerformanceReadBudget().limit).toBe(5000);
    for (const value of [0, -1, NaN, Infinity, 1.5, 100001]) expect(() => createPerformanceReadBudget(value)).toThrow();
    await expect(extract({ workout: { workoutId: "../other" } })).rejects.toThrow("Invalid authenticated telemetry identity");
    expect(state.reads).toEqual([]);
  });
});
