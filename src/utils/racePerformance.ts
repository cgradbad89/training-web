/** Phase 3A: pure race evidence, with no telemetry reads, writes or fitness credits. */
import type { Race } from "@/types/race";
import type {
  RacePerformanceEvidence, RacePerformanceInput, RacePerformancePolicy,
  RacePerformanceResult, RaceResearchEquivalence,
} from "@/types/racePerformance";
import { isPerformanceDate, isPerformanceInstant, performanceLocalDate } from "@/utils/performanceEvidence";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";
import { selectRaceConfirmationEvidence } from "@/utils/raceConfirmationEvidence";
import { buildRaceConfirmationSnapshot } from "@/utils/raceConfirmation";

export const HALF_MARATHON_METERS = 21_097.5;
export const DEFAULT_RACE_PERFORMANCE_POLICY: Readonly<RacePerformancePolicy> = Object.freeze({
  version: "phase3a-integrity-screen-v1",
  staleAfterDays: 90,
  recordedDistanceToleranceFraction: 0.05,
  sameDistanceToleranceMeters: 5,
  timingToleranceSeconds: 60,
  timingToleranceFraction: 0.01,
  currentEstimator: "unvalidated",
  forecastEstimator: "unvalidated",
});

const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dateMs = (date: Date | null | undefined) => date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;
const daysBetween = (earlier: string, later: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

export function nominalRaceDistanceMeters(race: Pick<Race, "raceDistance" | "customDistanceMiles">): number | null {
  const standards = { "5K": 5_000, "10K": 10_000, halfMarathon: HALF_MARATHON_METERS, marathon: 42_195 };
  return race.raceDistance === "custom"
    ? positive(race.customDistanceMiles) ? race.customDistanceMiles * 1609.344 : null
    : standards[race.raceDistance] ?? null;
}

/** Entered text is recorded evidence, never inferred official verification. */
export function parseRaceResultSeconds(result: string | null | undefined): number | null {
  if (!result || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(result.trim())) return null;
  const parts = result.trim().split(":").map(Number);
  if (parts.at(-1)! >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
  const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  return positive(seconds) ? seconds : null;
}

function validatePolicy(input: RacePerformanceInput): RacePerformancePolicy {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("Expected a valid UTC as-of instant");
  performanceLocalDate(input.asOf, input.timeZone); // Validate the explicit local timezone.
  const policy = input.policy ?? DEFAULT_RACE_PERFORMANCE_POLICY;
  if (!policy.version || !Number.isSafeInteger(policy.staleAfterDays) || policy.staleAfterDays < 1
    || !positive(policy.recordedDistanceToleranceFraction) || policy.recordedDistanceToleranceFraction >= 1
    || !positive(policy.sameDistanceToleranceMeters) || !positive(policy.timingToleranceSeconds)
    || !positive(policy.timingToleranceFraction) || policy.timingToleranceFraction >= 1
    || policy.currentEstimator !== "unvalidated" || policy.forecastEstimator !== "unvalidated") {
    throw new TypeError("Invalid or unsupported race performance policy");
  }
  if (input.targetDistanceMeters !== undefined && !positive(input.targetDistanceMeters)) throw new TypeError("Invalid target distance");
  return policy;
}

/** Conflicting duplicate identities are rejected rather than selected by array order. */
function indexRecords<T>(records: readonly T[], id: (record: T) => string, signature: (record: T) => string) {
  const groups = new Map<string, T[]>();
  for (const record of records) groups.set(id(record), [...(groups.get(id(record)) ?? []), record]);
  return new Map([...groups].map(([key, group]) => [key, {
    record: group[0], conflict: new Set(group.map(signature)).size > 1,
  }]));
}

export function buildRaceEvidence(input: RacePerformanceInput): RacePerformanceEvidence[] {
  const policy = validatePolicy(input);
  const asOfMs = Date.parse(input.asOf);
  const asOfDate = performanceLocalDate(input.asOf, input.timeZone);
  const target = input.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const raceIndex = indexRecords(input.races, r => r.id, r => JSON.stringify([
    r.name, r.raceDate, r.raceDistance, r.customDistanceMiles, r.actualRunId, r.actualRunDate,
    r.actualRunDistanceMiles, r.actualRunDurationSeconds, r.result, r.createdAt,
    r.performanceEvidence && [r.performanceEvidence.status, r.performanceEvidence.kind, r.performanceEvidence.knownAt,
      r.performanceEvidence.raceDate, r.performanceEvidence.distanceMeters, r.performanceEvidence.finishSeconds,
      r.performanceEvidence.effort, r.performanceEvidence.conditions, r.performanceEvidence.source, r.performanceEvidence.timingReconciliation],
    r.confirmationHistory,
  ]));
  const workoutIndex = indexRecords(input.workouts, w => w.workoutId, w => JSON.stringify([
    dateMs(w.startDate), dateMs(w.endDate), dateMs(w.syncedAt), w.isRunLike, w.distanceMiles, w.distanceMeters, w.durationSeconds,
  ]));
  const linkedCount = new Map<string, number>();
  for (const { record: race } of raceIndex.values()) {
    if (race.actualRunId) linkedCount.set(race.actualRunId, (linkedCount.get(race.actualRunId) ?? 0) + 1);
  }
  const effective = new Map(selectEffectiveWorkouts([...input.workouts], input.overrides).map(w => [w.workoutId, w]));
  const evidence: RacePerformanceEvidence[] = [];
  for (const { record: race, conflict } of raceIndex.values()) {
    const reasons: string[] = [];
    let inconsistent = conflict;
    if (conflict) reasons.push("conflicting_race_records");
    const nominal = nominalRaceDistanceMeters(race);
    const dateValid = isPerformanceDate(race.raceDate);
    const raceInPast = dateValid && race.raceDate <= asOfDate;
    // Upcoming races belong in the outlook, not in demonstrated historical evidence.
    if (dateValid && !raceInPast) continue;
    if (!dateValid) reasons.push("invalid_race_date");
    if (!positive(nominal)) reasons.push("invalid_race_distance");
    const selected = selectRaceConfirmationEvidence(race, input.asOf, input.timeZone);
    reasons.push(...selected.reasons);
    if (selected.reasons.includes("invalid_confirmation_history")) inconsistent = true;
    // A saved Phase 3B history replaces the legacy input, including when invalid
    // or unavailable. Otherwise an old knownAt could bypass its weaker chronology.
    const confirmation = selected.present ? selected.confirmation : race.performanceEvidence;
    if (selected.present) reasons.push("confirmation_chronology_untrusted");
    if (selected.revision && selected.revision.details.linkedWorkoutId !== race.actualRunId) {
      reasons.push("confirmation_workout_identity_mismatch"); inconsistent = true;
    }
    const confirmationTimeValid = !!confirmation && isPerformanceInstant(confirmation.knownAt);
    const confirmationAvailable = confirmationTimeValid && Date.parse(confirmation!.knownAt) <= asOfMs;
    const raceCreatedValid = isPerformanceInstant(race.createdAt);
    const raceCreatedInFuture = raceCreatedValid && Date.parse(race.createdAt) > asOfMs;
    if (raceCreatedInFuture) reasons.push("race_record_not_available_as_of");
    if (confirmation && !confirmationAvailable) reasons.push(confirmationTimeValid ? "confirmation_not_available_as_of" : "unknown_confirmation_revision_time");
    if (input.asOfMode === "historical" && !confirmationAvailable) reasons.push("unversioned_race_metadata");

    // Future confirmations must not leak corrected time, distance, effort or status.
    const confirmed = confirmationAvailable ? confirmation : undefined;
    let confirmationValid = !!confirmed;
    if (confirmed && (!positive(confirmed.finishSeconds) || !positive(confirmed.distanceMeters)
      || !isPerformanceDate(confirmed.raceDate) || !confirmed.source?.trim()
      || performanceLocalDate(confirmed.knownAt, input.timeZone) < confirmed.raceDate
      || !["verified", "owner_confirmed"].includes(confirmed.status)
      || !["official_race", "race", "time_trial", "high_effort"].includes(confirmed.kind))) {
      reasons.push("invalid_confirmation"); confirmationValid = false;
    }
    if (confirmed && (confirmed.raceDate !== race.raceDate || !positive(nominal)
      || Math.abs(confirmed.distanceMeters - nominal!) > policy.sameDistanceToleranceMeters)) {
      reasons.push("confirmation_race_identity_mismatch"); inconsistent = true;
    }
    const rawLink = race.actualRunId ? workoutIndex.get(race.actualRunId) : undefined;
    const workout = race.actualRunId ? effective.get(race.actualRunId) : undefined;
    if (rawLink?.conflict) { reasons.push("conflicting_workout_records"); inconsistent = true; }
    if (race.actualRunId && (linkedCount.get(race.actualRunId) ?? 0) > 1) { reasons.push("workout_linked_to_multiple_races"); inconsistent = true; }
    const override = race.actualRunId ? input.overrides?.[race.actualRunId] : undefined;
    if (override && override.workoutId !== race.actualRunId) { reasons.push("override_identity_mismatch"); inconsistent = true; }
    if (override?.isExcluded) { reasons.push("linked_workout_excluded"); inconsistent = true; }
    if (race.actualRunId && !rawLink) reasons.push("linked_workout_unavailable");
    if (selected.revision) {
      try {
        // Reconciliation applies to these exact original observations. A later
        // same-ID workout/race/override edit requires a new owner review, never
        // automatic reuse of an earlier explanation or confirmed finish time.
        if (!rawLink || rawLink.conflict || selected.revision.observations.timeZone !== input.timeZone
          || buildRaceConfirmationSnapshot(race, rawLink.record, override ?? null, selected.revision.observations.timeZone).snapshotToken
            !== selected.revision.snapshotToken) throw new Error("Changed confirmation observations");
      } catch {
        reasons.push("confirmation_observations_changed"); inconsistent = true; confirmationValid = false;
      }
    }
    const startMs = dateMs(workout?.startDate);
    const endMs = dateMs(workout?.endDate);
    const syncedMs = dateMs(workout?.syncedAt);
    const overrideKnown = override ? isPerformanceInstant(override.updatedAt) ? Date.parse(override.updatedAt) : null : null;
    const workoutAvailable = !!workout && startMs !== null && endMs !== null && startMs < endMs && endMs <= asOfMs
      && syncedMs !== null && syncedMs <= asOfMs
      && (!override || overrideKnown !== null && overrideKnown <= asOfMs);
    if (workout && (!workoutAvailable || startMs === null || endMs === null || endMs > asOfMs)) reasons.push("workout_not_available_as_of");
    const recordedDistance = workout ? positive(workout.distanceMeters) ? workout.distanceMeters
      : positive(workout.distanceMiles) ? workout.distanceMiles * 1609.344 : null : null;
    const duration = positive(workout?.durationSeconds) ? workout.durationSeconds : null;
    const elapsed = startMs !== null && endMs !== null && endMs > startMs ? (endMs - startMs) / 1000 : null;
    const timingTolerance = (a: number, b: number) => Math.max(policy.timingToleranceSeconds, Math.max(a, b) * policy.timingToleranceFraction);
    let timingAgreement: RacePerformanceEvidence["timingAgreement"] = duration !== null && elapsed !== null
      ? Math.abs(duration - elapsed) <= timingTolerance(duration, elapsed) ? "consistent" : "discrepant" : "unknown";
    if (workout && (!workout.isRunLike || startMs === null || !dateValid || performanceLocalDate(new Date(startMs).toISOString(), input.timeZone) !== race.raceDate
      || race.actualRunDate && race.actualRunDate !== race.raceDate)) {
      reasons.push("race_workout_date_or_type_mismatch"); inconsistent = true;
    }
    if (workout && (!positive(recordedDistance) || !positive(nominal)
      || Math.abs(recordedDistance! - nominal!) / nominal! > policy.recordedDistanceToleranceFraction)) {
      reasons.push("race_workout_distance_mismatch"); inconsistent = true;
    }
    if (workout && (!duration || !elapsed)) reasons.push("missing_valid_workout_timing");
    const entered = parseRaceResultSeconds(race.result);
    const officialReconciled = confirmationValid && confirmed?.kind === "official_race" && !!confirmed.timingReconciliation?.trim();
    if (timingAgreement === "discrepant") {
      reasons.push("duration_elapsed_discrepancy");
      if (officialReconciled) timingAgreement = "reconciled";
      else inconsistent = true;
    }
    if (duration !== null && positive(race.actualRunDurationSeconds)
      && Math.abs(duration - race.actualRunDurationSeconds) > timingTolerance(duration, race.actualRunDurationSeconds)) {
      reasons.push("copied_workout_duration_discrepancy");
      if (!officialReconciled) inconsistent = true;
    }
    for (const recordedTime of [entered, confirmationValid ? confirmed?.finishSeconds : null]) {
      if (duration !== null && positive(recordedTime) && Math.abs(duration - recordedTime) > timingTolerance(duration, recordedTime)) {
        reasons.push("result_workout_timing_discrepancy");
        if (!officialReconciled) inconsistent = true;
      }
    }
    const availableAsOf = raceInPast && !raceCreatedInFuture && (input.asOfMode === "historical"
      ? !selected.present && confirmationValid && confirmationAvailable && (!workout || workoutAvailable)
      : (!workout || workoutAvailable));
    const linkedUsable = !!workout && workoutAvailable && duration !== null && elapsed !== null;
    const finishSeconds = confirmationValid ? confirmed!.finishSeconds : linkedUsable ? duration : entered;
    const effort = confirmationValid ? confirmed!.effort : "unknown";
    const conditions = confirmationValid ? confirmed!.conditions : null;
    if (!confirmationValid) reasons.push("official_result_and_effort_unverified");
    if (effort !== "maximal") reasons.push(effort === "nonmaximal" ? "nonmaximal_effort" : "maximal_effort_not_confirmed");
    if (!conditions?.trim()) reasons.push("conditions_not_confirmed");
    let status: RacePerformanceEvidence["status"] = confirmationValid ? confirmed!.status : linkedUsable || entered !== null ? "recorded_unverified" : "insufficient_evidence";
    if (!dateValid || !positive(nominal) || !positive(finishSeconds) || !availableAsOf) status = "insufficient_evidence";
    if (inconsistent) status = "inconsistent";
    const eligible = confirmationValid && availableAsOf && !inconsistent && dateValid && positive(nominal)
      && positive(finishSeconds) && effort === "maximal" && !!conditions?.trim();
    const ageDays = dateValid ? daysBetween(race.raceDate, asOfDate) : null;
    const stale = ageDays !== null && ageDays > policy.staleAfterDays;
    if (stale) reasons.push("historical_benchmark_not_current_capability");
    evidence.push({
      raceId: race.id, name: confirmationValid && selected.revision ? selected.revision.details.officialEventName : race.name,
      raceDate: race.raceDate, distanceMeters: nominal,
      finishSeconds, workoutId: race.actualRunId ?? null, recordedDistanceMeters: recordedDistance,
      durationSeconds: duration, elapsedSeconds: elapsed,
      timingBasis: confirmationValid ? "confirmed_result" : linkedUsable ? "recorded_workout_duration" : entered !== null ? "unverified_entered_result" : "none",
      timingAgreement, status,
      tier: confirmationValid ? confirmed!.kind === "official_race" ? "official_result" : confirmed!.kind === "high_effort" ? "identified_high_effort" : "confirmed_race_or_time_trial"
        : linkedUsable ? "linked_race_workout" : "insufficient",
      effort, conditions, knownAt: confirmationValid ? confirmed!.knownAt : null, availableAsOf,
      confirmationRevisionId: confirmationValid ? selected.revision?.revisionId ?? null : null,
      confirmationChronology: selected.present ? "client_document_untrusted" : confirmationValid ? "legacy_known_at" : "unconfirmed",
      ageDays, stale, eligibleSameDistanceBenchmark: eligible && Math.abs(nominal! - target) <= policy.sameDistanceToleranceMeters,
      eligibleForEquivalence: eligible, reasons: [...new Set(reasons)],
      provenance: { source: workout?.sourceName || "race_record", sourceId: race.actualRunId ?? race.id, confirmationSource: confirmationValid ? confirmed!.source : null },
    });
  }
  return evidence.sort((a, b) => compare(a.raceDate, b.raceDate) || compare(a.raceId, b.raceId));
}

/** Fixed population-style exponent, never fitted from an athlete's same-distance races.
 * Research formula: https://pmc.ncbi.nlm.nih.gov/articles/PMC6239296/ */
export function researchRiegelSeconds(finishSeconds: number, sourceMeters: number, targetMeters: number, exponent = 1.06): number | null {
  if (![finishSeconds, sourceMeters, targetMeters, exponent].every(positive)) return null;
  const result = finishSeconds * Math.pow(targetMeters / sourceMeters, exponent);
  return positive(result) ? result : null;
}

/** Daniels–Gilbert oxygen-cost/sustainable-fraction approximation. VDOT is a
 * performance equivalence index, not a measured VO2 max or individualized forecast.
 * https://support.vdoto2.com/2022/03/equivalent-performances/ */
function vdot(distanceMeters: number, seconds: number): number {
  const minutes = seconds / 60;
  const velocity = distanceMeters / minutes;
  return (-4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity)
    / (0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes));
}

export function researchVdotSeconds(finishSeconds: number, sourceMeters: number, targetMeters: number): number | null {
  if (![finishSeconds, sourceMeters, targetMeters].every(positive)) return null;
  // Explicit numerical domain, not a claim of validated accuracy throughout it.
  if (sourceMeters < 1500 || sourceMeters > 42195 || targetMeters < 1500 || targetMeters > 42195 || finishSeconds < 180 || finishSeconds > 21600) return null;
  const index = vdot(sourceMeters, finishSeconds);
  if (!positive(index)) return null;
  let lower = 180;
  let upper = 21600;
  if (vdot(targetMeters, lower) < index || vdot(targetMeters, upper) > index) return null;
  for (let iteration = 0; iteration < 80; iteration++) {
    const midpoint = (lower + upper) / 2;
    if (vdot(targetMeters, midpoint) > index) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

export function evaluateRacePerformance(input: RacePerformanceInput): RacePerformanceResult {
  const policy = validatePolicy(input);
  const targetDistanceMeters = input.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const evidence = buildRaceEvidence(input);
  const historicalBenchmarks = evidence.filter(e => e.availableAsOf && e.finishSeconds !== null
    && e.effort !== "nonmaximal"
    && ["verified", "owner_confirmed", "recorded_unverified"].includes(e.status));
  const sameDistance = historicalBenchmarks.filter(e => e.distanceMeters !== null
    && Math.abs(e.distanceMeters - targetDistanceMeters) <= policy.sameDistanceToleranceMeters);
  const confirmed = sameDistance.filter(e => e.eligibleSameDistanceBenchmark);
  const tierRank: Record<RacePerformanceEvidence["tier"], number> = {
    official_result: 0, confirmed_race_or_time_trial: 1, linked_race_workout: 2,
    identified_high_effort: 3, insufficient: 4,
  };
  // Trust first, then the latest observation within that evidence level. The
  // full timeline remains chronological and preserves newer lower-tier results.
  const preferred = (candidates: RacePerformanceEvidence[]) => [...candidates].sort((a, b) =>
    tierRank[a.tier] - tierRank[b.tier]
    || Number(b.status === "verified") - Number(a.status === "verified")
    || compare(b.raceDate, a.raceDate) || compare(a.raceId, b.raceId))[0] ?? null;
  const latestBenchmark = preferred(confirmed) ?? preferred(sameDistance);
  const researchEquivalences: RaceResearchEquivalence[] = evidence.flatMap(e => {
    if (!e.eligibleForEquivalence || e.distanceMeters === null || e.finishSeconds === null
      || Math.abs(e.distanceMeters - targetDistanceMeters) <= policy.sameDistanceToleranceMeters) return [];
    return ([
      ["riegel_fixed_1_06", researchRiegelSeconds(e.finishSeconds, e.distanceMeters, targetDistanceMeters)],
      ["vdot_style", researchVdotSeconds(e.finishSeconds, e.distanceMeters, targetDistanceMeters)],
    ] as const).flatMap(([method, equivalentSeconds]) => equivalentSeconds === null ? [] : [{
      raceId: e.raceId, method, sourceDistanceMeters: e.distanceMeters!, targetDistanceMeters,
      equivalentSeconds, purpose: "research_only" as const,
      limitations: ["Distance equivalence is not a current capability estimate or a race-day forecast.", "No athlete-specific accuracy or uncertainty interval has been established."],
    }]);
  });
  return {
    version: "phase3a-race-evidence-v1", asOf: input.asOf, targetDistanceMeters, evidence,
    historicalBenchmarks, latestBenchmark, researchEquivalences,
    currentCapability: { status: "unavailable", estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_estimator" },
    raceDayForecast: { status: "unavailable", estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_forecast" },
    limitations: ["Historical finish times describe the race on its date, not proof of current capability.",
      "Recorded workout duration is not a verified official result or confirmation of maximal effort.",
      "Legacy race records lack revision history; strict historical evaluation abstains without known-then evidence.",
      "Saved client-document confirmation histories preserve observations but do not prove immutable chronology; historical predictors abstain on these revisions.",
      "Training summaries do not adjust race times; no planned-workout, mileage or consistency credit is applied."],
  };
}
