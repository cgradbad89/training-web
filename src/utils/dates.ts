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

/** Normalize a date to the Monday of its week (ISO string, local date) */
export function normalizeToMonday(date: Date): string {
  const d = weekStart(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
