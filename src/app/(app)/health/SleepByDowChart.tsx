"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

/**
 * "Avg Sleep by Day of Week" bar chart for the Health page's Sleep Analytics.
 * Extracted verbatim from the page so the Recharts render tree can be lazy-
 * loaded (next/dynamic, ssr:false). Presentation-only: per-bar goal-status fill
 * colors and the y-domain are computed by the parent and passed in, so the
 * goal-evaluation logic stays in the page.
 */
export interface SleepByDowDatum {
  day: string;
  avg: number;
  /** Goal-status fill color (already resolved to a CSS-var token by the parent). */
  fill: string;
}

export function SleepByDowChart({
  data,
  domain,
}: {
  data: SleepByDowDatum[];
  domain: [number, number] | string[];
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="var(--color-chart-grid)"
        />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={domain}
          tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }}
          axisLine={false}
          tickLine={false}
          width={28}
          tickFormatter={(v: number) => `${v}h`}
        />
        <Tooltip
          formatter={(v, _name, { payload }) => {
            const dayLabel =
              payload && typeof payload === "object" && "day" in payload
                ? (payload as { day: string }).day
                : "";
            return [`${Number(v).toFixed(1)} hrs avg on ${dayLabel}`, "Sleep"];
          }}
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
        <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
