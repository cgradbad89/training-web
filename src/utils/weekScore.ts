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

/** Max points per component (weights sum to 100). Single-sourced so the
 *  breakdown helper and the scorer can never disagree. */
export const RUN_MAX_POINTS = 40;
export const LOAD_MAX_POINTS = 35;
export const WORKOUT_MAX_POINTS = 25;
/** Training load earns FULL credit at this multiple of the 28-day baseline. */
export const LOAD_FULL_CREDIT_RATIO = 1.2;

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
  const runScore = Math.round(runAdherence * RUN_MAX_POINTS);

  // Load component (35 pts) — caps at 120% of baseline so going +20% above
  // baseline earns full credit; further volume isn't rewarded (and isn't
  // penalised either).
  const loadRatio =
    avgWeeklyLoad > 0
      ? Math.min(thisWeekTotalLoad / avgWeeklyLoad, LOAD_FULL_CREDIT_RATIO) /
        LOAD_FULL_CREDIT_RATIO
      : 1.0;
  const loadScore = Math.round(loadRatio * LOAD_MAX_POINTS);

  // Workout component (25 pts)
  const workoutAdherence =
    sessionsPlanned > 0
      ? Math.min(sessionsCompleted / sessionsPlanned, 1.0)
      : 1.0;
  const workoutScore = Math.round(workoutAdherence * WORKOUT_MAX_POINTS);

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

// ─── Score breakdown (explainer) ───────────────────────────────────────────────

export type WeekScoreComponentKey = "run" | "load" | "workout";

export interface WeekScoreComponent {
  key: WeekScoreComponentKey;
  label: string; // matches the card's bars
  /** Unit for the actual/target pair: "mi" | "load" | "sessions". */
  unit: "mi" | "load" | "sessions";
  actual: number;
  target: number; // 0 ⇒ no plan/baseline → full credit
  earnedPoints: number; // points contributed toward the total
  maxPoints: number;
  note: string; // one-line plain-language explanation
}

export interface WeekScoreBreakdown {
  components: WeekScoreComponent[];
  /** Equals sum(components.earnedPoints) AND computeWeekScore(input).total. */
  total: number;
}

/**
 * Per-component breakdown for the Week Score explainer. Derived from the SAME
 * `computeWeekScore` output (earnedPoints ARE its runScore/loadScore/
 * workoutScore), so `total === sum(earnedPoints) === computeWeekScore.total`
 * by construction — the breakdown can never drift from the displayed score.
 */
export function buildWeekScoreBreakdown(input: WeekScoreInput): WeekScoreBreakdown {
  const r = computeWeekScore(input);

  const components: WeekScoreComponent[] = [
    {
      key: "run",
      label: "Run miles",
      unit: "mi",
      actual: input.actualMiles,
      target: input.plannedMiles,
      earnedPoints: r.runScore,
      maxPoints: RUN_MAX_POINTS,
      note:
        input.plannedMiles > 0
          ? "Planned miles completed (capped at 100%)"
          : "No run plan this week — full credit",
    },
    {
      key: "load",
      label: "Training load",
      unit: "load",
      actual: input.thisWeekTotalLoad,
      target: input.avgWeeklyLoad,
      earnedPoints: r.loadScore,
      maxPoints: LOAD_MAX_POINTS,
      note:
        input.avgWeeklyLoad > 0
          ? "vs 28-day baseline — full credit at 120%"
          : "No baseline yet — full credit",
    },
    {
      key: "workout",
      label: "Workouts",
      unit: "sessions",
      actual: input.sessionsCompleted,
      target: input.sessionsPlanned,
      earnedPoints: r.workoutScore,
      maxPoints: WORKOUT_MAX_POINTS,
      note:
        input.sessionsPlanned > 0
          ? "Sessions completed of planned"
          : "No workout plan this week — full credit",
    },
  ];

  return { components, total: r.total };
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
