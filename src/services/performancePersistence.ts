import { getIdTokenResult, type User } from "firebase/auth";
import { doc, getDocFromServer, runTransaction, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { assertPerformanceUpdateEnabled } from "@/lib/performanceGate";
import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";
import { buildWorkoutInputDigest, canonicalizePerformanceValue, hashPerformanceValue, isPerformanceInstant } from "@/utils/performanceEvidence";
import type { PerformanceFeatureInput, PerformancePublicationInput, PerformancePublicationResult, PerformanceSession, SavedPerformanceCurrent, StoredPerformanceFeature } from "@/types/performancePersistence";

export const MAX_PERFORMANCE_FEATURES = 300;
const MAX_RECORD_BYTES = 700_000;
const DIGEST = /^[a-f0-9]{64}$/;

export class PerformanceConflictError extends Error {
  constructor(message = "Performance evidence or publication changed in another tab or device. Reopen Update Performance and try again.") {
    super(message);
    this.name = "PerformanceConflictError";
  }
}

function validId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 500 && !id.includes("/") && id !== "." && id !== "..";
}

function assertBoundedJson(value: unknown): void {
  if (new TextEncoder().encode(canonicalizePerformanceValue(value)).length > MAX_RECORD_BYTES) {
    throw new Error("Performance record exceeds the bounded storage limit.");
  }
}

export function assertPerformanceSession(session: PerformanceSession): void {
  if (auth.currentUser !== session.user || auth.currentUser?.uid !== session.uid
    || !session.isSessionCurrent(session.sessionEpoch)
    || !isAuthorizedTrainingUser(auth.currentUser?.email, auth.currentUser?.emailVerified)) {
    throw new Error("The authenticated performance session changed. Sign in again and restart the update.");
  }
}

export async function capturePerformanceSession(input: {
  user: User;
  sessionEpoch: number;
  isSessionCurrent: (epoch: number) => boolean;
}): Promise<PerformanceSession> {
  const session = Object.freeze({ ...input, uid: input.user.uid });
  assertPerformanceSession(session);
  const token = await getIdTokenResult(input.user, true);
  assertPerformanceSession(session);
  if (token.claims.sub !== session.uid || !isAuthorizedTrainingUser(
    typeof token.claims.email === "string" ? token.claims.email : null,
    token.claims.email_verified === true,
  )) throw new Error("Performance updates require the verified Training Web owner session.");
  return session;
}

function featureRef(session: PerformanceSession, workoutId: string) {
  if (!validId(workoutId)) throw new TypeError("Invalid performance workout ID");
  return doc(db, "users", session.uid, "performanceFeatures", workoutId);
}
function currentRef(session: PerformanceSession) {
  return doc(db, "users", session.uid, "performanceState", "current");
}

function parseFeature(value: unknown, workoutId: string): StoredPerformanceFeature {
  const record = value as StoredPerformanceFeature;
  if (!record || record.schemaVersion !== 1 || record.workoutId !== workoutId
    || record.feature?.workoutId !== workoutId || record.workout?.workoutId !== workoutId
    || !Number.isSafeInteger(record.revision) || record.revision < 1 || !DIGEST.test(record.featureDigest)) {
    throw new Error("Saved performance feature has an unsupported or invalid schema.");
  }
  return record;
}
function parseCurrent(value: unknown): SavedPerformanceCurrent {
  const record = value as SavedPerformanceCurrent;
  if (!record || record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !DIGEST.test(record.publicationDigest) || !DIGEST.test(record.snapshotId)
    || !record.payload?.result || !Array.isArray(record.featureRevisions)
    || record.payload.result.capability.estimatedSeconds !== null || record.payload.result.capability.confidenceInterval !== null) {
    throw new Error("Saved performance result has an unsupported or invalid schema.");
  }
  return record;
}

