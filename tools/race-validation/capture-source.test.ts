// @vitest-environment node
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { createFirestoreCaptureReader } from "./capture-source";
import { dueCheckpoints, sealCheckpoint } from "./checkpoint";
import { PROTOCOL } from "./evidence";
import { createPrivateCaptureStore } from "./capture-storage";
import { createFakeGcs } from "./fake-gcs";
import { runScheduledCapture } from "./scheduled-capture";

it.skipIf(process.env.PHASE3E_CAPTURE_EMULATOR !== "1")("reads one consistent parent-only snapshot and seals it on a local emulator", async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080") throw new Error("Expected the local emulator on 127.0.0.1:8080");
  const app = initializeApp({ projectId: "demo-training-capture-phase3e" }, "phase3e-source-test");
  const db = getFirestore(app);
  const uid = "synthetic-capture-source";
  const root = db.collection("users").doc(uid);
  const now = new Date();
  const target = { subject: "synthetic", raceId: "future", raceDate: shiftPerformanceDate(performanceLocalDate(now.toISOString(), "America/New_York"), 1),
    timeZone: "America/New_York" };
  const slot = dueCheckpoints([target], now.toISOString())[0];
  const started = new Date(now.getTime() - 7200_000);
  const ended = new Date(now.getTime() - 3600_000);
  const workout = root.collection("healthWorkouts").doc("one");
  const child = workout.collection("route").doc("never-read");
  const override = root.collection("workoutOverrides").doc("one");
  try {
    await db.batch().set(workout, {
      workoutId: "one", isRunLike: true, startDate: started, endDate: ended, updatedAt: ended, entrySource: "manual",
      distanceMiles: 4, durationSeconds: 3600, notes: "not in field mask",
    }).set(child, { sentinel: "never in capture" })
      .set(override, { workoutId: "one", userId: uid, isExcluded: false, updatedAt: ended.toISOString() }).commit();

    const result = await createFirestoreCaptureReader(db, uid)(slot);
    expect(result.counts).toEqual({ workouts: 1, overrides: 1, races: 0 });
    expect(result.reference).toMatch(/^firestore-read:\d+:\d+$/);
    const artifact = sealCheckpoint({
      protocol: PROTOCOL, target, horizon: slot.horizon, capturedAt: result.capturedAt,
      source: { kind: "synthetic", authorization: "emulator-only", reference: result.reference, codeRevision: "fixture" },
      coverage: result.coverage, inputs: result.inputs,
    });
    expect(artifact.results.eligibleWorkoutIds).toEqual(["one"]);
    expect(artifact.inputs.workouts[0].doc.syncedAt).toBe(ended.toISOString());
    expect(artifact.inputs.workouts[0].doc).not.toHaveProperty("notes");
    expect(JSON.stringify(artifact)).not.toContain("never in capture");
  } finally {
    await db.batch().delete(child).delete(workout).delete(override).commit();
    await deleteApp(app);
  }
});

