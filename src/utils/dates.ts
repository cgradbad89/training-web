/**
 * Date utilities. Week boundaries are Monday-start throughout the app,
 * matching the iOS app's WorkoutViewHelpers convention.
 */

/** Return the Monday of the week containing `date` */
export function weekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return the Sunday of the week containing `date` */
export function weekEnd(date: Date): Date {
  const start = weekStart(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Add `n` weeks to a date */
export function addWeeks(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return d;
}

/** Format as "Mon Jan 1" */
export function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Format as full month name + year, e.g. "March 2027". */
export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** Format as "Jan 1 – Jan 7" for a week range */
export function formatWeekRange(start: Date): string {
  const end = weekEnd(start);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", opts)}`;
}

/** Format ISO date string as "Mon Jan 1, 2026" */
export function formatDisplayDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** True if two dates are in the same calendar week (Mon-start) */
export function isSameWeek(a: Date, b: Date): boolean {
  return weekStart(a).getTime() === weekStart(b).getTime();
}

/** Format a Date as a local "YYYY-MM-DD" string (no UTC drift). */
export function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** True when a date-only value falls on/after a local calendar-month cutoff. */
export function isDateOnlyWithinPastMonths(
  isoDate: string,
  months: number,
  from: Date = new Date()
): boolean {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  // Clamped month math: 2028-02-29 − 12 months → 2027-02-28 (not Mar 1).
  const cutoff = addMonthsClamped(today, -months);
  return parseLocalDate(isoDate) >= cutoff;
}

// ─── Year-rollover helpers (device-local time) ───────────────────────────────

/** Local calendar year of a date (device-local). */
export function localYearOf(date: Date): number {
  return date.getFullYear();
}

/** Local midnight on Jan 1 of the given year. */
export function startOfLocalYear(year: number): Date {
  return new Date(year, 0, 1);
}

/**
 * Local ISO date (YYYY-MM-DD) of the Monday starting this date's Mon–Sun week.
 * Year-safe week key: unlike a bare ISO week NUMBER, keys never repeat across
 * years, so 2026-W53 (Mon 2026-12-28) sorts before 2027-W01 (Mon 2027-01-04).
 */
export function mondayKey(date: Date): string {
  return toLocalIsoDate(weekStart(date));
}

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Signed whole-week difference: (Monday of b) − (Monday of a), in weeks.
 * DST-safe: computed on local Y/M/D components via Date.UTC, never by dividing
 * raw milliseconds. 2026-12-28 vs 2027-01-04 → 1; 2026-12-28 vs 2026-12-21 → -1.
 */
export function weeksBetweenMondays(a: Date, b: Date): number {
  const ma = weekStart(a);
  const mb = weekStart(b);
  const ua = Date.UTC(ma.getFullYear(), ma.getMonth(), ma.getDate());
  const ub = Date.UTC(mb.getFullYear(), mb.getMonth(), mb.getDate());
  return Math.round((ub - ua) / MS_PER_WEEK);
}

/**
 * Number of distinct Monday-anchored Mon–Sun weeks overlapped by [start, end],
 * inclusive. Partial weeks count as 1. Returns 0 if end's local day is before
 * start's local day.
 */
export function elapsedWeeksIn(start: Date, end: Date): number {
  if (toLocalIsoDate(end) < toLocalIsoDate(start)) return 0;
  return weeksBetweenMondays(start, end) + 1;
}

/** Local-date cutoff string (YYYY-MM-DD) for `daysAgo` days before `now`. */
export function localDateCutoff(daysAgo: number, now: Date = new Date()): string {
  return toLocalIsoDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)
  );
}

/**
 * Add calendar months, clamping the day to the last valid day of the target
 * month (no overflow into the next month). Time of day is preserved.
 * 2028-02-29 + (-12) → 2027-02-28. 2027-01-31 + 1 → 2027-02-28.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getDate();
  const target = new Date(
    date.getFullYear(),
    date.getMonth() + months,
    1,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/** Normalize a date to the Monday of its week (ISO string, local date) */
export function normalizeToMonday(date: Date): string {
  return toLocalIsoDate(weekStart(date));
}

/**
 * Monday-start week-to-date window for the "This Week" ring view.
 *
 * Given an anchor local "YYYY-MM-DD" (normally today), returns three local
 * "YYYY-MM-DD" strings:
 *  - `start`:   Monday of the anchor's week (via the canonical weekStart /
 *               normalizeToMonday boundary — never a second week definition).
 *  - `end`:     the anchor itself — week-to-date, so days later in the week
 *               are excluded from the window.
 *  - `weekEnd`: Sunday of the anchor's week (the FULL Mon–Sun period), used to
 *               place the on-pace tick at elapsed/7 mid-week.
 */
export function weekToDateWindow(anchorIso: string): {
  start: string;
  end: string;
  weekEnd: string;
} {
  const start = normalizeToMonday(parseLocalDate(anchorIso));
  const sunday = parseLocalDate(start);
  sunday.setDate(sunday.getDate() + 6);
  return { start, end: anchorIso, weekEnd: toLocalIsoDate(sunday) };
}

/**
 * Parse a date-only ISO string ("YYYY-MM-DD") as LOCAL midnight.
 *
 * `new Date("YYYY-MM-DD")` interprets the string as UTC midnight, which
 * renders as the PREVIOUS calendar day in any timezone west of UTC (e.g.
 * "2026-09-06" → "Sat, Sep 5" in US Eastern). All race/plan/goal date-only
 * strings must be parsed through this helper so every page agrees on the
 * weekday, date, and days-away count.
 */
export function parseLocalDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/**
 * Whole calendar days from `from` (default: now) until `isoDate`, both at
 * LOCAL midnight. 0 = today, 1 = tomorrow, negative = past. Time of day never
 * shifts the count; DST hour offsets are absorbed by the rounding.
 */
export function daysUntil(isoDate: string, from: Date = new Date()): number {
  const target = parseLocalDate(isoDate);
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - base.getTime()) / 86400000);
}

/** Date-only race/result semantics: today remains current until local midnight. */
export function isPastLocalDate(
  isoDate: string,
  from: Date = new Date()
): boolean {
  return daysUntil(isoDate, from) < 0;
}

/**
 * Safely converts a Firestore Timestamp, Date, or ISO string to a JS Date.
 * Firestore Timestamp objects have a .toDate() method.
 * Use this everywhere instead of new Date(someFirestoreField).
 */
export function toDate(value: unknown): Date {
  if (!value) return new Date(0);
  // Firestore Timestamp
  if (typeof value === "object" && value !== null && "toDate" in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  // Already a Date
  if (value instanceof Date) return value;
  // ISO string or number
  return new Date(value as string | number);
}
