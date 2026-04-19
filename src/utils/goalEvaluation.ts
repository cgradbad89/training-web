/**
 * Shared goal-evaluation utilities for the Health page.
 *
 * Each metric returns one of four statuses, which the UI maps to a Tailwind
 * text-color token (success / warning / danger) or leaves uncolored
 * (neutral) when no goal is configured for that metric.
 */

export type GoalStatus = "success" | "warning" | "danger" | "neutral";

/**
 * For metrics with a single-direction goal:
 *   - direction: "lower"  → smaller is better (e.g. resting HR)
 *   - direction: "higher" → larger is better (e.g. steps, sleep, brushing)
 *
 * The user is at-or-better than goal → success.
 * Otherwise the % deviation from goal is bucketed:
 *   - within warningPct  → success (negligible miss)
 *   - within dangerPct   → warning
 *   - beyond dangerPct   → danger
 */
export function evaluateMetricGoal(
  current: number,
  goal: number,
  direction: "lower" | "higher",
  warningPct: number = 5,
  dangerPct: number = 15
): GoalStatus {
  if (!isFinite(current) || !isFinite(goal) || goal === 0) return "neutral";
  const isOffTarget = direction === "lower" ? current > goal : current < goal;
  if (!isOffTarget) return "success";
  const pctOff = Math.abs((current - goal) / goal) * 100;
  if (pctOff <= warningPct) return "success";
  if (pctOff <= dangerPct) return "warning";
  return "danger";
}

/**
 * Weight: success when inside [goal - tolerance, goal + tolerance];
 * outside the band the % deviation from goal is bucketed.
 */
export function evaluateWeightGoal(
  current: number,
  goal: number,
  tolerance: number,
  warningPct: number = 5,
  dangerPct: number = 15
): GoalStatus {
  if (!isFinite(current) || !isFinite(goal) || goal === 0) return "neutral";
  const low = goal - tolerance;
  const high = goal + tolerance;
  if (current >= low && current <= high) return "success";
  const pctOff =
    current > high
      ? ((current - high) / goal) * 100
      : ((low - current) / goal) * 100;
  if (pctOff <= warningPct) return "warning";
  if (pctOff <= dangerPct) return "danger";
  return "danger";
}

/**
 * BMI: success inside [min, max]; outside the band measured as % deviation
 * from the midpoint of the range. Slightly wider warning bucket than the
 * single-direction case since both sides of a range are "off."
 */
export function evaluateBMIGoal(
  current: number,
  min: number,
  max: number,
  warningPct: number = 5,
  _dangerPct: number = 15
): GoalStatus {
  if (!isFinite(current) || !isFinite(min) || !isFinite(max)) return "neutral";
  if (current >= min && current <= max) return "success";
  const midpoint = (min + max) / 2;
  if (midpoint === 0) return "neutral";
  const pctOff = Math.abs((current - midpoint) / midpoint) * 100;
  if (pctOff <= warningPct + 5) return "warning";
  return "danger";
}

/** Map a status to a Tailwind text-color token (and "" for neutral). */
export const STATUS_COLOR: Record<GoalStatus, string> = {
  success: "text-success",
  warning: "text-warning",
  danger:  "text-danger",
  neutral: "text-textPrimary",
};
