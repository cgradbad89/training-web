// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { Timestamp as BrowserTimestamp } from 'firebase/firestore';
import { expect, it } from 'vitest';
import { createValidationEvidenceReader, createValidationMetadataReader } from './prediction-source';
import { calculateValidation, DEFAULT_VALIDATION_FLAGS } from './prediction-models';
import { buildRaceEvidence } from '@/utils/racePerformance';
import { computeCurrentFitness } from '@/utils/performance/hybridCurrentFitness';
import { VALIDATION_TIME_ZONE } from './prediction-schedule';

/** Explicit opt-in. Only the read-only source adapters are reachable; no storage writer or mutation is imported. */
it.skipIf(process.env.PREDICTION_VALIDATION_READONLY_PROD !== '1')('measures one real read-only evaluation without exporting raw evidence or writing a snapshot', async () => {
  process.loadEnvFile('.env.local');
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Production measurement requires no emulator redirect');
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '{}');
  if (account.project_id !== 'malignant-metro') throw new Error('Unexpected project');
  const app = initializeApp({ credential: cert(account), projectId: account.project_id }, 'validation-readonly-measurement');
  const db = getFirestore(app);
  try {
    const user = await getAuth(app).getUserByEmail('folstromjohn@gmail.com');
    if (!user.emailVerified) throw new Error('Owner must be verified');
    const start = performance.now(), cpu = process.cpuUsage();
    const meta = await createValidationMetadataReader(db, user.uid, account.project_id)();
    const source = await createValidationEvidenceReader(db, user.uid, account.project_id)(new Date().toISOString(), true);
    const result = calculateValidation(source.input, source.discovered, DEFAULT_VALIDATION_FLAGS);
    const elapsedCpu = process.cpuUsage(cpu);
    const durationMs = performance.now() - start;
    const personal = computeCurrentFitness({ ...source.input, timeZone: VALIDATION_TIME_ZONE }, source.input.options);
    expect(result.currentFitness.map(r => [r.seconds, r.displayedSeconds, r.paceSecondsPerMile, r.confidence]))
      .toEqual(personal.rows.map(r => [r.estimate.seconds, r.finishSeconds, r.paceSecondsPerMile, r.confidence]));
    // Aggregate measurements and compact numeric outputs only. Never log uid, keys, names, samples or input documents.
    const measurement = { measuredAt: source.input.asOf,
      auth: 'local existing Admin credential; NOT deployed WIF authentication',
      documents: source.usage.documents, minimumDocumentReads: source.usage.queryMinimumReads + meta.minimumReads,
      metadataDocumentsRead: meta.documentsRead, firestoreWrites: 0, gcsWrites: 0, durationMs,
      processCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000, predictionPayloadBytes: Buffer.byteLength(JSON.stringify(result)),
      limitations: source.limitations, parity: 'PASS', currentFitness: result.currentFitness.map(r => ({ id: r.id, seconds: r.seconds, displayedSeconds: r.displayedSeconds, status: r.status, evidenceQuality: r.evidenceQuality, reason: r.reason, reasons: r.reasons })),
      raceQualification: buildRaceEvidence({ ...source.input, timeZone: VALIDATION_TIME_ZONE }).map(e => ({ status: e.status, reasons: e.reasons })),
      activeRaces: meta.races.map(r => ({ date: r.raceDate, distanceMeters: r.distanceMeters, linkedPlan: !!r.linkedPlanId })),
      forecasts: result.planInsights.forecasts.map(f => ({ date: f.raceDate, seconds: f.seconds, status: f.status, reason: f.reason })) };
    writeFileSync('/private/tmp/training-prediction-measurement.json', JSON.stringify(measurement, null, 2));
  } finally { await db.terminate(); await deleteApp(app); }
}, 120_000);

it.skipIf(process.env.PREDICTION_VALIDATION_DIAGNOSE_PROD !== '1')('compares app and collector normalization on linked race parents using read-only access', async () => {
  process.loadEnvFile('.env.local');
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Unexpected emulator redirect');
  const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '{}');
  if (account.project_id !== 'malignant-metro') throw new Error('Unexpected project');
  const app = initializeApp({ credential: cert(account), projectId: account.project_id }, 'validation-readonly-diagnostic');
  const db = getFirestore(app);
  try {
    const user = await getAuth(app).getUserByEmail('folstromjohn@gmail.com');
    const { docToHealthWorkout } = await import('@/services/healthWorkouts');
    const { normalizeRaceDocument } = await import('@/utils/raceDocument');
    const { validationWorkout } = await import('./prediction-source');
    const { buildRaceConfirmationSnapshot } = await import('@/utils/raceConfirmation');
    const { canonicalizePerformanceValue } = await import('@/utils/performanceEvidence');
    const owner = db.collection('users').doc(user.uid);
    const races = await owner.collection('halfMarathonRaces').get();
    const diagnostics = [];
    for (const doc of races.docs) {
      const race = normalizeRaceDocument(doc.id, doc.data());
      if (!race.actualRunId || !race.confirmationHistory) continue;
      const [workout, override] = await db.getAll(owner.collection('healthWorkouts').doc(race.actualRunId), owner.collection('workoutOverrides').doc(race.actualRunId));
      if (!workout.exists) continue;
      const raw = workout.data()!;
      const browserRaw = { ...raw };
      for (const field of ['startDate', 'endDate', 'syncedAt', 'updatedAt']) {
        const t = raw[field];
        if (t && typeof t.seconds === 'number' && typeof t.nanoseconds === 'number')
          browserRaw[field] = new BrowserTimestamp(t.seconds, t.nanoseconds);
      }
      const appWorkout = docToHealthWorkout(workout.id, browserRaw);
      const collectorWorkout = validationWorkout(workout.id, raw);
      const ov = override.exists ? override.data() as never : null;
      const revision = race.confirmationHistory.revisions[race.confirmationHistory.currentRevisionId];
      const current = buildRaceConfirmationSnapshot(race, appWorkout, ov, revision.observations.timeZone);
      const collector = buildRaceConfirmationSnapshot(race, collectorWorkout, ov, revision.observations.timeZone);
      expect(current.snapshotToken).toBe(collector.snapshotToken);
      const changed: string[] = [];
      const compare = (before: unknown, after: unknown, path: string) => {
        if (canonicalizePerformanceValue(before) === canonicalizePerformanceValue(after)) return;
        if (before && after && typeof before === 'object' && typeof after === 'object') {
          const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
          for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], `${path}.${k}`);
        } else changed.push(path);
      };
      compare(revision.observations, current.observations, 'observations');
      diagnostics.push({ normalizationParity: 'PASS', storedTimeZone: revision.observations.timeZone,
        expectedTimeZone: VALIDATION_TIME_ZONE, confirmationObservationChangedFields: changed });
    }
    writeFileSync('/private/tmp/training-prediction-diagnostic.json', JSON.stringify({ documentsRead: races.size + diagnostics.length * 2, diagnostics }, null, 2));
  } finally { await db.terminate(); await deleteApp(app); }
}, 60_000);
