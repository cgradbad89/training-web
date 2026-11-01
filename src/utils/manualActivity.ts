/**
 * Manual activity contract: the supported kinds, the one validated input shared
 * by the form and the service, the Firestore field mapping, and the possible-
 * duplicate heuristic. Pure — persistence lives in src/services/manualActivities.ts.
 *
 * Identifiers are the ones iOS and the Workouts page already understand; a manual
 * record never carries route, split, stream, cadence, elevation, weather or drift
 * data, because none was measured.
 */

import {
  MANUAL_ACTIVITY_SOURCE_NAME,
  type HealthWorkout,
} from "@/types/healthWorkout";
import { formatDuration, formatMiles } from "@/utils/pace";
import { toLocalIsoDate } from "@/utils/dates";

export type ManualActivityKind =
  | "outdoor_run"
  | "treadmill_run"
  | "walking"
  | "cycling"
  | "strength"
  | "hiit"
  | "pilates"
  | "yoga"
  | "other";

export interface ManualActivityKindConfig {
  label: string;
  activityType: string;
  displayType: string;
  isRunLike: boolean;
  distance: "required" | "optional" | "none";
  /** Fastest believable pace; anything quicker is treated as a typing mistake. */
  minPaceSecPerMile: number;
}

export const MANUAL_ACTIVITY_KINDS: Record<ManualActivityKind, ManualActivityKindConfig> = {
  outdoor_run:   { label: "Outdoor Run",        activityType: "running",                          displayType: "Run",           isRunLike: true,  distance: "required", minPaceSecPerMile: 180 },
  treadmill_run: { label: "Treadmill Run",      activityType: "treadmill_running",                displayType: "Treadmill Run", isRunLike: true,  distance: "required", minPaceSecPerMile: 180 },
  walking:       { label: "Walking",            activityType: "walking",                          displayType: "Walk",          isRunLike: false, distance: "optional", minPaceSecPerMile: 300 },
  cycling:       { label: "Cycling",            activityType: "cycling",                          displayType: "Cycling",       isRunLike: false, distance: "optional", minPaceSecPerMile: 60 },
  strength:      { label: "Strength Training",  activityType: "traditional_strength_training",    displayType: "Strength",      isRunLike: false, distance: "none",     minPaceSecPerMile: 0 },
  hiit:          { label: "HIIT / Orangetheory", activityType: "high_intensity_interval_training", displayType: "HIIT",          isRunLike: false, distance: "optional", minPaceSecPerMile: 180 },
  pilates:       { label: "Pilates",            activityType: "pilates",                          displayType: "Pilates",       isRunLike: false, distance: "none",     minPaceSecPerMile: 0 },
  yoga:          { label: "Yoga",               activityType: "yoga",                             displayType: "Yoga",          isRunLike: false, distance: "none",     minPaceSecPerMile: 0 },
  other:         { label: "Other Workout",      activityType: "workout",                          displayType: "Workout",       isRunLike: false, distance: "optional", minPaceSecPerMile: 60 },
};

export const MANUAL_ACTIVITY_KIND_ORDER = Object.keys(MANUAL_ACTIVITY_KINDS) as ManualActivityKind[];

export const MANUAL_ACTIVITY_ID_PREFIX = "manual_";
export const MAX_MANUAL_DURATION_SECONDS = 24 * 3600;
export const MAX_MANUAL_DISTANCE_MILES = 500;
export const MIN_MANUAL_HEART_RATE = 25;
export const MAX_MANUAL_HEART_RATE = 250;
export const MAX_MANUAL_CALORIES = 20000;
export const MAX_MANUAL_TITLE_LENGTH = 100;
export const MAX_MANUAL_NOTES_LENGTH = 2000;
const EARLIEST_MANUAL_YEAR = 2000;
const METERS_PER_MILE = 1609.344;

export function createManualActivityId(): string {
  return `${MANUAL_ACTIVITY_ID_PREFIX}${crypto.randomUUID()}`;
}

