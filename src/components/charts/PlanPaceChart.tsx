"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { formatPace } from "@/utils/pace";

/**
 * Per-week average-pace line for a completed running plan (lower = faster).
 * Extracted verbatim from PlanCompletionSummary so the Recharts render tree
 * can be lazy-loaded (next/dynamic, ssr:false) without pulling Recharts into
 * the plan-detail initial bundle. Presentation-only: it receives the already
 * computed per-week pace rows and renders nothing when no week has a pace.
 */
export function PlanPaceChart({
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
