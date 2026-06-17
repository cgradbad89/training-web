/**
 * Pure builder for the Plan Insights "Actual vs Planned" table tile.
 *
 * Groups an active RunningPlan's entries into collapsible week groups, each row
 * carrying planned-vs-actual distance, pace, and the actual run-level avg HR.
 *
 * Actuals come SOLELY from the canonical matching engine
 * (`matchPlanToActual` / `statusForRunEntry` in utils/planMatching.ts) — this
 * module adds no matching logic of its own. In-memory only: no Firestore, no
 * React.
 */

import {
  type RunningPlan,
  type PlannedRunEntry,
  type PlanRunType,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  matchPlanToActual,
  statusForRunEntry,
  type RunEntryStatus,
} from "@/utils/planMatching";
import { parseLocalDate } from "@/utils/dates";
import { parsePaceString } from "@/utils/pace";

/**
 * Row status: the four canonical `RunEntryStatus` values reused verbatim, plus
 * "rest" for rest-day entries (which the matcher never matches — feeding a past
 * rest day through statusForRunEntry would mislabel it "missed").
 */
export type ActualVsPlannedStatus = RunEntryStatus | "rest";

export interface ActualVsPlannedRow {
  weekday: string; // "Mon".."Sun"
  dateLabel: string; // e.g. "Apr 7"
  runType: string; // raw PlannedRunEntry.runType ("" when absent)
  plannedDistanceMiles: number | null;
  actualDistanceMiles: number | null;
  plannedPaceSecPerMile: number | null;
  actualPaceSecPerMile: number | null;
  actualAvgHr: number | null;
  status: ActualVsPlannedStatus;
}

export interface ActualVsPlannedWeek {
  weekIndex: number; // 0-based index into plan.weeks (toggle key)
  weekLabel: string; // "Week 9"
  dateRangeLabel: string; // "Apr 6–12"
  rows: ActualVsPlannedRow[];
  plannedDistanceTotal: number;
  actualDistanceTotal: number;
  /** Distance-weighted avg planned pace; null when no priced planned runs. */
  plannedPaceAvgSecPerMile: number | null;
  /** Distance-weighted avg actual pace; null when no matched runs. */
  actualPaceAvgSecPerMile: number | null;
}

export type DeltaTone = "positive" | "negative" | "neutral";

