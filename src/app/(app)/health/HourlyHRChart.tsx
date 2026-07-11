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

/**
 * "Heart Rate by Time of Day" line chart (30-day average HR) for the Health
 * page. Extracted verbatim from the page so the Recharts render tree can be
 * lazy-loaded (next/dynamic, ssr:false). Presentation-only: it receives the
 * already-shaped hourly series and its y-domain. The stroke matches the page's
 * getColor("hr") token.
 */
export interface HourlyHRDatum {
  label: string;
  bpm: number;
}

export function HourlyHRChart({
  data,
  domain,
}: {
  data: HourlyHRDatum[];
  /** Optional y-domain; undefined lets Recharts auto-scale (unchanged behavior). */
  domain?: [number, number];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 9, fill: "var(--color-chart-axis)" }}
          interval={2}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 9, fill: "var(--color-chart-axis)" }}
          tickFormatter={(v: number) => `${Math.round(v)}`}
          axisLine={false}
          tickLine={false}
          width={45}
          domain={domain}
        />
        <Tooltip
          formatter={(v) => [`${Math.round(Number(v))} bpm`, "Heart Rate"]}
          labelFormatter={(label) => `at ${String(label)}`}
          contentStyle={{
            fontSize: 11,
            borderRadius: 8,
            backgroundColor: "var(--color-chart-tooltip-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-textPrimary)",
          }}
          labelStyle={{ color: "var(--color-textSecondary)" }}
          itemStyle={{ color: "var(--color-textPrimary)" }}
        />
        <Line
          type="monotone"
          dataKey="bpm"
          stroke="var(--color-chart-hr)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
