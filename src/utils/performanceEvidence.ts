import type { HealthWorkout } from "@/types/healthWorkout";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";
import type {
  EffectivePerformanceWorkout, ManualWorkoutSelection, PerformanceCoverage,
  PerformanceQualityPolicy, PerformanceVersions, PerformanceWindow, TelemetryVerification, WorkoutPerformanceFeature,
} from "@/types/performanceAnalysis";

/** Canonical JSON rejects lossy values rather than silently dropping evidence. */
export function canonicalizePerformanceValue(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalizePerformanceValue).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalizePerformanceValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("Performance evidence must contain only finite JSON values with explicit nulls");
}

export async function hashPerformanceValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizePerformanceValue(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function isPerformanceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isPerformanceInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function performanceLocalDate(instant: string, timeZone: string): string {
  if (!isPerformanceInstant(instant)) throw new TypeError("Expected a valid UTC performance instant");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Calendar arithmetic on date keys: no host timezone or 24-hour DST assumptions. */
export function shiftPerformanceDate(date: string, days: number): string {
  if (!isPerformanceDate(date) || !Number.isSafeInteger(days)) throw new TypeError("Invalid performance date shift");
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function performanceObservationWindow(asOf: string, timeZone: string, days: number): PerformanceWindow {
  if (!Number.isSafeInteger(days) || days < 1 || days > 180) throw new TypeError("Observation days must be 1–180");
  const endDate = performanceLocalDate(asOf, timeZone);
  return { startDate: shiftPerformanceDate(endDate, 1 - days), endDate };
}

export function performanceComparisonWindows(asOf: string, timeZone: string, days: number): { currentWindow: PerformanceWindow; referenceWindow: PerformanceWindow } {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new TypeError("Comparison days must be 1–90");
  const currentWindow = performanceObservationWindow(asOf, timeZone, days);
  const referenceEnd = shiftPerformanceDate(currentWindow.startDate, -1);
  return { currentWindow, referenceWindow: { startDate: shiftPerformanceDate(referenceEnd, 1 - days), endDate: referenceEnd } };
}

export function workoutIsCompletedAsOf(workout: EffectivePerformanceWorkout, asOf: string): boolean {
  return !workout.excluded && workout.isRun && workout.completion === "completed"
    && isPerformanceInstant(asOf) && isPerformanceInstant(workout.startedAt) && isPerformanceInstant(workout.endedAt)
    && Date.parse(workout.startedAt) < Date.parse(workout.endedAt) && Date.parse(workout.endedAt) <= Date.parse(asOf)
    && (workout.availableAt === null || (isPerformanceInstant(workout.availableAt) && Date.parse(workout.availableAt) <= Date.parse(asOf)))
    && workout.distanceMeters !== null && Number.isFinite(workout.distanceMeters) && workout.distanceMeters > 0
    && workout.durationSeconds !== null && Number.isFinite(workout.durationSeconds) && workout.durationSeconds > 0;
}

export function hasVerifiedTelemetry(workout: EffectivePerformanceWorkout): boolean {
  return (workout.telemetry.state === "complete" || workout.telemetry.state === "absent")
    && workout.telemetry.verification === "supplied_content" && /^[a-f0-9]{64}$/.test(workout.telemetry.contentDigest ?? "");
}

export async function buildWorkoutInputDigest(workout: EffectivePerformanceWorkout): Promise<string> {
  return hashPerformanceValue(workout);
}

/** Identical repeats collapse; conflicting same-ID evidence is unresolved, never last-write-wins. */
export function uniquePerformanceRecords<T>(records: readonly T[], key: (record: T) => string): { records: T[]; conflictingIds: string[] } {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const id = key(record);
    grouped.set(id, [...(grouped.get(id) ?? []), record]);
  }
  const result: T[] = [];
  const conflictingIds: string[] = [];
  for (const id of [...grouped.keys()].sort()) {
    const group = grouped.get(id)!;
    if (new Set(group.map(canonicalizePerformanceValue)).size === 1) result.push(group[0]);
    else conflictingIds.push(id);
  }
  return { records: result, conflictingIds };
}

/** Pure source adapter. Completion and child verification must be explicitly supplied. */
export async function toEffectivePerformanceWorkout(input: {
  workout: HealthWorkout;
  override: WorkoutOverride | null;
  completion: EffectivePerformanceWorkout["completion"];
  availableAt: string | null;
  telemetry?: TelemetryVerification;
}): Promise<EffectivePerformanceWorkout> {
  const { workout, override } = input;
  if (override && override.workoutId !== workout.workoutId) throw new TypeError("Override workout ID mismatch");
  if (!workout.workoutId || !Number.isFinite(workout.startDate.getTime()) || !Number.isFinite(workout.endDate.getTime())) throw new TypeError("Invalid workout identity/date");
  if (input.availableAt !== null && !isPerformanceInstant(input.availableAt)) throw new TypeError("Invalid availability instant");
  const effective = applyOverride(workout, override);
  const finite = (value: number | null | undefined): number | null => {
    if (value == null) return null;
    if (!Number.isFinite(value)) throw new TypeError("Nonfinite source measurement");
    return value;
  };
  const raw = {
    workoutId: workout.workoutId, startedAt: workout.startDate.toISOString(), endedAt: workout.endDate.toISOString(),
    isRun: workout.isRunLike, activityType: workout.activityType, displayType: workout.displayType,
    distanceMiles: finite(workout.distanceMiles), distanceMeters: finite(workout.distanceMeters), durationSeconds: finite(workout.durationSeconds),
    averageHrBpm: finite(workout.avgHeartRate), ascentMeters: finite(workout.elevationGainM),
    routeComplete: workout.routeComplete ?? null, hasRoute: workout.hasRoute,
    sourceName: workout.sourceName, sourceBundle: workout.sourceBundle ?? null,
    environment: { temperatureF: finite(workout.weather?.tempF), dewPointF: finite(workout.weather?.dewPointF), windMph: finite(workout.weather?.windMph) },
  };
  const changes = { excluded: override?.isExcluded ?? false, distanceMiles: finite(override?.distanceMilesOverride), durationSeconds: finite(override?.durationSecondsOverride), runType: override?.runTypeOverride ?? null };
  const telemetry = workout.routeComplete === false
    ? { state: "pending" as const, contentDigest: null, verification: "unverified" as const }
    : input.telemetry ?? { state: "unknown" as const, contentDigest: null, verification: "unverified" as const };
  const limitations = ["Parent route/HR flags do not verify child completeness or detect child-only changes."];
  if (input.availableAt === null) limitations.push("Original source availability is unknown; historical reconstruction uses current metadata.");
  if ([override?.distanceMilesOverride, override?.durationSecondsOverride].some(v => v != null && !Number.isFinite(v))) throw new TypeError("Nonfinite workout override");
  return {
    workoutId: workout.workoutId, startedAt: raw.startedAt, endedAt: raw.endedAt, availableAt: input.availableAt,
    completion: input.completion, excluded: changes.excluded, isRun: effective.isRunLike,
    runKind: /treadmill/i.test(effective.activityType + effective.displayType) ? "treadmill" : /run|outdoor/i.test(effective.activityType + effective.displayType) ? "outdoor" : "other",
    distanceMeters: finite(effective.distanceMeters ?? effective.distanceMiles * 1609.344), durationSeconds: finite(effective.durationSeconds),
    averageHrBpm: finite(effective.avgHeartRate), ascentMeters: finite(effective.elevationGainM), environment: raw.environment,
    parentDigest: await hashPerformanceValue({ raw, changes }), telemetry: { ...telemetry },
    provenance: { source: workout.sourceName || null, sourceId: workout.workoutId, notes: ["HealthKit workout with canonical user overrides applied."] }, limitations,
  };
}

export async function selectWorkoutsForManualAnalysis(input: {
  workouts: readonly EffectivePerformanceWorkout[]; features: readonly WorkoutPerformanceFeature[];
  versions: PerformanceVersions; asOf: string; forcedWorkoutIds?: readonly string[];
  qualityPolicy: PerformanceQualityPolicy;
}): Promise<ManualWorkoutSelection[]> {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("Invalid analysis instant");
  const forced = new Set(input.forcedWorkoutIds ?? []);
  if (input.qualityPolicy.version !== input.versions.qualityPolicy) throw new TypeError("Quality policy/version mismatch");
  const policyDigest = await hashPerformanceValue(input.qualityPolicy);
  const workouts = uniquePerformanceRecords(input.workouts, w => w.workoutId);
  const features = uniquePerformanceRecords(input.features.map(f => ({ ...f, extractedAt: "" })), f => f.workoutId);
  const result: ManualWorkoutSelection[] = workouts.conflictingIds.map(workoutId => ({ workoutId, action: "review", reason: "conflicting_workout_evidence", requireFreshTelemetry: true }));
  for (const workout of workouts.records) {
    let selection: Omit<ManualWorkoutSelection, "workoutId">;
    const feature = features.records.find(f => f.workoutId === workout.workoutId);
    if (workout.excluded || !workout.isRun) selection = { action: "exclude", reason: "excluded_or_not_running", requireFreshTelemetry: false };
    else if (!workoutIsCompletedAsOf(workout, input.asOf)) selection = { action: "review", reason: "incomplete_invalid_or_future_workout", requireFreshTelemetry: true };
    else if (forced.has(workout.workoutId)) selection = { action: "extract", reason: "forced_reprocess", requireFreshTelemetry: true };
    else if (!feature) selection = { action: "extract", reason: features.conflictingIds.includes(workout.workoutId) ? "conflicting_features" : "missing_feature", requireFreshTelemetry: true };
    else if (feature.parentDigest !== workout.parentDigest) selection = { action: "extract", reason: "changed_parent_evidence", requireFreshTelemetry: true };
    else if (feature.extractorVersion !== input.versions.extractor || feature.qualityPolicyVersion !== input.versions.qualityPolicy || feature.qualityPolicyDigest !== policyDigest) selection = { action: "extract", reason: "incompatible_feature_version", requireFreshTelemetry: true };
    else if (!hasVerifiedTelemetry(workout)) selection = { action: "review", reason: "child_content_unverified", requireFreshTelemetry: true };
    else if (feature.sourceInputDigest !== await buildWorkoutInputDigest(workout) || feature.telemetryDigest !== workout.telemetry.contentDigest
      || feature.telemetryState !== workout.telemetry.state || feature.observedAt !== workout.startedAt) selection = { action: "extract", reason: "changed_source_inputs", requireFreshTelemetry: true };
    else if (feature.status === "unresolved" || feature.completion !== "completed") selection = { action: "extract", reason: "unresolved_feature", requireFreshTelemetry: true };
    else selection = { action: "reuse", reason: "verified_inputs_and_versions_match", requireFreshTelemetry: false };
    result.push({ workoutId: workout.workoutId, ...selection });
  }
  return result.sort((a, b) => comparePerformanceKeys(a.workoutId, b.workoutId));
}

export function coverageForPerformanceWindow(coverage: PerformanceCoverage, window: PerformanceWindow): PerformanceCoverage["workouts"] {
  if (coverage.workouts === "complete" && coverage.window.startDate <= window.startDate && coverage.window.endDate >= window.endDate) return "complete";
  return coverage.workouts === "unknown" ? "unknown" : "partial";
}

/** Host locale must not change evidence ordering or hashes. */
export function comparePerformanceKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
