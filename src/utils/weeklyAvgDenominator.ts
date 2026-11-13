import { elapsedWeeksIn, startOfLocalYear } from "@/utils/dates";

/**
 * Shared denominator for the "weekly avg load" tile on the Runs and Workouts
 * pages: the number of distinct Monday-anchored Mon–Sun weeks the window
 * overlaps (partial weeks count as 1). The window is the selected calendar
 * year — or one month of it — clamped to today, so a partially-elapsed period
 * never deflates the average. Only the denominator lives here; load itself is
 * always computed by `resolveDisplayLoad`.
 */
export function weeklyAvgWindow(
  selectedYear: number,
  selectedMonth: number | null,
  now: Date
): { start: Date; end: Date } | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start: Date;
  let end: Date;
  if (selectedMonth !== null) {
    start = new Date(selectedYear, selectedMonth, 1);
    end = new Date(selectedYear, selectedMonth + 1, 0);
  } else {
    start = startOfLocalYear(selectedYear);
    end = new Date(selectedYear, 11, 31);
  }
  if (end > today) end = today;
  if (start > today) return null;
  return { start, end };
}

/** Weeks to divide by; 0 when the window has not started (callers show "—"). */
export function weeklyAvgDenominator(
  selectedYear: number,
  selectedMonth: number | null,
  now: Date = new Date()
): number {
  const window = weeklyAvgWindow(selectedYear, selectedMonth, now);
  return window ? elapsedWeeksIn(window.start, window.end) : 0;
}
