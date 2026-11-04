/** Parent-only, bounded, deterministic assessment. No acquisition or extraction. */
import type { HealthWorkout } from "@/types/healthWorkout";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";
import type { PerformanceFreshness, PerformanceFreshnessInput, PerformanceMetadataObservation } from "@/types/performanceFreshness";
import { isPerformanceInstant, performanceLocalDate, performanceObservationWindow } from "./performanceEvidence";

// Match the existing manual workflow: parents before run filtering; 180 calendar days.
export const PERFORMANCE_FRESHNESS_PARENT_LIMIT = 300;
const OBSERVATION_DAYS = 180;

function parents(workouts: readonly HealthWorkout[]) {
  return [...workouts].sort((a, b) => b.startDate.getTime() - a.startDate.getTime()).slice(0, PERFORMANCE_FRESHNESS_PARENT_LIMIT);
}

/** Relevant source values only. A sync/override timestamp by itself is not a correction.
 * Derived aggregate/load caches, titles and badges are not measured inputs. */
function sourceBasis(workout: HealthWorkout, override: WorkoutOverride | undefined): string {
  return JSON.stringify([
    workout.startDate.getTime(), workout.endDate.getTime(), workout.isRunLike,
    workout.activityType, workout.displayType, workout.distanceMiles, workout.distanceMeters,
    workout.durationSeconds, workout.avgHeartRate, workout.elevationGainM,
    workout.hasRoute, workout.routeComplete ?? null, workout.hasHRStream ?? null,
    workout.sourceName, workout.sourceBundle ?? null, workout.entrySource ?? null,
    workout.weather?.tempF ?? null, workout.weather?.dewPointF ?? null, workout.weather?.windMph ?? null,
    override?.isExcluded ?? false, override?.distanceMilesOverride ?? null,
    override?.durationSecondsOverride ?? null, override?.runTypeOverride ?? null,
  ]);
}

export function observePerformanceMetadata(input: Omit<PerformanceFreshnessInput, "observation">): PerformanceMetadataObservation | null {
  const publication = input.evidence.evidence?.value.publication;
  if (!publication?.publicationDigest || !isPerformanceInstant(input.now)
    || !Object.values(input.sources).every(source => source.hasLoaded && source.resolution === "success")) return null;
  const loaded = parents(input.workouts);
  return {
    publicationDigest: publication.publicationDigest, observedAt: input.now,
    records: Object.fromEntries(loaded.map(workout => [workout.workoutId, {
      startedAt: workout.startDate.getTime(), basis: sourceBasis(workout, input.overrides[workout.workoutId]), isRun: workout.isRunLike,
    }])),
    absenceEstablishedFrom: loaded.length >= PERFORMANCE_FRESHNESS_PARENT_LIMIT
      ? loaded.at(-1)!.startDate.getTime()
      : input.workoutsHistoryComplete ? -Infinity : null,
  };
}

