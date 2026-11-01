/** @vitest-environment node */
/**
 * Manual activity CRUD through the real Firebase client SDK and the real service,
 * against an isolated `demo-` emulator with synthetic data. Rules are the excerpt in
 * ./firestore.rules, copied from the repository snapshot, which is NOT authoritative
 * for production (Firebase Console is) — so this proves code paths, not deployed rules.
 *
 * npx firebase emulators:exec --project demo-training-manual-activity \
 *   --config scripts/manual-activity/firebase.json --only firestore \
 *   'MANUAL_ACTIVITY_EMULATOR=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx vitest run scripts/manual-activity/manualActivities.integration.test.ts'
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  initializeFirestore,
  setDoc,
  terminate,
  Timestamp,
  type Firestore,
} from "firebase/firestore";

const OWNER_UID = "synthetic-owner";
const OWNER_EMAIL = "folstromjohn@gmail.com";

const h = vi.hoisted(() => ({
  db: null as Firestore | null,
  user: null as { uid: string; email: string; emailVerified: boolean } | null,
}));
vi.mock("@/lib/firebase", () => ({
  get db() { return h.db; },
  auth: { get currentUser() { return h.user; } },
}));

import { fetchHealthWorkoutsInRange } from "@/services/healthWorkouts";
import {
  createManualActivity,
  deleteManualActivity,
  updateManualActivity,
} from "@/services/manualActivities";
import { createManualActivityId, type ManualActivityInput } from "@/utils/manualActivity";

const enabled = process.env.MANUAL_ACTIVITY_EMULATOR === "1";
const projectId = "demo-training-manual-activity";
const HOST = "127.0.0.1";
const PORT = 8188;
let ownerApp: FirebaseApp;
let strangerApp: FirebaseApp;
let ownerDb: Firestore;
let strangerDb: Firestore;

const input = (overrides: Partial<ManualActivityInput> = {}): ManualActivityInput => ({
  kind: "outdoor_run", localDate: "2026-01-10", localTime: "07:30", durationSeconds: 1800,
  distanceMiles: 3, avgHeartRate: 150, calories: null, title: "Synthetic", notes: null, ...overrides,
});
const raw = async (path: string) => (await getDocFromServer(doc(ownerDb, path))).data();
const exists = async (path: string) => (await getDocFromServer(doc(ownerDb, path))).exists();
const workoutPath = (id: string) => `users/${OWNER_UID}/healthWorkouts/${id}`;

describe.skipIf(!enabled)("manual activities against the Firestore emulator", () => {
  beforeAll(() => {
    ownerApp = initializeApp({ projectId, apiKey: "demo" }, "manual-owner");
    ownerDb = initializeFirestore(ownerApp, {});
    connectFirestoreEmulator(ownerDb, HOST, PORT, {
      mockUserToken: { sub: OWNER_UID, user_id: OWNER_UID, email: OWNER_EMAIL, email_verified: true },
    });
    strangerApp = initializeApp({ projectId, apiKey: "demo" }, "manual-stranger");
    strangerDb = initializeFirestore(strangerApp, {});
    connectFirestoreEmulator(strangerDb, HOST, PORT, {
      mockUserToken: { sub: "synthetic-stranger", user_id: "synthetic-stranger", email: "stranger@example.test", email_verified: true },
    });
  });
  afterAll(async () => {
    await terminate(ownerDb); await terminate(strangerDb);
    await deleteApp(ownerApp); await deleteApp(strangerApp);
  });
  beforeEach(() => {
    h.db = ownerDb;
    h.user = { uid: OWNER_UID, email: OWNER_EMAIL, emailVerified: true };
  });

  it("creates a canonical record that range queries and the converter read back", async () => {
    const id = createManualActivityId();
    const saved = await createManualActivity(OWNER_UID, input(), id);
    const stored = await raw(workoutPath(id));
    expect(stored).toMatchObject({ workoutId: id, entrySource: "manual", sourceName: "Manual Entry", hasRoute: false, hasHRStream: false, avgPaceSecPerMile: 600 });
    expect(stored?.startDate).toBeInstanceOf(Timestamp);
    expect(stored?.endDate).toBeInstanceOf(Timestamp);
    expect(stored).not.toHaveProperty("syncedAt");
    expect(saved.startDate.getTime()).toBe((stored?.startDate as Timestamp).toMillis());

    const listed = await fetchHealthWorkoutsInRange(OWNER_UID, new Date(2026, 0, 10), new Date(2026, 0, 11));
    expect(listed.find((w) => w.workoutId === id)).toMatchObject({ entrySource: "manual", customTitle: "Synthetic", isRunLike: true });
  });

  it("is idempotent when the same ID is retried", async () => {
    const id = createManualActivityId();
    await createManualActivity(OWNER_UID, input(), id);
    await createManualActivity(OWNER_UID, input({ title: "Second attempt" }), id);
    expect((await raw(workoutPath(id)))?.customTitle).toBe("Synthetic");
  });

  it("edits with derived fields cleared and unrelated fields kept", async () => {
    const id = createManualActivityId();
    await createManualActivity(OWNER_UID, input(), id);
    await setDoc(doc(ownerDb, workoutPath(id)), { trainingLoadV2: 88, trainingLoadMethod: "avg-hr-fallback", hrBackfillFirstAttemptAt: Timestamp.now() }, { merge: true });
    await updateManualActivity(OWNER_UID, id, input({ avgHeartRate: null, calories: 300 }));
    const stored = await raw(workoutPath(id));
    expect(stored).not.toHaveProperty("trainingLoadV2");
    expect(stored).not.toHaveProperty("avgHeartRate");
    expect(stored).toHaveProperty("hrBackfillFirstAttemptAt");
    expect(stored?.calories).toBe(300);
  });

  it("refuses to edit or delete an Apple Health record", async () => {
    const hkId = "AAAAAAAA-0000-4000-8000-000000000001";
    const hkDoc = { workoutId: hkId, source: "healthkit", activityType: "running", startDate: Timestamp.now(), durationSeconds: 100 };
    await setDoc(doc(ownerDb, workoutPath(hkId)), hkDoc);
    await expect(updateManualActivity(OWNER_UID, hkId, input())).rejects.toMatchObject({ code: "not_manual" });
    await expect(deleteManualActivity(OWNER_UID, hkId)).rejects.toMatchObject({ code: "not_manual" });
    // An ID that merely looks manual is still protected by the stored marker.
    const disguised = createManualActivityId();
    await setDoc(doc(ownerDb, workoutPath(disguised)), { ...hkDoc, workoutId: disguised });
    await expect(updateManualActivity(OWNER_UID, disguised, input())).rejects.toMatchObject({ code: "not_manual" });
    await expect(deleteManualActivity(OWNER_UID, disguised)).rejects.toMatchObject({ code: "not_manual" });
    expect((await raw(workoutPath(hkId)))?.durationSeconds).toBe(100);
    expect((await raw(workoutPath(disguised)))?.durationSeconds).toBe(100);
  });

  it("deletes atomically with the shoe assignment and override", async () => {
    const id = createManualActivityId();
    await createManualActivity(OWNER_UID, input(), id);
    const shoes = `users/${OWNER_UID}/shoeAssignments/manual`;
    const override = `users/${OWNER_UID}/workoutOverrides/${id}`;
    await setDoc(doc(ownerDb, shoes), { [id]: "shoe-1", "other-run": "shoe-2" }, { merge: true });
    await setDoc(doc(ownerDb, override), { workoutId: id, isExcluded: true });
    await deleteManualActivity(OWNER_UID, id);
    expect(await exists(workoutPath(id))).toBe(false);
    expect(await exists(override)).toBe(false);
    const assignments = await raw(shoes);
    expect(assignments).not.toHaveProperty(id);
    expect(assignments?.["other-run"]).toBe("shoe-2");
  });

  it("blocks deleting a race-linked activity and leaves it intact", async () => {
    const id = createManualActivityId();
    await createManualActivity(OWNER_UID, input(), id);
    const race = `users/${OWNER_UID}/halfMarathonRaces/synthetic-race`;
    await setDoc(doc(ownerDb, race), { id: "synthetic-race", name: "Synthetic Half", actualRunId: id, raceDate: "2026-01-10", raceDistance: "halfMarathon" });
    await expect(deleteManualActivity(OWNER_UID, id)).rejects.toMatchObject({ code: "linked_race" });
    expect(await exists(workoutPath(id))).toBe(true);
    await setDoc(doc(ownerDb, race), { actualRunId: null }, { merge: true });
  });

  it("the snapshot rules deny another signed-in user's writes, surfaced as a failure", async () => {
    const id = createManualActivityId();
    h.db = strangerDb;
    // Past the app's owner check, so only the Firestore rule can stop this.
    await expect(createManualActivity(OWNER_UID, input(), id)).rejects.toMatchObject({
      code: "write_failed", message: expect.stringContaining("permission"),
    });
    h.db = ownerDb;
    expect(await exists(workoutPath(id))).toBe(false);
  });
});
