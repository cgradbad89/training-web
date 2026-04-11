"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from "recharts";
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
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { onHealthWorkoutsSnapshot } from "@/services/healthWorkouts";
import { prefetchRoutes } from "@/utils/routeCache";
import { fetchPlans } from "@/services/plans";
import { fetchRaces } from "@/services/races";

import {
  efficiencyDisplayScore,
  efficiencyLevel,
  distanceBucket,
  trainingLoadLevel,
} from "@/utils/metrics";
import {
  formatPace,
  formatDuration,
  formatMiles,
} from "@/utils/pace";
import {
  weekStart as getWeekStart,
  weekEnd as getWeekEnd,
  formatShortDate,
  isSameWeek,
} from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type RunningPlan,
  type WorkoutPlan,
  type PlannedRunEntry,
  type PlannedWorkoutEntry,
  isRunningPlan,
  isWorkoutPlan,
  isDurationOnlyEntry,
} from "@/types/plan";
import { type HalfMarathonRace, HALF_MARATHON_MILES } from "@/types/race";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatFinishTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function formatRaceDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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

// ─── Weekly Stats Bar ─────────────────────────────────────────────────────────

interface WeeklyStatsBarProps {
  workouts: HealthWorkout[];
  weekStart: Date;
  weekEnd: Date;
  plannedMiles: number;
}

function WeeklyStatsBar({ workouts, weekStart, weekEnd, plannedMiles }: WeeklyStatsBarProps) {
  const weekWorkouts = workouts.filter((w) => isInWeek(w, weekStart, weekEnd));
  const runs = weekWorkouts.filter((w) => w.isRunLike);
  const nonRunWorkouts = weekWorkouts.filter((w) => !w.isRunLike);

  const actualMiles = runs.reduce((s, w) => s + w.distanceMiles, 0);
  const totalMovingTime = runs.reduce((s, w) => s + w.durationSeconds, 0);
  const totalCalories = weekWorkouts.reduce((s, w) => s + w.calories, 0);

  const avgPaceSecPerMile = actualMiles > 0 ? totalMovingTime / actualMiles : 0;

  let milesColor = "text-textPrimary";
  if (plannedMiles > 0) {
    milesColor = actualMiles >= plannedMiles ? "text-success" : "text-danger";
  }

  return (
    <Card>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        <StatItem
          label="Planned Miles"
          value={
            <span className="text-textPrimary">
              {plannedMiles > 0 ? `${plannedMiles.toFixed(1)} mi` : "— mi"}
            </span>
          }
        />
        <StatItem
          label="Actual Miles"
          value={<span className={milesColor}>{`${actualMiles.toFixed(1)} mi`}</span>}
        />
        <StatItem label="Runs" value={runs.length} />
        <StatItem
          label="Avg Pace"
          value={avgPaceSecPerMile > 0 ? `${formatPace(avgPaceSecPerMile)} /mi` : "—"}
        />
        <StatItem label="Workouts" value={nonRunWorkouts.length} />
        <StatItem
          label="Calories"
          value={`${Math.round(totalCalories).toLocaleString()} kcal`}
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
              const hasHR = run.avgHeartRate !== null && (run.avgSpeedMPS ?? 0) > 0;
              const rawScore = hasHR
                ? ((run.avgSpeedMPS ?? 0) / run.avgHeartRate!) * 1000
                : 0;
              const displayScore = hasHR
                ? efficiencyDisplayScore(run.avgSpeedMPS ?? 0, run.avgHeartRate!)
                : 0;
              const bucket = distanceBucket(run.distanceMiles);
              const effLevel = hasHR ? efficiencyLevel(rawScore, bucket) : "neutral";
              const effBadgeLevel =
                effLevel === "good" ? "good" : effLevel === "ok" ? "ok" : effLevel === "low" ? "low" : "neutral";

              const localDate = getWorkoutLocalDate(run);
              const dayAbbrev = localDate
                .toLocaleDateString("en-US", { weekday: "short" })
                .toUpperCase();
              const dateStr = localDate.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });

              return (
                <div
                  key={run.workoutId}
                  className="flex items-center justify-between py-2 px-1 hover:bg-surface rounded-lg transition-colors"
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
                    {hasHR ? (
                      <MetricBadge
                        label="Eff"
                        value={displayScore.toFixed(1)}
                        level={effBadgeLevel as "good" | "ok" | "low" | "neutral"}
                      />
                    ) : (
                      <MetricBadge label="Eff" value="—" level="neutral" />
                    )}
                  </div>
                </div>
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
}

