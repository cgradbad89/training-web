/**
 * Week Score — a single 0–100 score for "how on-plan / how loaded was this
 * week?", broken into three weighted components, **pro-rated against the plan
 * scheduled THROUGH TODAY** (not the full week) so an on-track mid-week reads
 * as on-track rather than "incomplete":
 *
 *   - Run miles  (40 pts) — actual-to-date / miles scheduled through today,
 *                           capped at 100%
 *   - Training load (35 pts) — load-to-date / (28-day weekly baseline ×
 *                              daysElapsed/7), capped at 120% (120% = full 35)
 *   - Workouts  (25 pts) — sessions completed-to-date / sessions scheduled
 *                          through today, capped at 100%
 *
 * Nothing scheduled through today for a component (e.g. a Monday rest day, or
 * an absent plan) ⇒ that component scores 100% so the card never looks
 * "behind" for targets that haven't come due yet.
 *
 * `daysElapsed` = days from the week's Monday start through TODAY inclusive
 * (today counts as a full day), clamped 0..7. A fully-elapsed past week is 7,
 * so on the last day the pro-rated score equals the old full-week score.
 */

export interface WeekScoreInput {
  actualMiles: number; // actual run miles to date
  plannedMiles: number; // planned miles SCHEDULED THROUGH TODAY (0 = none yet)
  thisWeekTotalLoad: number; // runs + workouts combined, to date
  avgWeeklyLoad: number; // 28-day weekly baseline (full-week target)
  sessionsCompleted: number; // completed sessions to date
  sessionsPlanned: number; // sessions SCHEDULED THROUGH TODAY (0 = none yet)
  daysElapsed: number; // 0..7, Monday start through today inclusive
}

export interface WeekScoreResult {
  total: number; // 0–100, integer
  runScore: number; // 0–40
  loadScore: number; // 0–35
  workoutScore: number; // 0–25
  label: string;
  color: string; // hex for ring + label
  descriptionLine: string;
  /** Small subtext for the card stating the pro-rating basis, e.g.
   *  "vs plan through Wed" / "vs full-week plan" / "Upcoming week". */
  basisLine: string;
}

/** Max points per component (weights sum to 100). Single-sourced so the
 *  breakdown helper and the scorer can never disagree. */
export const RUN_MAX_POINTS = 40;
export const LOAD_MAX_POINTS = 35;
export const WORKOUT_MAX_POINTS = 25;
/** Training load earns FULL credit at this multiple of the 28-day baseline. */
export const LOAD_FULL_CREDIT_RATIO = 1.2;

/** Mon-start day labels, indexed 0=Mon … 6=Sun. */
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Days of the plan week that have started — the week's Monday through `today`
 * inclusive (today counts as a full day). Clamped to 0..7: a future week → 0,
 * a fully-elapsed past week → 7. Pure; normalises both dates to local midnight
 * so it counts calendar days, not 24h spans.
 */
export function daysElapsedInWeek(weekStart: Date, today: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((t.getTime() - start.getTime()) / MS_PER_DAY);
  return Math.max(0, Math.min(7, diffDays + 1));
}

/**
 * True when a plan entry on `weekday` (1=Mon … 7=Sun) is scheduled on or
 * before today, given `daysElapsed` (0..7). Used to pro-rate planned-mile and
 * planned-session denominators against the schedule through today.
 */
export function isScheduledThroughToday(
  weekday: number,
  daysElapsed: number
): boolean {
  return weekday >= 1 && weekday <= daysElapsed;
}

/**
 * Pro-rated training-load target: the full-week baseline scaled by the
 * fraction of the week elapsed. No per-day planned load exists in the plan
 * data, so this linear fallback is the load denominator. 0 when there's no
 * baseline or no days elapsed (→ component scores 100%).
 */
export function proRatedLoadTarget(
  avgWeeklyLoad: number,
  daysElapsed: number
): number {
  if (avgWeeklyLoad <= 0 || daysElapsed <= 0) return 0;
  return avgWeeklyLoad * (daysElapsed / 7);
}

/** Card subtext stating the pro-rating basis, derived from daysElapsed alone
 *  (TZ-independent). 0 → upcoming, 7 → full week, else → through that day. */
export function weekScoreBasisLabel(daysElapsed: number): string {
  if (daysElapsed <= 0) return "Upcoming week";
  if (daysElapsed >= 7) return "vs full-week plan";
  return `vs plan through ${DAY_LABELS[daysElapsed - 1]}`;
}

export function computeWeekScore(input: WeekScoreInput): WeekScoreResult {
  const {
    actualMiles,
    plannedMiles,
    thisWeekTotalLoad,
    avgWeeklyLoad,
    sessionsCompleted,
    sessionsPlanned,
    daysElapsed,
  } = input;

  // Run component (40 pts) — actual-to-date / miles scheduled through today.
  // Nothing scheduled yet (rest day / future week / no plan) → full credit.
  const runAdherence =
    plannedMiles > 0 ? Math.min(actualMiles / plannedMiles, 1.0) : 1.0;
  const runScore = Math.round(runAdherence * RUN_MAX_POINTS);

  // Load component (35 pts) — load-to-date / pro-rated baseline. Caps at 120%
  // of the pro-rated target so +20% earns full credit; further volume isn't
  // rewarded (or penalised). No pro-rated target (no baseline / 0 days) →
  // full credit.
  const loadTarget = proRatedLoadTarget(avgWeeklyLoad, daysElapsed);
  const loadRatio =
    loadTarget > 0
      ? Math.min(thisWeekTotalLoad / loadTarget, LOAD_FULL_CREDIT_RATIO) /
        LOAD_FULL_CREDIT_RATIO
      : 1.0;
  const loadScore = Math.round(loadRatio * LOAD_MAX_POINTS);

  // Workout component (25 pts) — completed-to-date / sessions scheduled
  // through today. Nothing scheduled yet → full credit.
  const workoutAdherence =
    sessionsPlanned > 0
      ? Math.min(sessionsCompleted / sessionsPlanned, 1.0)
      : 1.0;
  const workoutScore = Math.round(workoutAdherence * WORKOUT_MAX_POINTS);

  const total = runScore + loadScore + workoutScore;

  const { label, color } = bandFor(total);
  const descriptionLine = describe(input);
  const basisLine = weekScoreBasisLabel(daysElapsed);

  return {
    total,
    runScore,
    loadScore,
    workoutScore,
    label,
    color,
    descriptionLine,
    basisLine,
  };
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
          ? "Miles done vs scheduled through today (capped at 100%)"
          : "Nothing scheduled through today — full credit",
    },
    {
      key: "load",
      label: "Training load",
      unit: "load",
      actual: input.thisWeekTotalLoad,
      // Pro-rated baseline (28-day weekly × daysElapsed/7) so the actual/target
      // pair reconciles to the displayed (pro-rated) load score.
      target: proRatedLoadTarget(input.avgWeeklyLoad, input.daysElapsed),
      earnedPoints: r.loadScore,
      maxPoints: LOAD_MAX_POINTS,
      note:
        proRatedLoadTarget(input.avgWeeklyLoad, input.daysElapsed) > 0
          ? "vs 28-day baseline, pro-rated to date — full credit at 120%"
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
          ? "Sessions completed vs scheduled through today"
          : "Nothing scheduled through today — full credit",
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
