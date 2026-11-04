/** @vitest-environment node */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import type { User } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, terminate, type Firestore } from "firebase/firestore";
import { createPerformanceSessionStore } from "@/utils/performanceSessionStore";
import { adaptSavedManualPerformance } from "@/utils/sharedPerformanceEvidence";
import { assessPerformanceFreshness } from "@/utils/performanceFreshness";
import { ASSESSMENT_NOW, metadataRun, savedPerformanceFixture } from "@/utils/__tests__/fixtures/savedPerformanceFixture";

const h = vi.hoisted(() => ({ db: null as Firestore | null, user: null as User | null, reads: [] as string[], transactions: 0 }));
vi.mock("@/lib/firebase", () => ({ get db() { return h.db; }, auth: { get currentUser() { return h.user; } } }));
vi.mock("firebase/auth", async original => ({ ...await original<typeof import("firebase/auth")>(),
  getIdTokenResult: async () => ({ claims: { sub: "performance-owner", email: "folstromjohn@gmail.com", email_verified: true } }),
}));
vi.mock("firebase/firestore", async original => {
  const actual = await original<typeof import("firebase/firestore")>();
  return { ...actual,
    getDocFromServer: (...args: Parameters<typeof actual.getDocFromServer>) => {
      h.reads.push(args[0].path); return actual.getDocFromServer(...args);
    },
    runTransaction: (...args: Parameters<typeof actual.runTransaction>) => {
      h.transactions++; return actual.runTransaction(...args);
    },
  };
});
import { capturePerformanceSession, getSavedPerformance, publishPerformance } from "@/services/performancePersistence";

const enabled = process.env.PERFORMANCE_SECURITY_EMULATOR === "1";
const projectId = "demo-training-performance", host = "127.0.0.1:8187", uid = "performance-owner";
let app: FirebaseApp, epoch = 1;
let session: Awaited<ReturnType<typeof capturePerformanceSession>>;
function store() {
  const ownerEpoch = epoch;
  return createPerformanceSessionStore({ isCurrent: () => ownerEpoch === epoch,
    load: async () => (await getSavedPerformance(session)).current, now: () => ASSESSMENT_NOW });
}

describe.skipIf(!enabled)("shared evidence actual SDK call counts (isolated emulator)", () => {
  beforeAll(() => {
    if (process.env.FIRESTORE_EMULATOR_HOST !== host || !projectId.startsWith("demo-")) throw new Error("Refusing non-emulator target");
    app = initializeApp({ projectId, apiKey: "demo-only", appId: "demo-evidence" }, "shared-evidence-call-counts");
    h.db = initializeFirestore(app, {});
    connectFirestoreEmulator(h.db, "127.0.0.1", 8187, { mockUserToken: { sub: uid, email: "folstromjohn@gmail.com", email_verified: true } });
  });
  beforeEach(async () => {
    epoch++; vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "true");
    h.user = { uid, email: "folstromjohn@gmail.com", emailVerified: true } as User;
    const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
    if (!response.ok) throw new Error("Emulator reset failed");
    session = await capturePerformanceSession({ user: h.user, sessionEpoch: epoch, isSessionCurrent: candidate => candidate === epoch });
    h.reads = []; h.transactions = 0;
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (h.db) await terminate(h.db); if (app) await deleteApp(app); });

  it.each(["Plan", "Personal"])("cold %s plus concurrent/warm consumers: one current lookup, zero feature/child reads or writes", async () => {
    const owner = store(); await Promise.all([owner.ensureLoaded(), owner.ensureLoaded()]);
    await owner.ensureLoaded(); await owner.ensureLoaded();
    expect(owner.getSnapshot().status).toBe("absent");
    expect(h.reads).toEqual([`users/${uid}/performanceState/current`]); expect(h.transactions).toBe(0);
  });
  it("reuses actual published result and never writes or reads children during freshness assessment", async () => {
    const fixture = await savedPerformanceFixture();
    // Explicit test fixture publication; never a mount-triggered production write.
    const published = await publishPerformance(session, { payload: fixture.payload, publicationDigest: fixture.publicationDigest,
      features: [], expectedCurrentRevision: null });
    h.reads = []; h.transactions = 0;
    const owner = store(); await owner.ensureLoaded();
    const loaded = owner.getSnapshot().current!;
    expect(loaded.snapshotId).toBe(published.current.snapshotId);
    const assessment = assessPerformanceFreshness({ evidence: adaptSavedManualPerformance(loaded),
      workouts: [metadataRun("new", "2026-11-03T12:00:00Z")], overrides: {},
      sources: { workouts: { hasLoaded: true, resolution: "success" }, overrides: { hasLoaded: true, resolution: "success" } },
      workoutsHistoryComplete: true, observation: null, now: ASSESSMENT_NOW });
    expect(assessment.status).toBe("update_available");
    owner.receivePublication(published.current, false); await owner.ensureLoaded();
    expect(owner.getSnapshot().current?.payload.calculationCompletedAt).toBe(loaded.payload.calculationCompletedAt);
    expect(h.reads).toEqual([`users/${uid}/performanceState/current`]); expect(h.transactions).toBe(0);
  });
  it("starts a separate cold lookup for a replacement authenticated epoch", async () => {
    const original = store(); await original.ensureLoaded(); epoch++;
    session = await capturePerformanceSession({ user: h.user!, sessionEpoch: epoch, isSessionCurrent: candidate => candidate === epoch });
    const replacement = store(); await replacement.ensureLoaded();
    expect(h.reads).toHaveLength(2); expect(h.transactions).toBe(0);
  });
});
