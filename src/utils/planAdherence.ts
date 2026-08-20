/**
 * Pure plan-adherence aggregation for running plans.
 *
 * This is the SINGLE SOURCE for both:
 *   - Plan Insights (passes `throughDate = getWeekStart(now)` to reproduce its
 *     historical "elapsed weeks only" behavior), and
 *   - the plan-completion summary (omits `throughDate` to compute over the
 *     plan's FULL span).
 *
 * The math is lifted verbatim from the former inline `adherenceData` / `planStats`
 * useMemo closures on the Plan Insights page — same ±1-day matching engine
 * (`matchPlanToActual`), same per-week run-load (`resolveDisplayLoad`, null-HR
 * runs excluded), same planned/actual/weeks-hit definitions — so the rewired
 * page renders identical numbers. No Firestore, no React.
 */

import { type RunningPlan } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  matchPlanToActual,
  statusForRunEntry,
  isPlanEntryCompleted,
} from "@/utils/planMatching";
import { resolveDisplayLoad, DEFAULT_RESTING_HR } from "@/utils/trainingLoad";
import { parseLocalDate } from "@/utils/dates";

export interface WeekAdherence {
  weekNumber: number; // 1-based
  label: string; // e.g. "W1"
  plannedMiles: number;
  actualMiles: number;
  runLoad: number;
  plannedRuns: number;
  completedRuns: number;
  /** Per-week weighted avg pace (total duration ÷ total miles); null if no runs. */
  avgPaceSecPerMile: number | null;
}

export interface PlanAdherenceResult {
  weeks: WeekAdherence[];
  totalPlannedMiles: number;
  totalActualMiles: number;
  totalPlannedRuns: number;
  totalCompletedRuns: number;
  weeksHitTarget: number;
  /** Weighted avg pace across the whole included span; null if no runs. */
  overallAvgPaceSecPerMile: number | null;
}

interface BuildOpts {
  maxHr: number;
  restingHr?: number;
  /** When set, include only weeks whose start is on/before this date (the Plan
   *  Insights "elapsed weeks" cutoff). When omitted, include ALL plan weeks. */
  throughDate?: Date;
}

export function buildPlanAdherence(
  plan: RunningPlan,
  runs: HealthWorkout[],
  opts: BuildOpts
): PlanAdherenceResult {
  const { maxHr, throughDate } = opts;
  // resolveDisplayLoad needs a concrete resting HR; default matches the app.
  const restingHr = opts.restingHr ?? DEFAULT_RESTING_HR;

  // Plan start as LOCAL midnight (invariant #12) via the canonical
  // `parseLocalDate` — the same helper `planActualTable.ts` and
  // `planMatching.ts`'s `planWeekIndexFor` already use. NOT `new Date(...)`,
  // which parses a date-only string as UTC midnight: west of UTC that lands
  // on the SUNDAY EVENING before the plan's Monday, which shifted every
  // per-week window below off the Mon–Sun calendar (see PRD §6 #43).
  const planStart = parseLocalDate(plan.startDate);

  // ±1-day matching engine — applied once across the whole plan.
  const matchMap = matchPlanToActual(plan, runs);

  const weeks: WeekAdherence[] = [];
  let overallDuration = 0;
  let overallMiles = 0;

  plan.weeks.forEach((week, idx) => {
    // Optional elapsed-week cutoff (preserves Plan Insights behavior).
    if (throughDate) {
      const wsFilter = new Date(planStart);
      wsFilter.setDate(wsFilter.getDate() + idx * 7);
      if (!(wsFilter <= throughDate)) return;
    }

    const runEntries = week.entries.filter((e) => e.runType !== "rest");
    const plannedMiles = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
    const plannedRuns = runEntries.length;

    // Actual miles from matched runs (each run matched at most once).
    const matchedIds = new Set<string>();
    let actualMiles = 0;
    let completedRuns = 0;
    for (const e of runEntries) {
      const m = matchMap.get(e.id);
      // Canonical "is completed" rule (isPlanEntryCompleted): full AND
      // partial matches both count — not just "full" as before.
      if (isPlanEntryCompleted(statusForRunEntry(plan, e, matchMap))) {
        completedRuns += 1;
      }
      if (m && !matchedIds.has(m.activity.workoutId)) {
        actualMiles += m.activity.distanceMiles;
        matchedIds.add(m.activity.workoutId);
      }
    }

    // Week date range (Mon 00:00 → Sun 23:59:59.999 LOCAL), via weekNumber as
    // the page did. `setDate` on a local-midnight date keeps the wall-clock
    // time across a DST transition, so mid-plan weeks stay Monday-aligned.
    const ws = new Date(planStart);
    ws.setDate(ws.getDate() + (week.weekNumber - 1) * 7);
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    we.setHours(23, 59, 59, 999);

    // Bonus/extra runs in the week's range not tied to any planned session.
    for (const r of runs) {
      if (matchedIds.has(r.workoutId)) continue;
      if (!r.isRunLike) continue;
      if (r.startDate >= ws && r.startDate <= we) {
        actualMiles += r.distanceMiles;
        matchedIds.add(r.workoutId);
      }
    }

    // Per-week run load — every run in range, null-HR runs excluded.
    // Per-week pace — weighted (Σ duration ÷ Σ miles) over the same set.
    let runLoad = 0;
    let weekDuration = 0;
    let weekMiles = 0;
    for (const r of runs) {
      if (!r.isRunLike) continue;
      if (r.startDate < ws || r.startDate > we) continue;
      const score = resolveDisplayLoad(r, maxHr, restingHr);
      if (score != null) runLoad += score;
      if (r.distanceMiles > 0 && isFinite(r.durationSeconds) && r.durationSeconds > 0) {
        weekDuration += r.durationSeconds;
        weekMiles += r.distanceMiles;
      }
    }
    overallDuration += weekDuration;
    overallMiles += weekMiles;

    weeks.push({
      weekNumber: week.weekNumber,
      label: `W${week.weekNumber}`,
      plannedMiles,
      actualMiles,
      runLoad,
      plannedRuns,
      completedRuns,
      avgPaceSecPerMile: weekMiles > 0 ? weekDuration / weekMiles : null,
    });
  });

  const totalPlannedMiles = weeks.reduce((s, w) => s + w.plannedMiles, 0);
  const totalActualMiles = weeks.reduce((s, w) => s + w.actualMiles, 0);
  const totalPlannedRuns = weeks.reduce((s, w) => s + w.plannedRuns, 0);
  const totalCompletedRuns = weeks.reduce((s, w) => s + w.completedRuns, 0);
  const weeksHitTarget = weeks.filter(
    (w) => w.plannedMiles > 0 && w.actualMiles >= w.plannedMiles * 0.85
  ).length;

  return {
    weeks,
    totalPlannedMiles,
    totalActualMiles,
    totalPlannedRuns,
    totalCompletedRuns,
    weeksHitTarget,
    overallAvgPaceSecPerMile: overallMiles > 0 ? overallDuration / overallMiles : null,
  };
}
