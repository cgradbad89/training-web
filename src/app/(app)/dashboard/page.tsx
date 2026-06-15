"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  ChevronDown,
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
import { fetchUserSettings } from "@/services/userSettings";
import {
  fetchHealthMetricsRange,
  type HealthMetric,
} from "@/services/healthMetrics";
import { fetchHealthGoals as fetchRingGoalVersions } from "@/services/healthGoals";
import {
  ActivityRings,
  RING_COLORS,
  RING_LABELS,
  RING_UNITS,
  fmtRingNumber,
  type RingDatum,
} from "@/components/ActivityRings";
import {
  RING_METRICS,
  dailyRingProgress,
  eachDate,
  onPaceFraction,
  periodRingProgress,
  resolveGoalForDate,
  ringDailyAverage,
} from "@/lib/ringMath";
import type { HealthGoalDoc, RingMetric } from "@/types/healthGoal";

import { trainingLoadLevel } from "@/utils/metrics";
import {
  resolveDisplayLoad,
  MIN_RUN_MILES_FOR_AVG,
  MIN_WORKOUT_SECONDS_FOR_AVG,
  resolveMaxHr,
  resolveRestingHr,
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
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import {
  weekStart as getWeekStart,
  weekEnd as getWeekEnd,
  isSameWeek,
} from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type UserSettings } from "@/types/userSettings";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { WorkoutDetailModal } from "@/components/WorkoutDetailModal";
import { RunActivityModal } from "@/components/runs/RunActivityModal";
import {
  computeWeekScore,
  buildWeekScoreBreakdown,
  isWeekEmpty,
  daysElapsedInWeek,
  isScheduledThroughToday,
  type WeekScoreInput,
  type WeekScoreResult,
  type WeekScoreComponent,
} from "@/utils/weekScore";
import {
  type RunningPlan,
  type WorkoutPlan,
  type PlannedRunEntry,
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

/** Parse a local "YYYY-MM-DD" string to a local-midnight Date. */
function parseIsoDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
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

function RunningStatsCard({
  workouts,
  weekStart,
  weekEnd,
  plannedMiles,
  maxHr,
  restingHr,
}: SectionStatsProps & {
  plannedMiles: number;
  maxHr: number;
  restingHr: number;
}) {
  const runs = workouts.filter(
    (w) => w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );
  const totalMiles = runs.reduce((s, w) => s + w.distanceMiles, 0);
  const totalMovingTime = runs.reduce((s, w) => s + w.durationSeconds, 0);
  const avgPaceSecPerMile = totalMiles > 0 ? totalMovingTime / totalMiles : 0;

  // Planned / Actual coloring carried over from the (now-removed) Plan
  // Progress row:
  //   * Green when actual ≥ planned − 1 (within 1 mile of plan or ahead).
  //   * Default text otherwise, or when there's no plan.
  //   * "—" when the user hasn't run yet this week.
  const hasActual = totalMiles > 0;
  const hasPlan = plannedMiles > 0;
  const actualColor =
    hasActual && hasPlan && totalMiles >= plannedMiles - 1
      ? "text-success"
      : "text-textPrimary";

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
    .map((r) => resolveDisplayLoad(r, maxHr, restingHr))
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
      {/* 6-tile grid: Planned + Actual absorbed from the old Plan Progress
          row, followed by the original Running tiles. Breakpoint ladder
          keeps the row readable: 2-up on phones → 3-up on tablets →
          6-up on lg+. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatItem
          label="Planned"
          value={
            <span className="text-textPrimary">
              {hasPlan ? `${plannedMiles.toFixed(1)} mi` : "— mi"}
            </span>
          }
        />
        <StatItem
          label="Actual"
          value={
            <span className={actualColor}>
              {hasActual ? `${totalMiles.toFixed(1)} mi` : "—"}
            </span>
          }
        />
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

function WorkoutsStatsCard({
  workouts,
  weekStart,
  weekEnd,
  sessionsPlanned,
  sessionsCompleted,
  maxHr,
  restingHr,
}: SectionStatsProps & {
  sessionsPlanned: number;
  sessionsCompleted: number;
  maxHr: number;
  restingHr: number;
}) {
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
    .map((w) => resolveDisplayLoad(w, maxHr, restingHr))
    .filter((s): s is number => s !== null);
  const totalWorkoutLoad =
    loadScores.length > 0 ? loadScores.reduce((s, v) => s + v, 0) : null;
  const avgWorkoutLoad =
    loadScores.length > 0
      ? Math.round(loadScores.reduce((s, v) => s + v, 0) / loadScores.length)
      : null;

  // Conditional formatting on Actual workouts vs the plan:
  //   * Green   when met or exceeded the plan
  //   * Yellow  when exactly 1 session short
  //   * Red     when more than 1 session short
  //   * Default when there's no plan to compare against
  const sessionDiff = sessionsCompleted - sessionsPlanned;
  let actualColor = "text-textPrimary";
  if (sessionsPlanned > 0) {
    if (sessionDiff >= 0) actualColor = "text-success";
    else if (sessionDiff === -1) actualColor = "text-warning";
    else actualColor = "text-danger";
  }

  return (
    <Card>
      <CardTitle>Workouts</CardTitle>
      {/* 5-tile grid: Planned + Actual (vs the active workout plan)
          followed by the original Workouts tiles. Same responsive ladder
          as the Running row above: 2-up on phones → 3-up on tablets →
          5-up on lg+. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatItem
          label="Planned"
          value={
            <span className="text-textPrimary">
              {sessionsPlanned > 0 ? `${sessionsPlanned} sessions` : "—"}
            </span>
          }
        />
        <StatItem
          label="Actual workouts"
          value={<span className={actualColor}>{sessionsCompleted}</span>}
        />
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
  maxHr: number;
  restingHr: number;
}

function ThisWeekRunsCard({
  workouts,
  weekStart,
  maxHr,
  restingHr,
}: ThisWeekRunsCardProps) {
  const runs = useMemo(
    () =>
      workouts.filter(
        (w) => w.isRunLike && isSameWeek(getWorkoutLocalDate(w), weekStart)
      ),
    [workouts, weekStart]
  );

  return (
    <Card className="overflow-hidden h-full">
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
                      score={resolveDisplayLoad(run, maxHr, restingHr)}
                      avgHeartRate={run.avgHeartRate}
                      activityType={run.activityType}
                      maxHr={maxHr}
                      restingHr={restingHr}
                      durationSeconds={run.durationSeconds}
                      trainingLoadMethod={run.trainingLoadMethod}
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
  maxHr: number;
  restingHr: number;
  onSelect: (w: HealthWorkout) => void;
}

function WorkoutSummaryCard({
  workouts,
  weekStart,
  weekEnd,
  restingHr,
  maxHr,
  onSelect,
}: WorkoutSummaryCardProps) {
  const weekWorkouts = workouts.filter(
    (w) => !w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );

  return (
    <Card className="overflow-hidden h-full">
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
                    <span className="text-sm text-textPrimary truncate">
                      {resolveActivityTitle({
                        activityType: w.displayType,
                        rawActivityType: w.activityType,
                        distanceMiles: w.distanceMiles,
                      })}
                    </span>
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
                        score={resolveDisplayLoad(w, maxHr, restingHr)}
                        avgHeartRate={w.avgHeartRate}
                        activityType={w.activityType}
                        maxHr={maxHr}
                        restingHr={restingHr}
                        durationSeconds={w.durationSeconds}
                        trainingLoadMethod={w.trainingLoadMethod}
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

  // Selected planned run → opens the RunActivityModal (planned vs actual).
  // Hook MUST come before the early return below (Rules of Hooks).
  const [selectedSession, setSelectedSession] = useState<{
    entry: PlannedRunEntry;
    matchedRun: HealthWorkout | null;
    date: Date;
  } | null>(null);

  if (!activePlan) {
    return (
      <Card className="h-full">
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
    <>
    <Card className="h-full">
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
            const isRest = entry.runType === "rest";

            const rowContent = (
              <>
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
              </>
            );

            // Rest days are not clickable — only running sessions open the modal.
            if (isRest) {
              return (
                <div key={entry.id} className="flex items-center gap-2.5 py-1.5">
                  {rowContent}
                </div>
              );
            }

            const openSession = () => {
              const date = new Date(weekStart);
              date.setDate(weekStart.getDate() + entry.dayOfWeek);
              setSelectedSession({
                entry,
                matchedRun: matchMap.get(entry.id)?.activity ?? null,
                date,
              });
            };

            return (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={openSession}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openSession();
                  }
                }}
                className="flex items-center gap-2.5 py-1.5 rounded-lg -mx-1 px-1 cursor-pointer hover:bg-surface transition-colors"
              >
                {rowContent}
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

    {selectedSession && (
      <RunActivityModal
        isOpen
        onClose={() => setSelectedSession(null)}
        plannedEntry={selectedSession.entry}
        matchedRun={selectedSession.matchedRun}
        sessionDate={selectedSession.date}
      />
    )}
    </>
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
      <Card className="h-full">
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
    <Card className="h-full">
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

// ─── Health Hero Tile ─────────────────────────────────────────────────────────

type HeroMode = "today" | "week";
/** Week-ring number display: period total vs. daily average. */
type RingValueMode = "total" | "avg";

interface HealthHeroTileProps {
  /** Today's healthMetrics doc — fetched independently of the selected week so
   *  "Today" is always the live day, regardless of week navigation. */
  todayMetric: HealthMetric | null;
  /** healthMetrics docs for the selected week's date range. */
  weekMetrics: HealthMetric[];
  ringGoals: HealthGoalDoc[];
  weekStart: Date;
  weekEnd: Date;
  /** Ring / legend-row tap → /health Trends tab scrolled to the metric. */
  onMetricClick: (metric: RingMetric) => void;
}

/** Small segmented Today / Week control for the hero tile. */
function TodayWeekToggle({
  mode,
  onChange,
}: {
  mode: HeroMode;
  onChange: (m: HeroMode) => void;
}) {
  const options: { value: HeroMode; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "week", label: "This Week" },
  ];
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {options.map((o) => {
        const active = o.value === mode;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`text-xs px-3 h-7 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small segmented Total / Daily Avg control for the week ring. */
function TotalAvgToggle({
  mode,
  onChange,
}: {
  mode: RingValueMode;
  onChange: (m: RingValueMode) => void;
}) {
  const options: { value: RingValueMode; label: string }[] = [
    { value: "total", label: "Total" },
    { value: "avg", label: "Daily Avg" },
  ];
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {options.map((o) => {
        const active = o.value === mode;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`text-xs px-3 h-7 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Hero activity-rings tile — mirrors the Health page Today hero (full-size
 * ActivityRings + the 5-metric value/goal/% legend) with a Today/Week toggle
 * (default Week).
 *
 * - Today → dailyRingProgress against the live day's value + resolved goal;
 *           no on-pace tick.
 * - Week  → periodRingProgress over the SELECTED week (current week =
 *           week-start→today; past weeks = full week; future weeks = empty);
 *           value = summed actual, goal = summed resolved daily goals, with an
 *           on-pace tick for the CURRENT week only.
 *
 * All value/goal/%/color math comes from the shared ringMath helpers, and the
 * rings + legend render through the shared ActivityRings (showLegend) — the
 * same path the Health page hero uses, so the two surfaces can't diverge.
 */
function HealthHeroTile({
  todayMetric,
  weekMetrics,
  ringGoals,
  weekStart,
  weekEnd,
  onMetricClick,
}: HealthHeroTileProps) {
  const [mode, setMode] = useState<HeroMode>("week");
  // Total ↔ Daily Avg for the WEEK ring only (today is single-day, unaffected).
  const [valueMode, setValueMode] = useState<RingValueMode>("total");

  const todayIso = toIsoDate(new Date());
  const weekStartIso = toIsoDate(weekStart);
  const weekEndIso = toIsoDate(weekEnd);
  const isCurrentWeek = todayIso >= weekStartIso && todayIso <= weekEndIso;
  const isFutureWeek = weekStartIso > todayIso;

  const todayRings: RingDatum[] = useMemo(
    () =>
      RING_METRICS.map((metric) => {
        const goal = resolveGoalForDate(ringGoals, metric, todayIso);
        const value = todayMetric?.[metric] as number | undefined;
        const actual = value != null && value > 0 ? value : 0;
        return {
          metric,
          label: RING_LABELS[metric],
          progress: dailyRingProgress(value, goal),
          color: RING_COLORS[metric],
          valueLabel: `${fmtRingNumber(metric, actual)} / ${fmtRingNumber(metric, goal)}${RING_UNITS[metric]}`,
        };
      }),
    [ringGoals, todayMetric, todayIso]
  );

  const weekRings: RingDatum[] = useMemo(() => {
    const periodEnd = isCurrentWeek ? todayIso : weekEndIso;
    // On-pace tick over the FULL Mon–Sun week — current week only (past weeks
    // are complete and future weeks are empty; both hide the tick anyway).
    const weekOnPace = isCurrentWeek
      ? onPaceFraction(weekStartIso, weekEndIso, todayIso)
      : undefined;
    return RING_METRICS.map((metric) => {
      if (isFutureWeek) {
        return {
          metric,
          label: RING_LABELS[metric],
          progress: 0,
          color: RING_COLORS[metric],
          valueLabel: "—",
        };
      }
      const days = weekMetrics.map((m) => ({
        date: m.date,
        value: (m[metric] as number | undefined) ?? null,
      }));
      const progress = periodRingProgress(
        days,
        ringGoals,
        metric,
        weekStartIso,
        periodEnd
      );
      const actual = days.reduce(
        (s, d) =>
          s +
          (d.value != null && d.value > 0 && d.date <= periodEnd ? d.value : 0),
        0
      );
      const dailyGoals = eachDate(weekStartIso, periodEnd).map((date) =>
        resolveGoalForDate(ringGoals, metric, date)
      );
      const goalTotal = dailyGoals.reduce((s, g) => s + g, 0);
      const valueLabel =
        valueMode === "avg"
          ? (() => {
              const avg = ringDailyAverage({
                periodTotal: actual,
                periodStart: weekStart,
                periodEnd: parseIsoDate(periodEnd),
                dailyGoals,
                today: new Date(),
              });
              return `avg ${fmtRingNumber(metric, avg.avgValue)} / ${fmtRingNumber(metric, avg.avgGoal)}${RING_UNITS[metric]} per day`;
            })()
          : `${fmtRingNumber(metric, actual)} / ${fmtRingNumber(metric, goalTotal)}${RING_UNITS[metric]}`;
      return {
        metric,
        label: RING_LABELS[metric],
        progress,
        color: RING_COLORS[metric],
        valueLabel,
        onPaceFraction: weekOnPace,
      };
    });
  }, [
    weekMetrics,
    ringGoals,
    weekStart,
    weekStartIso,
    weekEndIso,
    todayIso,
    isCurrentWeek,
    isFutureWeek,
    valueMode,
  ]);

  const rings = mode === "today" ? todayRings : weekRings;

  return (
    <Card className="h-full">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary">
          Activity Rings
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Total ↔ Daily Avg applies to the multi-day week ring only. */}
          {mode === "week" && !isFutureWeek && (
            <TotalAvgToggle mode={valueMode} onChange={setValueMode} />
          )}
          <TodayWeekToggle mode={mode} onChange={setMode} />
        </div>
      </div>
      <div className="flex justify-center">
        <ActivityRings
          rings={rings}
          size={220}
          showLegend
          onRingClick={onMetricClick}
        />
      </div>
    </Card>
  );
}

// ─── Training Load ────────────────────────────────────────────────────────────

interface TrainingLoadCardProps {
  workouts: HealthWorkout[];
  weekStart: Date;
  weekEnd: Date;
}

function TrainingLoadCard({ workouts, weekStart, weekEnd }: TrainingLoadCardProps) {
  const now = new Date();

  const runs = workouts.filter((w) => w.isRunLike);

  const cutoff30 = new Date(now);
  cutoff30.setDate(now.getDate() - 30);

  // Acute = sum of miles for runs in the current Mon–Sun week (week-aligned,
  // matching the Running KPI row's "Actual" tile above).
  const acute = runs
    .filter((w) => isInWeek(w, weekStart, weekEnd))
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
          <span className="text-xs text-textSecondary">This week</span>
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
  weekStart: Date;
  weekEnd: Date;
  maxHr: number;
  restingHr: number;
}

function LoadScoreTrainingLoadCard({
  workouts,
  weekStart,
  weekEnd,
  maxHr,
  restingHr,
}: LoadScoreTrainingLoadCardProps) {
  const now = new Date();

  // Acute = sum of load scores for all activities in the current Mon–Sun week.
  // Direct filter (not rollingLoad) so the window matches isInWeek exactly,
  // consistent with the Running and Workout KPI rows above.
  const acute = useMemo(() => {
    let total = 0;
    for (const w of workouts) {
      if (!isInWeek(w, weekStart, weekEnd)) continue;
      const load = resolveDisplayLoad(w, maxHr, restingHr);
      if (load == null) continue;
      total += load;
    }
    return total;
  }, [workouts, weekStart, weekEnd, maxHr, restingHr]);

  // Chronic = rolling 28-day total / 4 = avg per week. Kept rolling (not
  // week-aligned) so it represents the user's established baseline capacity.
  const dailyMap = useMemo(
    () => buildDailyLoadMap(workouts, maxHr, restingHr),
    [workouts, maxHr, restingHr]
  );
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
          <span className="text-xs text-textSecondary">This Week</span>
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

// ─── Week Score Card ─────────────────────────────────────────────────────────

/** Format a breakdown component's actual/target pair for the explainer. */
function fmtWeekScoreValue(c: WeekScoreComponent): string {
  if (c.target <= 0) {
    if (c.unit === "mi") return `${c.actual.toFixed(1)} mi · no plan`;
    if (c.unit === "sessions") return "no plan";
    return "no baseline";
  }
  if (c.unit === "mi") return `${c.actual.toFixed(1)} / ${c.target.toFixed(1)} mi`;
  if (c.unit === "sessions") return `${c.actual} / ${c.target} sessions`;
  return `${Math.round(c.actual)} / ${Math.round(c.target)} load`;
}

/** Single ring + three sub-score bars summarising the current week's
 *  adherence and load. Pure presentation — all numbers come from
 *  computeWeekScore() at the page level. */
function WeekScoreCard({ input }: { input: WeekScoreInput }) {
  // Disclosure state — declared before any early return (React #310).
  const [showBreakdown, setShowBreakdown] = useState(false);

  const empty = isWeekEmpty(input);

  // Compute the score unconditionally so we still render *something* on an
  // empty week; the rendered branch decides whether to show the gauge or
  // the placeholder.
  const result: WeekScoreResult = computeWeekScore(input);
  // Per-component breakdown for the explainer (sums to result.total).
  const breakdown = buildWeekScoreBreakdown(input);

  if (empty) {
    return (
      <Card>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-2">
              Week Score
            </p>
            <p className="text-sm text-textSecondary">
              Check back as your week builds.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-6">
        {/* Left — ring gauge */}
        <WeekScoreRing result={result} />

        {/* Right — label + sub-score bars */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-textSecondary mb-1">
              Week Score
            </p>
            <p
              className="font-medium leading-tight"
              style={{ fontSize: 22, color: result.color }}
            >
              {result.label}
            </p>
            <p className="text-xs text-textSecondary mt-0.5">
              {result.descriptionLine}
            </p>
            {/* Pro-rating basis — e.g. "vs plan through Wed". */}
            <p className="text-[11px] text-textSecondary mt-0.5">
              {result.basisLine}
            </p>
          </div>

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-2">
            <WeekScoreBar label="Run miles"     points={result.runScore}     max={40} />
            <WeekScoreBar label="Training load" points={result.loadScore}    max={35} />
            <WeekScoreBar label="Workouts"      points={result.workoutScore} max={25} />
          </div>
        </div>
      </div>

      {/* Explainer — additive, collapsed by default (card is unchanged until
          opened). Each component reconciles to the displayed total. */}
      <button
        type="button"
        onClick={() => setShowBreakdown((v) => !v)}
        aria-expanded={showBreakdown}
        className="mt-3 flex items-center gap-1 text-xs text-textSecondary hover:text-textPrimary transition-colors"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${showBreakdown ? "rotate-180" : ""}`}
        />
        How is this calculated?
      </button>

      {showBreakdown && (
        <div className="mt-2 border-t border-border pt-3 flex flex-col gap-2">
          {breakdown.components.map((c) => (
            <div key={c.key} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-textPrimary font-medium">{c.label}</span>
                <span className="tabular-nums text-textSecondary">
                  {fmtWeekScoreValue(c)} ·{" "}
                  <span className="text-textPrimary font-semibold">
                    {c.earnedPoints}/{c.maxPoints} pts
                  </span>
                </span>
              </div>
              <span className="text-[11px] text-textSecondary">{c.note}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-2 text-xs border-t border-border pt-2">
            <span className="text-textPrimary font-semibold">Total</span>
            <span className="tabular-nums text-textPrimary font-semibold">
              {breakdown.total}/100 pts
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function WeekScoreRing({ result }: { result: WeekScoreResult }) {
  const RADIUS = 52;
  const CIRC = 2 * Math.PI * RADIUS;
  const filled = (result.total / 100) * CIRC;
  return (
    <svg viewBox="0 0 130 130" width="110" height="110" className="shrink-0">
      <circle
        cx={65}
        cy={65}
        r={RADIUS}
        fill="none"
        stroke="var(--color-background-secondary)"
        strokeWidth={11}
      />
      <circle
        cx={65}
        cy={65}
        r={RADIUS}
        fill="none"
        stroke={result.color}
        strokeWidth={11}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${CIRC}`}
        transform="rotate(-90 65 65)"
      />
      <text
        x={65}
        y={60}
        textAnchor="middle"
        fontSize={26}
        fontWeight={500}
        fill="var(--color-text-primary)"
      >
        {result.total}
      </text>
      <text
        x={65}
        y={76}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-text-secondary)"
      >
        /100
      </text>
    </svg>
  );
}

const WEEK_SCORE_BAR_FILL = "#7F77DD";

function WeekScoreBar({
  label,
  points,
  max,
}: {
  label: string;
  points: number;
  max: number;
}) {
  const pct = max > 0 ? Math.min(100, (points / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-textSecondary shrink-0" style={{ width: 62 }}>
        {label}
      </span>
      <div
        className="flex-1 rounded-full overflow-hidden"
        style={{
          height: 6,
          background: "var(--color-background-secondary)",
        }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: WEEK_SCORE_BAR_FILL }}
        />
      </div>
      <span
        className="text-right tabular-nums shrink-0"
        style={{ width: 36, fontSize: 11, color: WEEK_SCORE_BAR_FILL }}
      >
        {points}/{max}
      </span>
    </div>
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
  const [todayMetric, setTodayMetric] = useState<HealthMetric | null>(null);
  const [ringGoals, setRingGoals] = useState<HealthGoalDoc[]>([]);
  const router = useRouter();
  const [userSettings, setUserSettings] = useState<UserSettings | null>();
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
    fetchUserSettings(uid)
      .then(setUserSettings)
      .catch((err) => console.error("[fetchUserSettings]", err));
  }, [uid]);

  const maxHr = resolveMaxHr(userSettings);
  const restingHr = resolveRestingHr(userSettings);

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

  // One-time fetch for today's healthMetrics doc — powers the hero tile's
  // "Today" mode independently of week navigation, so toggling to Today always
  // shows the live day even when a past/future week is selected.
  useEffect(() => {
    if (!uid) return;
    const iso = toIsoDate(new Date());
    let cancelled = false;
    fetchHealthMetricsRange(uid, iso, iso)
      .then((m) => {
        if (!cancelled) setTodayMetric(m.find((d) => d.date === iso) ?? null);
      })
      .catch((err) => console.error("[fetchTodayMetric]", err));
    return () => {
      cancelled = true;
    };
  }, [uid]);

  // One-time fetch for the effective-dated ring goal versions
  // (users/{uid}/healthGoals) powering the activity rings.
  useEffect(() => {
    if (!uid) return;
    fetchRingGoalVersions(uid)
      .then(setRingGoals)
      .catch((err) => console.error("[fetchRingGoalVersions]", err));
  }, [uid]);

  // Ring tap → Health page Trends tab, scrolled to that metric's section
  // (same ?tab=trends&metric= deep link the Health page rings use).
  const goToHealthTrend = useCallback(
    (metric: RingMetric) => {
      router.push(`/health?tab=trends&metric=${metric}`);
    },
    [router]
  );

  // One-time fetch for plans (user-managed data, not iOS-synced).
  // Race data was previously fetched here for the now-removed RaceGoalCard.
  useEffect(() => {
    if (!uid) return;
    fetchPlans(uid)
      .then((plans) => {
        const runningPlans = plans.filter(isRunningPlan);
        setActivePlan(runningPlans.find((p) => p.status === "active") ?? null);
        const workoutPlansList = plans.filter(isWorkoutPlan);
        setActiveWorkoutPlan(
          workoutPlansList.find((p) => p.status === "active") ?? null
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

  // ── Week Score inputs ────────────────────────────────────────────────────
  // The Week Score is PRO-RATED against the plan scheduled THROUGH TODAY (not
  // the full week), so an on-track mid-week reads as on-track. daysElapsed =
  // Monday→today inclusive (0 future / 7 past), and the run/workout
  // denominators only count entries with weekday <= daysElapsed. The KPI cards
  // above keep showing full-week planned values (plannedMiles / sessions*).

  // daysElapsed for the SELECTED week: anchored on the live "today", so it is
  // 7 for any fully-elapsed past week and 0 for a future week.
  const daysElapsed = useMemo(
    () => daysElapsedInWeek(selectedWeekStart, new Date()),
    [selectedWeekStart]
  );

  // Planned miles SCHEDULED THROUGH TODAY (pro-rated run denominator). Mirrors
  // the full-week `plannedMiles` memo but filters entries to weekday <=
  // daysElapsed (weekday 1=Mon..7=Sun; legacy dayOfWeek = weekday-1).
  const plannedMilesThroughToday = useMemo(() => {
    if (!activePlan) return 0;
    const planStart = new Date(activePlan.startDate);
    const weekIndex = Math.floor(
      (selectedWeekStart.getTime() - planStart.getTime()) /
        (7 * 24 * 60 * 60 * 1000)
    );
    if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return 0;
    return activePlan.weeks[weekIndex].entries.reduce((s, e) => {
      const weekday = e.weekday ?? e.dayOfWeek + 1;
      return isScheduledThroughToday(weekday, daysElapsed)
        ? s + e.distanceMiles
        : s;
    }, 0);
  }, [activePlan, selectedWeekStart, daysElapsed]);
  // All six numbers fed into computeWeekScore() live here so the score
  // updates in lockstep with the week-navigator selection. Each value
  // mirrors the formula the corresponding tile below uses, so the score
  // never contradicts the numbers the user sees in the stats cards.

  const actualMiles = useMemo(
    () =>
      workouts
        .filter((w) => w.isRunLike && isInWeek(w, selectedWeekStart, selectedWeekEnd))
        .reduce((s, w) => s + w.distanceMiles, 0),
    [workouts, selectedWeekStart, selectedWeekEnd]
  );

  // Sum of in-week per-session loads, matching the filters the Running
  // and Workouts stats cards apply for their "load XXX" totals. Sessions
  // below the min thresholds are excluded so the score doesn't reward
  // warmup/aborted activity.
  const thisWeekTotalLoad = useMemo(() => {
    let total = 0;
    for (const w of workouts) {
      if (!isInWeek(w, selectedWeekStart, selectedWeekEnd)) continue;
      if (w.isRunLike) {
        if (w.distanceMiles < MIN_RUN_MILES_FOR_AVG) continue;
      } else {
        if (w.durationSeconds < MIN_WORKOUT_SECONDS_FOR_AVG) continue;
      }
      const load = resolveDisplayLoad(w, maxHr, restingHr);
      if (load == null) continue;
      total += load;
    }
    return total;
  }, [workouts, selectedWeekStart, selectedWeekEnd, maxHr, restingHr]);

  // 28-day rolling baseline ending TODAY — same value the Load Score
  // Training Load card surfaces as "28-Day Avg/Wk". Anchored on today
  // (not selectedWeekStart) by design: this represents the user's typical
  // weekly capacity, which doesn't shift when they navigate to a past
  // week.
  const avgWeeklyLoad = useMemo(() => {
    const dailyMap = buildDailyLoadMap(workouts, maxHr, restingHr);
    const total28 = rollingLoad(dailyMap, new Date(), 28);
    return total28 / 4;
  }, [workouts, maxHr, restingHr]);

  // Workout-plan session counts for the selected week — mirrors the
  // derivation inside WorkoutPlanProgressCard.
  const { sessionsCompleted, sessionsPlanned } = useMemo(() => {
    if (!activeWorkoutPlan) {
      return { sessionsCompleted: 0, sessionsPlanned: 0 };
    }
    const planStart = new Date(activeWorkoutPlan.startDate + "T00:00:00");
    const weekIndex = Math.floor(
      (selectedWeekStart.getTime() - planStart.getTime()) /
        (7 * 24 * 60 * 60 * 1000)
    );
    if (weekIndex < 0 || weekIndex >= activeWorkoutPlan.weeks.length) {
      return { sessionsCompleted: 0, sessionsPlanned: 0 };
    }
    const sessionEntries = activeWorkoutPlan.weeks[weekIndex].entries.filter(
      (e): e is PlannedWorkoutEntry => e.type === "workout"
    );
    return {
      sessionsCompleted: sessionEntries.filter((e) => e.completed === true)
        .length,
      sessionsPlanned: sessionEntries.length,
    };
  }, [activeWorkoutPlan, selectedWeekStart]);

  // Workout sessions SCHEDULED THROUGH TODAY (pro-rated workout denominator),
  // plus the completed count among them. Same week-index derivation as the
  // full-week memo above, filtered to weekday <= daysElapsed.
  const {
    sessionsCompletedThroughToday,
    sessionsPlannedThroughToday,
  } = useMemo(() => {
    if (!activeWorkoutPlan) {
      return {
        sessionsCompletedThroughToday: 0,
        sessionsPlannedThroughToday: 0,
      };
    }
    const planStart = new Date(activeWorkoutPlan.startDate + "T00:00:00");
    const weekIndex = Math.floor(
      (selectedWeekStart.getTime() - planStart.getTime()) /
        (7 * 24 * 60 * 60 * 1000)
    );
    if (weekIndex < 0 || weekIndex >= activeWorkoutPlan.weeks.length) {
      return {
        sessionsCompletedThroughToday: 0,
        sessionsPlannedThroughToday: 0,
      };
    }
    const scheduled = activeWorkoutPlan.weeks[weekIndex].entries
      .filter((e): e is PlannedWorkoutEntry => e.type === "workout")
      .filter((e) =>
        isScheduledThroughToday(e.weekday ?? e.dayOfWeek + 1, daysElapsed)
      );
    return {
      sessionsCompletedThroughToday: scheduled.filter(
        (e) => e.completed === true
      ).length,
      sessionsPlannedThroughToday: scheduled.length,
    };
  }, [activeWorkoutPlan, selectedWeekStart, daysElapsed]);

  const weekScoreInput: WeekScoreInput = {
    actualMiles,
    plannedMiles: plannedMilesThroughToday,
    thisWeekTotalLoad,
    avgWeeklyLoad,
    sessionsCompleted: sessionsCompletedThroughToday,
    sessionsPlanned: sessionsPlannedThroughToday,
    daysElapsed,
  };

  // ─── KPI data ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6 lg:p-6 p-4 max-w-5xl mx-auto">
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

      {/* Row 2: Week Score — single-glance summary of run/load/workout
          adherence for the selected week. (The standalone Plan Progress
          row was folded into the Running row's first two tiles below.) */}
      <WeekScoreCard input={weekScoreInput} />

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

      {/* Row 4: Health — single hero rings tile (full-size ActivityRings +
          5-metric legend) with a Today/Week toggle. Week mode respects the
          selected week; Today mode uses the live day's doc. */}
      <HealthHeroTile
        todayMetric={todayMetric}
        weekMetrics={weekMetrics}
        ringGoals={ringGoals}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
        onMetricClick={goToHealthTrend}
      />

      {/* Row 5: Training Load row — Mileage + Load Score side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TrainingLoadCard workouts={workouts} weekStart={selectedWeekStart} weekEnd={selectedWeekEnd} />
        <LoadScoreTrainingLoadCard
          workouts={workouts}
          weekStart={selectedWeekStart}
          weekEnd={selectedWeekEnd}
          maxHr={maxHr}
          restingHr={restingHr}
        />
      </div>

      {/* Row 6: Running KPIs — Planned + Actual miles (absorbed from the
          removed Plan Progress row) followed by Runs / Avg Pace / Avg HR /
          Run Load. */}
      <RunningStatsCard
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
        plannedMiles={plannedMiles}
        maxHr={maxHr}
        restingHr={restingHr}
      />

      {/* Row 7: Running row — Running Plan tile (left) + This Week's Runs
          tile (right). items-stretch + h-full on each card so the pair
          shares a common height (matches the tallest sibling). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <PlanProgressCard
          activePlan={activePlan}
          workouts={workouts}
          weekStart={selectedWeekStart}
          weekEnd={selectedWeekEnd}
        />
        <ThisWeekRunsCard
          workouts={workouts}
          weekStart={selectedWeekStart}
          maxHr={maxHr}
          restingHr={restingHr}
        />
      </div>

      {/* Row 8: Workout KPIs — Planned + Actual workouts (from the active
          workout plan) followed by Avg Dur / Avg HR / Workout Load. */}
      <WorkoutsStatsCard
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
        sessionsPlanned={sessionsPlanned}
        sessionsCompleted={sessionsCompleted}
        maxHr={maxHr}
        restingHr={restingHr}
      />

      {/* Row 9: Workout row — Workout Plan tile (left) + This Week's
          Workouts tile (right). Same responsive + items-stretch + h-full
          pattern as the Running row above. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <WorkoutPlanProgressCard
          activeWorkoutPlan={activeWorkoutPlan}
          weekStart={selectedWeekStart}
        />
        <WorkoutSummaryCard
          workouts={workouts}
          weekStart={selectedWeekStart}
          weekEnd={selectedWeekEnd}
          maxHr={maxHr}
          restingHr={restingHr}
          onSelect={setSelectedWorkout}
        />
      </div>

      {selectedWorkout && uid && (
        <WorkoutDetailModal
          workout={selectedWorkout}
          override={overrides[selectedWorkout.workoutId] ?? null}
          userId={uid}
          maxHr={maxHr}
          restingHr={restingHr}
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
