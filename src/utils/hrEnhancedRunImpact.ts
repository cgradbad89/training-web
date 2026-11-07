/**
 * Run Detail impact on the experimental HR-enhanced estimate.
 *
 * A same-model with/without comparison: both numbers come from `estimateHrEnhancedHalfMarathon`
 * over identical races, overrides, cutoff and time zone; only the selected workout differs. The
 * with-run value is exactly what Plan Insights shows for the same inputs. It is NEVER mixed with the
 * official estimate's own per-run delta (shown separately by `computeCurrentHalfRunImpact`).
 *
 * Race-linked workouts are race evidence (held fixed, no counterfactual). No Firestore, no wall clock.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { classifyRunEvidence } from "./currentHalfRunImpact";
import { estimateHrEnhancedHalfMarathon, HR_ENHANCED_VERSION } from "./hrEnhancedPerformance";

export interface HrEnhancedRunImpactInput {
  races: readonly Race[];
  /** RAW shared workouts: the estimator applies overrides/exclusions itself. */
  workouts: readonly HealthWorkout[];
  overrides: Record<string, WorkoutOverride> | null | undefined;
  asOf: string;
  timeZone: string;
  runId: string;
}

export type HrEnhancedRunImpact =
  | { kind: "unavailable"; reason: string; version: string }
  | { kind: "not_evidence"; reason: string; version: string; withSeconds: number; withMinutes: number }
  | { kind: "unsupported"; reason: string; version: string; withSeconds: number; withMinutes: number }
  | {
    kind: "estimate"; direction: "faster" | "slower" | "unchanged"; version: string;
    withSeconds: number; withMinutes: number; withoutSeconds: number; withoutMinutes: number;
    /** withSeconds − withoutSeconds (HR-enhanced model only). */
    deltaSeconds: number;
  };

const ZERO = 1e-6;

export function computeHrEnhancedRunImpact(input: HrEnhancedRunImpactInput): HrEnhancedRunImpact {
  const base = { races: [...input.races], workouts: [...input.workouts], overrides: input.overrides ?? {}, asOf: input.asOf, timeZone: input.timeZone };
  const withRun = estimateHrEnhancedHalfMarathon(base);
  if (withRun.candidateSeconds === null || withRun.candidateMinutes === null)
    return { kind: "unavailable", version: HR_ENHANCED_VERSION, reason: withRun.fallbackReason ?? "The HR-enhanced estimate is not available." };
  const withSeconds = withRun.candidateSeconds, withMinutes = withRun.candidateMinutes;

  const status = classifyRunEvidence(input);
  if (status !== "training_evidence")
    return { kind: "not_evidence", version: HR_ENHANCED_VERSION, withSeconds, withMinutes,
      reason: status === "race_evidence" ? "This run is race evidence, held fixed, so no with/without comparison is simulated."
        : "This run is not a training input to the model." };

  const without = estimateHrEnhancedHalfMarathon({ ...base, workouts: base.workouts.filter(w => w.workoutId !== input.runId) });
  if (without.candidateSeconds === null || without.candidateMinutes === null)
    return { kind: "unsupported", version: HR_ENHANCED_VERSION, withSeconds, withMinutes,
      reason: `Without this run the HR-enhanced estimate would not be available: ${without.fallbackReason ?? "insufficient evidence"}` };

  const delta = Math.abs(withSeconds - without.candidateSeconds) < ZERO ? 0 : withSeconds - without.candidateSeconds;
  return { kind: "estimate", version: HR_ENHANCED_VERSION, direction: delta < 0 ? "faster" : delta > 0 ? "slower" : "unchanged",
    withSeconds, withMinutes, withoutSeconds: without.candidateSeconds, withoutMinutes: without.candidateMinutes, deltaSeconds: delta };
}
