/**
 * Phase 3J — pure policy for automatic historical-weather acquisition.
 *
 * Weather used to be fetched only when a GPS run's detail page was opened
 * (runs/[id]/page.tsx). The comparable-effort weather gate therefore selected
 * the runs the owner happened to view. This module decides — with no I/O — which
 * workouts are eligible for a bounded background fetch, how failures back off,
 * and what a recovery plan for older history would cost. The I/O lives in
 * `src/components/WeatherBackfillRunner.tsx` and `scripts/recoverWeather.ts`.
 *
 * Nothing here reads the GPS track, the HR stream, or any location: the caller
 * supplies workout parent documents and a failure ledger, and receives workout
 * ids. Diagnostics are counts only.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WeatherSnapshot } from "@/types/weather";
import type { WorkoutOverride } from "@/types/workoutOverride";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A run must have ended this long ago before its start-hour weather is fetched,
 *  so the provider has a settled value for the hour the run began in. */
export const WEATHER_SETTLE_MS = 6 * HOUR_MS;
/** Automatic sweeps cover this many days back. Older runs are RECOVERY, which is
 *  dry-run-first and never automatic (scripts/recoverWeather.ts). */
export const WEATHER_AUTO_LOOKBACK_DAYS = 60;
/** Workouts attempted per pass, and per browser session. */
export const WEATHER_PASS_LIMIT = 3;
export const WEATHER_SESSION_LIMIT = 12;
/** Pause between provider calls inside one pass. */
export const WEATHER_CALL_SPACING_MS = 1500;
/** After an HTTP 429 no provider call is made for this long. */
export const WEATHER_RATE_LIMIT_PAUSE_MS = 2 * HOUR_MS;
/** Failure-ledger size bound (oldest entries are dropped first). */
export const WEATHER_LEDGER_MAX_ENTRIES = 400;

/** Backoff ladders. Index = failures so far (capped at the last entry). */
const TRANSIENT_BACKOFF_MS = [1 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS, 3 * DAY_MS, 7 * DAY_MS];
/** No start coordinate: the route may still be syncing from iOS, so retry
 *  slowly rather than never. */
const NO_START_BACKOFF_MS = [12 * HOUR_MS, 3 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS];

export type WeatherFailureKind = "transient" | "no-start-point";

export interface WeatherLedgerEntry {
  failures: number;
  /** Epoch ms before which the workout must not be retried. */
  nextAttemptAt: number;
  kind: WeatherFailureKind;
}

export interface WeatherLedger {
  version: 1;
  /** Epoch ms; while in the future no provider call may be made at all. */
  pausedUntil: number;
  entries: Record<string, WeatherLedgerEntry>;
}

export const EMPTY_WEATHER_LEDGER: WeatherLedger = { version: 1, pausedUntil: 0, entries: {} };

export type WeatherSkipReason =
  | "has-weather"
  | "not-run"
  | "manual-entry"
  | "no-route"
  | "indoor"
  | "excluded"
  | "invalid-dates"
  | "too-recent"
  | "outside-window"
  | "cooldown";

export type WeatherEligibility =
  | { eligible: true }
  | { eligible: false; reason: WeatherSkipReason };

const INDOOR = /treadmill|indoor/i;

/** A stored snapshot counts as present only when it is a complete record. */
export function hasStoredWeather(weather: WeatherSnapshot | null | undefined): boolean {
  return weather != null;
}

/** Latitude/longitude in range and not the (0, 0) "missing" sentinel. */
export function isUsableStartCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

export interface WeatherEligibilityOptions {
  now: number;
  /** Lookback window in days; `null` disables the window (recovery planning). */
  lookbackDays: number | null;
  override?: Pick<WorkoutOverride, "isExcluded" | "runTypeOverride"> | null;
  ledger?: WeatherLedger;
}

/**
 * Reasons are evaluated in a fixed order so counts are stable. Cooldown is
 * evaluated last: a workout that is ineligible for structural reasons never
 * reports a cooldown.
 */
