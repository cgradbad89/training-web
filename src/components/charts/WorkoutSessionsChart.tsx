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
 * Weekly planned-vs-actual session-count bar chart for workout plans. Visual
 * sibling of PlanAdherenceChart (two bars, muted = planned, primary = actual)
 * but counts whole sessions (integer axis). Styling on CSS-variable tokens.
 */
export interface WorkoutSessionsDatum {
  label: string;
  plannedSessions: number;
  completedSessions: number;
}

export function WorkoutSessionsChart({ data }: { data: WorkoutSessionsDatum[] }) {
  if (data.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
        Weekly Sessions — Plan vs Actual
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
            allowDecimals={false}
          />
          <Tooltip
            formatter={(v, name) => [
              `${Math.round(Number(v))}`,
              name === "plannedSessions" ? "Planned" : "Completed",
            ]}
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
          <Bar
            dataKey="plannedSessions"
            fill="var(--color-chart-primary-muted)"
            radius={[4, 4, 0, 0]}
            name="plannedSessions"
          />
          <Bar
            dataKey="completedSessions"
            fill="var(--color-chart-primary)"
            radius={[4, 4, 0, 0]}
            name="completedSessions"
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-3 text-xs text-textSecondary">
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded"
            style={{ backgroundColor: "var(--color-chart-primary-muted)" }}
          />{" "}
          Planned
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded"
            style={{ backgroundColor: "var(--color-chart-primary)" }}
          />{" "}
          Completed
        </span>
      </div>
    </div>
  );
}
