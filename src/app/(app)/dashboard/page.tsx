"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import {
  Dumbbell,
  Zap,
  Wind,
  Flower2,
  Bike,
  Activity,
  CheckCircle2,
  MinusCircle,
  XCircle,
  Circle,
} from "lucide-react";

import { WeekNavigator } from "@/components/layout/WeekNavigator";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { WeekCalendar } from "@/components/WeekCalendar";
import { useAuth } from "@/hooks/useAuth";
import { onHealthWorkoutsSnapshot } from "@/services/healthWorkouts";
import { prefetchRoutes } from "@/utils/routeCache";
import { fetchPlans } from "@/services/plans";
import {
  fetchHealthMetricsRange,
  fetchHealthGoals,
  type HealthMetric,
  type HealthGoals,
} from "@/services/healthMetrics";
import {
  evaluateMetricGoal,
  type GoalStatus,
} from "@/utils/goalEvaluation";

import { trainingLoadLevel } from "@/utils/metrics";
import {
  computeTrainingLoad,
  MIN_RUN_MILES_FOR_AVG,
  MIN_WORKOUT_SECONDS_FOR_AVG,
} from "@/utils/trainingLoad";
import {
  buildDailyLoadMap,
  rollingLoad,
  loadStatus,
} from "@/utils/trainingLoadSeries";
import {
  formatPace,
  formatDuration,
  formatMiles,
} from "@/utils/pace";
import {
  weekStart as getWeekStart,
  weekEnd as getWeekEnd,
  isSameWeek,
} from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { WorkoutDetailModal } from "@/components/WorkoutDetailModal";
import {
  type RunningPlan,
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  isRunningPlan,
  isWorkoutPlan,
  isDurationOnlyEntry,
} from "@/types/plan";
import {
  matchPlanToActual,
  statusForRunEntry,
  type PlanMatch,
} from "@/utils/planMatching";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Local-date "YYYY-MM-DD" string (matches the healthMetrics doc `date` field). */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getWorkoutLocalDate(w: HealthWorkout): Date {
  return w.startDate;
}

function isSameLocalDay(workoutDate: Date, weekMondayDate: Date, dayOffset: number): boolean {
  const target = new Date(weekMondayDate);
  target.setDate(weekMondayDate.getDate() + dayOffset);
  return (
    workoutDate.getFullYear() === target.getFullYear() &&
    workoutDate.getMonth() === target.getMonth() &&
    workoutDate.getDate() === target.getDate()
  );
}

function isInWeek(w: HealthWorkout, wStart: Date, wEnd: Date): boolean {
  const d = getWorkoutLocalDate(w);
  return d >= wStart && d <= wEnd;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-3">
      {children}
    </p>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
      {children}
    </h2>
  );
}

interface StatItemProps {
  label: string;
  value: React.ReactNode;
}

function StatItem({ label, value }: StatItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-textSecondary">{label}</span>
      <div className="text-2xl font-bold text-textPrimary tabular-nums leading-tight">
        {value}
      </div>
    </div>
  );
}

// ─── Weekly Stats Sections ────────────────────────────────────────────────────

function StatWithSubtext({
  label,
  value,
  subtext,
}: {
  label: string;
  value: React.ReactNode;
  subtext: string | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-textSecondary">{label}</span>
      <div className="text-2xl font-bold text-textPrimary tabular-nums leading-tight">
        {value}
      </div>
      {subtext && (
        <span className="text-xs text-textSecondary">{subtext}</span>
      )}
    </div>
  );
}

interface SectionStatsProps {
  workouts: HealthWorkout[];
  weekStart: Date;
  weekEnd: Date;
}

function PlanProgressStatsCard({
  workouts,
  weekStart,
  weekEnd,
  plannedMiles,
}: SectionStatsProps & { plannedMiles: number }) {
  const weekRuns = workouts.filter(
    (w) => w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );
  const actualMiles = weekRuns.reduce((s, w) => s + w.distanceMiles, 0);

  // Conditional formatting on the Actual Miles value only:
  //   * Green when actual ≥ planned − 1 (within 1 mile of plan, or ahead).
  //   * Default text when actual is more than 1 mile short of plan.
  // Coloring is gated on a real plan existing (plannedMiles > 0) so a
  // week with no plan never paints green just because actual > −1.
  // When the user hasn't run yet this week we render "—" in default color
  // rather than "0.0 mi", which reads better for an empty-week state.
  const hasActual = actualMiles > 0;
  const hasPlan = plannedMiles > 0;
  const milesColor =
    hasActual && hasPlan && actualMiles >= plannedMiles - 1
      ? "text-success"
      : "text-textPrimary";

  return (
    <Card>
      <CardTitle>Plan Progress</CardTitle>
      <div className="grid grid-cols-2 gap-4">
        <StatItem
          label="Planned Miles"
          value={
            <span className="text-textPrimary">
              {hasPlan ? `${plannedMiles.toFixed(1)} mi` : "— mi"}
            </span>
          }
        />
        <StatItem
          label="Actual Miles"
          value={
            <span className={milesColor}>
              {hasActual ? `${actualMiles.toFixed(1)} mi` : "—"}
            </span>
          }
        />
      </div>
    </Card>
  );
}

