import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { EffectivePerformanceWorkout, PerformanceAnalysisInput } from "@/types/performanceAnalysis";
import type { PerformancePublicationInput, PerformanceSession, StoredPerformanceFeature } from "@/types/performancePersistence";
import { DEFAULT_PERFORMANCE_QUALITY_POLICY, extractWorkoutPerformanceFeature } from "@/utils/aerobicPerformance";
import { calculatePerformanceAnalysis, buildPerformanceSnapshotPayload, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS } from "@/utils/performanceAnalysis";
import { hashPerformanceValue } from "@/utils/performanceEvidence";

const h = vi.hoisted(() => ({
  currentUser: null as User | null, records: new Map<string, unknown>(),
  getToken: vi.fn(), reads: [] as string[], failBeforeCommit: false, loseAcknowledgement: false,
  onRead: null as ((path: string) => void) | null,
}));
vi.mock("@/lib/firebase", () => ({ auth: { get currentUser() { return h.currentUser; } }, db: {} }));
vi.mock("firebase/auth", () => ({ getIdTokenResult: (...args: unknown[]) => h.getToken(...args) }));
vi.mock("firebase/firestore", () => {
  function snapshot(path: string) {
    h.reads.push(path); h.onRead?.(path);
    return { id: path.split("/").at(-1), exists: () => h.records.has(path), data: () => h.records.get(path) };
  }
  return {
    doc: (_db: unknown, ...parts: string[]) => parts.join("/"), serverTimestamp: () => "SERVER_TIMESTAMP",
    getDocFromServer: vi.fn(async (path: string) => snapshot(path)),
    runTransaction: vi.fn(async (_db: unknown, callback: (transaction: unknown) => Promise<unknown>) => {
      const writes = new Map<string, unknown>();
      const result = await callback({ get: async (path: string) => snapshot(path), set: (path: string, value: unknown) => { writes.set(path, value); } });
      if (h.failBeforeCommit) throw new Error("permission-denied");
      writes.forEach((value, path) => h.records.set(path, value));
      if (h.loseAcknowledgement) { h.loseAcknowledgement = false; throw new Error("unavailable: acknowledgement lost"); }
      return result;
    }),
  };
});
import { capturePerformanceSession, getPerformanceFeatures, getSavedPerformance, publishPerformance, savePerformanceFeature } from "@/services/performancePersistence";

const now = "2026-10-21T14:00:00.000Z";
let epoch = 1;
let session: PerformanceSession;
const owner = () => ({ uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as User);
const path = (suffix: string) => `users/owner/${suffix}`;
async function featureInput(id = "run-a") {
  const workout: EffectivePerformanceWorkout = {
    workoutId: id, startedAt: "2026-10-18T12:00:00.000Z", endedAt: "2026-10-18T12:30:00.000Z", availableAt: null,
    completion: "completed", excluded: false, isRun: true, runKind: "outdoor", distanceMeters: 5400, durationSeconds: 1800,
    averageHrBpm: 142, ascentMeters: 0, environment: { temperatureF: null, dewPointF: null, windMph: null }, parentDigest: "a".repeat(64),
    telemetry: { state: "absent", verification: "supplied_content", contentDigest: "b".repeat(64) },
    provenance: { source: "test", sourceId: id, notes: [] }, limitations: [],
  };
  const feature = await extractWorkoutPerformanceFeature({ workout, intervals: [], sourceSampleCount: 0, asOf: now, extractedAt: now, versions: PERFORMANCE_VERSIONS, policy: DEFAULT_PERFORMANCE_QUALITY_POLICY });
  return { workout, feature };
}
async function publication(features: StoredPerformanceFeature[] = [], expectedCurrentRevision: number | null = null, marker = "a"): Promise<PerformancePublicationInput> {
  const input: PerformanceAnalysisInput = {
    asOf: now, timeZone: "America/New_York", workouts: features.map(f => f.workout), features: features.map(f => f.feature), linkedRaces: [], deviceVo2: [],
    versions: PERFORMANCE_VERSIONS, ...PERFORMANCE_DEFAULTS, qualityPolicy: DEFAULT_PERFORMANCE_QUALITY_POLICY,
    coverage: { window: { startDate: "2026-04-25", endDate: "2026-10-21" }, workouts: "partial", telemetry: "partial", deviceVo2: "unknown", expectedWorkoutCount: null, limitations: [] },
  };
  const result = await calculatePerformanceAnalysis(input);
  return { payload: buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: now, calculationCompletedAt: now, provenance: [] }), publicationDigest: await hashPerformanceValue(marker), expectedCurrentRevision, features };
}
beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "true");
  h.records.clear(); h.reads = []; h.failBeforeCommit = false; h.loseAcknowledgement = false; h.onRead = null;
  epoch = 1; h.currentUser = owner();
  h.getToken.mockResolvedValue({ claims: { sub: "owner", email: "folstromjohn@gmail.com", email_verified: true } });
  session = await capturePerformanceSession({ user: h.currentUser, sessionEpoch: epoch, isSessionCurrent: candidate => candidate === epoch });
});