export interface DeltaResult {
  value: number;
  tone: DeltaTone;
  label: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const EN_DASH = "–"; // range separator, e.g. "Apr 6–12"
const MINUS = "−"; // true minus sign for negative deltas

/** Display labels for the confirmed PlanRunType set. */
export const RUN_TYPE_LABELS: Record<PlanRunType, string> = {
  outdoor: "Outdoor",
  treadmill: "Treadmill",
  otf: "OTF",
  longRun: "Long Run",
  rest: "Rest",
};

// ─── small pure helpers ──────────────────────────────────────────────────────

/**
 * Per-entry calendar date. Mirrors the canonical (non-exported)
 * `plannedEntryDate()` in utils/planMatching.ts:
 *   planStart + weekIndex*7 + (weekday - 1) days.
 * Kept in lock-step by parsing the plan start with the same local-date parse.
 */
function entryDate(planStart: Date, entry: PlannedRunEntry): Date {
  const d = new Date(planStart);
  d.setDate(planStart.getDate() + entry.weekIndex * 7 + (entry.weekday - 1));
  return d;
}

function formatMonthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateRange(start: Date, end: Date): string {
  const startMonth = start.toLocaleDateString("en-US", { month: "short" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short" });
  if (startMonth === endMonth) {
    return `${startMonth} ${start.getDate()}${EN_DASH}${end.getDate()}`;
  }
  return `${startMonth} ${start.getDate()}${EN_DASH}${endMonth} ${end.getDate()}`;
}

/** Planned target pace: seconds/mi field first, else parse the "M:SS" string. */
function plannedPaceFor(entry: PlannedRunEntry): number | null {
  if (
    entry.targetPaceSecondsPerMile != null &&
    entry.targetPaceSecondsPerMile > 0
  ) {
    return entry.targetPaceSecondsPerMile;
  }
  if (entry.paceTarget) return parsePaceString(entry.paceTarget);
  return null;
}

/**
 * Actual avg pace from a matched run. Prefer the stored `avgPaceSecPerMile`;
 * fall back to durationSeconds / distanceMiles. Returns null when distanceMiles
 * is 0 so a zero-distance row never yields Infinity pace.
 */
export function actualPaceFor(w: HealthWorkout): number | null {
  if (
    w.avgPaceSecPerMile != null &&
    isFinite(w.avgPaceSecPerMile) &&
    w.avgPaceSecPerMile > 0
  ) {
    return w.avgPaceSecPerMile;
  }
  if (w.distanceMiles > 0 && isFinite(w.durationSeconds) && w.durationSeconds > 0) {
    return w.durationSeconds / w.distanceMiles;
  }
  return null;
}

/** Run-level avg HR only (the sole reliable HR per PRD). null when absent. */
function actualHrFor(w: HealthWorkout): number | null {
  return w.avgHeartRate != null && isFinite(w.avgHeartRate) && w.avgHeartRate > 0
    ? w.avgHeartRate
    : null;
}

/**
 * Distance-weighted mean pace: Σ(pace·dist) / Σ(dist) over pairs where both are
 * present and dist > 0. null when nothing qualifies.
 */
function weightedPace(pairs: Array<[number | null, number | null]>): number | null {
  let num = 0;
  let den = 0;
  for (const [pace, dist] of pairs) {
    if (pace == null || dist == null || dist <= 0 || !isFinite(pace) || pace <= 0) {
      continue;
    }
    num += pace * dist;
    den += dist;
  }
  return den > 0 ? num / den : null;
}

// ─── delta formatters (the conditional-formatting source of truth) ───────────

/**
 * Distance delta = actual − planned (miles). actual > planned → positive tone,
 * actual < planned → negative, (near-)equal → neutral. null when either side
 * is absent.
 */
export function distanceDelta(
  planned: number | null,
  actual: number | null
): DeltaResult | null {
  if (planned == null || actual == null) return null;
  const value = actual - planned;
  const tone: DeltaTone =
    value > 0.05 ? "positive" : value < -0.05 ? "negative" : "neutral";
  const abs = Math.abs(value).toFixed(1);
  const label =
    tone === "positive" ? `+${abs}` : tone === "negative" ? `${MINUS}${abs}` : "0.0";
  return { value, tone, label };
}

/**
 * Pace delta = actual − planned (sec/mi). INVERTED meaning: a FASTER actual
 * (smaller seconds) is GOOD → positive tone, shown with a leading "−"
 * (e.g. "−0:07"); a SLOWER actual → negative tone, "+0:12". null when either
 * side is absent or non-positive.
 */
export function paceDelta(
  plannedPace: number | null,
  actualPace: number | null
): DeltaResult | null {
  if (plannedPace == null || actualPace == null) return null;
  if (plannedPace <= 0 || actualPace <= 0) return null;
  const value = actualPace - plannedPace; // < 0 → faster → good
  const tone: DeltaTone =
    value < -0.5 ? "positive" : value > 0.5 ? "negative" : "neutral";
  const abs = Math.abs(Math.round(value));
  const sign = value < -0.5 ? MINUS : value > 0.5 ? "+" : "";
  const label = `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
  return { value, tone, label };
}

// ─── builder ─────────────────────────────────────────────────────────────────

/**
 * Build week groups for the Actual vs Planned tile. Reuses the canonical
 * matching engine for every actual value; computes only display-side grouping,
 * subtotals, and weighted pace averages. All plan weeks are returned (including
 * future weeks, whose runs show as "upcoming").
 */
export function buildActualVsPlannedWeeks(
  plan: RunningPlan,
  runs: HealthWorkout[],
  now: Date = new Date()
): ActualVsPlannedWeek[] {
  const matchMap = matchPlanToActual(plan, runs);
  const planStart = parseLocalDate(plan.startDate);

  return plan.weeks.map((week, idx) => {
    // Week Mon→Sun range — mirrors buildPlanAdherence's weekNumber-based math.
    const ws = new Date(planStart);
    ws.setDate(planStart.getDate() + (week.weekNumber - 1) * 7);
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);

    const rows: ActualVsPlannedRow[] = week.entries.map((entry) => {
      const weekday = WEEKDAY_LABELS[entry.weekday - 1] ?? "";
      const dateLabel = formatMonthDay(entryDate(planStart, entry));
      const runType = entry.runType ?? "";

      // Rest entries are never matched — render muted, no planned/actual values.
      if (entry.runType === "rest") {
        return {
          weekday,
          dateLabel,
          runType,
          plannedDistanceMiles: null,
          actualDistanceMiles: null,
          plannedPaceSecPerMile: null,
          actualPaceSecPerMile: null,
          actualAvgHr: null,
          status: "rest",
        };
      }

      const status = statusForRunEntry(plan, entry, matchMap, now);
      const activity = matchMap.get(entry.id)?.activity ?? null;

      return {
        weekday,
        dateLabel,
        runType,
        plannedDistanceMiles: entry.distanceMiles,
        actualDistanceMiles: activity ? activity.distanceMiles : null,
        plannedPaceSecPerMile: plannedPaceFor(entry),
        actualPaceSecPerMile: activity ? actualPaceFor(activity) : null,
        actualAvgHr: activity ? actualHrFor(activity) : null,
        status,
      };
    });

    const plannedDistanceTotal = rows.reduce(
      (s, r) => s + (r.plannedDistanceMiles ?? 0),
      0
    );
    const actualDistanceTotal = rows.reduce(
      (s, r) => s + (r.actualDistanceMiles ?? 0),
      0
    );

    return {
      weekIndex: idx,
      weekLabel: `Week ${week.weekNumber}`,
      dateRangeLabel: formatDateRange(ws, we),
      rows,
      plannedDistanceTotal,
      actualDistanceTotal,
      plannedPaceAvgSecPerMile: weightedPace(
        rows.map((r) => [r.plannedPaceSecPerMile, r.plannedDistanceMiles])
      ),
      actualPaceAvgSecPerMile: weightedPace(
        rows.map((r) => [r.actualPaceSecPerMile, r.actualDistanceMiles])
      ),
    };
  });
}