function RunningStatsCard({ workouts, weekStart, weekEnd }: SectionStatsProps) {
  const runs = workouts.filter(
    (w) => w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );
  const totalMiles = runs.reduce((s, w) => s + w.distanceMiles, 0);
  const totalMovingTime = runs.reduce((s, w) => s + w.durationSeconds, 0);
  const avgPaceSecPerMile = totalMiles > 0 ? totalMovingTime / totalMiles : 0;

  const hrValues = runs
    .map((r) => r.avgHeartRate)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const avgHR =
    hrValues.length > 0
      ? Math.round(hrValues.reduce((s, v) => s + v, 0) / hrValues.length)
      : null;

  // Drop short/aborted activities from the load aggregates (badges on
  // individual runs are unaffected — only the totals/avgs are filtered).
  const loadScores = runs
    .filter((r) => r.distanceMiles >= MIN_RUN_MILES_FOR_AVG)
    .map((r) =>
      computeTrainingLoad(r.durationSeconds, r.avgHeartRate, r.activityType)
    )
    .filter((s): s is number => s !== null);
  const totalRunLoad =
    loadScores.length > 0 ? loadScores.reduce((s, v) => s + v, 0) : null;
  const avgRunLoad =
    loadScores.length > 0
      ? Math.round(loadScores.reduce((s, v) => s + v, 0) / loadScores.length)
      : null;

  return (
    <Card>
      <CardTitle>Running</CardTitle>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatItem label="Runs" value={runs.length} />
        <StatItem
          label="Avg Pace"
          value={
            avgPaceSecPerMile > 0 ? `${formatPace(avgPaceSecPerMile)} /mi` : "—"
          }
        />
        <StatItem
          label="Avg HR"
          value={avgHR != null ? `${avgHR} bpm` : "—"}
        />
        <StatWithSubtext
          label="Run load"
          value={
            totalRunLoad != null
              ? Math.round(totalRunLoad).toLocaleString()
              : "—"
          }
          subtext={
            avgRunLoad != null
              ? `${avgRunLoad.toLocaleString()} avg / run`
              : null
          }
        />
      </div>
    </Card>
  );
}

function WorkoutsStatsCard({ workouts, weekStart, weekEnd }: SectionStatsProps) {
  const weekWorkouts = workouts.filter(
    (w) => !w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );

  const qualifying = weekWorkouts.filter(
    (w) => w.durationSeconds >= MIN_WORKOUT_SECONDS_FOR_AVG
  );
  const avgDurationSec =
    qualifying.length > 0
      ? qualifying.reduce((s, w) => s + w.durationSeconds, 0) /
        qualifying.length
      : 0;

  const hrValues = weekWorkouts
    .map((w) => w.avgHeartRate)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const avgHR =
    hrValues.length > 0
      ? Math.round(hrValues.reduce((s, v) => s + v, 0) / hrValues.length)
      : null;

  const loadScores = qualifying
    .map((w) =>
      computeTrainingLoad(w.durationSeconds, w.avgHeartRate, w.activityType)
    )
    .filter((s): s is number => s !== null);
  const totalWorkoutLoad =
    loadScores.length > 0 ? loadScores.reduce((s, v) => s + v, 0) : null;
  const avgWorkoutLoad =
    loadScores.length > 0
      ? Math.round(loadScores.reduce((s, v) => s + v, 0) / loadScores.length)
      : null;

  return (
    <Card>
      <CardTitle>Workouts</CardTitle>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatItem label="Workouts" value={weekWorkouts.length} />
        <StatItem
          label="Avg Duration"
          value={avgDurationSec > 0 ? formatDuration(avgDurationSec) : "—"}
        />
        <StatItem
          label="Avg HR"
          value={avgHR != null ? `${avgHR} bpm` : "—"}
        />
        <StatWithSubtext
          label="Workout load"
          value={
            totalWorkoutLoad != null
              ? Math.round(totalWorkoutLoad).toLocaleString()
              : "—"
          }
          subtext={
            avgWorkoutLoad != null
              ? `${avgWorkoutLoad.toLocaleString()} avg / session`
              : null
          }
        />
      </div>
    </Card>
  );
}

// ─── This Week's Runs ─────────────────────────────────────────────────────────

interface ThisWeekRunsCardProps {
  workouts: HealthWorkout[];
  weekStart: Date;
}