describe("owner session and production-disabled write gate", () => {
  it("requires the current verified owner identity and refreshed owner token", async () => {
    expect(h.getToken).toHaveBeenCalledWith(h.currentUser, true);
    h.currentUser = { ...owner(), emailVerified: false } as User;
    await expect(capturePerformanceSession({ user: h.currentUser, sessionEpoch: 1, isSessionCurrent: () => true })).rejects.toThrow("session changed");
  });
  it("rejects an authenticated non-owner and never derives a writable UID from a caller", async () => {
    h.currentUser = { ...owner(), uid: "stranger", email: "stranger@example.com" } as User;
    await expect(getSavedPerformance({ ...session, uid: "stranger" })).rejects.toThrow("session changed");
    expect(h.reads).toHaveLength(0);
  });
  it("rejects a token whose verified owner claims do not match", async () => {
    h.getToken.mockResolvedValue({ claims: { sub: "owner", email: "folstromjohn@gmail.com", email_verified: false } });
    await expect(capturePerformanceSession({ user: h.currentUser!, sessionEpoch: 1, isSessionCurrent: () => true })).rejects.toThrow("verified Training Web owner");
  });
  it("invalidates work after same-UID logout/login even if the User object is reused", async () => {
    epoch += 1;
    await expect(getSavedPerformance(session)).rejects.toThrow("session changed");
    await expect(publishPerformance(session, await publication())).rejects.toThrow("session changed");
  });
  it("allows saved-result reads with gate off but cannot write features or publish", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "false");
    expect(await getSavedPerformance(session)).toEqual({ current: null, documentsRead: 1 });
    await expect(savePerformanceFeature(session, await featureInput(), null)).rejects.toThrow("disabled");
    await expect(publishPerformance(session, await publication())).rejects.toThrow("disabled");
    expect(h.records.size).toBe(0);
  });
  it("invalidates an in-flight read when the account changes", async () => {
    h.onRead = () => { h.currentUser = null; };
    await expect(getSavedPerformance(session)).rejects.toThrow("session changed");
  });
});

describe("bounded reusable feature receipts", () => {
  it("reads only requested feature records and counts missing document reads", async () => {
    await savePerformanceFeature(session, await featureInput(), null);
    h.reads = [];
    const result = await getPerformanceFeatures(session, ["run-a", "missing", "run-a"]);
    expect(result.features.map(f => f.workoutId)).toEqual(["run-a"]);
    expect(result.documentsRead).toBe(2);
    expect(h.reads).toEqual([path("performanceFeatures/run-a"), path("performanceFeatures/missing")]);
  });
  it("refuses a historical backfill beyond the explicit feature limit", async () => {
    await expect(getPerformanceFeatures(session, Array.from({ length: 301 }, (_, i) => String(i)))).rejects.toThrow("at most 300");
    expect(h.reads).toHaveLength(0);
  });
  it("deduplicates semantic extraction repeats despite a later extraction timestamp", async () => {
    const input = await featureInput();
    const first = await savePerformanceFeature(session, input, null);
    const second = await savePerformanceFeature(session, { ...input, feature: { ...input.feature, extractedAt: "2026-10-21T15:00:00.000Z" } }, null);
    expect(second).toEqual(first); expect(second.revision).toBe(1);
  });
  it("increments feature revision only with the expected prior receipt", async () => {
    const input = await featureInput();
    await savePerformanceFeature(session, input, null);
    const second = await savePerformanceFeature(session, { ...input, feature: { ...input.feature, limitations: ["updated"] } }, 1);
    expect(second.revision).toBe(2);
  });
  it("rejects stale feature writes and preserves existing evidence", async () => {
    const input = await featureInput();
    const saved = await savePerformanceFeature(session, input, null);
    await expect(savePerformanceFeature(session, { ...input, feature: { ...input.feature, limitations: ["changed"] } }, null)).rejects.toThrow("changed in another");
    expect(h.records.get(path("performanceFeatures/run-a"))).toEqual(saved);
  });
  it("rejects a forged extraction basis and invalid workout path", async () => {
    const input = await featureInput();
    await expect(savePerformanceFeature(session, { ...input, workout: { ...input.workout, distanceMeters: 9 } }, null)).rejects.toThrow("extraction basis");
    await expect(getPerformanceFeatures(session, ["../other"])).rejects.toThrow("Invalid performance workout ID");
  });
});