function WorkoutSummaryCard({ workouts, weekStart, weekEnd }: WorkoutSummaryCardProps) {
  const weekWorkouts = workouts.filter(
    (w) => !w.isRunLike && isInWeek(w, weekStart, weekEnd)
  );

  return (
    <Card className="overflow-hidden">
      <CardTitle>This Week&apos;s Workouts</CardTitle>

      {weekWorkouts.length === 0 ? (
        <EmptyState title="No workouts this week" />
      ) : (
        <div className="flex flex-col gap-1">
          {weekWorkouts.map((w) => {
            const Icon = WORKOUT_ICONS[w.displayType] ?? Activity;
            const localDate = getWorkoutLocalDate(w);
            const dayLabel = localDate.toLocaleDateString("en-US", { weekday: "short" });

            return (
              <div
                key={w.workoutId}
                className="flex items-center justify-between py-2.5 px-1 hover:bg-surface rounded-lg transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <Icon size={15} className="text-textSecondary shrink-0" />
                  <span className="text-xs text-textSecondary w-7 shrink-0">{dayLabel}</span>
                  <span className="text-sm text-textPrimary">{w.displayType}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-textSecondary whitespace-nowrap">
                  <span>{formatDuration(w.durationSeconds)}</span>
                  {w.calories > 0 && (
                    <>
                      <span className="text-border">·</span>
                      <span>{Math.round(w.calories).toLocaleString()} kcal</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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

function runStatus(
  entry: PlannedRunEntry,
  weekMonday: Date,
  weekRuns: HealthWorkout[]
): RunStatus {
  const entryDate = new Date(weekMonday);
  entryDate.setDate(weekMonday.getDate() + entry.dayOfWeek);
  const now = new Date();

  if (entryDate > now) return "upcoming";

  const run = weekRuns.find((w) => {
    if (!w.isRunLike) return false;
    const d = getWorkoutLocalDate(w);
    const diffDays = Math.abs(
      Math.round((d.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24))
    );
    return diffDays <= 1;
  });

  if (!run) return "missed";
  return run.distanceMiles >= entry.distanceMiles * 0.85 ? "met" : "partial";
}

function PlanProgressCard({ activePlan, workouts, weekStart, weekEnd }: PlanProgressCardProps) {
  if (!activePlan) {
    return (
      <Card>
        <CardTitle>Training Plan</CardTitle>
        <EmptyState
          title="No active plan"
          description="Create a training plan to track your weekly targets."
          action={
            <Link href="/plans" className="text-sm text-primary hover:underline">
              Create Plan →
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

  const weekRuns = workouts.filter((w) => w.isRunLike && isInWeek(w, weekStart, weekEnd));
  const actualMiles = weekRuns.reduce((s, w) => s + w.distanceMiles, 0);
  const plannedMiles = planWeek
    ? planWeek.entries.reduce((s, e) => s + e.distanceMiles, 0)
    : 0;
  const progressPct = plannedMiles > 0 ? Math.min(1, actualMiles / plannedMiles) : 0;

  return (
    <Card>
      <CardTitle>Training Plan</CardTitle>
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
            const status = runStatus(entry, weekStart, weekRuns);
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
  if (!activeWorkoutPlan) return null;

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
            const href = `/workout/${activeWorkoutPlan.id}/${weekIndex}/${entry.weekday}`;
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

// ─── Race Goal ────────────────────────────────────────────────────────────────

interface RaceGoalCardProps {
  activeRace: HalfMarathonRace | null;
}

function RaceGoalCard({ activeRace }: RaceGoalCardProps) {
  if (!activeRace) {
    return (
      <Card>
        <CardTitle>Race Goal</CardTitle>
        <EmptyState
          title="No active race"
          description="Add a half marathon goal to track your target pace."
          action={
            <Link href="/races" className="text-sm text-primary hover:underline">
              Add Race →
            </Link>
          }
        />
      </Card>
    );
  }

  const goalTimeSec = (activeRace.targetPaceSecondsPerMile ?? 0) * HALF_MARATHON_MILES;
  const days = daysUntil(activeRace.raceDate);

  return (
    <Card>
      <CardTitle>Race Goal</CardTitle>

      <p className="text-lg font-semibold text-textPrimary mb-1">{activeRace.name}</p>
      <div className="flex items-center gap-2 mb-1">
        <p className="text-xs text-textSecondary">{formatRaceDate(activeRace.raceDate)}</p>
        {days > 0 && (
          <span className="text-xs text-textSecondary">({days} days)</span>
        )}
        {days <= 0 && (
          <span className="text-xs text-success">(Race day!)</span>
        )}
      </div>
      <span className="inline-block text-xs bg-primary/10 text-primary font-medium px-2 py-0.5 rounded-full mb-4">
        Half Marathon
      </span>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">Target Pace</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {formatPace(activeRace.targetPaceSecondsPerMile ?? 0)}
            <span className="text-sm font-normal text-textSecondary"> /mi</span>
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">Goal Time</span>
          <span className="text-2xl font-bold text-textPrimary tabular-nums">
            {formatFinishTime(goalTimeSec)}
          </span>
        </div>
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
      <CardTitle>Training Load</CardTitle>

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
  const [activeRace, setActiveRace] = useState<HalfMarathonRace | null>(null);
  const [loading, setLoading] = useState(true);

  // One-time fetch for plans and races (user-managed data, not iOS-synced)
  useEffect(() => {
    if (!uid) return;
    Promise.all([fetchPlans(uid), fetchRaces(uid)])
      .then(([plans, races]) => {
        const runningPlans = plans.filter(isRunningPlan);
        setActivePlan(runningPlans.find((p) => p.isActive) ?? null);
        const workoutPlansList = plans.filter(isWorkoutPlan);
        setActiveWorkoutPlan(
          workoutPlansList.find((p) => p.isActive) ?? null
        );
        setActiveRace(races.find((r) => r.isActive) ?? null);
      })
      .catch(console.error);
  }, [uid]);

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

  // ─── KPI data ────────────────────────────────────────────────────────────────

  const thisWeekRuns = useMemo(
    () => workouts.filter((w) => w.isRunLike && isInWeek(w, selectedWeekStart, selectedWeekEnd)),
    [workouts, selectedWeekStart, selectedWeekEnd]
  );

  const actualMiles = useMemo(
    () => thisWeekRuns.reduce((s, w) => s + w.distanceMiles, 0),
    [thisWeekRuns]
  );

  const weekRunCount = thisWeekRuns.length;

  const { fourWeekAvg, weeklyMileageData } = useMemo(() => {
    const allRuns = workouts.filter((w) => w.isRunLike);
    const runsByWeek = new Map<string, number>();
    allRuns.forEach((run) => {
      const d = getWorkoutLocalDate(run);
      const ws = getWeekStart(d);
      const key = ws.toISOString().split("T")[0];
      runsByWeek.set(key, (runsByWeek.get(key) ?? 0) + run.distanceMiles);
    });

    const data = Array.from({ length: 8 }, (_, i) => {
      const weekDate = new Date(selectedWeekStart);
      weekDate.setDate(weekDate.getDate() - (7 - i) * 7);
      const key = weekDate.toISOString().split("T")[0];
      const miles = runsByWeek.get(key) ?? 0;
      const isCurrentWeek = i === 7;
      const label = weekDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return { label, miles, isCurrentWeek, key };
    });

    const recentWeeks = data.slice(3, 7).map((w) => w.miles);
    const avg =
      recentWeeks.length > 0
        ? recentWeeks.reduce((a, b) => a + b, 0) / recentWeeks.length
        : 0;

    return { fourWeekAvg: avg, weeklyMileageData: data };
  }, [workouts, selectedWeekStart]);

  const plannedRunCount = useMemo(() => {
    if (!activePlan) return 0;
    const planStart = new Date(activePlan.startDate);
    const weekIndex = Math.floor(
      (selectedWeekStart.getTime() - planStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return 0;
    return activePlan.weeks[weekIndex].entries.filter((e) => e.distanceMiles > 0).length;
  }, [activePlan, selectedWeekStart]);

  const daysUntilRaceCount = activeRace ? Math.max(0, daysUntil(activeRace.raceDate)) : 0;

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

      {/* Row 1: Week Navigator */}
      <WeekNavigator weekStart={selectedWeekStart} onChange={setSelectedWeekStart} />

      {/* Row 2: Weekly Stats Bar */}
      <WeeklyStatsBar
        workouts={workouts}
        weekStart={selectedWeekStart}
        weekEnd={selectedWeekEnd}
        plannedMiles={plannedMiles}
      />

      {/* ── Weekly KPI Row ──────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">

        {/* KPI 1 — Weekly Mileage vs 4-week average */}
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
            vs Recent Avg
          </p>
          <p className="text-2xl font-bold text-textPrimary">
            {actualMiles.toFixed(1)}
            <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
          </p>
          <p className="text-xs text-textSecondary mt-1">
            {fourWeekAvg > 0 ? (
              <>
                {actualMiles >= fourWeekAvg ? (
                  <span className="text-success">
                    +{(actualMiles - fourWeekAvg).toFixed(1)} above
                  </span>
                ) : (
                  <span className="text-textSecondary">
                    {(fourWeekAvg - actualMiles).toFixed(1)} below
                  </span>
                )}
                {" "}4-wk avg ({fourWeekAvg.toFixed(1)} mi/wk)
              </>
            ) : (
              "—"
            )}
          </p>
        </div>

        {/* KPI 2 — Runs this week vs plan */}
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
            Runs This Week
          </p>
          <p className="text-2xl font-bold text-textPrimary">
            {weekRunCount}
            {plannedRunCount > 0 && (
              <span className="text-sm font-normal text-textSecondary ml-1">
                / {plannedRunCount} planned
              </span>
            )}
          </p>
          <p className="text-xs text-textSecondary mt-1">
            {weekRunCount >= plannedRunCount && plannedRunCount > 0 ? (
              <span className="text-success">On track</span>
            ) : weekRunCount > 0 ? (
              `${plannedRunCount - weekRunCount} remaining`
            ) : (
              "No runs logged yet"
            )}
          </p>
        </div>

        {/* KPI 3 — Days until race */}
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
            Race Countdown
          </p>
          {activeRace ? (
            <>
              <p className="text-2xl font-bold text-textPrimary">
                {daysUntilRaceCount}
                <span className="text-sm font-normal text-textSecondary ml-1">days</span>
              </p>
              <p className="text-xs text-textSecondary mt-1 truncate">{activeRace.name}</p>
            </>
          ) : (
            <p className="text-2xl font-bold text-textSecondary">—</p>
          )}
        </div>
      </div>

      {/* ── 8-Week Mileage Trend ────────────────────────────── */}
      {weeklyMileageData.length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
            Weekly Mileage — Last 8 Weeks
          </p>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart
              data={weeklyMileageData}
              barSize={20}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(v) => [`${Number(v).toFixed(1)} mi`, "Miles"]}
                contentStyle={{ fontSize: 12 }}
              />
              <Bar dataKey="miles" radius={[4, 4, 0, 0]}>
                {weeklyMileageData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.isCurrentWeek ? "#2563eb" : "#93c5fd"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Row 3: Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Left column (3/5) */}
        <div className="lg:col-span-3 flex flex-col gap-5">
          <WorkoutSummaryCard
            workouts={workouts}
            weekStart={selectedWeekStart}
            weekEnd={selectedWeekEnd}
          />
        </div>

        {/* Right column (2/5) */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <PlanProgressCard
            activePlan={activePlan}
            workouts={workouts}
            weekStart={selectedWeekStart}
            weekEnd={selectedWeekEnd}
          />
          <WorkoutPlanProgressCard
            activeWorkoutPlan={activeWorkoutPlan}
            weekStart={selectedWeekStart}
          />
          <ThisWeekRunsCard
            workouts={workouts}
            weekStart={selectedWeekStart}
          />
          <RaceGoalCard activeRace={activeRace} />
          <TrainingLoadCard workouts={workouts} />
        </div>
      </div>
    </div>
  );
}
