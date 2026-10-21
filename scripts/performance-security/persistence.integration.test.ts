/** @vitest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import type { User } from "firebase/auth";
import { collection, connectFirestoreEmulator, getDocsFromServer, initializeFirestore, terminate, type Firestore } from "firebase/firestore";
import type { EffectivePerformanceWorkout } from "@/types/performanceAnalysis";
import type { PerformancePublicationInput, PerformanceSession, StoredPerformanceFeature } from "@/types/performancePersistence";
import { DEFAULT_PERFORMANCE_QUALITY_POLICY, extractWorkoutPerformanceFeature } from "@/utils/aerobicPerformance";
import { buildPerformanceSnapshotPayload, calculatePerformanceAnalysis, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS } from "@/utils/performanceAnalysis";
import { hashPerformanceValue } from "@/utils/performanceEvidence";

const h = vi.hoisted(() => ({ db: null as Firestore | null, currentUser: null as User | null }));
vi.mock("@/lib/firebase", () => ({
  get db() { return h.db; },
  auth: { get currentUser() { return h.currentUser; } },
}));
vi.mock("firebase/auth", async () => ({
  ...await vi.importActual<typeof import("firebase/auth")>("firebase/auth"),
  getIdTokenResult: async () => ({ claims: { sub: "performance-owner", email: "folstromjohn@gmail.com", email_verified: true } }),
}));
import { capturePerformanceSession, getPerformanceFeatures, getSavedPerformance, publishPerformance, savePerformanceFeature } from "@/services/performancePersistence";

const enabled = process.env.PERFORMANCE_SECURITY_EMULATOR === "1";
const projectId = "demo-training-performance";
const host = "127.0.0.1:8187";
const ownerUid = "performance-owner";
const asOf = "2026-10-21T14:00:00.000Z";
let app: FirebaseApp;
let session: PerformanceSession;
let epoch = 1;

async function extracted(workoutId = "sdk-run-a", speedMps = 3) {
  const intervals = Array.from({ length: 180 }, (_, index) => ({ startSeconds: index * 10, endSeconds: (index + 1) * 10, speedMps, hrBpm: 142 }));
  const workout: EffectivePerformanceWorkout = {
    workoutId, startedAt: "2026-10-18T12:00:00.000Z", endedAt: "2026-10-18T12:30:00.000Z", availableAt: null,
    completion: "completed", excluded: false, isRun: true, runKind: "outdoor", distanceMeters: speedMps * 1800,
    durationSeconds: 1800, averageHrBpm: 142, ascentMeters: 0,
    environment: { temperatureF: 55, dewPointF: 40, windMph: 2 },
    parentDigest: await hashPerformanceValue({ workoutId, speedMps }),
    telemetry: { state: "complete", verification: "supplied_content", contentDigest: await hashPerformanceValue({ intervals, sourceSampleCount: 181 }) },
    provenance: { source: "synthetic emulator watch", sourceId: workoutId, notes: [] }, limitations: [],
  };
  const feature = await extractWorkoutPerformanceFeature({ workout, intervals, sourceSampleCount: 181, asOf, extractedAt: asOf,
    versions: PERFORMANCE_VERSIONS, policy: DEFAULT_PERFORMANCE_QUALITY_POLICY });
  return { workout, feature };
}
async function publication(features: StoredPerformanceFeature[] = [], expectedCurrentRevision: number | null = null): Promise<PerformancePublicationInput> {
  const result = await calculatePerformanceAnalysis({
    asOf, timeZone: "America/New_York", workouts: features.map(record => record.workout), features: features.map(record => record.feature), linkedRaces: [], deviceVo2: [],
    versions: PERFORMANCE_VERSIONS, ...PERFORMANCE_DEFAULTS,
    coverage: { window: { startDate: "2026-04-25", endDate: "2026-10-21" }, workouts: "partial", telemetry: "partial", deviceVo2: "unknown", expectedWorkoutCount: null, limitations: ["Isolated synthetic emulator evidence."] },
  });
  const payload = buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: asOf, calculationCompletedAt: "2026-10-21T14:00:01.000Z", provenance: features.map(record => record.feature.provenance) });
  const publicationDigest = await hashPerformanceValue({ result: { ...result, asOf: null, evidenceDigest: null }, features: features.map(record => ({ ...record.feature, extractedAt: null })) });
  return { payload, publicationDigest, expectedCurrentRevision, features };
}
async function snapshotCount(): Promise<number> {
  return (await getDocsFromServer(collection(h.db!, "users", ownerUid, "performanceSnapshots"))).size;
}

describe.skipIf(!enabled)("real Firebase SDK manual performance persistence", () => {
  beforeAll(() => {
    if (process.env.FIRESTORE_EMULATOR_HOST !== host || !projectId.startsWith("demo-")) throw new Error("Refusing nonisolated emulator target");
    app = initializeApp({ projectId, apiKey: "demo-emulator-only", appId: "demo-performance-sdk" }, "isolated-performance-sdk");
    h.db = initializeFirestore(app, {});
    connectFirestoreEmulator(h.db, "127.0.0.1", 8187, {
      mockUserToken: { sub: ownerUid, email: "folstromjohn@gmail.com", email_verified: true },
    });
  });
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "true");
    epoch += 1;
    h.currentUser = { uid: ownerUid, email: "folstromjohn@gmail.com", emailVerified: true } as User;
    const reset = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
    if (!reset.ok) throw new Error(`Cannot reset isolated demo emulator: ${await reset.text()}`);
    session = await capturePerformanceSession({ user: h.currentUser, sessionEpoch: epoch, isSessionCurrent: candidate => candidate === epoch });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (h.db) await terminate(h.db);
    if (app) await deleteApp(app);
  });

  it("stores an actual extracted feature and atomically publishes/reads an actual Phase 1 result", async () => {
    const saved = await savePerformanceFeature(session, await extracted(), null);
    expect(saved.feature.status).toBe("accepted");
    expect((await getPerformanceFeatures(session, [saved.workoutId])).features).toEqual([saved]);
    const published = await publishPerformance(session, await publication([saved]));
    expect(published.snapshotCreated).toBe(true);
    expect(published.documentsWritten).toBe(2);
    const current = (await getSavedPerformance(session)).current!;
    expect(current.payload).toEqual(published.current.payload);
    expect(current.committedAt?.toDate()).toBeInstanceOf(Date);
    expect(current.featureRevisions).toEqual([{ workoutId: saved.workoutId, revision: 1, featureDigest: saved.featureDigest }]);
    expect(current.payload.result.capability.estimatedSeconds).toBeNull();
    expect(await snapshotCount()).toBe(1);
  });

  it("retries the same actual publication safely after the caller discards its acknowledgement", async () => {
    const saved = await savePerformanceFeature(session, await extracted(), null);
    const input = await publication([saved]);
    await publishPerformance(session, input); // Emulate a caller that no longer retains the first acknowledgement.
    input.payload.calculationCompletedAt = "2026-10-21T14:01:00.000Z";
    const retried = await publishPerformance(session, input);
    expect(retried.snapshotCreated).toBe(false);
    expect(retried.current.payload.calculationCompletedAt).toBe("2026-10-21T14:00:01.000Z");
    expect(await snapshotCount()).toBe(1);
  });

  it("allows only one winner for concurrent distinct publications from the same current revision", async () => {
    const saved = await savePerformanceFeature(session, await extracted(), null);
    const [first, second] = await Promise.all([publication([saved]), publication([])]);
    const outcomes = await Promise.allSettled([publishPerformance(session, first), publishPerformance(session, second)]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
    // Rules may reject a stale transaction at commit before the SDK retries its callback.
    expect(failed.reason.message).toMatch(/changed in another|PERMISSION_DENIED|permission-denied/);
    expect((await getSavedPerformance(session)).current?.revision).toBe(1);
    expect(await snapshotCount()).toBe(1);
  });

  it("preserves previous current when a stale distinct calculation tries to publish", async () => {
    const first = await publishPerformance(session, await publication());
    const saved = await savePerformanceFeature(session, await extracted(), null);
    await expect(publishPerformance(session, await publication([saved], null))).rejects.toThrow("changed in another");
    expect((await getSavedPerformance(session)).current?.snapshotId).toBe(first.current.snapshotId);
    expect(await snapshotCount()).toBe(1);
    // Features saved before a failed publication remain available to a refreshed calculation.
    const refreshed = await publishPerformance(session, await publication([saved], 1));
    expect(refreshed.current.previousSnapshotId).toBe(first.current.snapshotId);
    expect(await snapshotCount()).toBe(2);
  });

  it("rejects a calculation whose saved feature changed before the actual publication transaction", async () => {
    const original = await savePerformanceFeature(session, await extracted(), null);
    const first = await publishPerformance(session, await publication([original]));
    await savePerformanceFeature(session, await extracted(original.workoutId, 3.2), 1);
    await expect(publishPerformance(session, await publication([original], 1))).rejects.toThrow("changed in another");
    expect((await getSavedPerformance(session)).current?.snapshotId).toBe(first.current.snapshotId);
    expect(await snapshotCount()).toBe(1);
  });

  it("disabled clients cannot write despite an authorized emulator owner connection", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "false");
    await expect(savePerformanceFeature(session, await extracted(), null)).rejects.toThrow("disabled");
    await expect(publishPerformance(session, await publication())).rejects.toThrow("disabled");
    expect((await getSavedPerformance(session)).current).toBeNull();
    expect(await snapshotCount()).toBe(0);
  });
});
