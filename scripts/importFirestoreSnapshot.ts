import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

function getDb(): admin.firestore.Firestore {
  // SAFETY GUARD (required, non-negotiable)
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set! This script must ONLY run against the local emulator.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: 'malignant-metro', // Local emulator project
    });
  }
  return admin.firestore();
}

// Helper to revive Firestore Timestamps from JSON strings
function reviveTimestamps(obj: any): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(reviveTimestamps);
  if (obj._seconds !== undefined && obj._nanoseconds !== undefined && Object.keys(obj).length === 2) {
    return new admin.firestore.Timestamp(obj._seconds, obj._nanoseconds);
  }
  const revived: any = {};
  for (const [k, v] of Object.entries(obj)) {
    revived[k] = reviveTimestamps(v);
  }
  return revived;
}

interface TrainingWebSnapshot {
  uid: string;
  exportedAt: string;
  userDoc: Record<string, unknown> | null;
  healthWorkouts: Array<{
    id: string;
    doc: Record<string, unknown>;
    route: Array<Record<string, unknown>>;
    mileSplits: Array<Record<string, unknown>>;
    hrStream: Array<Record<string, unknown>>;
  }>;
  healthMetrics: Array<{ id: string; doc: Record<string, unknown> }>;
  plans: Array<{ id: string; doc: Record<string, unknown> }>;
  settingsPrefs: Record<string, unknown> | null;
}

export async function importTrainingWebSnapshot(inputPath: string): Promise<void> {
  const db = getDb();
  console.log(`[import] Reading snapshot from ${inputPath}...`);
  const snapshotData = readFileSync(inputPath, 'utf8');
  const snapshot: TrainingWebSnapshot = reviveTimestamps(JSON.parse(snapshotData));
  const uid = snapshot.uid;

  console.log(`[import] Importing snapshot for uid=${uid}...`);

  let batch = db.batch();
  let opCount = 0;
  let totalWritten = 0;

  const counts = {
    userDoc: 0,
    healthWorkouts: 0,
    route: 0,
    mileSplits: 0,
    hrStream: 0,
    healthMetrics: 0,
    plans: 0,
    settingsPrefs: 0,
  };

  async function commitBatchIfNeeded() {
    if (opCount >= 400) {
      await batch.commit();
      totalWritten += opCount;
      batch = db.batch();
      opCount = 0;
    }
  }

  function queueSet(ref: admin.firestore.DocumentReference, data: any) {
    batch.set(ref, data);
    opCount++;
  }

  // userDoc
  if (snapshot.userDoc) {
    queueSet(db.doc(`users/${uid}`), snapshot.userDoc);
    counts.userDoc++;
    await commitBatchIfNeeded();
  }

  // settingsPrefs
  if (snapshot.settingsPrefs) {
    queueSet(db.doc(`users/${uid}/settings/prefs`), snapshot.settingsPrefs);
    counts.settingsPrefs++;
    await commitBatchIfNeeded();
  }

  // healthMetrics
  for (const { id, doc } of snapshot.healthMetrics) {
    queueSet(db.doc(`users/${uid}/healthMetrics/${id}`), doc);
    counts.healthMetrics++;
    await commitBatchIfNeeded();
  }

  // plans
  for (const { id, doc } of snapshot.plans) {
    queueSet(db.doc(`users/${uid}/plans/${id}`), doc);
    counts.plans++;
    await commitBatchIfNeeded();
  }

  // healthWorkouts + subcollections
  for (const workout of snapshot.healthWorkouts) {
    queueSet(db.doc(`users/${uid}/healthWorkouts/${workout.id}`), workout.doc);
    counts.healthWorkouts++;
    await commitBatchIfNeeded();

    for (const route of workout.route) {
      const routeId = (route.__id as string) || db.collection('dummy').doc().id;
      const { __id, ...data } = route;
      queueSet(db.doc(`users/${uid}/healthWorkouts/${workout.id}/route/${routeId}`), data);
      counts.route++;
      await commitBatchIfNeeded();
    }

    for (const ms of workout.mileSplits) {
      const msId = (ms.__id as string) || db.collection('dummy').doc().id;
      const { __id, ...data } = ms;
      queueSet(db.doc(`users/${uid}/healthWorkouts/${workout.id}/mileSplits/${msId}`), data);
      counts.mileSplits++;
      await commitBatchIfNeeded();
    }

    for (const hs of workout.hrStream) {
      const hsId = (hs.__id as string) || db.collection('dummy').doc().id;
      const { __id, ...data } = hs;
      queueSet(db.doc(`users/${uid}/healthWorkouts/${workout.id}/hrStream/${hsId}`), data);
      counts.hrStream++;
      await commitBatchIfNeeded();
    }
  }

  if (opCount > 0) {
    await batch.commit();
    totalWritten += opCount;
  }

  console.log(`[import] Import complete! Total operations written: ${totalWritten}`);
  console.log(`  - userDoc: ${counts.userDoc}`);
  console.log(`  - settingsPrefs: ${counts.settingsPrefs}`);
  console.log(`  - healthMetrics: ${counts.healthMetrics}`);
  console.log(`  - plans: ${counts.plans}`);
  console.log(`  - healthWorkouts: ${counts.healthWorkouts}`);
  console.log(`  - healthWorkouts/route: ${counts.route}`);
  console.log(`  - healthWorkouts/mileSplits: ${counts.mileSplits}`);
  console.log(`  - healthWorkouts/hrStream: ${counts.hrStream}`);
}
