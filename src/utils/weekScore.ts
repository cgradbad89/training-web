/**
 * Week Score — a single 0–100 score for "how on-plan / how loaded was this
 * week?", broken into three weighted components:
 *
 *   - Run miles  (40 pts) — actual / planned, capped at 100%
 *   - Training load (35 pts) — this week's combined load / 28-day baseline,
 *                              capped at 120% (i.e. 120% = full 35 pts)
 *   - Workouts  (25 pts) — sessions completed / sessions planned
 *
 * No plan in a category? That category gets full credit so the user isn't
 * punished for an absent plan.
 */

export interface WeekScoreInput {
  actualMiles: number;
  plannedMiles: number; // 0 = no run plan this week
  thisWeekTotalLoad: number; // runs + workouts combined
  avgWeeklyLoad: number; // 28-day avg (from Load Score card)
  sessionsCompleted: number;
  sessionsPlanned: number; // 0 = no workout plan this week
}

export interface WeekScoreResult {
  total: number; // 0–100, integer
  runScore: number; // 0–40
  loadScore: number; // 0–35
  workoutScore: number; // 0–25
  label: string;
  color: string; // hex for ring + label
  descriptionLine: string;
}

export function computeWeekScore(input: WeekScoreInput): WeekScoreResult {
  const {
    actualMiles,
    plannedMiles,
    thisWeekTotalLoad,
    avgWeeklyLoad,
    sessionsCompleted,
    sessionsPlanned,
  } = input;

  // Run component (40 pts)
  const runAdherence =
    plannedMiles > 0 ? Math.min(actualMiles / plannedMiles, 1.0) : 1.0;
  const runScore = Math.round(runAdherence * 40);

  // Load component (35 pts) — caps at 120% of baseline so going +20% above
  // baseline earns full credit; further volume isn't rewarded (and isn't
  // penalised either).
  const loadRatio =
    avgWeeklyLoad > 0
      ? Math.min(thisWeekTotalLoad / avgWeeklyLoad, 1.2) / 1.2
      : 1.0;
  const loadScore = Math.round(loadRatio * 35);

  // Workout component (25 pts)
  const workoutAdherence =
    sessionsPlanned > 0
      ? Math.min(sessionsCompleted / sessionsPlanned, 1.0)
      : 1.0;
  const workoutScore = Math.round(workoutAdherence * 25);

  const total = runScore + loadScore + workoutScore;

  const { label, color } = bandFor(total);
  const descriptionLine = describe(input);

  return { total, runScore, loadScore, workoutScore, label, color, descriptionLine };
}

function bandFor(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Excellent week", color: "#0F6E56" };
  if (score >= 75) return { label: "Strong week", color: "#1D9E75" };
  if (score >= 60) return { label: "Solid week", color: "#639922" };
  if (score >= 40) return { label: "Light week", color: "#BA7517" };
  return { label: "Recovery week", color: "#888780" };
}

function describe(input: WeekScoreInput): string {
  const hasRunPlan = input.plannedMiles > 0;
  const hasWorkoutPlan = input.sessionsPlanned > 0;

  if (hasRunPlan && hasWorkoutPlan) {
    return `${input.actualMiles.toFixed(1)} of ${input.plannedMiles.toFixed(
      1
    )} mi planned · ${input.sessionsCompleted} of ${input.sessionsPlanned} sessions`;
  }
  if (hasRunPlan) {
    return `${input.actualMiles.toFixed(1)} of ${input.plannedMiles.toFixed(
      1
    )} mi planned`;
  }
  if (hasWorkoutPlan) {
    return `${input.sessionsCompleted} of ${input.sessionsPlanned} sessions completed`;
  }
  return "No plan this week";
}

/** True when every numeric input is 0 — the "empty-state" trigger for
 *  the WeekScoreCard's "Check back as your week builds" placeholder. */
export function isWeekEmpty(input: WeekScoreInput): boolean {
  return (
    input.actualMiles === 0 &&
    input.plannedMiles === 0 &&
    input.thisWeekTotalLoad === 0 &&
    input.avgWeeklyLoad === 0 &&
    input.sessionsCompleted === 0 &&
    input.sessionsPlanned === 0
  );
}
