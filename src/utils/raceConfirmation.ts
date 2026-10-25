import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RaceConfirmationDraft, RaceConfirmationHistory, RaceConfirmationObservations, RaceConfirmationRevision, SaveRaceConfirmationInput } from "@/types/raceConfirmation";
import { canonicalizePerformanceValue, isPerformanceDate, isPerformanceInstant, performanceLocalDate } from "@/utils/performanceEvidence";

export const MAX_RACE_CONFIRMATION_REVISIONS = 50;
export const MAX_RACE_CONFIRMATION_BYTES = 700_000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const validRequestId = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value)
  && !has(Object.prototype, value) && value !== "prototype";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalNumber = (value: unknown): number | null => value == null ? null : finite(value) ? value : (() => { throw new Error("Invalid numerical race observation."); })();
const optionalString = (value: unknown): string | null => value == null ? null : typeof value === "string" ? value : (() => { throw new Error("Invalid text race observation."); })();

export function isRaceConfirmationDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500 && !value.includes("/") && value !== "." && value !== "..";
}

/** Never replace an unresolved or malformed timestamp with a browser clock. */
export function raceConfirmationInstant(value: unknown, roundAvailabilityUp = false): string | null {
  try {
    if (typeof value === "string") return isPerformanceInstant(value) ? new Date(value).toISOString() : null;
    if (typeof value === "number" && Number.isFinite(value)) return raceConfirmationInstant(new Date(value));
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (value && typeof value === "object") {
      const raw = value as Record<string, unknown>;
      const seconds = raw.seconds ?? raw._seconds;
      const nanos = raw.nanoseconds ?? raw._nanoseconds ?? 0;
      if (finite(seconds) && Number.isInteger(seconds) && finite(nanos) && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9) {
        // Receipt availability rounds UP; observations match the existing SDK
        // loader's toDate truncation so raw and already-loaded parents compare.
        return raceConfirmationInstant(new Date(seconds * 1000 + (roundAvailabilityUp ? Math.ceil(nanos / 1e6) : Math.floor(nanos / 1e6))));
      }
      if ("toDate" in value && typeof value.toDate === "function") return raceConfirmationInstant(value.toDate());
    }
  } catch { /* Unresolved/invalid is unusable, never inferred. */ }
  return null;
}

function raceDate(value: unknown): string {
  if (typeof value === "string" && isPerformanceDate(value)) return value;
  const instant = raceConfirmationInstant(value);
  if (!instant) throw new Error("Race date is invalid.");
  return instant.slice(0, 10);
}

export function raceConfirmationNominalMeters(race: Pick<Race, "raceDistance" | "customDistanceMiles">): number | null {
  const standards = { "5K": 5000, "10K": 10000, halfMarathon: 21097.5, marathon: 42195 };
  if (race.raceDistance === "custom") return finite(race.customDistanceMiles) && race.customDistanceMiles > 0 ? race.customDistanceMiles * 1609.344 : null;
  return standards[race.raceDistance] ?? null;
}

export function getRaceConfirmationExpectedRevision(race: Race): string | null {
  if (!has(race, "confirmationHistory")) return null;
  const history = normalizeRaceConfirmationHistory(race.confirmationHistory);
  if (!history) throw new Error("Saved confirmation history is invalid. No confirmation can overwrite it.");
  return history.currentRevisionId;
}

/** The token covers every observation used to validate confirmation; background
 * caches and unrelated plan/goal presentation fields are deliberately excluded. */