export function weatherEligibility(
  workout: HealthWorkout,
  options: WeatherEligibilityOptions
): WeatherEligibility {
  const skip = (reason: WeatherSkipReason): WeatherEligibility => ({ eligible: false, reason });
  if (!workout.isRunLike) return skip("not-run");
  if (workout.entrySource === "manual") return skip("manual-entry");
  if (hasStoredWeather(workout.weather)) return skip("has-weather");
  if (workout.hasRoute !== true) return skip("no-route");
  const overrideType = options.override?.runTypeOverride;
  const indoor = overrideType != null
    ? INDOOR.test(overrideType)
    : INDOOR.test(workout.displayType ?? "");
  if (indoor) return skip("indoor");
  if (options.override?.isExcluded) return skip("excluded");
  const start = workout.startDate instanceof Date ? workout.startDate.getTime() : NaN;
  const end = workout.endDate instanceof Date ? workout.endDate.getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return skip("invalid-dates");
  if (options.now - end < WEATHER_SETTLE_MS) return skip("too-recent");
  if (options.lookbackDays !== null && options.now - start > options.lookbackDays * DAY_MS) {
    return skip("outside-window");
  }
  const entry = options.ledger?.entries[workout.workoutId];
  if (entry && entry.nextAttemptAt > options.now) return skip("cooldown");
  return { eligible: true };
}

export interface SelectOptions {
  now: number;
  limit?: number;
  lookbackDays?: number | null;
  overrides?: Record<string, WorkoutOverride>;
  ledger?: WeatherLedger;
  /** Ids already handled or in flight in this session. */
  exclude?: ReadonlySet<string>;
}

/** Newest-first, bounded list of workouts to attempt. Returns ids only. */
export function selectWeatherCandidates(workouts: readonly HealthWorkout[], options: SelectOptions): string[] {
  const ledger = options.ledger ?? EMPTY_WEATHER_LEDGER;
  if (ledger.pausedUntil > options.now) return [];
  const limit = Math.max(0, options.limit ?? WEATHER_PASS_LIMIT);
  const lookbackDays = options.lookbackDays === undefined ? WEATHER_AUTO_LOOKBACK_DAYS : options.lookbackDays;
  const ordered = [...workouts].sort((a, b) => {
    const diff = (b.startDate?.getTime?.() ?? 0) - (a.startDate?.getTime?.() ?? 0);
    return diff !== 0 ? diff : a.workoutId.localeCompare(b.workoutId);
  });
  const picked: string[] = [];
  for (const workout of ordered) {
    if (picked.length >= limit) break;
    if (options.exclude?.has(workout.workoutId)) continue;
    const verdict = weatherEligibility(workout, {
      now: options.now,
      lookbackDays,
      override: options.overrides?.[workout.workoutId] ?? null,
      ledger,
    });
    if (verdict.eligible) picked.push(workout.workoutId);
  }
  return picked;
}

/** Ledger update after a failed attempt. Pure; returns a new ledger. */
export function recordWeatherFailure(
  ledger: WeatherLedger,
  workoutId: string,
  kind: WeatherFailureKind,
  now: number
): WeatherLedger {
  const previous = ledger.entries[workoutId];
  const failures = (previous?.failures ?? 0) + 1;
  const ladder = kind === "no-start-point" ? NO_START_BACKOFF_MS : TRANSIENT_BACKOFF_MS;
  const delay = ladder[Math.min(failures - 1, ladder.length - 1)];
  return trimLedger({
    ...ledger,
    entries: { ...ledger.entries, [workoutId]: { failures, kind, nextAttemptAt: now + delay } },
  });
}

/** Success (or an already-present snapshot) clears the workout's entry. */
export function clearWeatherFailure(ledger: WeatherLedger, workoutId: string): WeatherLedger {
  if (!(workoutId in ledger.entries)) return ledger;
  const entries = { ...ledger.entries };
  delete entries[workoutId];
  return { ...ledger, entries };
}

/** Provider said "slow down": pause every call, whatever the workout. */
export function pauseWeatherProvider(ledger: WeatherLedger, now: number): WeatherLedger {
  return { ...ledger, pausedUntil: now + WEATHER_RATE_LIMIT_PAUSE_MS };
}

function trimLedger(ledger: WeatherLedger): WeatherLedger {
  const keys = Object.keys(ledger.entries);
  if (keys.length <= WEATHER_LEDGER_MAX_ENTRIES) return ledger;
  const keep = keys
    .sort((a, b) => ledger.entries[b].nextAttemptAt - ledger.entries[a].nextAttemptAt)
    .slice(0, WEATHER_LEDGER_MAX_ENTRIES);
  return { ...ledger, entries: Object.fromEntries(keep.map((k) => [k, ledger.entries[k]])) };
}

