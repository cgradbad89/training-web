"use client";

/**
 * Collapsible completion summary, rendered at the TOP of a plan detail view
 * (before the week editor) ONLY when plan.status === "completed". Branches by
 * plan type:
 *   - Running: runs + mileage tiles, the weekly planned-vs-actual mileage bar
 *     chart (full span via buildPlanAdherence), and a per-week avg-pace line.
 *   - Workout: workouts / OT / Pilates / Uncategorized tiles and the weekly
 *     planned-vs-actual session-count bar chart (buildWorkoutPlanSummary).
 *
 * All computation is in-memory (no Firestore). Numbers reuse the same pure
 * utils as Plan Insights — no reimplemented match/load/pace math.
 */

import { useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  type RunningPlan,
  type WorkoutPlan,
  isRunningPlan,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { buildPlanAdherence } from "@/utils/planAdherence";
import { buildWorkoutPlanSummary } from "@/utils/workoutPlanSummary";
import { PlanAdherenceChart } from "@/components/charts/PlanAdherenceChart";
import { WorkoutSessionsChart } from "@/components/charts/WorkoutSessionsChart";
import { formatCompletedAt } from "@/utils/planFormat";
import { formatPace } from "@/utils/pace";
import { DEFAULT_MAX_HR } from "@/utils/trainingLoad";

// ─── Stat tile ────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
        {label}
      </p>
      <p className="text-2xl font-bold text-textPrimary tabular-nums">{value}</p>
      {sub && <p className="text-xs text-textSecondary mt-1">{sub}</p>}
    </div>
  );
}

// ─── Per-week pace line ─────────────────────────────────────────────────────────

function PlanPaceChart({
  data,
}: {
  data: { label: string; pace: number | null }[];
}) {
  const hasPace = data.some((d) => d.pace != null);
  if (!hasPace) return null;

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
        Weekly Avg Pace
      </h2>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            reversed
            domain={["dataMin - 15", "dataMax + 15"]}
            tickFormatter={(v) => formatPace(Number(v))}
          />
          <Tooltip
            formatter={(v) => [`${formatPace(Number(v))} /mi`, "Avg pace"]}
            contentStyle={{
              fontSize: 12,
              backgroundColor: "var(--color-chart-tooltip-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: "0.375rem",
              color: "var(--color-textPrimary)",
            }}
            labelStyle={{ color: "var(--color-textSecondary)" }}
            itemStyle={{ color: "var(--color-textPrimary)" }}
          />
          <Line
            type="monotone"
            dataKey="pace"
            stroke="var(--color-chart-primary)"
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-textSecondary mt-3">
        Lower is faster · runs only.
      </p>
    </div>
  );
}

// ─── Section wrapper (collapsible) ──────────────────────────────────────────────

function SummaryShell({
  completedAt,
  expanded,
  onToggle,
  children,
}: {
  completedAt?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const completedLabel = formatCompletedAt(completedAt);
  return (
    <div className="border-b border-border bg-surface/40">
      <button
        onClick={onToggle}
        className="w-full px-6 py-3 flex items-center gap-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-textSecondary shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-textSecondary shrink-0" />
        )}
        <span className="text-sm font-semibold text-textPrimary">Plan Summary</span>
        {completedLabel && (
          <span className="text-xs text-textSecondary">
            · Completed {completedLabel}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-6 pb-5 flex flex-col gap-4">{children}</div>
      )}
    </div>
  );
}

// ─── Public component ───────────────────────────────────────────────────────────

interface PlanCompletionSummaryProps {
  plan: RunningPlan | WorkoutPlan;
  /** Required for running summaries (matched-run mileage/pace). */
  activities?: HealthWorkout[];
}

export function PlanCompletionSummary({
  plan,
  activities = [],
}: PlanCompletionSummaryProps) {
  // Hook before any early return (React error #310).
  const [expanded, setExpanded] = useState(true);

  if (plan.status !== "completed") return null;

  if (isRunningPlan(plan)) {
    const result = buildPlanAdherence(plan, activities, {
      maxHr: DEFAULT_MAX_HR,
    });
    const chartData = result.weeks.map((w) => ({
      label: w.label,
      planned: w.plannedMiles,
      actual: w.actualMiles,
      weekNumber: w.weekNumber,
      runLoad: w.runLoad,
    }));
    const paceData = result.weeks.map((w) => ({
      label: w.label,
      pace: w.avgPaceSecPerMile,
    }));

    return (
      <SummaryShell
        completedAt={plan.completedAt}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatTile
            label="Runs"
            value={`${result.totalCompletedRuns} / ${result.totalPlannedRuns}`}
            sub="completed / planned"
          />
          <StatTile
            label="Mileage"
            value={`${result.totalActualMiles.toFixed(1)} / ${result.totalPlannedMiles.toFixed(1)}`}
            sub="actual / planned mi"
          />
          <StatTile
            label="Avg Pace"
            value={
              result.overallAvgPaceSecPerMile != null
                ? `${formatPace(result.overallAvgPaceSecPerMile)} /mi`
                : "—"
            }
            sub="across plan"
          />
        </div>
        <PlanAdherenceChart data={chartData} />
        <PlanPaceChart data={paceData} />
      </SummaryShell>
    );
  }

  // Workout plan
  const summary = buildWorkoutPlanSummary(plan);
  const sessionData = summary.weeks.map((w) => ({
    label: w.label,
    plannedSessions: w.plannedSessions,
    completedSessions: w.completedSessions,
  }));

  return (
    <SummaryShell
      completedAt={plan.completedAt}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile
          label="Workouts"
          value={`${summary.totalCompleted} / ${summary.totalPlanned}`}
          sub="completed / planned"
        />
        <StatTile
          label="Orange Theory"
          value={`${summary.otCompleted} / ${summary.otPlanned}`}
          sub="completed / planned"
        />
        <StatTile
          label="Pilates"
          value={`${summary.pilatesCompleted} / ${summary.pilatesPlanned}`}
          sub="completed / planned"
        />
        <StatTile
          label="Uncategorized"
          value={`${summary.uncategorizedCompleted} / ${summary.uncategorizedPlanned}`}
          sub="no category set"
        />
      </div>
      <WorkoutSessionsChart data={sessionData} />
    </SummaryShell>
  );
}