/** One server document read; never consults an old offline saved summary. No telemetry reads. */
export async function getSavedPerformance(session: PerformanceSession): Promise<{ current: SavedPerformanceCurrent | null; documentsRead: number }> {
  assertPerformanceSession(session);
  const snapshot = await getDocFromServer(currentRef(session));
  assertPerformanceSession(session);
  return { current: snapshot.exists() ? parseCurrent(snapshot.data()) : null, documentsRead: 1 };
}

/** Explicit manual-selection metadata read, bounded by the supplied parent-workout list. */
export async function getPerformanceFeatures(session: PerformanceSession, workoutIds: readonly string[]): Promise<{ features: StoredPerformanceFeature[]; documentsRead: number }> {
  assertPerformanceSession(session);
  const ids = [...new Set(workoutIds)];
  if (ids.length > MAX_PERFORMANCE_FEATURES) throw new Error("Select at most 300 workout feature records per manual update.");
  const features: StoredPerformanceFeature[] = [];
  // Batches cap concurrent network work; every document request is counted, including missing docs.
  for (let offset = 0; offset < ids.length; offset += 20) {
    assertPerformanceSession(session);
    const snapshots = await Promise.all(ids.slice(offset, offset + 20).map(id => getDocFromServer(featureRef(session, id))));
    assertPerformanceSession(session);
    snapshots.forEach(snapshot => { if (snapshot.exists()) features.push(parseFeature(snapshot.data(), snapshot.id)); });
  }
  return { features, documentsRead: ids.length };
}

/** No setDoc/writeBatch queue: transactions fail while offline instead of publishing on reconnect. */
export async function savePerformanceFeature(session: PerformanceSession, input: PerformanceFeatureInput, expectedRevision: number | null): Promise<StoredPerformanceFeature> {
  assertPerformanceUpdateEnabled();
  assertPerformanceSession(session);
  const { feature, workout } = input;
  if (feature.workoutId !== workout.workoutId || feature.parentDigest !== workout.parentDigest
    || feature.telemetryDigest !== workout.telemetry.contentDigest || feature.telemetryState !== workout.telemetry.state
    || feature.sourceInputDigest !== await buildWorkoutInputDigest(workout)) throw new Error("Feature does not match its verified extraction basis.");
  assertBoundedJson(input);
  const featureDigest = await hashPerformanceValue({ feature: { ...feature, extractedAt: "" }, workout });
  const reference = featureRef(session, feature.workoutId);
  const saved = await runTransaction(db, async transaction => {
    assertPerformanceUpdateEnabled();
    assertPerformanceSession(session);
    const snapshot = await transaction.get(reference);
    assertPerformanceSession(session);
    const previous = snapshot.exists() ? parseFeature(snapshot.data(), feature.workoutId) : null;
    if (previous?.featureDigest === featureDigest) return previous;
    if ((previous?.revision ?? null) !== expectedRevision) throw new PerformanceConflictError();
    const next: StoredPerformanceFeature = { schemaVersion: 1, workoutId: feature.workoutId, revision: (previous?.revision ?? 0) + 1, featureDigest, feature, workout };
    transaction.set(reference, next);
    return next;
  });
  assertPerformanceSession(session);
  return saved;
}