/** Defensive parse of the persisted ledger; anything malformed resets to empty. */
export function parseWeatherLedger(raw: unknown): WeatherLedger {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || (value as WeatherLedger).version !== 1) return EMPTY_WEATHER_LEDGER;
    const source = value as WeatherLedger;
    const entries: Record<string, WeatherLedgerEntry> = {};
    for (const [id, entry] of Object.entries(source.entries ?? {})) {
      if (
        entry && Number.isFinite(entry.failures) && Number.isFinite(entry.nextAttemptAt) &&
        (entry.kind === "transient" || entry.kind === "no-start-point")
      ) {
        entries[id] = { failures: entry.failures, nextAttemptAt: entry.nextAttemptAt, kind: entry.kind };
      }
    }
    return trimLedger({
      version: 1,
      pausedUntil: Number.isFinite(source.pausedUntil) ? source.pausedUntil : 0,
      entries,
    });
  } catch {
    return EMPTY_WEATHER_LEDGER;
  }
}

/* ------------------------------------------------------------------ */
/* In-session de-duplication shared by the runner and Run Detail.      */
/* ------------------------------------------------------------------ */

const claimed = new Set<string>();

/** Returns false when another caller in this tab already owns the workout. */
export function claimWeatherWork(workoutId: string): boolean {
  if (claimed.has(workoutId)) return false;
  claimed.add(workoutId);
  return true;
}

export function releaseWeatherWork(workoutId: string): void {
  claimed.delete(workoutId);
}

/* ------------------------------------------------------------------ */
/* Recovery planning (counts only; executes nothing).                  */
/* ------------------------------------------------------------------ */

export interface WeatherRecoveryPlan {
  asOf: string;
  runLike: number;
  alreadyHaveWeather: number;
  /** Eligible now and inside the automatic window — the runner handles these. */
  automaticallyRecoverable: number;
  /** Eligible but older than the automatic window — needs an explicit run. */
  requiresExplicitRecovery: number;
  skippedByReason: Partial<Record<WeatherSkipReason, number>>;
  /** Upper bounds if every eligible workout were processed. */
  estimate: {
    weatherApiCalls: number;
    routeDocumentReads: number;
    workoutDocumentReads: number;
    workoutDocumentWrites: number;
    /** Open-Meteo free tier: 600/min, 5,000/h, 10,000/day (non-commercial). */
    daysAtDailyApiBudget: number;
  };
}

/** Non-commercial free-tier daily allowance, used only to size a recovery. */
const OPEN_METEO_DAILY_CALLS = 10_000;

export function planWeatherRecovery(
  workouts: readonly HealthWorkout[],
  options: { now: number; overrides?: Record<string, WorkoutOverride>; ledger?: WeatherLedger }
): WeatherRecoveryPlan {
  const skipped: Partial<Record<WeatherSkipReason, number>> = {};
  let runLike = 0;
  let have = 0;
  let automatic = 0;
  let explicit = 0;
  for (const workout of workouts) {
    if (!workout.isRunLike) continue;
    runLike += 1;
    const base = { now: options.now, override: options.overrides?.[workout.workoutId] ?? null, ledger: options.ledger };
    const all = weatherEligibility(workout, { ...base, lookbackDays: null });
    if (!all.eligible) {
      skipped[all.reason] = (skipped[all.reason] ?? 0) + 1;
      if (all.reason === "has-weather") have += 1;
      continue;
    }
    const windowed = weatherEligibility(workout, { ...base, lookbackDays: WEATHER_AUTO_LOOKBACK_DAYS });
    if (windowed.eligible) automatic += 1; else explicit += 1;
  }
  const eligible = automatic + explicit;
  return {
    asOf: new Date(options.now).toISOString(),
    runLike,
    alreadyHaveWeather: have,
    automaticallyRecoverable: automatic,
    requiresExplicitRecovery: explicit,
    skippedByReason: skipped,
    estimate: {
      weatherApiCalls: eligible,
      routeDocumentReads: eligible,
      workoutDocumentReads: eligible,
      workoutDocumentWrites: eligible,
      daysAtDailyApiBudget: Math.ceil(eligible / OPEN_METEO_DAILY_CALLS),
    },
  };
}
