/**
 * Effective-dated, per-day-of-week health goals powering the activity rings.
 *
 * Collection: users/{uid}/healthGoals/{docId}
 *
 * SEPARATE from both:
 *   - users/{uid}/goals             (running goals — RunningGoal)
 *   - users/{uid}/settings/healthGoals (threshold goals for KPI coloring)
 *
 * Goal history is append-only: saving goals always writes a NEW doc with
 * effectiveFrom = the first date the version applies. Past days are scored
 * against the version active on that day, so editing goals never re-scores
 * history.
 */

/** One goal value per day of week (Monday-start ordering by convention). */
export interface DayOfWeekGoals {
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
  sat: number;
  sun: number;
}

/** The five healthMetrics fields that render as activity rings. */
export type RingMetric =
  | "steps"
  | "exercise_mins"
  | "move_calories"
  | "stand_hours"
  | "sleep_total_hours";

export interface HealthGoalDoc {
  /** 'YYYY-MM-DD' — first date this goal version applies. */
  effectiveFrom: string;
  /** Epoch ms when this version was saved (tie-breaker for same-day saves). */
  createdAt: number;
  metrics: {
    steps: DayOfWeekGoals;
    exercise_mins: DayOfWeekGoals;
    move_calories: DayOfWeekGoals;
    stand_hours: DayOfWeekGoals;
    sleep_total_hours: DayOfWeekGoals;
  };
}
