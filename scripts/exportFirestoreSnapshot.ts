import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import admin from 'firebase-admin';

function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set in environment.');
    }
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin.firestore();
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

export async function exportTrainingWebSnapshot(uid: string, outputPath: string): Promise<void> {
  const db = getDb();
  
  console.log(`[export] Exporting snapshot for uid=${uid}...`);

  const userDocSnap = await db.doc(`users/${uid}`).get();
  const userDoc = userDocSnap.exists ? userDocSnap.data() as Record<string, unknown> : null;

  const settingsSnap = await db.doc(`users/${uid}/settings/prefs`).get();
  const settingsPrefs = settingsSnap.exists ? settingsSnap.data() as Record<string, unknown> : null;

  const workoutsSnap = await db.collection(`users/${uid}/healthWorkouts`).get();
  const healthWorkouts = await Promise.all(workoutsSnap.docs.map(async (docSnap) => {
    const routeSnap = await db.collection(`users/${uid}/healthWorkouts/${docSnap.id}/route`).get();
    const mileSplitsSnap = await db.collection(`users/${uid}/healthWorkouts/${docSnap.id}/mileSplits`).get();
    const hrStreamSnap = await db.collection(`users/${uid}/healthWorkouts/${docSnap.id}/hrStream`).get();

    return {
      id: docSnap.id,
      doc: docSnap.data() as Record<string, unknown>,
      route: routeSnap.docs.map(d => ({ __id: d.id, ...d.data() })),
      mileSplits: mileSplitsSnap.docs.map(d => ({ __id: d.id, ...d.data() })),
      hrStream: hrStreamSnap.docs.map(d => ({ __id: d.id, ...d.data() })),
    };
  }));

  const metricsSnap = await db.collection(`users/${uid}/healthMetrics`).get();
  const healthMetrics = metricsSnap.docs.map(d => ({ id: d.id, doc: d.data() as Record<string, unknown> }));

  const plansSnap = await db.collection(`users/${uid}/plans`).get();
  const plans = plansSnap.docs.map(d => ({ id: d.id, doc: d.data() as Record<string, unknown> }));

  const snapshot: TrainingWebSnapshot = {
    uid,
    exportedAt: new Date().toISOString(),
    userDoc,
    healthWorkouts,
    healthMetrics,
    plans,
    settingsPrefs,
  };

  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log(`[export] Export complete!`);
  console.log(`  - healthWorkouts: ${healthWorkouts.length}`);
  console.log(`  - healthMetrics: ${healthMetrics.length}`);
  console.log(`  - plans: ${plans.length}`);
  console.log(`  - output path: ${outputPath}`);
}
