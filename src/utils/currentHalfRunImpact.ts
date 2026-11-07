/**
 * Run Detail "This Run's Impact" for the current half-marathon estimate.
 *
 * A narrow, pure adapter over the SINGLE production estimator
 * (`estimateCurrentHalfMarathon`, experimental-current-hm-v2). Nothing here
 * re-implements the model: the with-run result is exactly the estimate Plan
 * Insights computes from the same inputs, and the without-run result is the same
 * estimator over the same inputs minus the selected workout.
 *
 * COUNTERFACTUAL POLICY
 * - Only the selected workout is removed from the supplied workout list. The
 *   evaluation instant, time zone, races, overrides, eligibility rules, windows,
 *   smoothing, deadbands and policy parameters are identical in both runs.
 * - A workout linked to a recorded race (`Race.actualRunId`) is race evidence, not a
 *   training input: the estimator already excludes it from every training
 *   statistic. Its race evidence is held fixed — it is never silently removed and
 *   no replacement anchor is invented — so no counterfactual is simulated for it.
 * - The delta measures influence on the MODEL'S ESTIMATE. It is not a measured
 *   fitness gain and is not attributed to the workout's physiology.
 * - Deltas are reported exactly as computed, including unfavorable ones.
 *
 * No Firestore access, no wall clock: callers supply `asOf`.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "./experimentalCurrentPerformance";
import { performanceLocalDate } from "./performanceEvidence";
import { selectResearchRuns } from "./workoutRaceResearch";

export interface CurrentHalfRunImpactInput {
  races: readonly Race[];
  /** RAW shared workouts: the estimator applies overrides/exclusions itself. */
  workouts: readonly HealthWorkout[];
  overrides: Record<string, WorkoutOverride> | null | undefined;
  asOf: string;
  timeZone: string;
  runId: string;
}

/** Why a viewed workout is, or is not, part of the model's evidence. */
export type RunEvidenceStatus =
  | "training_evidence"
  | "race_evidence"
  | "excluded"
  | "not_running"
  | "invalid_metrics"
  | "duplicate"
  | "unresolved"
  | "not_loaded";

export type UnavailableCause = "no_races" | "no_anchor" | "anchor_expired" | "insufficient_evidence";

export type CurrentHalfRunImpact =
  | { kind: "unavailable"; cause: UnavailableCause; reason: string; version: string }
  | {
    kind: "not_evidence"; runStatus: Exclude<RunEvidenceStatus, "training_evidence">; isAnchorRun: boolean;
    withSeconds: number; withMinutes: number; reason: string; version: string;
  }
  | { kind: "unsupported"; withSeconds: number; withMinutes: number; reason: string; version: string }
  | {
    kind: "estimate"; direction: "faster" | "slower" | "unchanged";
    withSeconds: number; withMinutes: number; withoutSeconds: number; withoutMinutes: number;
    /** withSeconds − withoutSeconds. Negative = including the run lowers the estimate. */
    deltaSeconds: number; runAgeDays: number | null; version: string;
  };

/** Below this magnitude the two unrounded estimates are the same number. */
export const IMPACT_ZERO_EPSILON_SECONDS = 1e-6;

const NOT_EVIDENCE_REASON: Record<Exclude<RunEvidenceStatus, "training_evidence" | "race_evidence">, string> = {
  excluded: "This run is excluded in your overrides, so the model never uses it.",
  not_running: "This activity is not classified as a run, so the model does not use it.",
  invalid_metrics: "This run has missing or invalid distance, duration or completion time, so the model cannot use it.",
  duplicate: "This run duplicates another recorded activity; the model counts only one copy.",
  unresolved: "This run's records conflict or cannot be verified, so the model does not use it.",
  not_loaded: "This run is not in the loaded workout history used by the estimate, so it has no influence on it.",
};

/** The estimator's own selector with its own v2 arguments; a test pins the equality. */
function selectEstimatorRuns(input: Omit<CurrentHalfRunImpactInput, "runId">) {
  return selectResearchRuns({
    workouts: input.workouts, races: input.races, overrides: input.overrides ?? {}, asOf: input.asOf, timeZone: input.timeZone,
    capturedAt: input.asOf, source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true },
    allowSummaryPaceTransfer: false,
  }, true);
}

