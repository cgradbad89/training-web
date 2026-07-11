/**
 * VO₂ max (Cardio Fitness) history windowing.
 *
 * The personal-insights VO₂ chart reads sparse `vo2_max` readings from
 * users/{uid}/healthMetrics. That query was previously unbounded
 * (`where('vo2_max', '>', 0)` with no date bound), so it grew without limit as
 * healthMetrics accumulated day over day.
 *
 * We bound it to a trailing window using a single `date >= cutoff` inequality
 * (with a matching `orderBy('date')`) — the same shape the fetchHealthMetrics*
 * helpers already use, which only needs Firestore's automatic single-field
 * index. The `vo2_max > 0` condition stays a client-side filter, so no
 * two-field composite index is required.
 */

/** Trailing window (days) for the VO₂ max history chart. */
export const VO2_HISTORY_DAYS = 180;

/**
 * The inclusive lower-bound `date` string (YYYY-MM-DD) for the VO₂ history
 * query, `days` before `now`. Mirrors the cutoff derivation in
 * services/healthMetrics.ts (`toISOString().split('T')[0]`).
 */
export function vo2HistoryCutoffISO(now: Date, days: number = VO2_HISTORY_DAYS): string {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString().split("T")[0];
}