it.skipIf(process.env.PHASE3E_CAPTURE_EMULATOR !== "1")("binds project, owner and enrolled race, stays bounded and runs the whole capture path on an emulator", async () => {
  if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080") throw new Error("Expected the local emulator on 127.0.0.1:8080");
  const projectId = "demo-training-capture-phase3f";
  const app = initializeApp({ projectId }, "phase3f-source-test");
  const db = getFirestore(app);
  const owner = "synthetic-owner";
  const other = "synthetic-other-user";
  const root = db.collection("users").doc(owner);
  const now = new Date();
  const raceDate = shiftPerformanceDate(performanceLocalDate(now.toISOString(), "America/New_York"), 1);
  const target = { subject: "synthetic", raceId: "enrolled", raceDate, timeZone: "America/New_York" };
  const slot = dueCheckpoints([target], now.toISOString())[0];
  const written: FirebaseFirestore.DocumentReference[] = [];
  const set = async (ref: FirebaseFirestore.DocumentReference, data: object) => { written.push(ref); await ref.set(data); };
  try {
    await set(db.collection("users").doc(other).collection("healthWorkouts").doc("foreign"), {
      workoutId: "foreign", isRunLike: true, startDate: new Date(now.getTime() - 7200_000), endDate: new Date(now.getTime() - 3600_000), updatedAt: new Date(now.getTime() - 3600_000), entrySource: "manual", sourceName: "FOREIGN-USER-SENTINEL" });
    const race = (id: string, date: string) => ({ name: "Synthetic", raceDate: date, raceDistance: "halfMarathon", createdAt: new Date(now.getTime() - 86400_000).toISOString() });

    // Wrong project or owner shape is refused before any query is issued.
    expect(() => createFirestoreCaptureReader(db, owner, { projectId: "another-project" })).toThrow("not bound");
    expect(() => createFirestoreCaptureReader(db, "a/b")).toThrow();

    const read = createFirestoreCaptureReader(db, owner, { projectId });
    expect((await read(slot)).race).toBe("absent");
    expect((await read(slot)).coverage).toMatchObject({ limitations: ["enrolled race record absent at capture"] });

    await set(root.collection("halfMarathonRaces").doc("enrolled"), race("enrolled", "2099-01-01"));
    expect((await read(slot)).race).toBe("date_mismatch");
    await root.collection("halfMarathonRaces").doc("enrolled").set(race("enrolled", raceDate));
    const result = await read(slot);
    expect(result.race).toBe("present");
    expect(JSON.stringify(result)).not.toContain("FOREIGN-USER-SENTINEL");
    expect(result.counts).toEqual({ workouts: 0, races: 1, overrides: 0 });

    // Real Firestore snapshot -> estimator replay -> create-only object -> generation verification.
    const gcs = createFakeGcs({ bucket: "synthetic-private", clock: () => new Date().toISOString(), retentionSeconds: 365 * 86_400 });
    const store = createPrivateCaptureStore({ bucket: "synthetic-private", minimumRetentionSeconds: 365 * 86_400, retentionMode: "unlocked_pilot", request: gcs.fetch,
      writer: { principal: "writer", accessToken: async () => "token:writer" }, verifier: { principal: "reader", accessToken: async () => "token:reader" } });
    const secret = "synthetic-emulator-secret-never-deployed";
    const outcome = await runScheduledCapture(`Bearer ${secret}`, { enabled: true, secret, target, authorization: "emulator-only", codeRevision: "fixture" },
      { now: () => new Date().toISOString(), readSource: read, store });
    expect(["abstained", "captured"]).toContain(outcome.status);
    expect(outcome).toMatchObject({ horizon: 1, counts: { workouts: 0, races: 1, overrides: 0 }, retentionLocked: false });
    expect(gcs.objects.size).toBe(1);
    expect(await runScheduledCapture(`Bearer ${secret}`, { enabled: true, secret, target, authorization: "emulator-only", codeRevision: "fixture" },
      { now: () => new Date().toISOString(), readSource: read, store })).toMatchObject({ status: "duplicate", generation: outcome.generation });

    // The bounded query reports overflow as partial coverage rather than reading without limit.
    for (let start = 0; start < 101; start += 50) {
      const batch = db.batch();
      for (let i = start; i < Math.min(start + 50, 101); i++) { const ref = root.collection("halfMarathonRaces").doc(`bulk-${i}`); written.push(ref); batch.set(ref, race(`bulk-${i}`, "2030-01-01")); }
      await batch.commit();
    }
    const overflow = await read(slot);
    expect(overflow.counts.races).toBe(101);
    expect(overflow.coverage).toMatchObject({ races: "partial" });
  } finally {
    for (let i = 0; i < written.length; i += 400) {
      const batch = db.batch();
      written.slice(i, i + 400).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    await deleteApp(app);
  }
});
