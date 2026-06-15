/**
 * icsExport — pure, dependency-free generation of an RFC 5545 VCALENDAR (.ics)
 * from a RunningPlan. No side effects, no Firestore, no network, no clock reads
 * (DTSTAMP is derived from each run's own date so output is deterministic).
 *
 * The ONLY source of a run's calendar date is the existing plannedDate scheme
 * used on the Plans page: startDate (Monday-normalized YYYY-MM-DD) shifted by
 * weekIndex*7 + (weekday-1). There is no per-entry date field — do not invent one.
 */

import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";

export interface IcsExportOptions {
  plan: RunningPlan;
  /** "HH:MM" — runs without a stored scheduledTime use this. Undefined → all-day. */
  defaultTime?: string;
  /** Event length for timed events. Default 60. */
  eventDurationMinutes?: number;
}

// ─── Date derivation (mirrors plannedDate in plans/page.tsx exactly) ──────────

/**
 * Calendar date of a planned entry: plan.startDate + weekIndex*7 + (weekday-1),
 * computed in local time. Identical math to plannedDate() on the Plans page.
 */
export function buildRunDate(plan: RunningPlan, entry: PlannedRunEntry): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const daysOffset = entry.weekIndex * 7 + (entry.weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + daysOffset);
  return d;
}

// ─── Title ────────────────────────────────────────────────────────────────────

/**
 * Human-readable label for an entry, keyed off workoutType first then runType.
 * No stored title exists, so this is built from the typed fields only.
 */
const LABEL_BY_TYPE: Record<string, string> = {
  easy: "Easy Run",
  tempo: "Tempo Run",
  long: "Long Run",
  longRun: "Long Run",
  race: "Race",
  otf: "OTF",
  treadmill: "Treadmill Run",
};

function humanLabel(entry: PlannedRunEntry): string {
  return (
    (entry.workoutType && LABEL_BY_TYPE[entry.workoutType]) ||
    (entry.runType && LABEL_BY_TYPE[entry.runType]) ||
    "Run"
  );
}

/** "<distance.toFixed(1)> mi <label>", e.g. "5.0 mi Easy Run". */
export function buildEventTitle(entry: PlannedRunEntry): string {
  return `${entry.distanceMiles.toFixed(1)} mi ${humanLabel(entry)}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isRestEntry(entry: PlannedRunEntry): boolean {
  return entry.runType === "rest" || entry.workoutType === "rest";
}

/** RFC 5545 text escaping: backslash, semicolon, comma, newline. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local date as YYYYMMDD (for VALUE=DATE all-day events). */
function formatDateOnly(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** Local floating date-time as YYYYMMDDTHHMMSS (no Z — intended wall-clock). */
function formatLocalDateTime(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** Deterministic DTSTAMP derived from the run date — midnight UTC of that day. */
function formatStamp(d: Date): string {
  return `${formatDateOnly(d)}T000000Z`;
}

/** Parse "HH:MM" → {hours, minutes}, or null if malformed/out of range. */
function parseTime(value: string | undefined): { hours: number; minutes: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/** Fold a content line to ≤75 octets per RFC 5545 (continuation lines start with a space). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length > 0) parts.push(" " + rest);
  return parts.join("\r\n");
}

// ─── VCALENDAR generation ──────────────────────────────────────────────────────

/**
 * Build a valid VCALENDAR string for every non-rest entry across all weeks.
 *
 * Time precedence per entry: entry.scheduledTime → options.defaultTime → all-day.
 * Timed events emit floating local DTSTART/DTEND (start + eventDurationMinutes);
 * all-day events emit DTSTART;VALUE=DATE (+ next-day DTEND;VALUE=DATE).
 */
export function generateIcs(options: IcsExportOptions): string {
  const { plan, defaultTime, eventDurationMinutes = 60 } = options;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//training-web//Plan Export//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const week of plan.weeks) {
    for (const entry of week.entries) {
      if (isRestEntry(entry)) continue;

      const runDate = buildRunDate(plan, entry);
      const time = parseTime(entry.scheduledTime) ?? parseTime(defaultTime);

      const vevent: string[] = [
        "BEGIN:VEVENT",
        `UID:${plan.id}-${entry.id}@training-web`,
        `DTSTAMP:${formatStamp(runDate)}`,
      ];

      if (time) {
        const start = new Date(runDate);
        start.setHours(time.hours, time.minutes, 0, 0);
        const end = new Date(start.getTime() + eventDurationMinutes * 60_000);
        vevent.push(`DTSTART:${formatLocalDateTime(start)}`);
        vevent.push(`DTEND:${formatLocalDateTime(end)}`);
      } else {
        const next = new Date(runDate);
        next.setDate(runDate.getDate() + 1);
        vevent.push(`DTSTART;VALUE=DATE:${formatDateOnly(runDate)}`);
        vevent.push(`DTEND;VALUE=DATE:${formatDateOnly(next)}`);
      }

      vevent.push(`SUMMARY:${escapeText(buildEventTitle(entry))}`);
      if (entry.description) {
        vevent.push(`DESCRIPTION:${escapeText(entry.description)}`);
      }
      vevent.push("END:VEVENT");

      lines.push(...vevent);
    }
  }

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n");
}