/** The one validated contract shared by the form and the service. */
export interface ManualActivityInput {
  kind: ManualActivityKind;
  /** Local calendar date, YYYY-MM-DD. */
  localDate: string;
  /** Local wall-clock start, HH:MM (24-hour). */
  localTime: string;
  durationSeconds: number;
  distanceMiles: number | null;
  avgHeartRate: number | null;
  calories: number | null;
  title: string | null;
  notes: string | null;
}

export type ManualActivityField =
  | "kind" | "date" | "time" | "duration" | "distance"
  | "avgHeartRate" | "calories" | "title" | "notes";
export type ManualActivityErrors = Partial<Record<ManualActivityField, string>>;

/** Raw text the form holds; parsed into a ManualActivityInput on submit. */
export interface ManualActivityFormValues {
  kind: ManualActivityKind;
  date: string;
  time: string;
  hours: string;
  minutes: string;
  seconds: string;
  distanceMiles: string;
  avgHeartRate: string;
  calories: string;
  title: string;
  notes: string;
}

/**
 * Local date + wall-clock time → instant, or null when invalid. Built from local
 * components (never `new Date("YYYY-MM-DD")`, which parses as UTC and lands on the
 * previous evening west of Greenwich). The round-trip check rejects rolled-over
 * dates like Feb 30 and wall-clock times skipped by a spring-forward DST change.
 */
export function localDateTimeToInstant(localDate: string, localTime: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!dateMatch || !timeMatch) return null;
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hour, minute] = timeMatch.slice(1).map(Number);
  const instant = new Date(year, month - 1, day, hour, minute, 0, 0);
  const roundTrips =
    instant.getFullYear() === year && instant.getMonth() === month - 1 &&
    instant.getDate() === day && instant.getHours() === hour &&
    instant.getMinutes() === minute;
  return roundTrips ? instant : null;
}

function isDateOnlyValid(localDate: string): boolean {
  return localDateTimeToInstant(localDate, "12:00") !== null;
}

export function validateManualActivityInput(
  input: ManualActivityInput,
  now: Date = new Date()
): ManualActivityErrors {
  const errors: ManualActivityErrors = {};
  const config = MANUAL_ACTIVITY_KINDS[input.kind];
  if (!config) {
    errors.kind = "Choose an activity type.";
    return errors;
  }

  const durationValid =
    Number.isFinite(input.durationSeconds) && input.durationSeconds > 0 &&
    input.durationSeconds <= MAX_MANUAL_DURATION_SECONDS;
  if (!durationValid) {
    errors.duration = input.durationSeconds > MAX_MANUAL_DURATION_SECONDS
      ? "Duration can't be longer than 24 hours."
      : "Enter a duration greater than zero.";
  }

  if (!isDateOnlyValid(input.localDate)) {
    errors.date = "Enter a valid date.";
  } else if (!/^\d{2}:\d{2}$/.test(input.localTime)) {
    errors.time = "Enter a start time.";
  } else {
    const start = localDateTimeToInstant(input.localDate, input.localTime);
    if (!start) {
      errors.time = "That time doesn't exist on this date (clocks moved forward). Choose another time.";
    } else if (start.getFullYear() < EARLIEST_MANUAL_YEAR) {
      errors.date = `Enter a date in ${EARLIEST_MANUAL_YEAR} or later.`;
    } else if (start.getTime() > now.getTime()) {
      errors.time = "The start time can't be in the future.";
    } else if (durationValid && start.getTime() + input.durationSeconds * 1000 > now.getTime()) {
      errors.duration = "This activity would end in the future. Check the start time and duration.";
    }
  }

  const distance = input.distanceMiles;
  if (config.distance === "none") {
    if (distance !== null) errors.distance = `${config.label} doesn't record distance.`;
  } else if (distance === null) {
    if (config.distance === "required") errors.distance = "Enter a distance for this run.";
  } else if (!Number.isFinite(distance) || distance <= 0) {
    errors.distance = "Distance must be greater than zero.";
  } else if (distance > MAX_MANUAL_DISTANCE_MILES) {
    errors.distance = `Distance can't be more than ${MAX_MANUAL_DISTANCE_MILES} miles.`;
  } else if (durationValid && input.durationSeconds / distance < config.minPaceSecPerMile) {
    errors.distance = "That pace isn't possible for this activity. Check the distance and duration.";
  }

  const hr = input.avgHeartRate;
  if (hr !== null && (!Number.isFinite(hr) || hr < MIN_MANUAL_HEART_RATE || hr > MAX_MANUAL_HEART_RATE)) {
    errors.avgHeartRate = `Average heart rate must be between ${MIN_MANUAL_HEART_RATE} and ${MAX_MANUAL_HEART_RATE} bpm.`;
  }
  const calories = input.calories;
  if (calories !== null && (!Number.isFinite(calories) || calories <= 0 || calories > MAX_MANUAL_CALORIES)) {
    errors.calories = `Calories must be between 1 and ${MAX_MANUAL_CALORIES.toLocaleString("en-US")}.`;
  }
  if (input.title !== null && input.title.length > MAX_MANUAL_TITLE_LENGTH) {
    errors.title = `Keep the title to ${MAX_MANUAL_TITLE_LENGTH} characters.`;
  }
  if (input.notes !== null && input.notes.length > MAX_MANUAL_NOTES_LENGTH) {
    errors.notes = `Keep notes to ${MAX_MANUAL_NOTES_LENGTH.toLocaleString("en-US")} characters.`;
  }
  return errors;
}

