/**
 * Pure date-recompute core for editing a plan's start date / length and for
 * copy-with-new-start-date. No React, no Firestore, no IO — every function
 * returns a fresh value and never mutates its inputs.
 *
 * Domain model (see PRD §5):
 *   - A plan stores `startDate` (ISO "YYYY-MM-DD", Monday-normalized by
 *     convention) + `weeks: PlanWeek[]`. There is NO stored end date or total
 *     week count — total weeks = `plan.weeks.length`, end date is derived.
 *   - Entry calendar dates are DERIVED: startDate + weekIndex*7 + (weekday-1)
 *     days (mirrors `plannedEntryDate` in planMatching.ts). Entries store only
 *     weekIndex/weekday/dayOfWeek, never an absolute date — so a "slide" is
 *     literally just changing `startDate`; every consumer re-derives live.
 *
 * Locked policy decisions implemented here:
 *   - START date = slide handle: shift the whole plan; weeks.length unchanged;
 *     the derived end date moves with it.
 *   - END date = length handle: start fixed; recompute week count from the span;
 *     lengthen → append empty weeks, shorten → drop trailing weeks.
 *   - Monday-snap: start dates are snapped to the Monday of their week.
 *   - Workout completion on slide: every workout entry's completed/completedAt
 *     is cleared (so a re-run of auto-match re-evaluates against new dates).
 *     Running plans carry no per-entry completion state, so they're untouched.
 */

import {
  type Plan,
  type RunningPlan,
  type WorkoutPlan,
  type PlannedRunEntry,
  type PlannedWorkoutEntry,
  isRunningPlan,
  isWorkoutPlan,
} from "@/types/plan";
import { deepCopyRunningPlan, deepCopyWorkoutPlan } from "@/utils/planCopy";

// ─── Local-date helpers (no UTC parse — avoids off-by-one timezone drift) ─────

