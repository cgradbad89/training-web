"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

/**
 * Weekly planned-vs-actual mileage bar chart. Shared by Plan Insights and the
 * plan-completion summary. Self-contained card so callers just render
 * <PlanAdherenceChart data={...} />. Styling is on CSS-variable tokens only.
 */
export interface WeekAdherenceData {
  label: string;
  planned: number;
  actual: number;
  weekNumber: number;
  /** Sum of computeTrainingLoad across runs in this plan week (runs only,
   *  null-HR runs excluded). 0 when no qualifying runs in window. */
  runLoad: number;
}

export function PlanAdherenceChart({ data }: { data: WeekAdherenceData[] }) {
  if (data.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
        Weekly Mileage — Plan vs Actual
      </h2>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          barGap={2}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
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
            width={30}
          />
          <Tooltip
            formatter={(v, name) => [
              `${Number(v).toFixed(1)} mi`,
              name === "planned" ? "Planned" : "Actual",
            ]}
            contentStyle={{
              fontSize: 12,
              backgroundColor: 'var(--color-chart-tooltip-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: '0.375rem',
              color: 'var(--color-textPrimary)',
            }}
            labelStyle={{ color: 'var(--color-textSecondary)' }}
            itemStyle={{ color: 'var(--color-textPrimary)' }}
          />
          <Bar dataKey="planned" fill="var(--color-chart-primary-muted)" radius={[4, 4, 0, 0]} name="planned" />
          <Bar dataKey="actual" fill="var(--color-chart-primary)" radius={[4, 4, 0, 0]} name="actual" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-3 text-xs text-textSecondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'var(--color-chart-primary-muted)' }} /> Planned
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'var(--color-chart-primary)' }} /> Actual
        </span>
      </div>
    </div>
  );
}
