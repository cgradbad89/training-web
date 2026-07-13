/**
 * READ-ONLY one-doc reader for a healthWorkouts document. Reuses the admin-SDK
 * setup from scripts/backfillTrainingLoad.ts (getDb). Never writes.
 *
 * The repo has no tsx/ts-node runner, so this is driven by an env-gated Vitest
 * entry (same convention as the backfill). Output is written to a file because
 * Vitest buffers console output.
 *
 *   READ_WORKOUT=1 READ_WORKOUT_UID=<uid> READ_WORKOUT_ID=<docIdOrPrefix> \
 *   READ_WORKOUT_OUT=/tmp/read_workout.json \
 *   npx vitest run scripts/readHealthWorkout.test.ts
 */
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import admin from "firebase-admin";
import { getDb } from "./backfillTrainingLoad";

const MODE = process.env.READ_WORKOUT;

// Conventional high code point for Firestore document-id prefix scans.
const HIGH_SENTINEL = String.fromCharCode(0xf8ff);

it.skipIf(!MODE)(
  "read one healthWorkouts doc (read-only)",
  async () => {
    const uid = process.env.READ_WORKOUT_UID;
    const idOrPrefix = process.env.READ_WORKOUT_ID;
    const outPath = process.env.READ_WORKOUT_OUT ?? "/tmp/read_workout.json";
    if (!uid || !idOrPrefix) {
      throw new Error("Set READ_WORKOUT_UID and READ_WORKOUT_ID");
    }

    const db = getDb();
    const collPath = `users/${uid}/healthWorkouts`;

    // 1) Exact doc-id match.
    let snap = await db.doc(`${collPath}/${idOrPrefix}`).get();
    let matchedBy = "exact";
    let prefixMatches: string[] = [];

    // 2) Fall back to a document-id prefix range query (HealthKit ids are UUIDs;
    //    the caller may pass only the leading segment). Range = [prefix, prefix+sentinel).
    if (!snap.exists) {
      const rangeSnap = await db
        .collection(collPath)
        .orderBy(admin.firestore.FieldPath.documentId())
        .startAt(idOrPrefix)
        .endAt(idOrPrefix + HIGH_SENTINEL)
        .get();
      prefixMatches = rangeSnap.docs.map((d) => d.id);
      if (rangeSnap.size === 1) {
        snap = rangeSnap.docs[0];
        matchedBy = "prefix";
      } else if (rangeSnap.size > 1) {
        matchedBy = `prefix-ambiguous(${rangeSnap.size})`;
      } else {
        matchedBy = "not-found";
      }
    }

    const ambiguous = matchedBy.startsWith("prefix-ambiguous");
    const result: Record<string, unknown> = {
      uid,
      query: idOrPrefix,
      collectionPath: collPath,
      matchedBy,
      prefixMatches,
    };

    if (snap.exists && !ambiguous) {
      const data = snap.data() as Record<string, unknown>;
      const startDate = data.startDate as { toDate?: () => Date } | undefined;
      const startDateObj = startDate?.toDate?.();
      const durationSeconds =
        typeof data.durationSeconds === "number" ? data.durationSeconds : null;
      const distanceMiles =
        typeof data.distanceMiles === "number" ? data.distanceMiles : null;
      const avgHeartRate =
        typeof data.avgHeartRate === "number" ? data.avgHeartRate : null;
      const trainingLoadV2 =
        typeof data.trainingLoadV2 === "number" ? data.trainingLoadV2 : null;

      result.found = true;
      result.docId = snap.id;
      result.report = {
        date: startDateObj ? startDateObj.toISOString() : null,
        dateLocal: startDateObj ? startDateObj.toISOString().slice(0, 10) : null,
        distanceMiles,
        durationMinutes:
          durationSeconds == null
            ? null
            : Math.round((durationSeconds / 60) * 100) / 100,
        avgHR: avgHeartRate == null ? null : Math.round(avgHeartRate),
        trainingLoadV2,
      };
      result.context = {
        durationSeconds,
        activityType: data.activityType ?? null,
        displayType: data.displayType ?? null,
        trainingLoadMethod: data.trainingLoadMethod ?? null,
        hasRoute: data.hasRoute ?? null,
        hasHRStream: data.hasHRStream ?? null,
      };
      result.allFieldKeys = Object.keys(data).sort();
    } else {
      result.found = false;
    }

    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(`[read-workout] wrote ${outPath}`);
    console.log(JSON.stringify(result, null, 2));

    // Keep the test green regardless of found/not-found; this is a reader.
    expect(typeof result.matchedBy).toBe("string");
  },
  600_000
);
