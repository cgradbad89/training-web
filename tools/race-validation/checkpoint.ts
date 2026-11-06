import { CURRENT_HALF_POLICY, LEGACY_CURRENT_HALF_VERSION, type CurrentHalfVersion } from "@/utils/experimentalCurrentPerformance";
import { PERFORMANCE_VERSIONS } from "@/utils/performanceAnalysis";
import { canonicalizePerformanceValue, performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { raceEvaluationCutoff } from "@/utils/racePerformanceEvaluation";
import { normalizeRaceConfirmationHistory } from "@/utils/raceConfirmation";
import { WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import { normalizeWorkoutResearchExport } from "@/utils/workoutResearchInput";
import {
  PROTOCOL, HORIZONS, checkpointKey, choice, compareKeys, date, digest, fieldProjection,
  instant, key, list, readTarget, record, requireVersion, sha256, string,
  type Horizon, type RecordValue, type Target,
} from "./evidence";
import { modelVersionsFor, readCurrentHalfVersion, runModels } from "./models";

const COVERAGE = ["complete", "partial", "unknown"] as const;
const WORKOUT_FIELDS = [
  "workoutId", "startDate", "endDate", "syncedAt", "isRunLike", "distanceMiles", "distanceMeters",
  "durationSeconds", "displayType", "activityType", "sourceName", "avgHeartRate", "avgPaceSecPerMile",
  "elevationGainM", "routeClusterId", "weather", "hasRoute", "hasHRStream",
] as const;
const RACE_FIELDS = [
  "id", "name", "raceDate", "raceDistance", "customDistanceMiles", "createdAt", "actualRunId",
  "actualRunDate", "actualRunDistanceMiles", "actualRunDurationSeconds", "result", "performanceEvidence",
  "confirmationHistory",
] as const;
const OVERRIDE_FIELDS = [
  "workoutId", "isExcluded", "updatedAt", "distanceMilesOverride", "durationSecondsOverride",
  "runTypeOverride",
] as const;

export function checkpointSchedule(target: Target, horizon: Horizon) {
  const checkpointDate = shiftPerformanceDate(target.raceDate, -horizon);
  return { checkpointDate, cutoff: raceEvaluationCutoff(shiftPerformanceDate(checkpointDate, 1), target.timeZone) };
}

/** Pure scheduler and idempotency key. The caller owns its clock, read and any storage. */
export function dueCheckpoints(targets: readonly Target[], now: string) {
  const capturedAt = instant(now, "now");
  const due = new Map<string, { key: string; target: Target; horizon: Horizon; checkpointDate: string; cutoff: string }>();
  for (const target of targets.map(readTarget)) {
    const today = performanceLocalDate(capturedAt, target.timeZone);
    for (const horizon of HORIZONS) {
      const schedule = checkpointSchedule(target, horizon);
      if (schedule.checkpointDate !== today) continue;
      const id = checkpointKey(target, horizon);
      due.set(id, { key: id, target, horizon, ...schedule });
    }
  }
  return [...due.values()].sort((a, b) => compareKeys(a.key, b.key));
}

function nullableInstant(value: unknown, field: string) {
  return value == null ? null : instant(value, field);
}

function readWorkout(raw: RecordValue, id: string) {
  const doc = fieldProjection(raw, WORKOUT_FIELDS);
  if (doc.workoutId !== id || typeof doc.isRunLike !== "boolean") throw new TypeError(`Invalid workout identity or type: ${id}`);
  doc.startDate = instant(doc.startDate, `${id}.startDate`);
  doc.endDate = instant(doc.endDate, `${id}.endDate`);
  doc.syncedAt = nullableInstant(doc.syncedAt, `${id}.syncedAt`);
  for (const field of ["distanceMiles", "distanceMeters", "durationSeconds", "avgHeartRate", "avgPaceSecPerMile", "elevationGainM"]) {
    const value = doc[field];
    if (value != null && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`Invalid ${field}: ${id}`);
  }
  for (const field of ["displayType", "activityType", "sourceName", "routeClusterId"]) {
    if (doc[field] != null && typeof doc[field] !== "string") throw new TypeError(`Invalid ${field}: ${id}`);
  }
  if (doc.weather != null) {
    const weather = fieldProjection(record(doc.weather, `${id}.weather`),
      ["tempF", "humidity", "windMph", "conditionCode", "fetchedAt"]);
    for (const field of ["tempF", "humidity", "windMph", "conditionCode"]) {
      const value = weather[field];
      if (value != null && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`Invalid weather ${field}: ${id}`);
    }
    weather.fetchedAt = nullableInstant(weather.fetchedAt, `${id}.weather.fetchedAt`);
    doc.weather = weather;
  }
  return doc;
}

function readRace(raw: RecordValue, id: string) {
  const doc = fieldProjection(raw, RACE_FIELDS);
  if (doc.id !== id) throw new TypeError(`Invalid race identity: ${id}`);
  string(doc.name, `${id}.name`);
  doc.raceDate = date(doc.raceDate, `${id}.raceDate`);
  doc.createdAt = instant(doc.createdAt, `${id}.createdAt`);
  choice(doc.raceDistance, ["5K", "10K", "halfMarathon", "marathon", "custom"], `${id}.raceDistance`);
  if (doc.actualRunId != null) key(doc.actualRunId, `${id}.actualRunId`);
  if (doc.actualRunDate != null) date(doc.actualRunDate, `${id}.actualRunDate`);
  if (doc.result != null) string(doc.result, `${id}.result`);
  if (doc.performanceEvidence != null) {
    const confirmation = fieldProjection(record(doc.performanceEvidence, `${id}.performanceEvidence`), [
      "status", "kind", "knownAt", "raceDate", "distanceMeters", "finishSeconds", "effort", "conditions", "source", "timingReconciliation",
    ]);
    confirmation.knownAt = instant(confirmation.knownAt, `${id}.knownAt`);
    string(confirmation.source, `${id}.confirmationSource`);
    for (const field of ["conditions", "timingReconciliation"]) {
      if (confirmation[field] != null) string(confirmation[field], `${id}.${field}`);
    }
    choice(confirmation.effort, ["maximal", "hard", "nonmaximal", "unknown"], `${id}.effort`);
    doc.performanceEvidence = confirmation;
  }
  if (Object.hasOwn(doc, "confirmationHistory")) doc.confirmationHistory = normalizeRaceConfirmationHistory(doc.confirmationHistory);
  return doc;
}

function readOverride(raw: RecordValue, id: string, version: CurrentHalfVersion) {
  // Current confirmations bind exact override observations. Preserve the old
  // projection when reproducing a sealed v1 artifact.
  const doc = fieldProjection(raw, version === LEGACY_CURRENT_HALF_VERSION ? OVERRIDE_FIELDS
    : [...OVERRIDE_FIELDS, "userId", "excludedAt", "excludedReason"]);
  if (doc.workoutId !== id || typeof doc.isExcluded !== "boolean") throw new TypeError(`Invalid override identity or exclusion: ${id}`);
  const updatedAt = instant(doc.updatedAt, `${id}.updatedAt`);
  if (version === LEGACY_CURRENT_HALF_VERSION) doc.updatedAt = updatedAt;
  for (const field of ["userId", "excludedAt", "excludedReason"]) {
    if (doc[field] != null && typeof doc[field] !== "string") throw new TypeError(`Invalid override ${field}: ${id}`);
  }
  for (const field of ["distanceMilesOverride", "durationSecondsOverride"]) {
    const value = doc[field];
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new TypeError(`Invalid ${field}: ${id}`);
    }
  }
  if (doc.runTypeOverride != null) string(doc.runTypeOverride, `${id}.runTypeOverride`);
  return doc;
}

function readRevisions(value: unknown, name: string, capturedAt: string, readDoc: (doc: RecordValue, id: string) => RecordValue) {
  const rows = list(value, name).map(item => {
    const row = record(item, name);
    const id = key(row.id, `${name}.id`);
    const availableAt = instant(row.availableAt, `${name}.${id}.availableAt`);
    if (availableAt > capturedAt) throw new TypeError(`${name}.${id} revision became available after capture`);
    return { id, revision: string(row.revision, `${name}.${id}.revision`), availableAt, doc: readDoc(record(row.doc, `${name}.${id}.doc`), id) };
  });
  const byId = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const prior = byId.get(row.id);
    if (prior && digest(prior) !== digest(row)) throw new TypeError(`Conflicting ${name} revisions for ${row.id}`);
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => compareKeys(a.id, b.id));
}