export function classifyRunEvidence(input: CurrentHalfRunImpactInput): RunEvidenceStatus {
  const { runs, exclusions } = selectEstimatorRuns(input);
  const raceLinked = input.races.some(r => r.actualRunId === input.runId);
  if (runs.some(r => r.workout.workoutId === input.runId)) return raceLinked ? "race_evidence" : "training_evidence";
  if (!input.workouts.some(w => w.workoutId === input.runId)) return raceLinked ? "race_evidence" : "not_loaded";
  const reason = exclusions.filter(e => e.workoutId === input.runId && !e.reason.startsWith("collapsed_")).at(-1)?.reason;
  if (reason === "canonical_owner_exclusion") return "excluded";
  if (reason === "not_running") return "not_running";
  if (reason?.startsWith("repeated_activity_of_")) return "duplicate";
  if (reason === "missing_or_invalid_distance_or_duration" || reason === "invalid_or_missing_completion_dates"
    || reason === "not_completed_at_cutoff" || reason === "summary_availability_unknown_or_after_cutoff") return "invalid_metrics";
  return "unresolved";
}

const secondsOf = (e: CurrentHalfEstimate) => e.baselineSeconds! + e.adjustmentSeconds;

function unavailable(estimate: CurrentHalfEstimate, hasRaces: boolean): CurrentHalfRunImpact {
  const version = estimate.version;
  if (!hasRaces) return { kind: "unavailable", cause: "no_races", version,
    reason: "No race records are loaded, so the model has no race result to anchor a current half-marathon estimate." };
  if (!estimate.anchor) {
    const old = estimate.historicalAnchor;
    return old
      ? { kind: "unavailable", cause: "anchor_expired", version,
        reason: `Your most recent usable race (${old.raceDate}) is ${old.ageDays} days old. The model only uses a race anchor up to ${CURRENT_HALF_POLICY.maximumAnchorDays} days old, so no current estimate is available.` }
      : { kind: "unavailable", cause: "no_anchor", version, reason: estimate.reason };
  }
  return { kind: "unavailable", cause: "insufficient_evidence", version, reason: estimate.reason };
}

export function computeCurrentHalfRunImpact(input: CurrentHalfRunImpactInput): CurrentHalfRunImpact {
  const base = { races: input.races, workouts: input.workouts, overrides: input.overrides ?? {}, asOf: input.asOf, timeZone: input.timeZone };
  const withEstimate = estimateCurrentHalfMarathon({ ...base, races: [...base.races], workouts: [...base.workouts] });
  if (withEstimate.finishMinutes === null) return unavailable(withEstimate, input.races.length > 0);

  const version = withEstimate.version;
  const withSeconds = secondsOf(withEstimate), withMinutes = withEstimate.finishMinutes;
  const runStatus = classifyRunEvidence(input);
  if (runStatus !== "training_evidence") {
    const isAnchorRun = withEstimate.anchor?.workoutId === input.runId;
    const reason = runStatus === "race_evidence"
      ? `${isAnchorRun ? "This run is the recorded result for the race the estimate is anchored to" : "This run is a recorded race result"}. The model uses it as race evidence, not as a training run, and that evidence is held fixed, so removing it is not simulated.`
      : NOT_EVIDENCE_REASON[runStatus];
    return { kind: "not_evidence", runStatus, isAnchorRun, withSeconds, withMinutes, reason, version };
  }

  const withoutEstimate = estimateCurrentHalfMarathon({ ...base, races: [...base.races],
    workouts: base.workouts.filter(w => w.workoutId !== input.runId) });
  if (withoutEstimate.finishMinutes === null) return { kind: "unsupported", withSeconds, withMinutes, version,
    reason: `Without this run the model cannot produce a current estimate: ${withoutEstimate.reason}` };

  const withoutSeconds = secondsOf(withoutEstimate);
  const deltaSeconds = Math.abs(withSeconds - withoutSeconds) < IMPACT_ZERO_EPSILON_SECONDS ? 0 : withSeconds - withoutSeconds;
  const target = input.workouts.find(w => w.workoutId === input.runId);
  const runAgeDays = target
    ? Math.round((Date.parse(performanceLocalDate(input.asOf, input.timeZone) + "T00:00:00Z")
      - Date.parse(performanceLocalDate(target.startDate.toISOString(), input.timeZone) + "T00:00:00Z")) / 86400000)
    : null;
  return { kind: "estimate", direction: deltaSeconds < 0 ? "faster" : deltaSeconds > 0 ? "slower" : "unchanged",
    withSeconds, withMinutes, withoutSeconds, withoutMinutes: withoutEstimate.finishMinutes, deltaSeconds, runAgeDays, version };
}

/** Whole seconds from 10 s up, one decimal below, "<0.1 s" instead of a false zero, m:ss from one minute. */
export function formatImpactDelta(absSeconds: number): string {
  if (!(absSeconds > 0)) return "0 s";
  if (absSeconds < 0.05) return "<0.1 s";
  if (absSeconds < 10) return `${absSeconds.toFixed(1)} s`;
  const s = Math.round(absSeconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
