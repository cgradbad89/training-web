import { type HealthWorkout, isRunWorkout } from "@/types/healthWorkout";
import { type RunningShoe, type ShoeAutoAssignRule } from "@/types/shoe";

/**
 * Evaluates all active auto-assign rules across all shoes and returns
 * a map of workoutId -> shoeId for runs that match a rule and don't
 * already have a manual assignment.
 *
 * Rules are evaluated in priority order:
 * 1. More specific rules win over general ones
 * 2. Within equal specificity, the first matching rule wins
 * 3. Manual assignments always take precedence — never overwrite them
 */
export function evaluateAutoAssignRules(
  workouts: HealthWorkout[],
  shoes: RunningShoe[],
  existingAssignments: Record<string, string | null>
): Record<string, string> {
  const result: Record<string, string> = {};

  // Only process run-like workouts
  const runs = workouts.filter((w) => isRunWorkout(w));

  // Collect all enabled rules across all shoes, sorted by specificity
  const allRules = shoes
    .flatMap((shoe) =>
      (shoe.autoAssignRules ?? [])
        .filter((rule) => rule.isEnabled)
        .map((rule) => ({ rule, shoe }))
    )
    .sort((a, b) => ruleSpecificity(b.rule) - ruleSpecificity(a.rule));

  for (const run of runs) {
    const workoutId = run.workoutId;

    // Skip if manually assigned (manual assignments always win)
    if (workoutId in existingAssignments) continue;

    // Find first matching rule
    for (const { rule, shoe } of allRules) {
      if (ruleMatchesRun(rule, run)) {
        result[workoutId] = shoe.id;
        break;
      }
    }
  }

  return result;
}

/**
 * Higher score = more specific rule = higher priority
 */
function ruleSpecificity(rule: ShoeAutoAssignRule): number {
  let score = 0;
  if (rule.scope !== "any") score += 10;
  if (rule.minDistance != null) score += 5;
  if (rule.maxDistance != null) score += 5;
  if (rule.startDate != null) score += 3;
  if (rule.endDate != null) score += 3;
  return score;
}

/**
 * Returns true if a rule matches a given run.
 */
export function ruleMatchesRun(
  rule: ShoeAutoAssignRule,
  run: HealthWorkout
): boolean {
  // Scope check
  if (rule.scope !== "any") {
    const isTreadmill = run.displayType.toLowerCase().includes("treadmill");
    if (rule.scope === "treadmill" && !isTreadmill) return false;
    if (rule.scope === "outdoor" && isTreadmill) return false;
  }

  // Distance check
  const miles = run.distanceMiles ?? 0;
  if (rule.minDistance != null && miles < rule.minDistance) return false;
  if (rule.maxDistance != null && miles >= rule.maxDistance) return false;

  // Date range check
  const runDate = new Date(run.startDate);
  if (rule.startDate != null) {
    const start = new Date(rule.startDate);
    start.setHours(0, 0, 0, 0);
    if (runDate < start) return false;
  }
  if (rule.endDate != null) {
    const end = new Date(rule.endDate);
    end.setHours(23, 59, 59, 999);
    if (runDate > end) return false;
  }

  return true;
}