describe("atomic current and immutable calculation publication", () => {
  it("publishes exactly two documents, with null numerical capability and same receipt", async () => {
    const result = await publishPerformance(session, await publication());
    expect(result).toMatchObject({ snapshotCreated: true, documentsWritten: 2, documentsRead: 2 });
    expect(h.records.get(path("performanceState/current"))).toEqual(h.records.get(path(`performanceSnapshots/${result.current.snapshotId}`)));
    expect(result.current.payload.result.capability.estimatedSeconds).toBeNull();
  });
  it("deduplicates identical evidence/result after actual calculation time changes", async () => {
    const input = await publication();
    const first = await publishPerformance(session, input);
    const repeated = structuredClone(input);
    repeated.payload.calculationStartedAt = "2026-10-21T15:00:00.000Z";
    repeated.payload.calculationCompletedAt = "2026-10-21T15:00:01.000Z";
    expect(await publishPerformance(session, repeated)).toMatchObject({ snapshotCreated: false, documentsWritten: 0, current: { snapshotId: first.current.snapshotId } });
    expect(h.records.size).toBe(2);
  });
  it("supports multiple meaningful calculations on the same day and links prior receipt", async () => {
    const first = await publishPerformance(session, await publication());
    const next = await publishPerformance(session, await publication([], 1, "new evidence membership"));
    expect(next.current).toMatchObject({ revision: 2, previousSnapshotId: first.current.snapshotId });
    expect(h.records.size).toBe(3);
  });
  it("rejects concurrent stale publication without overwriting newer current", async () => {
    const first = await publishPerformance(session, await publication());
    await expect(publishPerformance(session, await publication([], null, "older in-flight"))).rejects.toThrow("changed in another");
    expect((await getSavedPerformance(session)).current?.snapshotId).toBe(first.current.snapshotId);
    expect(h.records.size).toBe(2);
  });
  it("rechecks saved feature revisions before publication, including same-publication retries", async () => {
    const feature = await savePerformanceFeature(session, await featureInput(), null);
    const input = await publication([feature]);
    await publishPerformance(session, input);
    h.records.set(path("performanceFeatures/run-a"), { ...feature, revision: 2 });
    await expect(publishPerformance(session, input)).rejects.toThrow("changed in another");
  });
  it("rejects incompatible feature versions", async () => {
    const feature = await savePerformanceFeature(session, await featureInput(), null);
    const input = await publication([feature]);
    input.features = [{ ...feature, feature: { ...feature.feature, extractorVersion: "future" } }];
    await expect(publishPerformance(session, input)).rejects.toThrow("versions do not match");
  });
  it("preserves current if a transaction fails, and permits safe retry", async () => {
    const first = await publishPerformance(session, await publication());
    const input = await publication([], 1, "changed");
    h.failBeforeCommit = true;
    await expect(publishPerformance(session, input)).rejects.toThrow("permission-denied");
    expect(h.records.size).toBe(2);
    expect((await getSavedPerformance(session)).current?.snapshotId).toBe(first.current.snapshotId);
    h.failBeforeCommit = false;
    expect((await publishPerformance(session, input)).snapshotCreated).toBe(true);
  });
  it("retries a successful transaction with lost acknowledgement without duplicate history", async () => {
    const input = await publication(); h.loseAcknowledgement = true;
    await expect(publishPerformance(session, input)).rejects.toThrow("acknowledgement lost");
    expect(h.records.size).toBe(2);
    expect((await publishPerformance(session, input)).snapshotCreated).toBe(false);
    expect(h.records.size).toBe(2);
  });
  it("aborts publication if session changes during its feature read", async () => {
    const feature = await savePerformanceFeature(session, await featureInput(), null);
    const input = await publication([feature]);
    h.onRead = read => { if (read.includes("performanceFeatures")) epoch += 1; };
    await expect(publishPerformance(session, input)).rejects.toThrow("session changed");
    expect(h.records.size).toBe(1);
  });
});