/** Blank → null; anything unparseable → NaN so validation rejects it. */
function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : Number(trimmed);
}

function parseDurationPart(raw: string): number {
  const trimmed = raw.trim();
  return trimmed === "" ? 0 : Number(trimmed);
}

export function parseManualActivityForm(
  values: ManualActivityFormValues,
  now: Date = new Date()
):
  | { ok: true; input: ManualActivityInput }
  | { ok: false; errors: ManualActivityErrors } {
  const config = MANUAL_ACTIVITY_KINDS[values.kind];
  const hours = parseDurationPart(values.hours);
  const minutes = parseDurationPart(values.minutes);
  const seconds = parseDurationPart(values.seconds);
  const partsValid =
    [hours, minutes, seconds].every((part) => Number.isInteger(part) && part >= 0) &&
    minutes < 60 && seconds < 60;

  const input: ManualActivityInput = {
    kind: values.kind,
    localDate: values.date,
    localTime: values.time,
    durationSeconds: partsValid ? hours * 3600 + minutes * 60 + seconds : NaN,
    distanceMiles: config?.distance === "none" ? null : parseOptionalNumber(values.distanceMiles),
    avgHeartRate: parseOptionalNumber(values.avgHeartRate),
    calories: parseOptionalNumber(values.calories),
    title: values.title.trim() || null,
    notes: values.notes.trim() || null,
  };
  const errors = validateManualActivityInput(input, now);
  if (!partsValid) {
    errors.duration = "Enter whole numbers, with minutes and seconds under 60.";
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, input };
}

/** Pace for the form's live readout; null until both inputs are usable. */
export function manualPaceSecPerMile(
  durationSeconds: number,
  distanceMiles: number | null
): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (distanceMiles === null || !Number.isFinite(distanceMiles) || distanceMiles <= 0) return null;
  return durationSeconds / distanceMiles;
}

/** Recover the form from a stored manual record. */
export function formValuesFromWorkout(workout: HealthWorkout): ManualActivityFormValues {
  const total = Math.round(workout.durationSeconds);
  const hh = String(workout.startDate.getHours()).padStart(2, "0");
  const mm = String(workout.startDate.getMinutes()).padStart(2, "0");
  return {
    kind: kindFromActivityType(workout.activityType),
    date: toLocalIsoDate(workout.startDate),
    time: `${hh}:${mm}`,
    hours: String(Math.floor(total / 3600)),
    minutes: String(Math.floor((total % 3600) / 60)),
    seconds: String(total % 60),
    distanceMiles: workout.distanceMiles > 0 ? String(workout.distanceMiles) : "",
    avgHeartRate: workout.avgHeartRate != null ? String(workout.avgHeartRate) : "",
    calories: workout.calories > 0 ? String(workout.calories) : "",
    title: workout.customTitle ?? "",
    notes: workout.notes ?? "",
  };
}

