"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

/**
 * Generic health-metric trend chart (line or bar) for the Health page. Extracted
 * verbatim from the page so the Recharts render tree can be lazy-loaded
 * (next/dynamic, ssr:false) and Recharts stays out of the Health route's initial
 * bundle. Presentation-only: same props, axes, tooltip, reference line, and
 * empty-state as before. `formatDate` below is a render-only copy of the page's
 * helper (kept local so this component is self-contained).
 */

/** "YYYY-MM-DD" → "May 18" (noon parse to avoid TZ drift). */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function HealthTrendChart({
  data,
  label,
  color,
  formatter,
  refValue,
  refLabel,
  type = "line",
  yDomain,
  yTickFormatter,
}: {
  data: { date: string; value: number | undefined }[];
  label: string;
  color: string;
  formatter?: (v: number) => string;
  refValue?: number;
  refLabel?: string;
  type?: "line" | "bar";
  yDomain?: [number, number];
  yTickFormatter?: (v: number) => string;
}) {
  const filtered = data.filter(
    (d) => d.value !== undefined && d.value > 0
  );
  if (filtered.length < 2) {
    return (
      <div className="h-28 flex items-center justify-center">
        <p className="text-xs text-textSecondary">Not enough data</p>
      </div>
    );
  }

  const fmt = formatter ?? ((v: number) => String(v));
  const yFmt = yTickFormatter ?? fmt;
  const chartMargin = { top: 4, right: 8, bottom: 0, left: 8 };

  if (type === "bar") {
    return (
      <ResponsiveContainer width="100%" height={112}>
        <BarChart data={filtered} margin={chartMargin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
            tickFormatter={formatDate}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
            tickFormatter={yFmt}
            axisLine={false}
            tickLine={false}
            width={52}
            domain={yDomain}
          />
          <Tooltip
            formatter={(v) => [fmt(Number(v)), label]}
            labelFormatter={(v) => formatDate(String(v))}
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              backgroundColor: 'var(--color-chart-tooltip-bg)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-textPrimary)',
            }}
            labelStyle={{ color: 'var(--color-textSecondary)' }}
            itemStyle={{ color: 'var(--color-textPrimary)' }}
          />
          {refValue && (
            <ReferenceLine
              y={refValue}
              stroke={color}
              strokeDasharray="4 2"
              strokeOpacity={0.5}
              label={{ value: refLabel, fontSize: 9, fill: color }}
            />
          )}
          <Bar
            dataKey="value"
            fill={color}
            radius={[3, 3, 0, 0]}
            fillOpacity={0.85}
          />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={112}>
      <LineChart data={filtered} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
          tickFormatter={formatDate}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
          tickFormatter={fmt}
          axisLine={false}
          tickLine={false}
          width={52}
          domain={yDomain}
        />
        <Tooltip
          formatter={(v) => [fmt(Number(v)), label]}
          labelFormatter={(v) => formatDate(String(v))}
          contentStyle={{
            fontSize: 11,
            borderRadius: 8,
            backgroundColor: 'var(--color-chart-tooltip-bg)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-textPrimary)',
          }}
          labelStyle={{ color: 'var(--color-textSecondary)' }}
          itemStyle={{ color: 'var(--color-textPrimary)' }}
        />
        {refValue && (
          <ReferenceLine
            y={refValue}
            stroke={color}
            strokeDasharray="4 2"
            strokeOpacity={0.5}
            label={{ value: refLabel, fontSize: 9, fill: color }}
          />
        )}
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
