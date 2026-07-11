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
import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  type RunningPlan,
  type WorkoutPlan,
  isRunningPlan,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { buildPlanAdherence } from "@/utils/planAdherence";
import { buildWorkoutPlanSummary } from "@/utils/workoutPlanSummary";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";
import { formatCompletedAt } from "@/utils/planFormat";
import { formatPace } from "@/utils/pace";
import { DEFAULT_MAX_HR } from "@/utils/trainingLoad";

// The three Recharts charts in this (completed-plan-only) summary are lazy-
// loaded client-side, so Recharts stays out of the plan-detail initial bundle
// and only loads when a completed plan's summary is expanded. Each chart is
// wrapped separately so one doesn't block the others; a ChartSkeleton holds
// its space while the chunk streams in.
const PlanAdherenceChart = dynamic(
  () =>
    import("@/components/charts/PlanAdherenceChart").then(
      (m) => m.PlanAdherenceChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);
const WorkoutSessionsChart = dynamic(
  () =>
    import("@/components/charts/WorkoutSessionsChart").then(
      (m) => m.WorkoutSessionsChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);
const PlanPaceChart = dynamic(
  () =>
    import("@/components/charts/PlanPaceChart").then((m) => m.PlanPaceChart),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);

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
