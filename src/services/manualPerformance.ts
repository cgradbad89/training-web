/** Explicit browser workflow. Mounting a view may only call loadSavedPerformance. */
import {
  collection, documentId, getDocsFromServer, limit, orderBy, query, where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { getPerformanceUpdateGate, assertPerformanceUpdateEnabled } from "@/lib/performanceGate";
import { docToHealthWorkout } from "@/services/healthWorkouts";
import {
  assertPerformanceSession, capturePerformanceSession, getPerformanceFeatures,
  getSavedPerformance, PerformanceConflictError, publishPerformance, savePerformanceFeature,
  type PerformanceSession,
} from "@/services/performancePersistence";
import { createPerformanceReadBudget, extractFreshWorkoutPerformance } from "@/services/performanceTelemetry";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { Race } from "@/types/race";
import { RACE_DISTANCE_MILES } from "@/types/race";
import { toDate } from "@/utils/dates";
import type { DeviceVo2Measurement, EffectivePerformanceWorkout, LinkedPerformanceRace } from "@/types/performanceAnalysis";
import type { SavedPerformanceCurrent, StoredPerformanceFeature } from "@/types/performancePersistence";
import {
  buildWorkoutInputDigest, comparePerformanceKeys, hashPerformanceValue, isPerformanceDate, isPerformanceInstant,
  performanceObservationWindow, selectWorkoutsForManualAnalysis, toEffectivePerformanceWorkout,
  workoutIsCompletedAsOf,
} from "@/utils/performanceEvidence";
import {
  buildPerformanceSnapshotPayload, calculatePerformanceAnalysis, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS,
} from "@/utils/performanceAnalysis";

export type StoredPerformanceCurrent = SavedPerformanceCurrent;
export { type PerformanceSession };
export const createManualPerformanceSession = capturePerformanceSession;
export const getManualPerformanceGate = getPerformanceUpdateGate;
export const MANUAL_PERFORMANCE_PARENT_LIMIT = 300;
export const MANUAL_PERFORMANCE_SELECTION_LIMIT = 20;

export interface ManualPerformanceCandidate {
  workoutId: string; startedAt: string; label: string;
  status: "new" | "analyzed" | "changed" | "incomplete";
  concerns: string[]; preselected: boolean;
}
export interface ManualPerformanceReview {
  candidates: ManualPerformanceCandidate[]; documentsRead: number; limitations: string[];
  expectedCurrentRevision: number | null;
}
export interface ManualPerformanceProgress {
  selected: number; completed: number; skipped: number; documentReads: number; status: string;
}
export interface ManualPerformanceUpdateOptions {
  selectedWorkoutIds: string[]; forceReprocessWorkoutIds: string[];
  userConfirmedReady: true; readBudget: number;
}
export interface ManualPerformanceUpdateResult {
  current: SavedPerformanceCurrent; snapshotCreated: boolean; processedWorkoutIds: string[];
  skippedWorkoutIds: string[]; documentReads: number;
}
interface ParentRecord {
  raw: HealthWorkout; routePointCount: number | null; hasRouteHR: boolean | null;
}
interface ReviewEvidence { session: PerformanceSession; parents: ParentRecord[] }
const reviews = new WeakMap<ManualPerformanceReview, ReviewEvidence>();
const activeUpdates = new Set<string>();

export async function loadSavedPerformance(session: PerformanceSession): Promise<SavedPerformanceCurrent | null> {
  return (await getSavedPerformance(session)).current;
}

/** Returns documents, not query count. Empty query billing minima are documented separately. */
async function loadParents(session: PerformanceSession) {
  assertPerformanceSession(session);
  const snap = await getDocsFromServer(query(collection(db, "users", session.uid, "healthWorkouts"),
    orderBy("startDate", "desc"), limit(MANUAL_PERFORMANCE_PARENT_LIMIT)));
  assertPerformanceSession(session);
  const parents: ParentRecord[] = snap.docs.map(d => {
    const data = d.data();
    const raw = docToHealthWorkout(d.id, data);
    // Canonical document identity must agree with the HealthKit identity.
    if (raw.workoutId !== d.id) throw new Error("Workout document identity mismatch; correct the source before analysis.");
    return { raw, routePointCount: typeof data.routePointCount === "number" && Number.isFinite(data.routePointCount) ? data.routePointCount : null,
      hasRouteHR: typeof data.hasRouteHR === "boolean" ? data.hasRouteHR : null };
  });
  return { parents, documentsRead: snap.size };
}
async function loadOverrides(session: PerformanceSession, ids: string[]) {
  const overrides = new Map<string, WorkoutOverride>();
  let documentsRead = 0;
  for (let offset = 0; offset < ids.length; offset += 30) {
    assertPerformanceSession(session);
    const snap = await getDocsFromServer(query(collection(db, "users", session.uid, "workoutOverrides"),
      where(documentId(), "in", ids.slice(offset, offset + 30))));
    assertPerformanceSession(session);
    documentsRead += snap.size;
    for (const d of snap.docs) {
      const override = d.data() as WorkoutOverride;
      if (override.workoutId !== d.id || override.userId !== session.uid) throw new Error("Workout override ownership mismatch.");
      overrides.set(d.id, override);
    }
  }
  return { overrides, documentsRead };
}
async function effectiveParent(parent: ParentRecord, override: WorkoutOverride | null, asOf: string) {
  const workout = await toEffectivePerformanceWorkout({ workout: parent.raw, override,
    completion: parent.raw.endDate.getTime() <= Date.parse(asOf) ? "completed" : "incomplete", availableAt: null });
  workout.parentDigest = await hashPerformanceValue({ phase1ParentDigest: workout.parentDigest,
    hasHRStream: parent.raw.hasHRStream ?? false, routePointCount: parent.routePointCount, hasRouteHR: parent.hasRouteHR });
  return workout;
}

/** Match a dated extraction basis independently of whether its observations are usable. */
async function matchingPerformanceReceipt(current: EffectivePerformanceWorkout, stored: StoredPerformanceFeature | undefined, asOf: string): Promise<EffectivePerformanceWorkout | null> {
  if (!stored || !workoutIsCompletedAsOf(current, asOf)
    || stored.workoutId !== current.workoutId || stored.feature.workoutId !== current.workoutId || stored.workout.workoutId !== current.workoutId
    || stored.feature.parentDigest !== current.parentDigest || stored.workout.parentDigest !== current.parentDigest
    || stored.feature.extractorVersion !== PERFORMANCE_VERSIONS.extractor || stored.feature.qualityPolicyVersion !== PERFORMANCE_VERSIONS.qualityPolicy
    || stored.feature.qualityPolicyDigest !== await hashPerformanceValue(PERFORMANCE_DEFAULTS.qualityPolicy)
    || stored.feature.observedAt !== current.startedAt || stored.feature.completion !== current.completion
    || stored.workout.telemetry.verification !== "supplied_content" || !/^[a-f0-9]{64}$/.test(stored.workout.telemetry.contentDigest ?? "")
    || stored.feature.telemetryDigest !== stored.workout.telemetry.contentDigest || stored.feature.telemetryState !== stored.workout.telemetry.state) return null;
  const receipt = { ...current, telemetry: stored.workout.telemetry, limitations: stored.workout.limitations };
  if (await buildWorkoutInputDigest(receipt) !== stored.feature.sourceInputDigest
    || await buildWorkoutInputDigest(stored.workout) !== stored.feature.sourceInputDigest) return null;
  return receipt;
}

/** Reuse eligible observations only; a matching unresolved receipt still needs review. */
export async function reusablePerformanceReceipt(current: EffectivePerformanceWorkout, stored?: StoredPerformanceFeature): Promise<EffectivePerformanceWorkout | null> {
  const asOf = new Date().toISOString();
  const receipt = await matchingPerformanceReceipt(current, stored, asOf);
  if (!receipt || !stored) return null;
  const selection = await selectWorkoutsForManualAnalysis({ workouts: [receipt], features: [stored.feature],
    versions: PERFORMANCE_VERSIONS, qualityPolicy: PERFORMANCE_DEFAULTS.qualityPolicy,
    asOf });
  if (selection[0]?.action !== "reuse") return null;
  return receipt;
}

export async function prepareManualPerformanceReview(session: PerformanceSession): Promise<ManualPerformanceReview> {
  assertPerformanceUpdateEnabled(); assertPerformanceSession(session);
  const { parents, documentsRead: parentReads } = await loadParents(session);
  const runs = parents.filter(p => p.raw.isRunLike);
  const { overrides, documentsRead: overrideReads } = await loadOverrides(session, runs.map(p => p.raw.workoutId));
  const saved = await getPerformanceFeatures(session, runs.map(p => p.raw.workoutId));
  const current = await getSavedPerformance(session);
  const asOf = new Date().toISOString();
  const candidates: ManualPerformanceCandidate[] = [];
  for (const parent of runs) {
    const id = parent.raw.workoutId;
    const stored = saved.features.find(f => f.workoutId === id);
    const concerns = ["Parent metadata cannot detect child-only HR/GPS corrections; select an analyzed run to retrieve fresh telemetry."];
    let status: ManualPerformanceCandidate["status"] = stored ? "analyzed" : "new";
    try {
      const effective = await effectiveParent(parent, overrides.get(id) ?? null, asOf);
      if (stored && !(await reusablePerformanceReceipt(effective, stored))) status = "changed";
      if (effective.excluded || effective.completion !== "completed" || parent.raw.routeComplete === false) {
        status = "incomplete";
        concerns.push(effective.excluded ? "Excluded by a saved workout override." : "Workout or route is still incomplete; telemetry may still be syncing.");
      }
      if (parent.raw.routeComplete === undefined) concerns.push("Route completion marker is absent; ingestion completeness is unknown.");
      if (!parent.raw.hasRoute) concerns.push("No GPS route is advertised; steady pace-at-HR evidence may be unavailable.");
      if (!parent.raw.hasHRStream && parent.hasRouteHR !== true) concerns.push("HR coverage is unknown until selected telemetry is read.");
      if (stored) concerns.push(...stored.feature.reasons, ...stored.feature.limitations);
    } catch {
      status = "incomplete"; concerns.push("Invalid parent measurements or dates; source needs correction.");
    }
    candidates.push({ workoutId: id, startedAt: Number.isFinite(parent.raw.startDate.getTime()) ? parent.raw.startDate.toISOString() : "",
      label: parent.raw.displayType, status, concerns: [...new Set(concerns)], preselected: false });
  }
  candidates.filter(c => c.status === "new").slice(0, 3).forEach(c => { c.preselected = true; });
  const review: ManualPerformanceReview = { candidates, expectedCurrentRevision: current.current?.revision ?? null,
    documentsRead: parentReads + overrideReads + saved.documentsRead + current.documentsRead,
    limitations: [
      `Review is bounded to the newest ${MANUAL_PERFORMANCE_PARENT_LIMIT} workout parents, before run filtering. No historical telemetry backfill runs automatically.`,
      "Unselected compatible features represent their last dated extraction. Matching parents do not establish that current children are unchanged.",
      "User confirmation records readiness; it does not scientifically verify sync completeness. Additional history requires later manual selections.",
    ] };
  assertPerformanceSession(session);
  reviews.set(review, { session, parents });
  return review;
}

async function loadSupportingEvidence(session: PerformanceSession, asOf: string, timeZone: string) {
  const window = performanceObservationWindow(asOf, timeZone, PERFORMANCE_DEFAULTS.observationDays);
  assertPerformanceSession(session);
  const raceSnap = await getDocsFromServer(query(collection(db, "users", session.uid, "halfMarathonRaces"), limit(100)));
  assertPerformanceSession(session);
  const healthSnap = await getDocsFromServer(query(collection(db, "users", session.uid, "healthMetrics"),
    where("date", ">=", window.startDate), where("date", "<=", window.endDate), orderBy("date", "desc"), limit(181)));
  assertPerformanceSession(session);
  const linkedRaces: LinkedPerformanceRace[] = [];
  for (const d of raceSnap.docs) {
    const race = d.data() as Race;
    if (!race.actualRunId) continue;
    // Preserve the existing race service's support for both date keys and Firestore timestamps.
    const raceInstant = toDate(race.raceDate);
    const date = typeof race.raceDate === "string" && isPerformanceDate(race.raceDate) ? race.raceDate
      : Number.isFinite(raceInstant.getTime()) ? raceInstant.toISOString().slice(0, 10) : null;
    if (!date || !isPerformanceDate(date)) continue;
    const meters = (race.raceDistance === "custom" ? race.customDistanceMiles : RACE_DISTANCE_MILES[race.raceDistance])! * 1609.344;
    if (!Number.isFinite(meters) || meters <= 0) continue;
    linkedRaces.push({ raceId: d.id, workoutId: race.actualRunId, raceDate: date,
      nominalDistanceMeters: meters, copiedDurationSeconds: Number.isFinite(race.actualRunDurationSeconds) ? race.actualRunDurationSeconds! : null,
      provenance: { source: "workout-linked race", sourceId: d.id, notes: ["Official timing and maximal race effort remain unverified."] }, limitations: [] });
  }
  const deviceVo2: DeviceVo2Measurement[] = healthSnap.docs.flatMap(d => {
    const m = d.data();
    if (typeof m.vo2_max !== "number" || !Number.isFinite(m.vo2_max) || m.vo2_max <= 0 || !isPerformanceDate(m.date)) return [];
    return [{ measurementId: d.id, date: m.date, value: m.vo2_max, unit: "unknown" as const,
      sourceKind: "device_estimate" as const, sourceName: null,
      availableAt: typeof m.syncedAt === "string" && isPerformanceInstant(m.syncedAt) ? m.syncedAt : null,
      provenance: { source: "HealthKit daily device estimate", sourceId: d.id,
        notes: ["Stored daily VO₂ has no verified per-sample device identity, algorithm version or unit; comparable-source trend is unavailable."] } }];
  });
  return { linkedRaces, deviceVo2, documentsRead: raceSnap.size + healthSnap.size,
    limitations: raceSnap.size === 100 ? ["Race links are bounded to 100 documents; additional race links may be missing."] : [] };
}

export async function runManualPerformanceUpdate(session: PerformanceSession, review: ManualPerformanceReview,
  options: ManualPerformanceUpdateOptions, onProgress: (progress: ManualPerformanceProgress) => void): Promise<ManualPerformanceUpdateResult> {
  assertPerformanceUpdateEnabled(); assertPerformanceSession(session);
  const evidence = reviews.get(review);
  if (!evidence || evidence.session !== session) throw new Error("Review expired; open Update Performance again.");
  const selected = [...new Set(options.selectedWorkoutIds)];
  if (!options.userConfirmedReady || selected.length === 0) throw new Error("Select at least one workout and confirm syncing readiness.");
  if (selected.length > MANUAL_PERFORMANCE_SELECTION_LIMIT || selected.some(id => !review.candidates.some(c => c.workoutId === id))) throw new Error("Select at most 20 workouts from this review.");
  if (activeUpdates.has(session.uid)) throw new Error("A performance update is already running in this browser.");
  const budget = createPerformanceReadBudget(options.readBudget);
  const calculationStartedAt = new Date().toISOString();
  const asOf = calculationStartedAt;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let documentReads = review.documentsRead;
  const processedWorkoutIds: string[] = []; const skippedWorkoutIds: string[] = [];
  const report = (status: string) => onProgress({ selected: selected.length, completed: processedWorkoutIds.length,
    skipped: skippedWorkoutIds.length, documentReads: documentReads + budget.documentsRead, status });
  activeUpdates.add(session.uid);
  try {
    report("Refreshing selected evidence and saved features");
    const source = await loadParents(session); documentReads += source.documentsRead;
    const runs = source.parents.filter(p => p.raw.isRunLike);
    const overrideResult = await loadOverrides(session, runs.map(p => p.raw.workoutId)); documentReads += overrideResult.documentsRead;
    const originals = await getPerformanceFeatures(session, runs.map(p => p.raw.workoutId)); documentReads += originals.documentsRead;
    const effective = new Map<string, EffectivePerformanceWorkout>();
    const selectedReceipts = new Map<string, StoredPerformanceFeature>();
    const invalidIds: string[] = [];
    for (const parent of runs) {
      try { effective.set(parent.raw.workoutId, await effectiveParent(parent, overrideResult.overrides.get(parent.raw.workoutId) ?? null, asOf)); }
      catch { invalidIds.push(parent.raw.workoutId); }
    }
    for (const id of selected) {
      assertPerformanceSession(session); report(`Reading fresh telemetry for ${id}`);
      const parent = runs.find(p => p.raw.workoutId === id); const workout = effective.get(id);
      if (!parent || !workout || workout.excluded || workout.completion !== "completed" || parent.raw.routeComplete === false) {
        skippedWorkoutIds.push(id); report(`Skipped incomplete, excluded or unavailable workout ${id}`); continue;
      }
      // Every explicitly selected prior workout is forced, regardless of matching parent metadata.
      const extracted = await extractFreshWorkoutPerformance({ uid: session.uid, workout,
        source: { hasRoute: parent.raw.hasRoute, routeComplete: parent.raw.routeComplete,
          hasHRStream: parent.raw.hasHRStream, routePointCount: parent.routePointCount },
        asOf, extractedAt: new Date().toISOString(), versions: PERFORMANCE_VERSIONS,
        policy: PERFORMANCE_DEFAULTS.qualityPolicy, budget, assertSession: () => assertPerformanceSession(session) });
      const original = originals.features.find(f => f.workoutId === id);
      const savedReceipt = await savePerformanceFeature(session, { feature: extracted.feature, workout: extracted.workout }, original?.revision ?? null);
      selectedReceipts.set(id, savedReceipt);
      // A feature transaction reads the one feature document (including a missing doc).
      documentReads += 1;
      effective.set(id, extracted.workout);
      processedWorkoutIds.push(id);
      if (extracted.feature.status !== "accepted") skippedWorkoutIds.push(id);
      report(`Saved ${extracted.feature.status} feature for ${id}`);
    }
    const saved = await getPerformanceFeatures(session, runs.map(p => p.raw.workoutId)); documentReads += saved.documentsRead;
    const verified: StoredPerformanceFeature[] = [];
    for (const [id, workout] of effective) {
      const stored = saved.features.find(f => f.workoutId === id);
      const selectedReceipt = selectedReceipts.get(id);
      if (selectedReceipt && (!stored || stored.revision !== selectedReceipt.revision || stored.featureDigest !== selectedReceipt.featureDigest)) {
        throw new PerformanceConflictError();
      }
      const receipt = await matchingPerformanceReceipt(workout, stored, asOf);
      if (selectedReceipt && !receipt) throw new PerformanceConflictError();
      if (receipt && stored) { effective.set(id, receipt); verified.push(stored); }
    }
    // Parent/override metadata is not a child revision, but changes we CAN detect
    // during acquisition must not be published as one coherent evidence basis.
    report("Verifying recorded workout and override inputs after extraction");
    const checked = await loadParents(session); documentReads += checked.documentsRead;
    const checkedRuns = checked.parents.filter(p => p.raw.isRunLike);
    const checkedOverrides = await loadOverrides(session, checkedRuns.map(p => p.raw.workoutId)); documentReads += checkedOverrides.documentsRead;
    const before = runs.map(parent => ({ workoutId: parent.raw.workoutId,
      parentDigest: effective.get(parent.raw.workoutId)?.parentDigest ?? null }));
    const after = await Promise.all(checkedRuns.map(async parent => {
      let parentDigest: string | null = null;
      try { parentDigest = (await effectiveParent(parent, checkedOverrides.overrides.get(parent.raw.workoutId) ?? null, asOf)).parentDigest; }
      catch { /* Already-invalid summaries remain omitted; becoming valid is a detectable change. */ }
      return { workoutId: parent.raw.workoutId, parentDigest };
    }));
    const ordered = (records: typeof before) => records.sort((a, b) => comparePerformanceKeys(a.workoutId, b.workoutId));
    if (await hashPerformanceValue(ordered(before)) !== await hashPerformanceValue(ordered(after))) {
      throw new Error("Workout or override inputs changed during analysis. Reopen Update Performance to review current evidence and retry.");
    }
    assertPerformanceSession(session);
    report("Calculating measured performance evidence");
    const supporting = await loadSupportingEvidence(session, asOf, timeZone); documentReads += supporting.documentsRead;
    const coverageWindow = performanceObservationWindow(asOf, timeZone, PERFORMANCE_DEFAULTS.observationDays);
    const limitations = [...review.limitations, ...supporting.limitations,
      `${verified.length} compatible saved extraction receipts among ${runs.length} recorded runs in the bounded parent selection. Unprocessed history remains partial.`,
      ...(invalidIds.length ? [`Invalid parent measurements omitted: ${invalidIds.join(", ")}`] : []),
      "No source revision can rule out child changes during or after extraction. This is a dated manual analysis, not a claim that all historical telemetry is current."];
    const result = await calculatePerformanceAnalysis({ asOf, timeZone, workouts: [...effective.values()],
      features: verified.map(f => f.feature), linkedRaces: supporting.linkedRaces, deviceVo2: supporting.deviceVo2,
      versions: PERFORMANCE_VERSIONS, ...PERFORMANCE_DEFAULTS,
      coverage: { window: coverageWindow, workouts: "partial", telemetry: "partial", deviceVo2: "partial", expectedWorkoutCount: null, limitations } });
    const payload = buildPerformanceSnapshotPayload({ result,
      reason: selected.some(id => review.candidates.find(c => c.workoutId === id)?.status !== "new") ? "reprocess_selected_workouts" : "analyze_new_workouts",
      calculationStartedAt, calculationCompletedAt: new Date().toISOString(), provenance: verified.map(f => f.feature.provenance) });
    // Actual receipt time is retained, but time passing within the same window is not new evidence.
    const publicationDigest = await hashPerformanceValue({ result: { ...result, asOf: null, evidenceDigest: null },
      workouts: [...effective.values()].sort((a,b) => comparePerformanceKeys(a.workoutId, b.workoutId)),
      features: verified.map(f => ({ ...f.feature, extractedAt: null })).sort((a,b) => comparePerformanceKeys(a.workoutId, b.workoutId)) });
    report("Publishing current summary and immutable calculation receipt");
    const published = await publishPerformance(session, { payload, publicationDigest,
      expectedCurrentRevision: review.expectedCurrentRevision, features: verified });
    documentReads += published.documentsRead;
    assertPerformanceSession(session);
    report(published.snapshotCreated ? "Published a new historical snapshot" : "Evidence unchanged; retained the existing snapshot");
    return { current: published.current, snapshotCreated: published.snapshotCreated,
      processedWorkoutIds, skippedWorkoutIds, documentReads: documentReads + budget.documentsRead };
  } finally { activeUpdates.delete(session.uid); }
}