/** Parse an ISO "YYYY-MM-DD" string as a LOCAL date (mirrors plannedEntryDate). */
function parseLocalDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Format a Date back to ISO "YYYY-MM-DD" using its LOCAL components. */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Add `days` to an ISO date (local) and return the new ISO date. */
function addDays(iso: string, days: number): string {
  const d = parseLocalDate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/**
 * DST-safe whole-day difference (a − b) using UTC components of the local
 * calendar dates — same technique as differenceInCalendarDays in planMatching.
 */
function calendarDaysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

// ─── Public payload type for copy ─────────────────────────────────────────────

/** The shape the copy handlers feed createPlan (no id/createdAt/updatedAt). */
export type NewPlanPayload =
  | Omit<RunningPlan, "id" | "createdAt" | "updatedAt">
  | Omit<WorkoutPlan, "id" | "createdAt" | "updatedAt">;

// ─── Date math ────────────────────────────────────────────────────────────────

/**
 * Monday of the week containing `iso`, returned as ISO "YYYY-MM-DD". A Monday
 * returns itself; any other day snaps back to the Monday on/before it.
 */
export function snapToMonday(iso: string): string {
  const d = parseLocalDate(iso);
  const dow = d.getDay(); // 0=Sun, 1=Mon, … 6=Sat
  const delta = dow === 0 ? -6 : 1 - dow; // back to the Monday on/before
  d.setDate(d.getDate() + delta);
  return toISODate(d);
}

/**
 * End date (ISO) for a plan that starts on `startIso` and runs `weeks` weeks =
 * startIso + (weeks*7 − 1) days — the Sunday of the final week. Canonical
 * version of the former inline `endDateForWeeks` helper in plans/page.tsx.
 */
export function endDateForWeeks(startIso: string, weeks: number): string {
  return addDays(startIso, weeks * 7 - 1);
}

/**
 * Derived end date (ISO) for an existing plan = startDate + (weeks.length*7 − 1)
 * days — the Sunday of the final week.
 */
export function derivePlanEndDate(plan: Plan): string {
  return endDateForWeeks(plan.startDate, plan.weeks.length);
}

/**
 * True when the plan's derived end date falls strictly after the given race
 * date (both ISO "YYYY-MM-DD", so a lexical compare is a date compare). False
 * when no race date is supplied. Pure — drives a non-blocking informational note.
 */
export function endsAfterRace(plan: Plan, raceDateIso?: string): boolean {
  if (!raceDateIso) return false;
  return derivePlanEndDate(plan) > raceDateIso;
}

/**
 * Number of weeks spanned by start..end, matching the create-modal formula:
 * ceil(daySpan / 7), clamped to a minimum of 1.
 */
export function weeksForSpan(startIso: string, endIso: string): number {
  const days = calendarDaysBetween(endIso, startIso);
  return Math.max(1, Math.ceil(days / 7));
}

// ─── Slide (start handle) ─────────────────────────────────────────────────────

/**
 * SLIDE: set the plan's startDate (snapped to Monday). The whole plan shifts;
 * weeks.length is unchanged and every derived date moves by the same offset.
 *
 * For a WORKOUT plan, completed/completedAt on every entry is cleared (policy) so
 * a re-run of auto-match re-evaluates against the new dates. Running plans have
 * no per-entry completion state and are left structurally identical.
 *
 * Pure — returns a new plan; inputs are never mutated.
 */
export function slideStartDate(plan: Plan, newStartIso: string): Plan {
  const startDate = snapToMonday(newStartIso);

  if (isWorkoutPlan(plan)) {
    const weeks = plan.weeks.map((w) => ({
      ...w,
      entries: w.entries.map((e) => {
        const cleared: PlannedWorkoutEntry = { ...e, completed: false };
        delete cleared.completedAt;
        return cleared;
      }),
    }));
    return { ...plan, startDate, weeks };
  }

  return { ...plan, startDate };
}

// ─── Resize (length handle) ───────────────────────────────────────────────────

/**
 * RESIZE via end date: start fixed; newWeeks = weeksForSpan(startDate, end).
 *   - lengthen → append empty { weekNumber: n+1, entries: [] } up to newWeeks
 *   - shorten  → weeks.slice(0, newWeeks)
 *   - same count → returns an equivalent plan (no-op)
 * weekNumber stays sequential (index+1); kept weeks/entries are untouched, so
 * no weekIndex reindexing is needed. newWeeks is clamped to ≥1 by weeksForSpan.
 *
 * Pure — returns a new plan; inputs are never mutated.
 */
export function resizeToEndDate(plan: Plan, newEndIso: string): Plan {
  const newWeeks = weeksForSpan(plan.startDate, newEndIso);
  const current = plan.weeks.length;

  // Loose view of the existing weeks so the union (PlanWeek[] | PlanWorkoutWeek[])
  // can be spread/sliced uniformly; the empty-week shape satisfies both.
  const existing = plan.weeks as Array<{ weekNumber: number; entries: unknown[] }>;

  if (newWeeks === current) {
    return { ...plan, weeks: [...existing] } as Plan;
  }

  if (newWeeks > current) {
    const appended: Array<{ weekNumber: number; entries: never[] }> = [];
    for (let i = current; i < newWeeks; i++) {
      appended.push({ weekNumber: i + 1, entries: [] });
    }
    return { ...plan, weeks: [...existing, ...appended] } as Plan;
  }

  return { ...plan, weeks: existing.slice(0, newWeeks) } as Plan;
}

/**
 * The trailing weeks (index ≥ newWeeks) that would be dropped by a resize AND
 * contain at least one non-rest entry. Used by the shorten-confirm dialog
 * (Prompt 2). Empty or rest-only trailing weeks are excluded.
 */
export function droppedWeeksWithEntries(
  plan: Plan,
  newWeeks: number
): { weekNumber: number; entryCount: number }[] {
  const isRest = isRunningPlan(plan)
    ? (e: unknown) => (e as PlannedRunEntry).runType === "rest"
    : (e: unknown) => (e as PlannedWorkoutEntry).type === "rest";

  const result: { weekNumber: number; entryCount: number }[] = [];
  for (let i = Math.max(0, newWeeks); i < plan.weeks.length; i++) {
    const week = plan.weeks[i];
    const nonRest = (week.entries as unknown[]).filter((e) => !isRest(e));
    if (nonRest.length > 0) {
      result.push({ weekNumber: week.weekNumber, entryCount: nonRest.length });
    }
  }
  return result;
}

// ─── Copy + new start ─────────────────────────────────────────────────────────

/**
 * COPY with a new start date: deep-copy the plan (fresh entry ids, status
 * "draft", isActive false; workout copies already clear completed/completedAt),
 * then slide it to the new Monday-snapped start. Returns the payload ready for
 * createPlan. Equivalent to deepCopy → slideStartDate; the deep-copy already
 * applies the workout completion-clear, so only the startDate is set here.
 *
 * Pure — the source plan is never mutated.
 */
export function copyPlanWithNewStart(
  plan: Plan,
  newName: string,
  newStartIso: string
): NewPlanPayload {
  const startDate = snapToMonday(newStartIso);

  if (isWorkoutPlan(plan)) {
    return { ...deepCopyWorkoutPlan(plan, newName), startDate };
  }
  return { ...deepCopyRunningPlan(plan as RunningPlan, newName), startDate };
}