export function buildRaceConfirmationSnapshot(race: Race, workout: HealthWorkout, override: WorkoutOverride | null, timeZone: string) {
  const started = raceConfirmationInstant(workout.startDate);
  const ended = raceConfirmationInstant(workout.endDate);
  if (!started || !ended || Date.parse(ended) <= Date.parse(started)) throw new Error("The linked workout needs valid start and end timestamps.");
  if (!isRaceConfirmationDocumentId(race.id) || !isRaceConfirmationDocumentId(workout.workoutId)
    || race.actualRunId !== workout.workoutId) throw new Error("The linked workout identity does not match this race.");
  if (!workout.isRunLike || !finite(workout.durationSeconds) || workout.durationSeconds <= 0
    || !finite(workout.distanceMiles) || workout.distanceMiles <= 0) throw new Error("The linked workout needs valid running distance and duration.");
  if (override && (override.workoutId !== workout.workoutId || override.isExcluded)) throw new Error("The linked workout override is mismatched or excluded.");
  const date = raceDate(race.raceDate);
  if (performanceLocalDate(started, timeZone) !== date) throw new Error("The linked workout date does not match this race.");
  const observations: RaceConfirmationObservations = {
    timeZone,
    race: {
      id: race.id, name: race.name, raceDate: date, raceDistance: race.raceDistance,
      customDistanceMiles: optionalNumber(race.customDistanceMiles), actualRunId: race.actualRunId ?? null,
      actualRunDate: optionalString(race.actualRunDate), actualRunDistanceMiles: optionalNumber(race.actualRunDistanceMiles),
      actualRunDurationSeconds: optionalNumber(race.actualRunDurationSeconds), result: optionalString(race.result),
      createdAt: raceConfirmationInstant(race.createdAt), performanceEvidence: race.performanceEvidence ?? null,
    },
    workout: {
      workoutId: workout.workoutId, startDate: started, endDate: ended,
      durationSeconds: workout.durationSeconds, distanceMiles: workout.distanceMiles,
      distanceMeters: optionalNumber(workout.distanceMeters), isRunLike: workout.isRunLike,
      activityType: workout.activityType ?? "", syncedAt: raceConfirmationInstant(workout.syncedAt),
    },
    override: override ? {
      workoutId: override.workoutId, userId: override.userId, isExcluded: override.isExcluded,
      excludedAt: optionalString(override.excludedAt), excludedReason: optionalString(override.excludedReason),
      distanceMilesOverride: optionalNumber(override.distanceMilesOverride), durationSecondsOverride: optionalNumber(override.durationSecondsOverride),
      runTypeOverride: optionalString(override.runTypeOverride), updatedAt: override.updatedAt,
    } : null,
  };
  return { observations, snapshotToken: canonicalizePerformanceValue(observations), expectedRevisionId: getRaceConfirmationExpectedRevision(race) };
}

function boundedText(value: unknown, label: string, max: number, required = true): string | null {
  if (value == null && !required) return null;
  if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return value.trim() || null;
}

/** Same recorded-text grammar as the Phase 3A evaluator; this module cannot
 * import that evaluator because the evaluator validates confirmation history. */