export function kindFromActivityType(activityType: string): ManualActivityKind {
  return (
    MANUAL_ACTIVITY_KIND_ORDER.find(
      (kind) => MANUAL_ACTIVITY_KINDS[kind].activityType === activityType
    ) ?? "other"
  );
}

export function emptyManualActivityForm(
  kind: ManualActivityKind,
  now: Date = new Date()
): ManualActivityFormValues {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return {
    kind, date: toLocalIsoDate(now), time: `${hh}:${mm}`,
    hours: "", minutes: "", seconds: "",
    distanceMiles: "", avgHeartRate: "", calories: "", title: "", notes: "",
  };
}

// ─── Firestore field mapping ──────────────────────────────────────────────────

/**
 * Document fields for a validated input, in the field conventions iOS writes
 * (optional metrics are simply absent when unknown). `syncedAt` is deliberately
 * NOT written: iOS's incremental sync anchors on `orderBy("syncedAt", "desc")`, and
 * a manual save moving that anchor forward could drop unsynced Watch workouts.
 * `routeComplete` is also absent, so no "route still syncing" state can appear.
 */
export function buildManualActivityFields(
  input: ManualActivityInput
): Record<string, unknown> {
  const config = MANUAL_ACTIVITY_KINDS[input.kind];
  const start = localDateTimeToInstant(input.localDate, input.localTime);
  if (!start) throw new RangeError("Invalid manual activity start time");
  const fields: Record<string, unknown> = {
    entrySource: "manual",
    source: "manual",
    sourceName: MANUAL_ACTIVITY_SOURCE_NAME,
    activityType: config.activityType,
    displayType: config.displayType,
    isRunLike: config.isRunLike,
    hasRoute: false,
    hasHRStream: false,
    startDate: start,
    endDate: new Date(start.getTime() + input.durationSeconds * 1000),
    durationSeconds: input.durationSeconds,
  };
  if (input.distanceMiles !== null) {
    fields.distanceMiles = input.distanceMiles;
    fields.distanceMeters = input.distanceMiles * METERS_PER_MILE;
    fields.avgPaceSecPerMile = input.durationSeconds / input.distanceMiles;
    fields.avgSpeedMPS = (input.distanceMiles * METERS_PER_MILE) / input.durationSeconds;
  }
  if (input.avgHeartRate !== null) fields.avgHeartRate = input.avgHeartRate;
  if (input.calories !== null) fields.calories = input.calories;
  if (input.title !== null) fields.customTitle = input.title;
  if (input.notes !== null) fields.notes = input.notes;
  return fields;
}

/** Optional fields a later edit may blank; cleared explicitly so merge can't keep them. */
export const MANUAL_OPTIONAL_FIELDS = [
  "distanceMiles", "distanceMeters", "avgPaceSecPerMile", "avgSpeedMPS",
  "avgHeartRate", "calories", "customTitle", "notes",
] as const;

/** Computed fields that depend on duration, distance, type or average HR. */
export const MANUAL_DERIVED_FIELDS = [
  "trainingLoadV2", "trainingLoadMethod", "trainingLoadBasisComplete",
  "prBadges", "bestEfforts", "efficiencyRaw", "efficiencyScore",
  "overlayChartCache", "gapSecPerMile", "gapNetRiseM", "gapAggregateGradeFlat",
  "zoneBreakdown", "simplifiedPath", "routeClusterId",
] as const;

// ─── Possible-duplicate heuristic ─────────────────────────────────────────────

export const DUPLICATE_START_WINDOW_MS = 15 * 60 * 1000;
export const DUPLICATE_MIN_OVERLAP = 0.5;
export const DUPLICATE_DURATION_TOLERANCE = 0.25;
export const DUPLICATE_DISTANCE_TOLERANCE = 0.1;
export const SAME_DAY_DURATION_TOLERANCE = 0.05;
export const SAME_DAY_DISTANCE_TOLERANCE = 0.03;