export function assessPerformanceFreshness(input: PerformanceFreshnessInput): PerformanceFreshness {
  const { evidence, sources } = input;
  const result: PerformanceFreshness = {
    status: "checking", newWorkoutIds: [], newlyVisibleWorkoutIds: [], changedWorkoutIds: [],
    incompleteWorkoutIds: [], uncertainWorkoutIds: [], evidenceCutoff: evidence.evidence?.metadata.evidenceCutoff ?? null,
    limitations: [
      "Only loaded records within the newest 300 workout parents and manual 180-day observation scope are checked.",
      "Parent flags cannot verify GPS/HR completeness or detect child-only corrections. Detailed processing requires your confirmation.",
      "Same-day refresh covers a seven-day overlap; older late arrivals require the existing full reconciliation or manual refresh.",
    ],
    refreshFailed: evidence.retrieval.status === "error" || Object.values(sources).some(source => source.resolution === "error"),
  };
  if (evidence.availability === "absent") {
    result.status = Object.values(sources).some(source => source.resolution === "error") ? "unable_to_verify" : "no_saved_analysis"; return result;
  }
  if (!evidence.evidence) {
    result.status = evidence.availability === "unavailable" ? "unable_to_verify" : "checking";
    return result;
  }
  if (Object.values(sources).some(source => !source.hasLoaded)) {
    result.status = Object.values(sources).some(source => source.resolution === "error") ? "unable_to_verify" : "checking";
    return result;
  }
  const { analysis, publication } = evidence.evidence.value;
  const cutoff = result.evidenceCutoff;
  if (!cutoff || !isPerformanceInstant(cutoff) || !isPerformanceInstant(input.now)) {
    result.status = "unable_to_verify"; result.limitations.push("A usable calculation cutoff or current assessment date is unavailable."); return result;
  }
  let window: { startDate: string; endDate: string };
  try { window = performanceObservationWindow(input.now, analysis.timeZone, OBSERVATION_DAYS); }
  catch { result.status = "unable_to_verify"; result.limitations.push("The saved observation timezone is unavailable."); return result; }
  const manifest = publication.featureRevisions;
  const incorporated = new Set(manifest?.map(feature => feature.workoutId) ?? []);
  const knownUnusable = new Set([...analysis.completeness.unresolvedWorkoutIds, ...analysis.completeness.rejectedWorkoutIds]);
  const observation = input.observation?.publicationDigest === publication.publicationDigest ? input.observation : null;
  if (!manifest) result.limitations.push("The saved feature manifest is unavailable; missing membership cannot establish new evidence.");
  result.limitations.push("Saved feature revisions contain no prior parent digest. Initial historical corrections cannot be verified; changes observed later in this session are identified separately.");
  if (evidence.evidence.metadata.coverage.workouts !== "complete" || !input.workoutsHistoryComplete) {
    result.limitations.push("Source/evidence coverage is bounded or partial; absence is not proof of complete history.");
  }
  for (const workout of parents(input.workouts)) {
    const start = workout.startDate.getTime(), end = workout.endDate.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const day = performanceLocalDate(workout.startDate.toISOString(), analysis.timeZone);
    if (day < window.startDate || day > window.endDate) continue;
    const previous = observation?.records[workout.workoutId];
    const override = input.overrides[workout.workoutId];
    if (!workout.isRunLike && !previous?.isRun) continue;
    const changed = previous && previous.basis !== sourceBasis(workout, override);
    if (changed) result.changedWorkoutIds.push(workout.workoutId);
    if (!workout.isRunLike || override?.isExcluded) continue;
    const effective = applyOverride(workout, override ?? null);
    if (workout.routeComplete === false || end > Date.parse(input.now)) {
      result.incompleteWorkoutIds.push(workout.workoutId); continue;
    }
    const meters = effective.distanceMeters ?? effective.distanceMiles * 1609.344;
    if (start >= end || effective.durationSeconds <= 0 || !Number.isFinite(effective.durationSeconds)
      || meters <= 0 || !Number.isFinite(meters)) {
      result.uncertainWorkoutIds.push(workout.workoutId); continue;
    }
    if (changed || incorporated.has(workout.workoutId)) continue;
    if (manifest && end > Date.parse(cutoff)) { result.newWorkoutIds.push(workout.workoutId); continue; }
    // Newly visible is a session observation, not a claimed source creation time.
    if (manifest && observation && !previous && observation.absenceEstablishedFrom !== null
      && start > observation.absenceEstablishedFrom) {
      result.newlyVisibleWorkoutIds.push(workout.workoutId); continue;
    }
    if (!knownUnusable.has(workout.workoutId)) result.uncertainWorkoutIds.push(workout.workoutId);
  }
  result.status = result.newWorkoutIds.length + result.newlyVisibleWorkoutIds.length + result.changedWorkoutIds.length > 0
    ? "update_available" : result.incompleteWorkoutIds.length ? "incomplete_sync"
    : result.uncertainWorkoutIds.length || !manifest || result.refreshFailed ? "unable_to_verify"
    : Object.values(sources).some(source => source.resolution === "loading") ? "checking" : "no_detected_changes";
  if (result.refreshFailed) result.limitations.push("A source request failed. The previous dated analysis and resident workout records are retained; latest changes could not be verified.");
  return result;
}
