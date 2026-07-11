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

/**
 * Fitness curve (CTL / ATL, TSB in tooltip) for the Personal Insights training
 * load section. Extracted verbatim from the page so the Recharts render tree
 * can be lazy-loaded (next/dynamic, ssr:false). Presentation-only: it receives
 * the already-rounded series and renders the exact same axes, tooltip, legend,
 * and lines as before. The two tiny formatters below are render-only copies of
 * the page's helpers (kept local so this component is self-contained).
 */

/** "YYYY-MM-DD" → "May 18" (parsed as a LOCAL date). */
function shortDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Signed integer with a real minus sign (for the TSB tooltip value). */
function signedRound(n: number): string {
  const r = Math.round(n);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return "0";
}

export interface FitnessCurveDatum {
  date: string;
  ctl: number;
  atl: number;
  tsb: number;
}

export function FitnessCurveChart({ data }: { data: FitnessCurveDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={data}
        margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          stroke="var(--color-border)"
        />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          interval={6}
          tickFormatter={(v: string) => shortDateLabel(v)}
        />
        <YAxis
          domain={[0, "dataMax + 10"]}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          labelFormatter={(l) => shortDateLabel(String(l))}
          formatter={(value, name) => {
            const label =
              name === "ctl"
                ? "Fitness (CTL)"
                : name === "atl"
                  ? "Fatigue (ATL)"
                  : "Form (TSB)";
            const num = Number(value);
            const display =
              name === "tsb" ? signedRound(num) : String(Math.round(num));
            return [display, label];
          }}
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
        <Legend
          wrapperStyle={{ fontSize: 11 }}
          formatter={(value) =>
            value === "ctl"
              ? "Fitness (CTL)"
              : value === "atl"
                ? "Fatigue (ATL)"
                : value
          }
        />
        <Line
          type="monotone"
          dataKey="ctl"
          stroke="var(--color-chart-primary)"
          strokeWidth={2}
          dot={false}
          name="ctl"
        />
        <Line
          type="monotone"
          dataKey="atl"
          stroke="var(--color-chart-orange)"
          strokeWidth={2}
          dot={false}
          name="atl"
        />
        {/* TSB is computed but rendered only in tooltip — wired via an
            invisible line so Recharts includes it in payload. */}
        <Line
          type="monotone"
          dataKey="tsb"
          stroke="transparent"
          strokeWidth={0}
          dot={false}
          legendType="none"
          name="tsb"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