export interface PossibleDuplicate {
  workout: HealthWorkout;
  reasons: string[];
}

function ratioWithin(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * tolerance;
}

/** iOS stores most non-run types as the generic "workout", so it can stand in for any. */
function comparableActivities(
  config: ManualActivityKindConfig,
  other: HealthWorkout
): boolean {
  if (config.isRunLike !== other.isRunLike) return false;
  if (config.isRunLike) return true;
  return (
    config.activityType === other.activityType ||
    config.activityType === "workout" ||
    other.activityType === "workout"
  );
}

/**
 * Conservative "might already be recorded" check. A candidate is flagged when it
 * has a comparable type and EITHER:
 *   A. it starts within 15 minutes of the existing activity, or the two time
 *      ranges overlap by at least half of the shorter one, with durations within
 *      25% and (when both have one) distances within 10%; OR
 *   B. it is on the same local day with durations within 5% and distances within
 *      3% — both distances required — which catches a mistyped start time.
 * Distance disagreement always clears a flag. Only ever a prompt: nothing is
 * merged, modified, excluded or deleted, and the owner decides.
 */
export function findPossibleDuplicates(
  input: ManualActivityInput,
  workouts: HealthWorkout[]
): PossibleDuplicate[] {
  const config = MANUAL_ACTIVITY_KINDS[input.kind];
  const start = localDateTimeToInstant(input.localDate, input.localTime);
  if (!start) return [];
  const startMs = start.getTime();
  const endMs = startMs + input.durationSeconds * 1000;
  const localDay = toLocalIsoDate(start);
  const matches: PossibleDuplicate[] = [];

  for (const workout of workouts) {
    if (!comparableActivities(config, workout)) continue;
    const otherStart = workout.startDate.getTime();
    const otherEnd = otherStart + workout.durationSeconds * 1000;
    const startGapMs = Math.abs(startMs - otherStart);
    const overlapMs = Math.max(0, Math.min(endMs, otherEnd) - Math.max(startMs, otherStart));
    const shorterMs = Math.min(endMs - startMs, otherEnd - otherStart);
    const overlaps = shorterMs > 0 && overlapMs / shorterMs >= DUPLICATE_MIN_OVERLAP;
    const startsClose = startGapMs <= DUPLICATE_START_WINDOW_MS;
    const bothHaveDistance = input.distanceMiles !== null && workout.distanceMiles > 0;
    const distance = input.distanceMiles ?? 0;

    const reasons: string[] = [];
    if (
      (startsClose || overlaps) &&
      ratioWithin(input.durationSeconds, workout.durationSeconds, DUPLICATE_DURATION_TOLERANCE) &&
      (!bothHaveDistance || ratioWithin(distance, workout.distanceMiles, DUPLICATE_DISTANCE_TOLERANCE))
    ) {
      reasons.push(
        startsClose
          ? `Starts ${Math.round(startGapMs / 60000)} min apart`
          : "Time ranges overlap"
      );
      reasons.push(`Similar duration (${formatDuration(workout.durationSeconds)})`);
      if (bothHaveDistance) reasons.push(`Similar distance (${formatMiles(workout.distanceMiles)} mi)`);
    } else if (
      bothHaveDistance &&
      toLocalIsoDate(workout.startDate) === localDay &&
      ratioWithin(input.durationSeconds, workout.durationSeconds, SAME_DAY_DURATION_TOLERANCE) &&
      ratioWithin(distance, workout.distanceMiles, SAME_DAY_DISTANCE_TOLERANCE)
    ) {
      reasons.push("Same day");
      reasons.push(`Nearly identical duration (${formatDuration(workout.durationSeconds)})`);
      reasons.push(`Nearly identical distance (${formatMiles(workout.distanceMiles)} mi)`);
    }
    if (reasons.length > 0) matches.push({ workout, reasons });
  }
  return matches;
}