function ThisWeekRunsCard({ workouts, weekStart }: ThisWeekRunsCardProps) {
  const runs = useMemo(
    () =>
      workouts.filter(
        (w) => w.isRunLike && isSameWeek(getWorkoutLocalDate(w), weekStart)
      ),
    [workouts, weekStart]
  );

  return (
    <Card className="overflow-hidden">
      <CardTitle>This Week&apos;s Runs</CardTitle>

      {runs.length === 0 ? (
        <EmptyState title="No runs this week yet" />
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            {runs.map((run) => {
              const localDate = getWorkoutLocalDate(run);
              const dayAbbrev = localDate
                .toLocaleDateString("en-US", { weekday: "short" })
                .toUpperCase();
              const dateStr = localDate.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });

              return (
                <Link
                  key={run.workoutId}
                  href={`/runs/${run.workoutId}`}
                  className="flex items-center justify-between py-2 px-1 hover:bg-surface rounded-lg transition-colors cursor-pointer"
                >
                  <span className="text-xs text-textSecondary w-20 shrink-0">
                    {dayAbbrev} {dateStr}
                  </span>
                  <span className="text-sm font-semibold text-textPrimary tabular-nums">
                    {formatMiles(run.distanceMiles)} mi
                  </span>
                  <span className="text-sm text-textPrimary tabular-nums">
                    {run.avgPaceSecPerMile ? `${formatPace(run.avgPaceSecPerMile)} /mi` : "—"}
                  </span>
                  <span className="text-sm text-textSecondary tabular-nums">
                    {run.avgHeartRate ? `${Math.round(run.avgHeartRate)} bpm` : "—"}
                  </span>
                  <div>
                    <TrainingLoadBadge
                      durationSeconds={run.durationSeconds}
                      avgHeartRate={run.avgHeartRate}
                      activityType={run.activityType}
                    />
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <Link href="/runs" className="text-sm text-primary hover:underline">
              View all runs →
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

// ─── Workout Summary ──────────────────────────────────────────────────────────

const WORKOUT_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  WeightTraining: Dumbbell,
  Strength: Dumbbell,
  Workout: Zap,
  Yoga: Wind,
  Pilates: Flower2,
  Ride: Bike,
  Cycling: Bike,
};

interface WorkoutSummaryCardProps {
  workouts: HealthWorkout[];
  weekStart: Date;
  weekEnd: Date;
  onSelect: (w: HealthWorkout) => void;
}

function WorkoutSummaryCard({
  workouts,
  weekStart,
  weekEnd,
  onSelect,
}: WorkoutSummaryCardProps) {
  const weekWorkouts = workouts.filter(
    (w) => !w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );

  return (
    <Card className="overflow-hidden">
      <CardTitle>This Week&apos;s Workouts</CardTitle>

      {weekWorkouts.length === 0 ? (
        <EmptyState title="No workouts this week" />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {weekWorkouts.map((w) => {
              const Icon = WORKOUT_ICONS[w.displayType] ?? Activity;
              const localDate = getWorkoutLocalDate(w);
              const dayLabel = localDate.toLocaleDateString("en-US", { weekday: "short" });

              return (
                <button
                  key={w.workoutId}
                  onClick={() => onSelect(w)}
                  className="w-full flex items-center justify-between py-2.5 px-1 hover:bg-surface rounded-lg transition-colors gap-2 text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon size={15} className="text-textSecondary shrink-0" />
                    <span className="text-xs text-textSecondary w-7 shrink-0">{dayLabel}</span>
                    <span className="text-sm text-textPrimary truncate">{w.displayType}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-textSecondary whitespace-nowrap">
                    <span>{formatDuration(w.durationSeconds)}</span>
                    {w.calories > 0 && (
                      <>
                        <span className="text-border">·</span>
                        <span>{Math.round(w.calories).toLocaleString()} kcal</span>
                      </>
                    )}
                    {w.avgHeartRate && w.durationSeconds > 0 && (
                      <TrainingLoadBadge
                        durationSeconds={w.durationSeconds}
                        avgHeartRate={w.avgHeartRate}
                        activityType={w.activityType}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <Link href="/workouts" className="text-sm text-primary hover:underline">
              View all workouts →
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

// ─── Plan Progress ────────────────────────────────────────────────────────────

interface PlanProgressCardProps {
  activePlan: RunningPlan | null;
  workouts: HealthWorkout[];
  weekStart: Date;
  weekEnd: Date;
}

type RunStatus = "met" | "partial" | "missed" | "upcoming";

function PlanProgressCard({ activePlan, workouts, weekStart, weekEnd }: PlanProgressCardProps) {
  // matchPlanToActual filters isRunLike internally and locks each run to at
  // most one planned entry via its usedGlobal Set. The Plans page and the
  // dashboard's WeekCalendar tile already call it with the same {plan,
  // workouts} pair, so routing this card through it too keeps all three
  // surfaces in sync. Hook MUST come before any early return.
  const matchMap = useMemo<Map<string, PlanMatch | null>>(
    () =>
      activePlan
        ? matchPlanToActual(activePlan, workouts)
        : new Map<string, PlanMatch | null>(),
    [activePlan, workouts]
  );

  if (!activePlan) {
    return (
      <Card>
        <CardTitle>Running Plan</CardTitle>
        <EmptyState
          title="No active running plan"
          description="Create a training plan to track your weekly targets."
          action={
            <Link href="/plans" className="text-sm text-primary hover:underline">
              Go to Plans →
            </Link>
          }
        />
      </Card>
    );
  }

  const planStart = new Date(activePlan.startDate);
  const weekIndex = Math.floor(
    (weekStart.getTime() - planStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const planWeek =
    weekIndex >= 0 && weekIndex < activePlan.weeks.length
      ? activePlan.weeks[weekIndex]
      : null;

  // Weekly mileage display — sum of ALL actual runs this week (unchanged
  // metric, independent of plan matching).
  const weekRuns = workouts.filter((w) => w.isRunLike && isInWeek(w, weekStart, weekEnd));
  const actualMiles = weekRuns.reduce((s, w) => s + w.distanceMiles, 0);
  const plannedMiles = planWeek
    ? planWeek.entries.reduce((s, e) => s + e.distanceMiles, 0)
    : 0;
  const progressPct = plannedMiles > 0 ? Math.min(1, actualMiles / plannedMiles) : 0;

  return (
    <Card>
      <CardTitle>Running Plan</CardTitle>
      <p className="text-sm font-semibold text-textPrimary mb-0.5">{activePlan.name}</p>
      <p className="text-xs text-textSecondary mb-4">
        Week {planWeek ? planWeek.weekNumber : "—"} of {activePlan.weeks.length}
      </p>

      {!planWeek ? (
        <p className="text-sm text-textSecondary">This week is outside the plan range.</p>
      ) : planWeek.entries.length === 0 ? (
        <p className="text-sm text-textSecondary">Rest week — no runs planned.</p>
      ) : (
        <div className="flex flex-col gap-1 mb-4">
          {planWeek.entries.map((entry) => {
            const status = statusForRunEntry(activePlan, entry, matchMap);
            const dayLabel = DAY_LABELS[entry.dayOfWeek];

            return (
              <div key={entry.id} className="flex items-center gap-2.5 py-1.5">
                <StatusIcon status={status} />
                <span className="text-xs text-textSecondary w-7 shrink-0">{dayLabel}</span>
                <span className="text-sm text-textPrimary flex-1">
                  {entry.notes ?? (entry.workoutType
                    ? entry.workoutType.charAt(0).toUpperCase() + entry.workoutType.slice(1) + " Run"
                    : "Run")}
                </span>
                <span className="text-sm text-textPrimary tabular-nums">
                  {entry.distanceMiles.toFixed(1)} mi
                </span>
                {entry.paceTarget && (
                  <span className="text-xs text-textSecondary">{entry.paceTarget}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
      <div className="mt-2">
        <div className="flex justify-between mb-1">
          <span className="text-xs text-textSecondary">Weekly mileage</span>
          <span className="text-xs text-textSecondary tabular-nums">
            {actualMiles.toFixed(1)} of {plannedMiles.toFixed(1)} mi
          </span>
        </div>
        <div className="h-2 bg-surface rounded-full overflow-hidden border border-border">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${progressPct * 100}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case "met":
      return <CheckCircle2 size={15} className="text-success shrink-0" />;
    case "partial":
      return <MinusCircle size={15} className="text-warning shrink-0" />;
    case "missed":
      return <XCircle size={15} className="text-danger shrink-0" />;
    case "upcoming":
      return <Circle size={15} className="text-textSecondary shrink-0" />;
  }
}

// ─── Workout Plan Progress ────────────────────────────────────────────────────

interface WorkoutPlanProgressCardProps {
  activeWorkoutPlan: WorkoutPlan | null;
  weekStart: Date;
}

function WorkoutPlanProgressCard({
  activeWorkoutPlan,
  weekStart,
}: WorkoutPlanProgressCardProps) {
  if (!activeWorkoutPlan) {
    return (
      <Card>
        <CardTitle>Workout Plan</CardTitle>
        <EmptyState
          title="No active workout plan"
          description="Create a workout plan to track your weekly sessions."
          action={
            <Link href="/plans" className="text-sm text-primary hover:underline">
              Go to Plans →
            </Link>
          }
        />
      </Card>
    );
  }

  const planStart = new Date(activeWorkoutPlan.startDate + "T00:00:00");
  const weekIndex = Math.floor(
    (weekStart.getTime() - planStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const planWeek =
    weekIndex >= 0 && weekIndex < activeWorkoutPlan.weeks.length
      ? activeWorkoutPlan.weeks[weekIndex]
      : null;

  const sessionEntries = (planWeek?.entries ?? [])
    .filter((e): e is PlannedWorkoutEntry => e.type === "workout")
    .sort((a, b) => a.weekday - b.weekday);

  // Track the within-weekday index for each session so the workout follow-along
  // route can pick the right entry on multi-session days.
  const sessionIndexByEntryId = new Map<string, number>();
  const totalOnDayByEntryId = new Map<string, number>();
  {
    const counters = new Map<number, number>();
    const totals = new Map<number, number>();
    for (const e of sessionEntries) {
      totals.set(e.weekday, (totals.get(e.weekday) ?? 0) + 1);
    }
    for (const e of sessionEntries) {
      const next = counters.get(e.weekday) ?? 0;
      sessionIndexByEntryId.set(e.id, next);
      totalOnDayByEntryId.set(e.id, totals.get(e.weekday) ?? 1);
      counters.set(e.weekday, next + 1);
    }
  }

  const completedCount = sessionEntries.filter(
    (e) => e.completed === true
  ).length;
  const totalCount = sessionEntries.length;
  const progressPct =
    totalCount > 0 ? Math.min(1, completedCount / totalCount) : 0;

  return (
    <Card>
      <CardTitle>Workout Plan</CardTitle>
      <p className="text-sm font-semibold text-textPrimary mb-0.5">
        {activeWorkoutPlan.name}
      </p>
      <p className="text-xs text-textSecondary mb-4">
        Week {planWeek ? planWeek.weekNumber : "—"} of{" "}
        {activeWorkoutPlan.weeks.length}
      </p>

      {!planWeek ? (
        <p className="text-sm text-textSecondary">
          This week is outside the plan range.
        </p>
      ) : sessionEntries.length === 0 ? (
        <p className="text-sm text-textSecondary">
          Rest week — no sessions planned.
        </p>
      ) : (
        <div className="flex flex-col gap-1 mb-4">
          {sessionEntries.map((entry) => {
            const dayLabel = DAY_LABELS[entry.dayOfWeek];
            const isComplete = entry.completed === true;
            const subtitle = isDurationOnlyEntry(entry)
              ? entry.duration_mins != null
                ? `${entry.duration_mins} min`
                : "Session"
              : (() => {
                  const n = (entry.exercises ?? []).filter(
                    (e) => !("kind" in e) || e.kind === "exercise"
                  ).length;
                  return `${n} exercise${n === 1 ? "" : "s"}`;
                })();
            const sIdx = sessionIndexByEntryId.get(entry.id) ?? 0;
            const href = `/workout/${activeWorkoutPlan.id}/${weekIndex}/${entry.weekday}/${sIdx}`;
            return (
              <Link
                key={entry.id}
                href={href}
                className={`flex items-center gap-2.5 py-1.5 rounded-lg -mx-1 px-1 hover:bg-surface transition-colors ${
                  isComplete ? "opacity-60" : ""
                }`}
              >
                {isComplete ? (
                  <CheckCircle2
                    size={15}
                    className="text-success shrink-0"
                  />
                ) : (
                  <Circle
                    size={15}
                    className="text-textSecondary shrink-0"
                  />
                )}
                <span className="text-xs text-textSecondary w-7 shrink-0">
                  {dayLabel}
                </span>
                <span className="text-sm text-textPrimary flex-1 truncate">
                  {(totalOnDayByEntryId.get(entry.id) ?? 1) > 1 && (
                    <span className="text-textSecondary">
                      Session {sIdx + 1}
                      {" · "}
                    </span>
                  )}
                  {entry.label ?? "Workout"}
                </span>
                <span className="text-xs text-textSecondary shrink-0">
                  {subtitle}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Progress bar */}
      <div className="mt-2">
        <div className="flex justify-between mb-1">
          <span className="text-xs text-textSecondary">Weekly sessions</span>
          <span className="text-xs text-textSecondary tabular-nums">
            {completedCount} / {totalCount} sessions
          </span>
        </div>
        <div className="h-2 bg-surface rounded-full overflow-hidden border border-border">
          <div
            className="h-full bg-purple-500 rounded-full transition-all duration-500"
            style={{ width: `${progressPct * 100}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

// ─── Health KPIs Row ──────────────────────────────────────────────────────────

interface HealthKpisRowProps {
  metrics: HealthMetric[];
  goals: HealthGoals | null;
  totalWeekCalories: number;
}

/** Tailwind text-color token for a GoalStatus. Neutral → primary text. */
function goalStatusTextClass(status: GoalStatus): string {
  switch (status) {
    case "success": return "text-success";
    case "warning": return "text-warning";
    case "danger":  return "text-danger";
    default:        return "text-textPrimary";
  }
}

/**
 * Horizontal row of per-day averages for the selected week's healthMetrics:
 * Steps, Exercise Mins, Move Calories, Stand Hours, Sleep Hours. The Sleep
 * tile applies goal-driven conditional formatting when a sleep goal is set;
 * the other tiles stay neutral (their goal coloring lives on the Health page).
 */
function HealthKpisRow({ metrics, goals, totalWeekCalories }: HealthKpisRowProps) {
  const weeklyAvg = (field: keyof HealthMetric): number | null => {
    const values = metrics
      .map((m) => m[field])
      .filter((v): v is number => typeof v === "number" && v > 0);
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  };

  const avgSleep = weeklyAvg("sleep_total_hours");
  const sleepStatus: GoalStatus =
    avgSleep != null && goals?.sleep
      ? evaluateMetricGoal(
          avgSleep,
          goals.sleep.goal,
          "higher",
          goals.sleep.warningPct,
          goals.sleep.dangerPct
        )
      : "neutral";

  const tiles: {
    label: string;
    value: string;
    valueClass?: string;
    caption?: string;
  }[] = [
    {
      label: "Steps",
      value: (() => {
        const v = weeklyAvg("steps");
        return v == null ? "—" : Math.round(v).toLocaleString();
      })(),
    },
    {
      label: "Exercise Mins",
      value: (() => {
        const v = weeklyAvg("exercise_mins");
        return v == null ? "—" : `${Math.round(v)} min`;
      })(),
    },
    {
      label: "Move Calories",
      value: (() => {
        const v = weeklyAvg("move_calories");
        return v == null ? "—" : `${Math.round(v)} kcal`;
      })(),
    },
    {
      label: "Stand Hours",
      value: (() => {
        const v = weeklyAvg("stand_hours");
        return v == null ? "—" : `${v.toFixed(1)} hrs`;
      })(),
    },
    {
      label: "Sleep Hours",
      value: avgSleep == null ? "—" : `${avgSleep.toFixed(1)} hrs`,
      valueClass: goalStatusTextClass(sleepStatus),
    },
    {
      label: "Total Calories",
      value:
        totalWeekCalories > 0
          ? `${Math.round(totalWeekCalories).toLocaleString()} kcal`
          : "—",
      caption: "this week",
    },
  ];

  return (
    <Card>
      <CardTitle>Health</CardTitle>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        {tiles.map((t) => (
          <div key={t.label} className="flex flex-col gap-0.5">
            <div
              className={`text-2xl font-bold tabular-nums leading-tight ${
                t.valueClass ?? "text-textPrimary"
              }`}
            >
              {t.value}
            </div>
            <span className="text-xs text-textPrimary">{t.label}</span>
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              {t.caption ?? "avg/day"}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─── Training Load ────────────────────────────────────────────────────────────

interface TrainingLoadCardProps {
  workouts: HealthWorkout[];
}

function TrainingLoadCard({ workouts }: TrainingLoadCardProps) {
  const now = new Date();

  const runs = workouts.filter((w) => w.isRunLike);

  const cutoff7 = new Date(now);
  cutoff7.setDate(now.getDate() - 7);
  const cutoff30 = new Date(now);
  cutoff30.setDate(now.getDate() - 30);

  const acute = runs
    .filter((w) => getWorkoutLocalDate(w) >= cutoff7)
    .reduce((s, w) => s + w.distanceMiles, 0);

  const last30Miles = runs
    .filter((w) => getWorkoutLocalDate(w) >= cutoff30)
    .reduce((s, w) => s + w.distanceMiles, 0);
  const chronic = last30Miles / (30 / 7);

  const ratio = chronic > 0 ? acute / chronic : 0;
  const loadLevel = chronic > 0 ? trainingLoadLevel(ratio) : null;

  const daysOfData = useMemo(() => {
    if (runs.length === 0) return 0;
    const oldest = runs
      .map((w) => getWorkoutLocalDate(w).getTime())
      .reduce((min, t) => Math.min(min, t), Infinity);
    return Math.round((now.getTime() - oldest) / (1000 * 60 * 60 * 24));
  }, [runs]);

  const loadBadge = (level: ReturnType<typeof trainingLoadLevel>) => {
    const map: Record<
      ReturnType<typeof trainingLoadLevel>,
      { label: string; level: "good" | "ok" | "low" | "neutral" }
    > = {
      stable:     { label: "Stable",    level: "good"    },
      building:   { label: "Building",  level: "ok"      },
      aggressive: { label: "High Load", level: "low"     },
      deload:     { label: "Recovery",  level: "neutral" },
    };
    return map[level];
  };

  return (
    <Card>
      <CardTitle>Mileage Training Load</CardTitle>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">7-Day</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {acute.toFixed(1)}
            <span className="text-sm font-normal text-textSecondary"> mi</span>
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">4-Week Avg/Wk</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {chronic.toFixed(1)}
            <span className="text-sm font-normal text-textSecondary"> mi</span>
          </span>
        </div>
      </div>

      {daysOfData < 30 ? (
        <p className="text-xs text-textSecondary">
          Building baseline ({daysOfData} days of data)
        </p>
      ) : loadLevel ? (
        <MetricBadge
          label="Status"
          value={loadBadge(loadLevel).label}
          level={loadBadge(loadLevel).level}
        />
      ) : (
        <p className="text-xs text-textSecondary">No run data yet</p>
      )}
    </Card>
  );
}

// ─── Load Score Training Load ─────────────────────────────────────────────────

interface LoadScoreTrainingLoadCardProps {
  workouts: HealthWorkout[];
}

function LoadScoreTrainingLoadCard({
  workouts,
}: LoadScoreTrainingLoadCardProps) {
  const now = new Date();

  // Build the daily-load map across ALL workout types (runs + non-runs).
  // The advantage of this card over the mileage card is that it surfaces
  // cross-training stress mileage can't see.
  const dailyMap = useMemo(() => buildDailyLoadMap(workouts), [workouts]);

  const acute = rollingLoad(dailyMap, now, 7);          // 7-day total
  const chronicTotal = rollingLoad(dailyMap, now, 28);  // 28-day total
  const chronicWeekly = chronicTotal / 4;               // avg per week over 28d

  const hasAcute = acute > 0;
  const hasChronic = chronicWeekly > 0;

  const status = loadStatus(acute, chronicWeekly);

  return (
    <Card>
      <CardTitle>Load Score Training Load</CardTitle>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">7-Day Load</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {hasAcute ? Math.round(acute).toLocaleString() : "—"}
            {hasAcute && (
              <span className="text-sm font-normal text-textSecondary"> score</span>
            )}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">28-Day Avg/Wk</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {hasChronic ? Math.round(chronicWeekly).toLocaleString() : "—"}
            {hasChronic && (
              <span className="text-sm font-normal text-textSecondary"> score</span>
            )}
          </span>
        </div>
      </div>

      {status ? (
        <MetricBadge label="Status" value={status.label} level={status.level} />
      ) : (
        <p className="text-xs text-textSecondary">
          No HR-bearing activity in the window
        </p>
      )}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [selectedWeekStart, setSelectedWeekStart] = useState<Date>(() =>
    getWeekStart(new Date())
  );
  const selectedWeekEnd = getWeekEnd(selectedWeekStart);

  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [activePlan, setActivePlan] = useState<RunningPlan | null>(null);
  const [activeWorkoutPlan, setActiveWorkoutPlan] = useState<WorkoutPlan | null>(
    null
  );
  const [weekMetrics, setWeekMetrics] = useState<HealthMetric[]>([]);
  const [healthGoals, setHealthGoals] = useState<HealthGoals | null>(null);
  const [loading, setLoading] = useState(true);

  // Workout detail modal state — matches the workouts-page pattern so the
  // "This Week's Workouts" tile can pop the same modal on row click.
  const [selectedWorkout, setSelectedWorkout] = useState<HealthWorkout | null>(
    null
  );
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>(
    {}
  );
  const overridesRef = useRef<Record<string, WorkoutOverride>>({});

  useEffect(() => {
    if (!uid) return;
    fetchAllOverrides(uid)
      .then((o) => {
        overridesRef.current = o;
        setOverrides(o);
      })
      .catch((err) => console.error("[fetchAllOverrides]", err));
  }, [uid]);

  useEffect(() => {
    document.body.style.overflow = selectedWorkout ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [selectedWorkout]);

  // One-time fetch for user-defined health goals. Drives the Sleep KPI
  // tile's conditional formatting on the row below the weekly stats bar.
  useEffect(() => {
    if (!uid) return;
    fetchHealthGoals(uid)
      .then(setHealthGoals)
      .catch((err) => console.error("[fetchHealthGoals]", err));
  }, [uid]);

  // One-time fetch for plans (user-managed data, not iOS-synced).
  // Race data was previously fetched here for the now-removed RaceGoalCard.
  useEffect(() => {
    if (!uid) return;
    fetchPlans(uid)
      .then((plans) => {
        const runningPlans = plans.filter(isRunningPlan);
        setActivePlan(runningPlans.find((p) => p.isActive) ?? null);
        const workoutPlansList = plans.filter(isWorkoutPlan);
        setActiveWorkoutPlan(
          workoutPlansList.find((p) => p.isActive) ?? null
        );
      })
      .catch(console.error);
  }, [uid]);

  // Fetch healthMetrics for the selected week's date range. Re-runs whenever
  // the user navigates to a different week. One-time getDocs per range —
  // no live snapshot, since this row is summary data.
  useEffect(() => {
    if (!uid) return;
    const fromIso = toIsoDate(selectedWeekStart);
    const toIso = toIsoDate(selectedWeekEnd);
    let cancelled = false;
    fetchHealthMetricsRange(uid, fromIso, toIso)
      .then((m) => {
        if (!cancelled) setWeekMetrics(m);
      })
      .catch((err) => {
        console.error("[fetchHealthMetricsRange]", err);
        if (!cancelled) setWeekMetrics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [uid, selectedWeekStart, selectedWeekEnd]);

  // Real-time listener for healthWorkouts — updates when iOS syncs
  useEffect(() => {
    if (!uid) return;
    setLoading(true);

    const unsubscribe = onHealthWorkoutsSnapshot(
      uid,
      { limitCount: 200 },
      (wkts) => {
        setWorkouts(wkts);
        setLoading(false);

        // Background prefetch — most recent 20 runs with routes
        setTimeout(() => {
          const recentWithRoutes = wkts
            .filter((a) => a.isRunLike && a.hasRoute)
            .sort(
              (a, b) =>
                new Date(b.startDate).getTime() -
                new Date(a.startDate).getTime()
            )
            .slice(0, 20)
            .map((a) => a.workoutId);
          if (recentWithRoutes.length > 0 && uid) {
            prefetchRoutes(uid, recentWithRoutes).catch(() => {});
          }
        }, 1000);
      },
      () => setLoading(false)
    );

    return () => unsubscribe();
  }, [uid]);

  const plannedMiles = useMemo(() => {
    if (!activePlan) return 0;
    const planStart = new Date(activePlan.startDate);
    const weekIndex = Math.floor(
      (selectedWeekStart.getTime() - planStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return 0;
    return activePlan.weeks[weekIndex].entries.reduce((s, e) => s + e.distanceMiles, 0);
  }, [activePlan, selectedWeekStart]);

  // Sum of calories across ALL workouts (runs + non-runs) in the selected
  // week — moved out of the old stats bar and into the Health section.
  const totalWeekCalories = useMemo(
    () =>
      workouts
        .filter((w) => isInWeek(w, selectedWeekStart, selectedWeekEnd))
        .reduce((s, w) => s + w.calories, 0),
    [workouts, selectedWeekStart, selectedWeekEnd]
  );

  // ─── KPI data ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6 lg:p-6 p-4">
      {/* Page title */}
      <h1 className="text-2xl font-bold text-textPrimary">This Week</h1>

      {/* Row 1: Week Navigator — allow past & future navigation; "Today" pill
          auto-appears when not on the current week. */}
      <WeekNavigator
        weekStart={selectedWeekStart}
        onChange={setSelectedWeekStart}
        disableFuture={false}
        showTodayReset
      />

      {/* Row 2: Plan Progress (target vs actual miles for the week) */}
      <PlanProgressStatsCard
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
        plannedMiles={plannedMiles}
      />

      {/* Row 3: Mon–Sun weekly activity calendar */}
      <section>
        <WeekCalendar
          plans={[
            ...(activePlan ? [activePlan] : []),
            ...(activeWorkoutPlan ? [activeWorkoutPlan] : []),
          ]}
          actualRuns={workouts}
          weekStart={selectedWeekStart}
        />
      </section>

      {/* Row 4: Health KPIs */}
      <HealthKpisRow
        metrics={weekMetrics}
        goals={healthGoals}
        totalWeekCalories={totalWeekCalories}
      />

      {/* Row 5: Training Load row — Mileage + Load Score side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TrainingLoadCard workouts={workouts} />
        <LoadScoreTrainingLoadCard workouts={workouts} />
      </div>

      {/* Row 6: Running KPIs (Runs / Avg Pace / Avg HR / Run Load) */}
      <RunningStatsCard
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
      />

      {/* Row 7: Running row — Running Plan tile (left) + This Week's Runs
          tile (right). lg breakpoint and items-start so the two tiles take
          their natural heights instead of stretching to match. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <PlanProgressCard
          activePlan={activePlan}
          workouts={workouts}
          weekStart={selectedWeekStart}
          weekEnd={selectedWeekEnd}
        />
        <ThisWeekRunsCard
          workouts={workouts}
          weekStart={selectedWeekStart}
        />
      </div>

      {/* Row 8: Workout KPIs (Workouts / Avg Dur / Avg HR / Workout Load) */}
      <WorkoutsStatsCard
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
      />

      {/* Row 9: Workout row — Workout Plan tile (left) + This Week's
          Workouts tile (right). Same responsive + items-start pattern as
          the Running row above. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <WorkoutPlanProgressCard
          activeWorkoutPlan={activeWorkoutPlan}
          weekStart={selectedWeekStart}
        />
        <WorkoutSummaryCard
          workouts={workouts}
          weekStart={selectedWeekStart}
          weekEnd={selectedWeekEnd}
          onSelect={setSelectedWorkout}
        />
      </div>

      {selectedWorkout && uid && (
        <WorkoutDetailModal
          workout={selectedWorkout}
          override={overrides[selectedWorkout.workoutId] ?? null}
          userId={uid}
          onClose={() => setSelectedWorkout(null)}
          onExcludeChange={(workoutId, excluded) => {
            setOverrides((prev) => ({
              ...prev,
              [workoutId]: {
                ...prev[workoutId],
                workoutId,
                userId: uid,
                isExcluded: excluded,
                excludedAt: excluded ? new Date().toISOString() : null,
                excludedReason: null,
                distanceMilesOverride: null,
                durationSecondsOverride: null,
                runTypeOverride: null,
                updatedAt: new Date().toISOString(),
              },
            }));
          }}
        />
      )}
    </div>
  );
}
