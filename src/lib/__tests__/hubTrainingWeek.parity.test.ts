/**
 * PARITY GATE — the Hub's shared weekly function vs the Dashboard's own logic.
 *
 * The REFERENCE section below is the Dashboard's ORIGINAL inline weekly logic,
 * copied verbatim from `src/app/(app)/dashboard/page.tsx` and
 * `src/utils/planCalendar.ts` / `src/services/plans.ts` as they stood at
 * origin/main 1395000c (before the extraction). It must NEVER be edited to
 * "match" the shared code: if a test here fails, the shared function (or the
 * dashboard) drifted — fix the code, do not touch the reference. If the
 * dashboard's weekly rules change intentionally, change the dashboard AND the
 * shared function together, then re-derive the reference from the new
 * dashboard code in the same commit and say so in the PR.
 *
 * Time zones. Each scenario runs with the process pinned to BOTH
 * `America/New_York` and `UTC` (process.env.TZ is switched in-process; Node
 * re-reads it on every Date call — same technique as planWeekIndexFor.test.ts).
 * No external TZ=… invocation is needed, and `npm test` covers both:
 *   A. default calendar  — the shared function with no `timeZone` must equal the
 *      reference computed in the SAME host zone (behavior-preserving; this is
 *      what the dashboard now calls).
 *   B. Eastern-pinned    — the shared function with `America/New_York` must equal
 *      the reference computed AS THE OWNER'S NEW-YORK BROWSER SEES IT, even when
 *      the host is UTC (the reference is evaluated inside a NY-zone window).
 */

import { afterAll, describe, expect, it } from "vitest";
import { deriveTrainingWeek, toHubWorkout, type HubWorkout } from "@/lib/hubTrainingWeek";
import { HUB_TIME_ZONE } from "@/lib/hubWeek";
import {
  isRunningPlan,
  isWorkoutPlan,
  derivePlanStatus,
  isActiveFromStatus,
  type Plan,
  type PlannedRunEntry,
  type PlannedWorkoutEntry,
  type RunningPlan,
  type WorkoutPlan,
} from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { weekStart as getWeekStart, weekEnd as getWeekEnd, toDate } from "@/utils/dates";
import { buildCalendarEvents } from "@/utils/planCalendar";
import { planWeekIndexFor } from "@/utils/planMatching";
import { normalizePlanDocument } from "@/utils/planDocument";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";

// ═════════════════════════════════════════════════════════════════════════════
// REFERENCE — ORIGINAL inline logic, verbatim. Do not edit to match the code.
// ═════════════════════════════════════════════════════════════════════════════

// dashboard/page.tsx:114-134
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function getWorkoutLocalDate(w: HubWorkout): Date {
  return w.startDate;
}
function isInWeek(w: HubWorkout, wStart: Date, wEnd: Date): boolean {
  const d = getWorkoutLocalDate(w);
  return d >= wStart && d <= wEnd;
}

// dashboard/page.tsx:212-215 (RunningStatsCard)
function refRunningCard(workouts: HubWorkout[], weekStart: Date, weekEnd: Date) {
  const runs = workouts.filter((w) => w.isRunLike && isInWeek(w, weekStart, weekEnd));
  const totalMiles = runs.reduce((s, w) => s + w.distanceMiles, 0);
  return { runs, totalMiles };
}

// dashboard/page.tsx:319-321 (WorkoutsStatsCard / "This Week's Workouts")
function refWeekWorkouts(workouts: HubWorkout[], weekStart: Date, weekEnd: Date) {
  return workouts.filter((w) => !w.isRunLike && isInWeek(w, weekStart, weekEnd));
}

// dashboard/page.tsx:1677-1684
function refActivePlan(plans: Plan[]): RunningPlan | null {
  return plans.filter(isRunningPlan).find((p) => p.status === "active") ?? null;
}
function refActiveWorkoutPlan(plans: Plan[]): WorkoutPlan | null {
  return plans.filter(isWorkoutPlan).find((p) => p.status === "active") ?? null;
}

