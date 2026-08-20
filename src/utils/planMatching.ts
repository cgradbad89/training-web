import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";
import { parseLocalDate } from "@/utils/dates";

export type MatchQuality = "full" | "partial";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Canonical "which plan week is `referenceDate` in" index for a plan whose
 * `startDate` is the stored "YYYY-MM-DD" string. 0 = the plan's first week.
 *
 * This standardizes ONLY the parsing and the arithmetic. It does NOT decide
 * which reference date is appropriate — that is the caller's business, and
 * different surfaces legitimately differ (the Monday of the week being viewed
 * on /dashboard, "now" on /plans and PlanEditor). Callers keep their own
 * reference date and their own clamping/range checks.
 *
 * `startDate` is parsed as LOCAL midnight via `parseLocalDate` (invariant #12).
 * The bug this replaces: three call sites used `new Date(plan.startDate)`,
 * which parses a date-only string as UTC midnight. At a POSITIVE UTC offset
 * (e.g. Europe/Berlin, UTC+1) that lands an hour AHEAD of the local Monday the
 * caller passes in, so `weekStart - planStart` goes slightly negative and
 * `Math.floor` returns **-1 for the plan's own first week** — the week tiles
 * then read "no plan this week" on a plan that started that very Monday.
 *
 * The result is unclamped and can be negative (reference date before the plan
 * started) or past the last week; every caller already range-checks it.
 *
 * DST FIX (see PRD §6 #41): diffing raw milliseconds and dividing by a
 * fixed week-length under-counts by one week for every reference date after
 * a SPRING-FORWARD DST transition inside the plan (49 calendar days becomes
 * 49 days minus an hour = 6.994 weeks, which used to floor to 6 instead of
 * the correct 7).
 *
 * The dashboard's page-title week-diff fixes this the same class of bug by
 * rounding a raw ms/week division — but that's only safe there because BOTH
 * dates it diffs are already Monday-aligned (`getWeekStart()` results), so
 * the DST hour is the only source of fractional drift. `planWeekIndexFor` is
 * called with arbitrary, non-aligned reference dates too (`new Date()` "now"
 * on /plans and PlanEditor) — for those, rounding a raw ms/week fraction
 * would flip the index a week early as soon as `referenceDate` is more than
 * 3.5 days into the current week (i.e. every Thu–Sun, regardless of DST).
 *
 * The fix that's actually DST-safe without that regression: diff whole
 * CALENDAR days first (via `Date.UTC` on each date's local Y/M/D components —
 * same technique as `differenceInCalendarDays` below, which sidesteps DST by
 * never touching wall-clock time-of-day), THEN floor-divide by 7. Calendar
 * days are always exact integers, so there is no fractional week to round —
 * this removes the DST hour distortion at the source instead of rounding it
 * away, and every non-DST-crossing case is unchanged (day-diff floor === the
 * old ms-diff floor whenever there's no DST transition in between).
 */
export function planWeekIndexFor(
  startDate: string,
  referenceDate: Date
): number {
  const start = parseLocalDate(startDate);
  const startUTC = Date.UTC(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  );
  const refUTC = Date.UTC(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  );
  const dayDiff = Math.round((refUTC - startUTC) / MS_PER_DAY);
  return Math.floor(dayDiff / 7);
}

export interface PlanMatch {
  activity: HealthWorkout;
  quality: MatchQuality;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function plannedEntryDate(plan: RunningPlan, entry: PlannedRunEntry): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const daysOffset = entry.weekIndex * 7 + (entry.weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + daysOffset);
  return d;
}

/**
 * The workout's LOCAL calendar day key, "YYYY-MM-DD".
 *
 * This must agree with `plannedEntryDate`/`toISODate` above (planned dates are
 * built from LOCAL date components) and with every mileage/stat surface in the
 * app, all of which bucket a run by its local day — `weeklyLoad.ts`,
 * `trainingLoadSeries.ts`, `routePerformance.ts`, `MiniCalendar.tsx` each carry
 * their own identical `toLocalIsoDate`, and `services/autoMatch.ts` groups its
 * workout pool with the same `localISODate` (getFullYear/getMonth/getDate)
 * mechanism. `toISODate` here IS that mechanism — this is a reuse, not a
 * reimplementation.
 *
 * The bug this replaces (PRD §6): the key was `startDate.toISOString()`, i.e.
 * the UTC day. West of UTC that rolls forward for evening runs (a 21:00 EDT
 * Sunday run is Monday in UTC); east of UTC it rolls backward for the small
 * hours (a 00:30 CET Monday run is Sunday in UTC). Verified against the real
 * matcher: with a plan holding a Sunday entry and the next week's Monday
 * entry, a 21:00-local Sunday run matched the MONDAY entry in America/New_York
 * while its mileage counted toward the Sunday week on every stat card, and a
 * Sunday-evening + Monday-morning pair had their two entries swapped outright.
 *
 * The ±1-day tolerance below is untouched and needed no adjustment: both
 * `differenceInCalendarDays` and `isoWeekNumber` operate on the "YYYY-MM-DD"
 * STRINGS, so they are agnostic to how a key was derived — this changes only
 * which day a run reports, not what "within one day" means.
 */
function workoutDate(w: HealthWorkout): string {
  return toISODate(w.startDate);
}

// A run is "full" completion once its actual mileage reaches 85% of planned;
// below that it still matches (day proximity is the only matching gate) but
// is graded "partial".
const COMPLETION_THRESHOLD_RATIO = 0.85;

function meetsCompletionThreshold(
  actualMiles: number,
  plannedMiles: number
): boolean {
  if (!plannedMiles || plannedMiles <= 0) return true;
  return actualMiles / plannedMiles >= COMPLETION_THRESHOLD_RATIO;
}

/** DST-safe calendar day difference using local date components */
function differenceInCalendarDays(a: string, b: string): number {
  // Parse as local dates (YYYY-MM-DD) to avoid timezone/DST issues
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const aUtcMs = Date.UTC(ay, am - 1, ad);
  const bUtcMs = Date.UTC(by, bm - 1, bd);
  return Math.round((aUtcMs - bUtcMs) / 86400000);
}

function withinOneDay(aDate: string, eDate: string): boolean {
  return Math.abs(differenceInCalendarDays(aDate, eDate)) <= 1;
}

/** ISO week number (week containing Thursday, starts Monday) using UTC components */
function isoWeekNumber(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * When multiple entries compete for the same run within ±1 day,
 * pick the best candidate using tiebreaker rules:
 *   1. Prefer same/past ISO week over future week
 *   2. Prefer closest calendar day
 *   3. Prefer closest planned distance to actual run distance
 *   4. Prefer earlier planned date as final tiebreaker
 */
function pickBestCandidate(
  candidates: { entry: PlannedRunEntry; eDate: string; diffDays: number }[],
  runDateStr: string,
  runDistanceMiles: number
): { entry: PlannedRunEntry; eDate: string; diffDays: number } | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const runWeek = isoWeekNumber(runDateStr);

  // Rule 1: Prefer same/past week over future week
  const sameOrPast = candidates.filter((c) => isoWeekNumber(c.eDate) <= runWeek);
  const pool = sameOrPast.length > 0 ? sameOrPast : candidates;

  // Rule 2: Prefer closest calendar day
  const minDiff = Math.min(...pool.map((c) => c.diffDays));
  const closest = pool.filter((c) => c.diffDays === minDiff);
  if (closest.length === 1) return closest[0];

  // Rule 3: Prefer closest planned mileage
  const withDistDiff = closest.map((c) => ({
    ...c,
    distDiff: Math.abs(c.entry.distanceMiles - runDistanceMiles),
  }));
  const minDistDiff = Math.min(...withDistDiff.map((c) => c.distDiff));
  const byDist = withDistDiff.filter((c) => c.distDiff === minDistDiff);
  if (byDist.length === 1) return byDist[0];

  // Rule 4: Prefer earlier planned date
  byDist.sort((a, b) => a.eDate.localeCompare(b.eDate));
  return byDist[0];
}

/**
 * 2-pass plan vs actual matching with global used-set and tiebreaker rules.
 * Day proximity (same-day, then ±1-day) is the only gate on WHETHER a run
 * matches an entry; match quality ("full" vs "partial") is then decided
 * solely by `meetsCompletionThreshold` (actual ≥ 85% of planned).
 * Returns a map: entryId → PlanMatch | null
 *
 * `overrides` (optional, keyed by workoutId) layers user corrections onto each
 * run via the SAME `applyOverride` helper /runs and /plan-insights display
 * through — so a `distanceMilesOverride` grades against the corrected mileage
 * instead of the raw HealthKit value. It does NOT move the 85% threshold, only
 * the distance the threshold is applied to. Callers that already ran their
 * workout list through `applyOverride` may omit it (re-applying the same
 * override is idempotent — it assigns absolute values, never deltas).
 * `PlanMatch.activity` carries the override-applied workout when overrides are
 * supplied, so downstream displays show the same effective distance graded.
 */
export function matchPlanToActual(
  plan: RunningPlan,
  workouts: HealthWorkout[],
  overrides?: Record<string, WorkoutOverride>
): Map<string, PlanMatch | null> {
  const runs = workouts
    .filter((w) => w.isRunLike)
    .map((w) =>
      overrides ? applyOverride(w, overrides[w.workoutId] ?? null) : w
    );
  const result = new Map<string, PlanMatch | null>();
  // Global used set — prevents a run from matching entries across different weeks
  const usedGlobal = new Set<string>();

  // Collect all non-rest entries with their planned dates
  const allEntries: { entry: PlannedRunEntry; eDate: string }[] = [];
  for (const week of plan.weeks) {
    for (const e of week.entries) {
      if (e.runType === "rest") continue;
      allEntries.push({ entry: e, eDate: toISODate(plannedEntryDate(plan, e)) });
    }
  }

  // Pass 1: exact day, any distance → quality via completion threshold
  for (const { entry: e, eDate } of allEntries) {
    if (result.has(e.id)) continue;
    for (const w of runs) {
      if (usedGlobal.has(w.workoutId)) continue;
      if (workoutDate(w) !== eDate) continue;
      const quality: MatchQuality = meetsCompletionThreshold(
        w.distanceMiles,
        e.distanceMiles
      )
        ? "full"
        : "partial";
      result.set(e.id, { activity: w, quality });
      usedGlobal.add(w.workoutId);
      break;
    }
  }

  // Pass 2: ±1 day, any distance → quality via completion threshold (with tiebreaker)
  for (const w of runs) {
    if (usedGlobal.has(w.workoutId)) continue;
    const wDate = workoutDate(w);

    const candidates = allEntries
      .filter(({ entry: e, eDate }) => {
        if (result.has(e.id)) return false;
        if (!withinOneDay(wDate, eDate)) return false;
        return true;
      })
      .map(({ entry, eDate }) => ({
        entry,
        eDate,
        diffDays: Math.abs(differenceInCalendarDays(wDate, eDate)),
      }));

    const best = pickBestCandidate(candidates, wDate, w.distanceMiles);
    if (best) {
      const quality: MatchQuality = meetsCompletionThreshold(
        w.distanceMiles,
        best.entry.distanceMiles
      )
        ? "full"
        : "partial";
      result.set(best.entry.id, { activity: w, quality });
      usedGlobal.add(w.workoutId);
    }
  }

  // Mark unmatched entries as null
  for (const { entry: e } of allEntries) {
    if (!result.has(e.id)) result.set(e.id, null);
  }

  return result;
}

// ─── Per-entry status derivation ─────────────────────────────────────────────
//
// Shared four-state status used by dashboard PlanProgressCard and the Plans
// page weekly grid. Single-sourcing this here prevents the two surfaces from
// drifting (previous regression: the dashboard treated a today-dated
// unmatched entry as "missed" while the Plans page showed "upcoming"; the
// canonical rule below — today's unmatched entry is "upcoming" until the
// day ends — is adopted everywhere).

export type RunEntryStatus = "met" | "partial" | "missed" | "upcoming";

/**
 * Decide how a planned run should display given the matchMap output and a
 * reference "now". Semantics:
 *   - matchMap value with quality "full"    → "met"
 *   - matchMap value with quality "partial" → "partial"
 *   - no match (entry absent OR null in map):
 *       entryDate < start-of-today (local) → "missed"
 *       otherwise (entryDate today or future) → "upcoming"
 * The entry's calendar date is derived from the SAME `plannedEntryDate` util
 * matchPlanToActual uses internally — no parallel date math.
 */
export function statusForRunEntry(
  plan: RunningPlan,
  entry: PlannedRunEntry,
  matchMap: Map<string, PlanMatch | null>,
  now: Date = new Date()
): RunEntryStatus {
  const match = matchMap.get(entry.id);
  if (match) {
    if (match.quality === "full") return "met";
    if (match.quality === "partial") return "partial";
  }
  const entryDate = plannedEntryDate(plan, entry);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return entryDate < startOfToday ? "missed" : "upcoming";
}

/**
 * Single source of truth for "is this planned entry completed", given its
 * four-state status. "met" (full match) and "partial" (partial match) both
 * count as completed; "missed" and "upcoming" (no match) do not.
 *
 * This is the canonical "any match counts as completed" rule — no page
 * should compute this independently again. Route any completion tally
 * (Plan Completion Summary, Plan Insights, week-progress bars, calendar
 * `completed` flags, etc.) through this helper instead of re-deriving it
 * from `PlanMatch.quality` or a raw "match != null" check.
 */
export function isPlanEntryCompleted(status: RunEntryStatus): boolean {
  return status === "met" || status === "partial";
}
