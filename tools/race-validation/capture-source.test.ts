// @vitest-environment node
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { createFirestoreCaptureReader } from "./capture-source";
import { dueCheckpoints, sealCheckpoint } from "./checkpoint";
import { PROTOCOL } from "./evidence";

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
