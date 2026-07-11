"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { formatPaceLabel } from "@/utils/pace";

/**
 * Pace Trends (last 8 weeks) — short/medium/long distance-bucket average pace,
 * inverted y (lower = faster). Extracted verbatim from the Personal Insights
 * page so the Recharts render tree can be lazy-loaded (next/dynamic, ssr:false).
 * Presentation-only: it receives the already-bucketed per-week series and
 * renders the exact same axes, tooltip, legend, and three lines as before.
 */
export interface PaceTrendDatum {
  label: string;
  short: number | null;
  medium: number | null;
  long: number | null;
}

export function PaceTrendChart({ data }: { data: PaceTrendDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
        <YAxis
          domain={["dataMin - 30", "dataMax + 30"]}
          reversed
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => formatPaceLabel(v)}
          width={50}
        />
        <Tooltip
          formatter={(v) => [formatPaceLabel(Number(v)) + " /mi"]}
          labelFormatter={(l) => `Week of ${l}`}
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
        <Legend
          wrapperStyle={{ fontSize: 11 }}
          formatter={(value) =>
            value === "short" ? "Short (1-3 mi)" : value === "medium" ? "Medium (3-6 mi)" : "Long (6+ mi)"
          }
        />
        <Line
          type="monotone"
          dataKey="short"
          stroke="var(--color-chart-orange)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls
          name="short"
        />
        <Line
          type="monotone"
          dataKey="medium"
          stroke="var(--color-chart-primary)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls
          name="medium"
        />
        <Line
          type="monotone"
          dataKey="long"
          stroke="var(--color-chart-success)"
          strokeWidth={2}
          dot={{ r: 3 }}
          connectNulls
          name="long"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
