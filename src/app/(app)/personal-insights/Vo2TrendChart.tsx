"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

/**
 * Cardio Fitness (VO₂ max) trend line for the Personal Insights page. Extracted
 * verbatim from the page so the Recharts render tree can be lazy-loaded
 * (next/dynamic, ssr:false). Presentation-only: it receives the already
 * date-formatted, rounded series and renders the exact same axes, tooltip,
 * average reference line, and line as before.
 */
export interface Vo2TrendDatum {
  date: string;
  value: number;
}

export function Vo2TrendChart({ data }: { data: Vo2TrendDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
          minTickGap={32}
        />
        <YAxis
          domain={[(min: number) => Math.floor(min - 2), (max: number) => Math.ceil(max + 2)]}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        <Tooltip
          formatter={(v) => [`${Number(v).toFixed(1)} ml/kg·min`, 'VO₂ max']}
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
        <ReferenceLine
          y={41.0}
          stroke="#639922"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          label={{
            value: 'avg',
            position: 'right',
            fill: '#639922',
            fontSize: 10,
          }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--color-chart-primary)"
          strokeWidth={2}
          dot={{ r: 3 }}
          name="value"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