// dashboard/page.tsx:1759-1764
function refPlannedMiles(activePlan: RunningPlan | null, selectedWeekStart: Date): number {
  if (!activePlan) return 0;
  const weekIndex = planWeekIndexFor(activePlan.startDate, selectedWeekStart);
  if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return 0;
  return activePlan.weeks[weekIndex].entries.reduce((s, e) => s + e.distanceMiles, 0);
}

// dashboard/page.tsx:1840-1859
function refSessions(activeWorkoutPlan: WorkoutPlan | null, selectedWeekStart: Date) {
  if (!activeWorkoutPlan) {
    return { sessionsCompleted: 0, sessionsPlanned: 0 };
  }
  const weekIndex = planWeekIndexFor(activeWorkoutPlan.startDate, selectedWeekStart);
  if (weekIndex < 0 || weekIndex >= activeWorkoutPlan.weeks.length) {
    return { sessionsCompleted: 0, sessionsPlanned: 0 };
  }
  const sessionEntries = activeWorkoutPlan.weeks[weekIndex].entries.filter(
    (e): e is PlannedWorkoutEntry => e.type === "workout"
  );
  return {
    sessionsCompleted: sessionEntries.filter((e) => e.completed === true).length,
    sessionsPlanned: sessionEntries.length,
  };
}

// dashboard/page.tsx:1616 + WeekCalendar.tsx addDays/days memo (seven local days)
function refAddDays(date: Date, n: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

// dashboard/page.tsx:~540 (WorkoutSummaryCard label call)
function refNonRunLabel(w: HubWorkout): string {
  return resolveActivityTitle({
    customTitle: w.customTitle,
    activityType: w.displayType,
    rawActivityType: w.activityType,
    distanceMiles: w.distanceMiles,
  });
}

// planCalendar.ts (ORIGINAL buildCalendarEvents planned-construction loop, no matching)
const REF_RUN_TYPE_LABELS: Record<string, string> = {
  outdoor: "Outdoor", treadmill: "Treadmill", otf: "OTF", longRun: "Long Run",
};
function refSessionDate(startDate: string, weekIndex: number, dayIndex: number): Date {
  const [y, m, d] = startDate.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1); // parseLocalDate
  date.setDate(date.getDate() + weekIndex * 7 + dayIndex);
  return date;
}
interface RefPlannedEvent {
  kind: "planned-running" | "planned-workout";
  date: Date; entryId: string; planId: string; planName: string;
  weekIndex: number; dayIndex: number; weekday: number; sessionIndex: number;
  label: string; distanceMiles?: number; category?: string; completed?: boolean;
}
function refPlannedEvents(plans: (RunningPlan | WorkoutPlan)[]): RefPlannedEvent[] {
  const events: RefPlannedEvent[] = [];
  for (const plan of plans) {
    if (plan.status !== "active") continue;
    const counters = new Map<string, number>();
    if (plan.planType === "workout") {
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.type === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          events.push({
            kind: "planned-workout",
            date: refSessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id, planId: plan.id, planName: plan.name,
            weekIndex: entry.weekIndex, dayIndex,
            weekday: entry.weekday, sessionIndex,
            label: entry.label ?? "Workout", category: entry.category,
            completed: entry.completed ?? false,
          });
        }
      }
    } else {
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.runType === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          events.push({
            kind: "planned-running",
            date: refSessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id, planId: plan.id, planName: plan.name,
            weekIndex: entry.weekIndex, dayIndex,
            weekday: entry.weekday, sessionIndex,
            label: entry.description ??
              (entry.runType ? (REF_RUN_TYPE_LABELS[entry.runType] ?? entry.runType) : "Run"),
            distanceMiles: entry.distanceMiles,
          });
        }
      }
    }
  }
  return events;
}

// services/plans.ts fetchPlans mapping (ORIGINAL)
function refFetchPlansMapping(id: string, data: Record<string, unknown>): Plan {
  const planType = (data.planType as string | undefined) ?? "running";
  const status = derivePlanStatus(data);
  return {
    ...data,
    id,
    planType,
    status,
    isActive: isActiveFromStatus(status),
    startDate: toDate(data.startDate).toISOString().split("T")[0],
    createdAt: toDate(data.createdAt).toISOString(),
  } as Plan;
}