function recordedRaceResultSeconds(result: string | null): number | null {
  if (!result || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(result.trim())) return null;
  const parts = result.trim().split(":").map(Number);
  if (parts.at(-1)! >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return seconds > 0 ? seconds : null;
}

export function validateRaceConfirmationInput(input: SaveRaceConfirmationInput): void {
  if (!input || !isRaceConfirmationDocumentId(input.raceId) || !validRequestId(input.requestId)
    || (input.expectedRevisionId !== null && !validRequestId(input.expectedRevisionId))) throw new Error("Invalid confirmation identity or request ID.");
  const { details: d, observations: o } = input;
  if (!d || !o || input.snapshotToken !== canonicalizePerformanceValue(o) || o.race.id !== input.raceId
    || d.linkedWorkoutId !== o.race.actualRunId || d.linkedWorkoutId !== o.workout.workoutId) throw new Error("Confirmation does not match its original observations.");
  boundedText(d.officialEventName, "Official event name", 200);
  boundedText(d.conditions, "Conditions or limitations", 2000);
  boundedText(d.source, "Result URL or explicit owner attestation", 2000);
  boundedText(d.timingReconciliation, "Timing explanation", 2000, false);
  boundedText(input.correctionReason, "Correction reason", 2000, false);
  if (!["verified", "owner_confirmed"].includes(d.status) || d.kind !== "official_race"
    || !["maximal", "hard", "nonmaximal", "unknown"].includes(d.effort)
    || !["chip", "gun", "other"].includes(d.timeBasis)) throw new Error("Choose explicit verification, effort and finish-time categories.");
  if (d.status === "verified") {
    let url: URL;
    try { url = new URL(d.source); } catch { throw new Error("Official verification requires an HTTP(S) result URL."); }
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Official verification requires an HTTP(S) result URL without credentials.");
  } else {
    let bareUrl = false;
    try { bareUrl = ["https:", "http:"].includes(new URL(d.source).protocol) && !/\s/.test(d.source); } catch { /* Attestation prose is expected. */ }
    if (bareUrl) throw new Error("Owner confirmation requires explicit attestation text, not only a result URL.");
  }
  if (!isPerformanceDate(d.raceDate) || d.raceDate !== o.race.raceDate) throw new Error("Confirmed date must match the existing race identity.");
  const nominal = raceConfirmationNominalMeters({ raceDistance: o.race.raceDistance, customDistanceMiles: o.race.customDistanceMiles ?? undefined });
  if (!nominal || !finite(d.distanceMeters) || d.distanceMeters <= 0 || Math.abs(d.distanceMeters - nominal) > 5) throw new Error("Official distance must match the existing race distance; correct the race identity first.");
  if (!finite(d.finishSeconds) || !Number.isInteger(d.finishSeconds) || d.finishSeconds <= 0 || d.finishSeconds > 86400) throw new Error("Finish time must be a positive whole number of seconds, at most 24 hours.");
  const w = o.workout;
  if (!w.isRunLike || !isPerformanceInstant(w.startDate) || !isPerformanceInstant(w.endDate)
    || Date.parse(w.endDate) <= Date.parse(w.startDate) || !finite(w.durationSeconds) || w.durationSeconds <= 0
    || !finite(w.distanceMiles) || w.distanceMiles <= 0 || performanceLocalDate(w.startDate, o.timeZone) !== d.raceDate) throw new Error("Linked workout observations are invalid or belong to a different event date.");
  const override = o.override;
  if (override && (override.workoutId !== w.workoutId || override.isExcluded || !isRaceConfirmationDocumentId(override.userId))) throw new Error("The linked workout override is mismatched or excluded.");
  const effectiveMiles = override?.distanceMilesOverride ?? w.distanceMiles;
  // applyOverride replaces meters when miles are overridden; otherwise the
  // evaluator prefers a positive recorded meter value to the miles fallback.
  const effectiveMeters = override?.distanceMilesOverride != null ? override.distanceMilesOverride * 1609.344
    : finite(w.distanceMeters) && w.distanceMeters > 0 ? w.distanceMeters : effectiveMiles * 1609.344;
  const effectiveDuration = override?.durationSecondsOverride ?? w.durationSeconds;
  if (!finite(effectiveMiles) || effectiveMiles <= 0 || !finite(effectiveMeters) || effectiveMeters <= 0
    || Math.abs(effectiveMeters - nominal) / nominal > 0.05) throw new Error("Linked workout distance is inconsistent with the race distance.");
  if (!finite(effectiveDuration) || effectiveDuration <= 0) throw new Error("Linked workout duration is invalid.");
  const elapsed = (Date.parse(w.endDate) - Date.parse(w.startDate)) / 1000;
  const disagrees = (a: number, b: number) => Math.abs(a - b) > Math.max(60, Math.max(a, b) * 0.01);
  const entered = recordedRaceResultSeconds(o.race.result);
  const discrepant = disagrees(w.durationSeconds, elapsed) // Overrides cannot conceal an original observation conflict.
    || disagrees(effectiveDuration, elapsed)
    || disagrees(d.finishSeconds, effectiveDuration)
    || (entered !== null && disagrees(entered, effectiveDuration))
    || (o.race.actualRunDurationSeconds !== null && o.race.actualRunDurationSeconds > 0 && disagrees(o.race.actualRunDurationSeconds, effectiveDuration));
  if (discrepant && !d.timingReconciliation?.trim()) throw new Error("Recorded, elapsed or official timing differs. An explicit timing explanation is required; the shorter time is not assumed official.");
  if ((input.expectedRevisionId !== null || o.race.performanceEvidence !== null) && !input.correctionReason?.trim()) throw new Error("A correction reason is required when changing previously confirmed evidence.");
  if (new TextEncoder().encode(canonicalizePerformanceValue(input)).length > 30_000) throw new Error("Confirmation exceeds the bounded input size.");
}

export function buildRaceConfirmationInput(input: { race: Race; workout: HealthWorkout; override: WorkoutOverride | null; timeZone: string; draft: RaceConfirmationDraft; requestId: string }): SaveRaceConfirmationInput {
  const snapshot = buildRaceConfirmationSnapshot(input.race, input.workout, input.override, input.timeZone);
  const draft = input.draft;
  const result: SaveRaceConfirmationInput = {
    raceId: input.race.id, requestId: input.requestId, ...snapshot,
    details: {
      officialEventName: boundedText(draft.officialEventName, "Official event name", 200)!, raceDate: draft.raceDate,
      distanceMeters: draft.distanceMeters, finishSeconds: draft.finishSeconds, timeBasis: draft.timeBasis,
      status: draft.status, kind: "official_race", effort: draft.effort,
      conditions: boundedText(draft.conditions, "Conditions or limitations", 2000)!,
      source: boundedText(draft.source, "Result URL or explicit owner attestation", 2000)!,
      timingReconciliation: boundedText(draft.timingReconciliation, "Timing explanation", 2000, false),
      linkedWorkoutId: input.workout.workoutId,
    },
    correctionReason: boundedText(draft.correctionReason, "Correction reason", 2000, false),
  };
  validateRaceConfirmationInput(result);
  return JSON.parse(canonicalizePerformanceValue(result)) as SaveRaceConfirmationInput;
}

export function buildRaceConfirmationRevision(input: SaveRaceConfirmationInput, previous: RaceConfirmationHistory | null, availableAt: string | null): RaceConfirmationRevision {
  validateRaceConfirmationInput(input);
  if ((previous?.currentRevisionId ?? null) !== input.expectedRevisionId) throw new Error("Confirmation changed. Reload the race before submitting.");
  if (previous && Object.keys(previous.revisions).length >= MAX_RACE_CONFIRMATION_REVISIONS) throw new Error("Confirmation revision limit reached; existing evidence must not be discarded.");
  if (availableAt !== null && !isPerformanceInstant(availableAt)) throw new Error("Invalid confirmation receipt time.");
  if (availableAt !== null && (Date.parse(availableAt) < Date.parse(input.observations.workout.endDate)
    || performanceLocalDate(availableAt, input.observations.timeZone) < input.details.raceDate)) throw new Error("Confirmation cannot be available before the completed event.");
  const previousAvailableAt = previous?.revisions[previous.currentRevisionId]?.availableAt;
  if (previous && !previousAvailableAt) throw new Error("Previous confirmation receipt time is unresolved. Reload before correcting it.");
  if (availableAt !== null && previousAvailableAt && Date.parse(availableAt) < Date.parse(previousAvailableAt)) throw new Error("A correction cannot predate its previous confirmation.");
  const legacyKnownAt = input.observations.race.performanceEvidence?.knownAt;
  if (availableAt !== null && legacyKnownAt && isPerformanceInstant(legacyKnownAt) && Date.parse(availableAt) < Date.parse(legacyKnownAt)) throw new Error("A confirmation cannot predate the original evidence.");
  const latest = previous?.revisions[previous.currentRevisionId];
  if (latest?.snapshotToken === input.snapshotToken && canonicalizePerformanceValue(latest.details) === canonicalizePerformanceValue(input.details)) throw new Error("This exact evidence is already confirmed. No duplicate revision was added.");
  return {
    revisionId: input.requestId, requestId: input.requestId,
    revisionNumber: (previous?.revisions[previous.currentRevisionId]?.revisionNumber ?? 0) + 1,
    supersedesRevisionId: input.expectedRevisionId, availableAt,
    details: input.details, correctionReason: input.correctionReason,
    observations: input.observations, snapshotToken: input.snapshotToken,
  };
}

/** Normalize only receipt timestamps; do not repair missing provenance or silently
 * erase invalid history. Callers preserve null as an explicitly invalid history. */
export function normalizeRaceConfirmationHistory(value: unknown): RaceConfirmationHistory | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as RaceConfirmationHistory;
    if (raw.schemaVersion !== 1 || raw.chronology !== "client_document_untrusted" || !validRequestId(raw.currentRevisionId)
      || !raw.revisions || typeof raw.revisions !== "object" || Array.isArray(raw.revisions)) return null;
    const entries = Object.entries(raw.revisions);
    if (!entries.length || entries.length > MAX_RACE_CONFIRMATION_REVISIONS) return null;
    const revisions: Record<string, RaceConfirmationRevision> = {};
    for (const [id, revision] of entries) {
      if (!validRequestId(id) || !revision || revision.revisionId !== id || revision.requestId !== id
        || !Number.isSafeInteger(revision.revisionNumber) || revision.revisionNumber < 1) return null;
      const normalized = { ...revision, availableAt: raceConfirmationInstant(revision.availableAt, true) };
      validateRaceConfirmationInput({ raceId: revision.observations?.race.id, requestId: id,
        expectedRevisionId: revision.supersedesRevisionId, snapshotToken: revision.snapshotToken,
        observations: revision.observations, details: revision.details, correctionReason: revision.correctionReason });
      if (normalized.availableAt !== null && (Date.parse(normalized.availableAt) < Date.parse(revision.observations.workout.endDate)
        || performanceLocalDate(normalized.availableAt, revision.observations.timeZone) < revision.details.raceDate)) return null;
      const legacyKnownAt = revision.observations.race.performanceEvidence?.knownAt;
      if (normalized.availableAt !== null && legacyKnownAt && isPerformanceInstant(legacyKnownAt) && Date.parse(normalized.availableAt) < Date.parse(legacyKnownAt)) return null;
      revisions[id] = normalized;
    }
    const ordered = Object.values(revisions).sort((a, b) => a.revisionNumber - b.revisionNumber);
    if (ordered.some((r, i) => r.revisionNumber !== i + 1 || r.supersedesRevisionId !== (ordered[i - 1]?.revisionId ?? null))
      || ordered.at(-1)?.revisionId !== raw.currentRevisionId) return null;
    if (ordered.some((r, i) => i > 0 && r.availableAt !== null && ordered[i - 1].availableAt !== null
      && Date.parse(r.availableAt) < Date.parse(ordered[i - 1].availableAt!))) return null;
    const history: RaceConfirmationHistory = { schemaVersion: 1, chronology: "client_document_untrusted", currentRevisionId: raw.currentRevisionId, revisions };
    if (new TextEncoder().encode(canonicalizePerformanceValue(history)).length > MAX_RACE_CONFIRMATION_BYTES) return null;
    return history;
  } catch { return null; }
}
