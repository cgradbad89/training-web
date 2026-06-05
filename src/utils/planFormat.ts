/**
 * Shared formatting for plan/session completion timestamps.
 *
 * Used by the workout DayCard ("✓ Completed · {date}") and both plan-detail
 * headers' "Completed {date}" badge. Single source so the two surfaces never
 * drift. Returns null for a missing/invalid ISO string so callers can omit the
 * label entirely.
 */
export function formatCompletedAt(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}