function validatePublication(input: PerformancePublicationInput): void {
  const { payload, features } = input;
  const result = payload.result;
  if (!DIGEST.test(input.publicationDigest) || payload.evidenceDigest !== result.evidenceDigest
    || canonicalizePerformanceValue(payload.versions) !== canonicalizePerformanceValue(result.versions)
    || result.versions.schema !== 1 || result.versions.model !== "manual-performance-v1"
    || result.capability.estimatedSeconds !== null || result.capability.confidenceInterval !== null
    || !isPerformanceInstant(payload.calculationStartedAt) || !isPerformanceInstant(payload.calculationCompletedAt)
    || Date.parse(payload.calculationCompletedAt) < Date.parse(payload.calculationStartedAt)
    || payload.evidenceAsOf !== result.asOf || !isPerformanceInstant(result.asOf)
    || Date.parse(result.asOf) > Date.parse(payload.calculationStartedAt)
    || payload.historyBasis !== "actual_calculation" || payload.reason === "historical_reconstruction") {
    throw new Error("Only a valid, actual manual-performance-v1 calculation can be published.");
  }
  if (features.length > MAX_PERFORMANCE_FEATURES || new Set(features.map(feature => feature.workoutId)).size !== features.length) {
    throw new Error("Publication requires a bounded, unique saved feature set.");
  }
  for (const { feature } of features) {
    if (feature.extractorVersion !== result.versions.extractor || feature.qualityPolicyVersion !== result.versions.qualityPolicy) {
      throw new Error("Feature and summary versions do not match.");
    }
  }
  assertBoundedJson({ payload, featureRevisions: features.map(({ workoutId, revision, featureDigest }) => ({ workoutId, revision, featureDigest })) });
}

/** CAS current + recheck every feature revision + immutable deterministic receipt in one online transaction. */
export async function publishPerformance(session: PerformanceSession, input: PerformancePublicationInput): Promise<PerformancePublicationResult> {
  assertPerformanceUpdateEnabled();
  assertPerformanceSession(session);
  validatePublication(input);
  const snapshotId = await hashPerformanceValue({ publicationDigest: input.publicationDigest, expectedCurrentRevision: input.expectedCurrentRevision });
  const snapshotReference = doc(db, "users", session.uid, "performanceSnapshots", snapshotId);
  let documentsRead = 0;
  const result = await runTransaction(db, async transaction => {
    assertPerformanceUpdateEnabled();
    assertPerformanceSession(session);
    const saved = await transaction.get(currentRef(session));
    documentsRead += 1;
    const prior = saved.exists() ? parseCurrent(saved.data()) : null;
    const receipts: (StoredPerformanceFeature | null)[] = [];
    for (let offset = 0; offset < input.features.length; offset += 20) {
      const batch = await Promise.all(input.features.slice(offset, offset + 20).map(async feature => {
        const receipt = await transaction.get(featureRef(session, feature.workoutId));
        documentsRead += 1;
        return receipt.exists() ? parseFeature(receipt.data(), feature.workoutId) : null;
      }));
      receipts.push(...batch);
      assertPerformanceSession(session);
    }
    assertPerformanceSession(session);
    receipts.forEach((receipt, index) => {
      const expected = input.features[index];
      if (!receipt || receipt.revision !== expected.revision || receipt.featureDigest !== expected.featureDigest) throw new PerformanceConflictError();
    });
    if (prior?.publicationDigest === input.publicationDigest) return { current: prior, snapshotCreated: false, documentsWritten: 0 };
    if ((prior?.revision ?? null) !== input.expectedCurrentRevision) throw new PerformanceConflictError();
    const previousReceipt = await transaction.get(snapshotReference);
    documentsRead += 1;
    if (previousReceipt.exists()) throw new PerformanceConflictError("A publication receipt exists without its canonical current result. Refresh before retrying.");
    assertPerformanceUpdateEnabled();
    assertPerformanceSession(session);
    const next: SavedPerformanceCurrent = {
      schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, snapshotId,
      previousSnapshotId: prior?.snapshotId ?? null, publicationDigest: input.publicationDigest,
      payload: input.payload,
      featureRevisions: input.features.map(({ workoutId, revision, featureDigest }) => ({ workoutId, revision, featureDigest })).sort((a, b) => a.workoutId < b.workoutId ? -1 : a.workoutId > b.workoutId ? 1 : 0),
      committedAt: null,
    };
    const stored = { ...next, committedAt: serverTimestamp() };
    transaction.set(snapshotReference, stored);
    transaction.set(currentRef(session), stored);
    return { current: next, snapshotCreated: true, documentsWritten: 2 };
  });
  assertPerformanceSession(session);
  return { ...result, documentsRead };
}

export type { PerformanceSession } from "@/types/performancePersistence";
