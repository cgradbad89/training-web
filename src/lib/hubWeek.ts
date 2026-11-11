/**
 * Zone-aware civil-date helpers for the Hub summary endpoint (pure, no I/O).
 *
 * Everything the dashboard computes about "this week" uses HOST-LOCAL time (the
 * browser's). The server runs in UTC, so the endpoint pins the named zone
 * `America/New_York` explicitly. All conversions go through `Intl` with that
 * zone — never a manual UTC offset, never `new Date("YYYY-MM-DD")` — so DST
 * weeks (23 h / 25 h days) are handled by the platform's tz database.
 *
 * Civil dates are "YYYY-MM-DD" strings; calendar arithmetic on them uses UTC
 * `Date` fields only (no host-zone dependence).
 */

export const HUB_TIME_ZONE = "America/New_York";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function parseKey(dateKey: string): { y: number; m: number; d: number } {
  const match = KEY_PATTERN.exec(dateKey);
  if (!match) throw new RangeError("Expected a YYYY-MM-DD civil date");
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    throw new RangeError("Expected a valid YYYY-MM-DD civil date");
  }
  return { y, m, d };
}

/** The civil date ("YYYY-MM-DD") the instant falls on in `timeZone`. */
export function zonedDateKey(instant: Date, timeZone: string = HUB_TIME_ZONE): string {
  const p = zonedParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today's civil date in `timeZone` for an injected `now`. */
export function todayInZone(now: Date, timeZone: string = HUB_TIME_ZONE): string {
  return zonedDateKey(now, timeZone);
}

/** Civil-date arithmetic (UTC fields only, host-zone independent). */
export function addDaysToKey(dateKey: string, days: number): string {
  const { y, m, d } = parseKey(dateKey);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Monday (Monday-start weeks, like `weekStart()`) of the week containing the civil date. */
export function mondayOfKey(dateKey: string): string {
  const { y, m, d } = parseKey(dateKey);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToKey(dateKey, -((weekday + 6) % 7));
}

/**
 * The UTC instant at which `dateKey` begins (00:00:00.000) in `timeZone`.
 * Solved against the zone's own offset at that moment, so it is correct on
 * either side of a DST transition.
 */
export function zonedMidnightInstant(
  dateKey: string,
  timeZone: string = HUB_TIME_ZONE
): Date {
  const { y, m, d } = parseKey(dateKey);
  const wallAsUtc = Date.UTC(y, m - 1, d);
  let instant = wallAsUtc;
  // The offset depends on the instant, and the instant on the offset: two
  // fixed-point passes converge for every real zone (midnight never lands in
  // a spring-forward gap for America/New_York, whose shifts occur at 02:00).
  for (let pass = 0; pass < 3; pass += 1) {
    const p = zonedParts(new Date(instant), timeZone);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const offset = shownAsUtc - Math.floor(instant / 1000) * 1000;
    instant = wallAsUtc - offset;
  }
  return new Date(instant);
}

export interface ZonedWeek {
  timeZone: string;
  /** Monday civil date. */
  weekStartKey: string;
  /** Sunday civil date. */
  weekEndKey: string;
  /** Seven civil dates, Monday to Sunday. */
  dayKeys: [string, string, string, string, string, string, string];
  /** Monday 00:00 in the zone, as a UTC instant (inclusive lower bound). */
  startInstant: Date;
  /** Next Monday 00:00 in the zone (exclusive upper bound; DST weeks are not 168 h). */
  endExclusiveInstant: Date;
  /**
   * Last millisecond of the week (`endExclusiveInstant - 1 ms`). Pairs with
   * `startInstant` to feed the dashboard's inclusive `start <= d <= end` rule.
   */
  endInclusiveInstant: Date;
}

/** The Monday-to-Sunday week (in `timeZone`) that contains `now`. */
export function zonedWeekFor(now: Date, timeZone: string = HUB_TIME_ZONE): ZonedWeek {
  const weekStartKey = mondayOfKey(todayInZone(now, timeZone));
  const dayKeys = Array.from({ length: 7 }, (_, i) =>
    addDaysToKey(weekStartKey, i)
  ) as ZonedWeek["dayKeys"];
  const startInstant = zonedMidnightInstant(weekStartKey, timeZone);
  const endExclusiveInstant = zonedMidnightInstant(addDaysToKey(weekStartKey, 7), timeZone);
  return {
    timeZone,
    weekStartKey,
    weekEndKey: dayKeys[6],
    dayKeys,
    startInstant,
    endExclusiveInstant,
    endInclusiveInstant: new Date(endExclusiveInstant.getTime() - 1),
  };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Nov 9–15" within a month, "Oct 26 – Nov 1" across a month boundary. */
export function formatWeekLabel(weekStartKey: string): string {
  const start = parseKey(weekStartKey);
  const end = parseKey(addDaysToKey(weekStartKey, 6));
  const startMonth = MONTHS[start.m - 1];
  if (start.m === end.m) return `${startMonth} ${start.d}–${end.d}`;
  return `${startMonth} ${start.d} – ${MONTHS[end.m - 1]} ${end.d}`;
}