// ── the reference "owner's dashboard" numbers for one scenario ──────────────
interface Reference {
  runs: number;
  runMiles: number;
  nonRuns: number;
  plannedMiles: number;
  plannedRuns: number;
  sessionsPlanned: number;
  sessionsCompleted: number;
  dayKeys: string[];
  completed: Record<string, { type: string; miles?: number }[]>;
  planned: Record<string, string[]>;
}

function buildReference(s: Scenario): Reference {
  const plans = s.plans.map((p) => refFetchPlansMapping(p.id as string, p));
  const selectedWeekStart = getWeekStart(s.now);
  const selectedWeekEnd = getWeekEnd(selectedWeekStart);
  const effective = selectEffectiveWorkouts(s.workouts, s.overrides);
  const { runs, totalMiles } = refRunningCard(effective, selectedWeekStart, selectedWeekEnd);
  const nonRuns = refWeekWorkouts(effective, selectedWeekStart, selectedWeekEnd);
  const activePlan = refActivePlan(plans);
  const activeWorkoutPlan = refActiveWorkoutPlan(plans);
  const { sessionsCompleted, sessionsPlanned } = refSessions(activeWorkoutPlan, selectedWeekStart);
  const dayKeys = Array.from({ length: 7 }, (_, i) => toIsoDate(refAddDays(selectedWeekStart, i)));
  const events = refPlannedEvents(
    [activePlan, activeWorkoutPlan].filter((p): p is RunningPlan | WorkoutPlan => p !== null)
  );
  const completed: Reference["completed"] = {};
  const planned: Reference["planned"] = {};
  for (const key of dayKeys) {
    completed[key] = [...runs, ...nonRuns]
      .filter((w) => toIsoDate(w.startDate) === key)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.workoutId.localeCompare(b.workoutId))
      .map((w) => (w.isRunLike ? { type: "run", miles: w.distanceMiles } : { type: refNonRunLabel(w) }));
    planned[key] = events
      .filter((e) => toIsoDate(e.date) === key)
      .map((e) =>
        e.kind === "planned-running" && (e.distanceMiles ?? 0) > 0
          ? `${(e.distanceMiles as number).toFixed(1)} mi ${e.label}`
          : e.label
      );
  }
  return {
    runs: runs.length,
    runMiles: totalMiles,
    nonRuns: nonRuns.length,
    plannedMiles: refPlannedMiles(activePlan, selectedWeekStart),
    plannedRuns: events.filter(
      (e) => e.kind === "planned-running" && dayKeys.includes(toIsoDate(e.date))
    ).length,
    sessionsPlanned,
    sessionsCompleted,
    dayKeys,
    completed,
    planned,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

interface Scenario {
  name: string;
  now: Date;
  workouts: HubWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plans: Record<string, unknown>[]; // raw plan documents (with `id`)
}

function utc(iso: string): Date {
  return new Date(iso);
}

function rawWorkout(
  id: string,
  startIso: string,
  fields: {
    isRunLike: boolean;
    distanceMiles?: number;
    displayType: string;
    activityType: string;
    durationSeconds?: number;
    manual?: { customTitle?: string };
  }
): HubWorkout {
  const start = utc(startIso);
  return toHubWorkout(id, {
    workoutId: id,
    startDate: start,
    endDate: new Date(start.getTime() + (fields.durationSeconds ?? 1800) * 1000),
    durationSeconds: fields.durationSeconds ?? 1800,
    isRunLike: fields.isRunLike,
    distanceMiles: fields.distanceMiles,
    displayType: fields.displayType,
    activityType: fields.activityType,
    ...(fields.manual ? { entrySource: "manual", customTitle: fields.manual.customTitle } : {}),
  });
}
const run = (id: string, iso: string, miles: number) =>
  rawWorkout(id, iso, { isRunLike: true, distanceMiles: miles, displayType: "Run", activityType: "running" });

function override(id: string, patch: Partial<WorkoutOverride>): WorkoutOverride {
  return {
    workoutId: id, userId: "u", isExcluded: false, excludedAt: null, excludedReason: null,
    distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null,
    updatedAt: "2026-01-01T00:00:00.000Z", ...patch,
  };
}

function runEntry(
  id: string, weekIndex: number, weekday: number, distanceMiles: number,
  extra: Partial<PlannedRunEntry> = {}
): PlannedRunEntry {
  return { id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles, runType: "outdoor", ...extra };
}
function workoutEntry(
  id: string, weekIndex: number, weekday: number,
  extra: Partial<PlannedWorkoutEntry> = {}
): PlannedWorkoutEntry {
  return { id, weekIndex, weekday, dayOfWeek: weekday - 1, type: "workout", ...extra };
}

/** A raw running-plan document whose weeks[weekIndex] holds the supplied entries. */
function runningDoc(
  id: string, startDate: unknown, weekIndex: number, entries: PlannedRunEntry[],
  flags: Record<string, unknown> = { status: "active", isActive: true }
): Record<string, unknown> {
  const weeks = Array.from({ length: weekIndex + 2 }, (_, i) => ({
    weekNumber: i + 1,
    entries: i === weekIndex ? entries : [],
  }));
  return { id, name: `Running ${id}`, planType: "running", startDate, weeks, createdAt: "2026-01-01T00:00:00.000Z", ...flags };
}
function workoutDoc(
  id: string, startDate: unknown, weekIndex: number, entries: PlannedWorkoutEntry[],
  flags: Record<string, unknown> = { status: "active", isActive: true }
): Record<string, unknown> {
  const weeks = Array.from({ length: weekIndex + 2 }, (_, i) => ({
    weekNumber: i + 1,
    entries: i === weekIndex ? entries : [],
  }));
  return { id, name: `Workout ${id}`, planType: "workout", startDate, weeks, createdAt: "2026-01-01T00:00:00.000Z", ...flags };
}

/** Standard plan set for a week whose plan index is `wi`, starting `startDate`. */
function standardPlans(startDate: string, wi: number): Record<string, unknown>[] {
  return [
    runningDoc("run-a", startDate, wi, [
      runEntry("r1", wi, 1, 3, { description: "Easy" }),
      runEntry("r2", wi, 3, 5.5),
      runEntry("r3", wi, 5, 2, { runType: "rest" }), // malformed rest entry WITH miles (counts in miles, not runs)
      runEntry("r4", wi, 7, 8, { runType: "longRun" }),
    ]),
    workoutDoc("wk-a", startDate, wi, [
      workoutEntry("w1", wi, 2, { label: "Upper Body", category: "strength", completed: true }),
      workoutEntry("w2", wi, 4, { label: "Lower Body", category: "strength" }),
      workoutEntry("w3", wi, 4, { duration_mins: 45, category: "pilates" }), // second same-day session, default label
      workoutEntry("w4", wi, 6, { type: "rest" }),
    ]),
    runningDoc("run-old", "2025-01-06", 0, [], { status: "completed", isActive: false }),
    workoutDoc("wk-draft", startDate, wi, [workoutEntry("w9", wi, 1, { label: "Draft" })], { status: "draft", isActive: false }),
  ];
}

function scenarios(): Scenario[] {
  // Week of Mon Nov 9 – Sun Nov 15 2026 (EST, UTC-5).
  const novWorkouts: HubWorkout[] = [
    run("n-prev-sun-late", "2026-11-09T04:59:59.999Z", 9), // Sun Nov 8 23:59:59.999 ET → previous week
    run("n-utc-midnight", "2026-11-09T00:00:00.000Z", 6), // Sun Nov 8 19:00 ET (UTC Monday!) → previous ET week
    run("n-mon-first-ms", "2026-11-09T05:00:00.000Z", 1.5), // Mon 00:00:00 ET → first ms of the week
    run("n-mon", "2026-11-09T11:30:00.000Z", 3.1),
    run("n-wed", "2026-11-11T23:00:00.000Z", 5.04),
    run("n-fri-ovr", "2026-11-13T12:00:00.000Z", 4.0), // distance override → 4.2
    run("n-excluded", "2026-11-10T13:00:00.000Z", 3.0), // excluded by override
    run("n-sun-last-ms", "2026-11-16T04:59:59.999Z", 1.0), // Sun Nov 15 23:59:59.999 ET → in week
    run("n-next-mon", "2026-11-16T05:00:00.000Z", 2.0), // Mon Nov 16 00:00:00 ET → next week
    rawWorkout("n-manual", "2026-11-10T12:00:00.000Z", {
      isRunLike: false, displayType: "Strength", activityType: "traditional_strength_training",
      manual: { customTitle: "Garage lift" },
    }),
    rawWorkout("n-pilates", "2026-11-12T11:00:00.000Z", { isRunLike: false, displayType: "Pilates", activityType: "pilates" }),
    rawWorkout("n-late-thu", "2026-11-13T00:00:00.000Z", { // Thu 19:00 ET (UTC Friday)
      isRunLike: false, displayType: "Workout", activityType: "workout", distanceMiles: 2.5,
    }),
    rawWorkout("n-walk", "2026-11-14T15:00:00.000Z", { isRunLike: false, displayType: "Walk", activityType: "walking", distanceMiles: 1.2 }),
    rawWorkout("n-otf", "2026-11-14T22:00:00.000Z", { isRunLike: false, displayType: "Workout", activityType: "high_intensity_interval_training" }),
  ];
  const novOverrides = {
    "n-fri-ovr": override("n-fri-ovr", { distanceMilesOverride: 4.2 }),
    "n-excluded": override("n-excluded", { isExcluded: true, excludedAt: "2026-11-10T14:00:00.000Z" }),
  };
  const now = utc("2026-11-11T17:00:00.000Z");

  return [
    { name: "ordinary week with boundaries, overrides, exclusions, manual + non-runs", now, workouts: novWorkouts, overrides: novOverrides, plans: standardPlans("2026-11-02", 1) },
    {
      name: "legacy plans without status (isActive only) and a double-active legacy pair",
      now, workouts: novWorkouts, overrides: novOverrides,
      plans: [
        // legacy: no `status`, no `planType`; Timestamp-like startDate
        runningDoc("legacy-1", { toDate: () => new Date("2026-11-02T00:00:00.000Z") }, 1,
          [runEntry("a1", 1, 2, 4), runEntry("a2", 1, 6, 6)], { isActive: true }),
        runningDoc("legacy-2", "2026-11-02", 1, [runEntry("b1", 1, 1, 9)], { isActive: true }), // second active: must lose
        workoutDoc("legacy-w1", "2026-11-02", 1, [workoutEntry("c1", 1, 3, { label: "Core" })], { isActive: true }),
        workoutDoc("legacy-w2", "2026-11-02", 1, [workoutEntry("c2", 1, 5, { label: "Other" }), workoutEntry("c3", 1, 6, { label: "Third" })], { isActive: true }),
      ].map((d) => (d.id === "legacy-1" ? { ...d, planType: undefined } : d)),
    },
    { name: "no active plans (all draft/completed)", now, workouts: novWorkouts, overrides: novOverrides,
      plans: [
        runningDoc("d1", "2026-11-02", 1, [runEntry("x", 1, 1, 3)], { status: "draft", isActive: false }),
        workoutDoc("d2", "2026-11-02", 1, [workoutEntry("y", 1, 2, { label: "Z" })], { status: "completed", isActive: false }),
      ] },
    { name: "active plans but the week is outside the plan range", now, workouts: novWorkouts, overrides: novOverrides,
      plans: standardPlans("2025-01-06", 1) },
    { name: "empty week", now: utc("2026-12-02T17:00:00.000Z"), workouts: novWorkouts, overrides: novOverrides, plans: standardPlans("2026-11-02", 4) },
    {
      // Mon Oct 26 – Sun Nov 1 2026: spans a month end AND the DST fall-back (169 h).
      name: "month-end week that is also the DST-end week",
      now: utc("2026-10-28T15:00:00.000Z"),
      workouts: [
        run("m-prev", "2026-10-26T03:59:59.999Z", 9), // Sun Oct 25 23:59:59.999 EDT → previous week
        run("m-mon-first", "2026-10-26T04:00:00.000Z", 2), // Mon 00:00:00 EDT
        run("m-sun-early", "2026-11-01T04:30:00.000Z", 3), // Sun Nov 1 00:30 EDT
        run("m-sun-late", "2026-11-02T04:30:00.000Z", 7), // Sun Nov 1 23:30 EST (after fall-back)
        run("m-next-first", "2026-11-02T05:00:00.000Z", 5), // Mon Nov 2 00:00:00 EST → next week
        rawWorkout("m-otf", "2026-11-01T22:00:00.000Z", { isRunLike: false, displayType: "Workout", activityType: "high_intensity_interval_training" }),
      ],
      overrides: {},
      plans: standardPlans("2026-10-12", 2),
    },
    {
      // Mon Mar 2 – Sun Mar 8 2026: DST spring-forward week (167 h); plan crosses the transition.
      name: "DST-start week with a plan that crosses the spring-forward",
      now: utc("2026-03-05T15:00:00.000Z"),
      workouts: [
        run("s-mon-first", "2026-03-02T05:00:00.000Z", 4), // Mon 00:00:00 EST
        run("s-sun-early", "2026-03-08T06:00:00.000Z", 3), // Sun 01:00 EST (before spring-forward)
        run("s-sun-late", "2026-03-09T02:00:00.000Z", 5), // Sun 22:00 EDT
        run("s-next-first", "2026-03-09T04:00:00.000Z", 6), // Mon Mar 9 00:00:00 EDT → next week
        rawWorkout("s-strength", "2026-03-07T17:00:00.000Z", { isRunLike: false, displayType: "Strength", activityType: "traditional_strength_training" }),
      ],
      overrides: {},
      plans: standardPlans("2026-02-02", 4),
    },
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
  expect(actual.toFixed(1)).toBe(expected.toFixed(1));
}

function sharedInput(s: Scenario, timeZone?: string) {
  return {
    plans: s.plans.map((p) => normalizePlanDocument(p.id as string, p)),
    workouts: s.workouts,
    overrides: s.overrides,
    now: s.now,
    timeZone,
  };
}

function expectParity(s: Scenario, timeZone: string | undefined, ref: Reference) {
  const { data } = deriveTrainingWeek(sharedInput(s, timeZone));
  // totals
  expect(data.totals.runs).toBe(ref.runs);
  near(data.totals.miles, ref.runMiles);
  expect(data.totals.workouts).toBe(ref.nonRuns);
  // planned totals
  near(data.planned.miles, ref.plannedMiles);
  expect(data.planned.runs).toBe(ref.plannedRuns);
  expect(data.planned.workouts).toBe(ref.sessionsPlanned);
  // seven days
  expect(data.days.map((d) => d.date)).toEqual(ref.dayKeys);
  for (const day of data.days) {
    const expected = ref.completed[day.date];
    expect(day.completed.map((c) => c.type)).toEqual(expected.map((c) => c.type));
    day.completed.forEach((c, i) => {
      if (expected[i].miles === undefined) expect(c.miles).toBeUndefined();
      else near(c.miles as number, expected[i].miles as number);
    });
    const plannedLabels = ref.planned[day.date];
    if (plannedLabels.length === 0) expect(day).not.toHaveProperty("planned");
    else expect(day.planned).toBe(plannedLabels.join(" · "));
  }
}

const HOST_ZONES = ["America/New_York", "UTC"] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe.each(HOST_ZONES)("Hub shared week vs the dashboard's original logic — host TZ %s", (hostZone) => {
  for (const scenario of scenarios()) {
    describe(scenario.name, () => {
      it("A. default (host-local) calendar equals the dashboard reference in the same zone", () => {
        withTZ(hostZone, () => {
          expectParity(scenario, undefined, buildReference(scenario));
        });
      });

      it("B. Eastern-pinned equals the reference as a New York browser sees it", () => {
        withTZ(hostZone, () => {
          const nyReference = withTZ(HUB_TIME_ZONE, () => buildReference(scenario));
          expectParity(scenario, HUB_TIME_ZONE, nyReference);
        });
      });
    });
  }
});

describe.each(HOST_ZONES)("Eastern-pinned absolute expectations — host TZ %s", (hostZone) => {
  it("ordinary week: boundaries, overrides, exclusions and non-run records (hand-derived)", () => {
    withTZ(hostZone, () => {
      const s = scenarios()[0];
      const { periodLabel, data } = deriveTrainingWeek(sharedInput(s, HUB_TIME_ZONE));
      expect(periodLabel).toBe("Nov 9–15");
      // In ET week: first-ms 1.5, Mon 3.1, Wed 5.04, Fri override 4.2, Sun last-ms 1.0 (excluded run, prev-week and next-week runs out).
      expect(data.totals.runs).toBe(5);
      near(data.totals.miles, 1.5 + 3.1 + 5.04 + 4.2 + 1.0);
      // Non-run RECORDS: manual, pilates, late-Thursday workout, walk, OTF = 5.
      expect(data.totals.workouts).toBe(5);
      // Planned: running week miles incl. the rest entry (3 + 5.5 + 2 + 8), 3 non-rest runs, 3 workout sessions.
      near(data.planned.miles, 18.5);
      expect(data.planned.runs).toBe(3);
      expect(data.planned.workouts).toBe(3);
      // The UTC-Friday-00:00Z workout is Thursday evening in New York.
      const thu = data.days.find((d) => d.date === "2026-11-12")!;
      const fri = data.days.find((d) => d.date === "2026-11-13")!;
      // (activityType "workout" resolves to the dashboard's own friendly label, "HIIT".)
      expect(thu.completed.map((c) => c.type)).toEqual(["Pilates", "HIIT"]);
      expect(fri.completed).toEqual([{ type: "run", miles: 4.2 }]);
      // Rest-only day omits `planned`; planned days join labels with " · ".
      expect(data.days[0].planned).toBe("3.0 mi Easy");
      expect(data.days[3].planned).toBe("Lower Body · Workout");
      expect(data.days[5]).not.toHaveProperty("planned");
      // Walk keeps no miles on the item and is not in totals.miles.
      expect(data.days[5].completed.find((c) => c.type === "Walk")).toEqual({ type: "Walk" });
    });
  });
});

describe("extraction equivalence (original verbatim vs extracted)", () => {
  it("normalizePlanDocument equals the original fetchPlans mapping, incl. legacy and Timestamp-like docs", () => {
    const docs: Record<string, unknown>[] = [
      { id: "a", startDate: "2026-11-02", weeks: [], createdAt: "2026-01-01T00:00:00.000Z", isActive: true },
      { id: "b", planType: "workout", startDate: { toDate: () => new Date("2026-11-02T00:00:00Z") }, weeks: [], status: "completed", isActive: true },
      { id: "c", planType: "running", startDate: "2026-11-02", weeks: [], status: "bogus", isActive: false },
    ];
    for (const hostZone of HOST_ZONES) {
      withTZ(hostZone, () => {
        for (const doc of docs) {
          expect(normalizePlanDocument(doc.id as string, doc)).toEqual(refFetchPlansMapping(doc.id as string, doc));
        }
      });
    }
  });

  it("buildCalendarEvents' planned events (re-pointed at plannedSessionsForPlan) equal the original construction", () => {
    for (const hostZone of HOST_ZONES) {
      withTZ(hostZone, () => {
        const plans = standardPlans("2026-11-02", 1).map((p) => normalizePlanDocument(p.id as string, p)) as (RunningPlan | WorkoutPlan)[];
        const actual = buildCalendarEvents(plans, []).filter(
          (e) => e.kind === "planned-running" || e.kind === "planned-workout"
        );
        const expected = refPlannedEvents(plans);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((event, i) => {
          if (event.kind !== "planned-running" && event.kind !== "planned-workout") return;
          const ref = expected[i];
          expect(event.kind).toBe(ref.kind);
          expect(event.date.getTime()).toBe(ref.date.getTime());
          expect([event.entryId, event.planId, event.planName, event.weekIndex, event.dayIndex, event.weekday, event.sessionIndex, event.label])
            .toEqual([ref.entryId, ref.planId, ref.planName, ref.weekIndex, ref.dayIndex, ref.weekday, ref.sessionIndex, ref.label]);
          if (event.kind === "planned-running") expect(event.distanceMiles).toBe(ref.distanceMiles);
          else {
            expect(event.category).toBe(ref.category);
            expect(event.completed).toBe(ref.completed);
          }
        });
      });
    }
  });
});