function readFeatures(value: unknown) {
  const features = list(value, "features").map(item => {
    const row = record(item, "feature");
    return {
      workoutId: key(row.workoutId, "feature.workoutId"),
      parentRevision: string(row.parentRevision, "feature.parentRevision"),
      revision: string(row.revision, "feature.revision"),
      digest: sha256(row.digest, "feature.digest"),
      status: choice(row.status, ["accepted", "rejected", "unresolved"], "feature.status"),
      extractorVersion: string(row.extractorVersion, "feature.extractorVersion"),
      qualityPolicyVersion: string(row.qualityPolicyVersion, "feature.qualityPolicyVersion"),
      extractedAt: nullableInstant(row.extractedAt, "feature.extractedAt"),
      availableAt: nullableInstant(row.availableAt, "feature.availableAt"),
    };
  });
  if (new Set(features.map(feature => feature.workoutId)).size !== features.length) {
    throw new TypeError("Supply at most one selected feature revision per workout");
  }
  return features.sort((a, b) => compareKeys(a.workoutId, b.workoutId));
}

export function sealCheckpoint(value: unknown, version: CurrentHalfVersion = CURRENT_HALF_POLICY.version) {
  const request = record(value, "checkpoint input");
  requireVersion(request.protocol, PROTOCOL, "Checkpoint protocol");
  const target = readTarget(request.target);
  const horizon = HORIZONS.find(days => days === request.horizon);
  if (horizon === undefined) throw new TypeError("Unsupported checkpoint horizon");
  const { checkpointDate, cutoff } = checkpointSchedule(target, horizon);
  const capturedAt = instant(request.capturedAt, "capturedAt");
  if (capturedAt > cutoff || performanceLocalDate(capturedAt, target.timeZone) !== checkpointDate) {
    throw new TypeError(`Actual capture must be on ${checkpointDate} at or before cutoff ${cutoff}`);
  }
  const provenance = record(request.source, "source");
  const source = {
    kind: choice(provenance.kind, ["synthetic", "historical_capture", "prospective_capture"], "source.kind"),
    authorization: string(provenance.authorization, "source.authorization"),
    reference: string(provenance.reference, "source.reference"),
    codeRevision: string(provenance.codeRevision, "source.codeRevision"),
  };
  const supplied = record(request.coverage, "coverage");
  const coverage = {
    workouts: choice(supplied.workouts, COVERAGE, "coverage.workouts"),
    races: choice(supplied.races, COVERAGE, "coverage.races"),
    overrides: choice(supplied.overrides, COVERAGE, "coverage.overrides"),
    workoutsFrom: supplied.workoutsFrom == null ? null : date(supplied.workoutsFrom, "coverage.workoutsFrom"),
    limitations: list(supplied.limitations, "coverage.limitations").map(reason => string(reason, "coverage limitation")),
  };
  const raw = record(request.inputs, "inputs");
  const workouts = readRevisions(raw.workouts, "workouts", capturedAt, readWorkout);
  const races = readRevisions(raw.races, "races", capturedAt, readRace);
  const overrides = readRevisions(raw.overrides, "overrides", capturedAt, (doc, id) => readOverride(doc, id, version));
  const features = readFeatures(raw.features ?? []);

  const exclusions: { source: string; id: string; reason: string }[] = [];
  const excluded = (source: string, id: string, reason: string) => {
    exclusions.push({ source, id, reason });
    return false;
  };
  const heldOutWorkout = races.find(row => row.id === target.raceId)?.doc.actualRunId;
  const workoutRows = workouts.filter(({ id, doc }) => {
    if (id === heldOutWorkout) return excluded("workout", id, "held_out_workout");
    if (performanceLocalDate(doc.startDate as string, target.timeZone) >= target.raceDate) {
      return excluded("workout", id, "target_date_or_later");
    }
    if (!doc.syncedAt) return excluded("workout", id, "unknown_ingestion_timestamp");
    if ((doc.syncedAt as string) > capturedAt) return excluded("workout", id, "ingested_after_capture");
    if ((doc.endDate as string) > capturedAt) return excluded("workout", id, "incomplete_at_capture");
    return true;
  });
  const raceRows = races.filter(({ id, doc }) => {
    if (id === target.raceId || (doc.raceDate as string) >= target.raceDate) return excluded("race", id, "target_date_or_later");
    if ((doc.createdAt as string) > capturedAt) return excluded("race", id, "race_created_after_capture");
    return true;
  });

  const coverageReasons: string[] = [];
  for (const scope of ["workouts", "races", "overrides"] as const) {
    if (coverage[scope] !== "complete") coverageReasons.push(`Incomplete ${scope} scope (${coverage[scope]})`);
  }
  const earliest = shiftPerformanceDate(checkpointDate, -CURRENT_HALF_POLICY.maximumAnchorDays - WORKOUT_RESEARCH_POLICY.baselineDays);
  if (!coverage.workoutsFrom || coverage.workoutsFrom > earliest) coverageReasons.push(`Workout scope must start by ${earliest}`);
  // A later correction cannot stand for the unknown effective override at capture.
  for (const row of overrides) {
    if (Date.parse(row.doc.updatedAt as string) > Date.parse(capturedAt)) coverageReasons.push(`Override ${row.id} has a post-capture revision`);
  }
  const inputs = normalizeWorkoutResearchExport({
    capturedAt, asOf: capturedAt, timeZone: target.timeZone,
    healthWorkouts: workoutRows.map(({ id, doc }) => ({ id, doc })),
    halfMarathonRaces: raceRows.map(({ id, doc }) => ({ id, doc })),
    workoutOverrides: overrides.map(({ id, doc }) => ({ id, doc })),
  });
  const results = runModels(inputs, coverageReasons, version);
  const eligible = new Set(results.eligibleWorkoutIds);
  const parentRevisions = new Map(workouts.map(row => [row.id, row.revision]));
  const featureChecks = features.map(feature => {
    const reasons: string[] = [];
    if (!feature.availableAt || !feature.extractedAt || feature.extractedAt > feature.availableAt || feature.availableAt > capturedAt) {
      reasons.push("No trustworthy pre-capture feature date");
    }
    if (!eligible.has(feature.workoutId) || parentRevisions.get(feature.workoutId) !== feature.parentRevision) {
      reasons.push("No matching eligible parent revision");
    }
    if (feature.status !== "accepted") reasons.push("Feature is not accepted");
    if (feature.extractorVersion !== PERFORMANCE_VERSIONS.extractor || feature.qualityPolicyVersion !== PERFORMANCE_VERSIONS.qualityPolicy) {
      reasons.push("Incompatible extractor or quality policy");
    }
    return { workoutId: feature.workoutId, revision: feature.revision, status: reasons.length ? "ineligible" : "compatible_reference_only", reasons };
  });
  const capture = {
    protocol: PROTOCOL, key: checkpointKey(target, horizon), target, horizon, checkpointDate, cutoff, capturedAt, source,
    coverage, inputs: { workouts, races, overrides, features },
  };
  const payload = {
    ...capture, inputDigest: digest(capture),
    predictionType: "current_capability_checkpoint", modelVersions: modelVersionsFor(version),
    results: { ...results, inputExclusions: exclusions, coverageReasons, featureChecks },
  };
  return { ...payload, integrityDigest: digest(payload) };
}

export type Checkpoint = ReturnType<typeof sealCheckpoint>;

export function replayCheckpoint(value: unknown): Checkpoint {
  const saved = record(value, "checkpoint");
  const { integrityDigest, ...payload } = saved;
  requireVersion(payload.protocol, PROTOCOL, "Checkpoint protocol");
  const versions = record(payload.modelVersions, "Checkpoint model versions");
  const version = readCurrentHalfVersion(versions.experimental);
  if (canonicalizePerformanceValue(versions) !== canonicalizePerformanceValue(modelVersionsFor(version))) {
    throw new TypeError("Checkpoint model-version mismatch");
  }
  if (sha256(integrityDigest, "integrityDigest") !== digest(payload)) throw new TypeError("Checkpoint integrity digest mismatch");
  const replayed = sealCheckpoint(payload, version);
  if (replayed.integrityDigest !== integrityDigest) throw new TypeError("Checkpoint did not replay identically");
  return replayed;
}
