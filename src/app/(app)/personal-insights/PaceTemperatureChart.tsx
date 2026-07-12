"use client";

import {
  ComposedChart,
  Scatter,
  Line,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { formatPaceLabel } from "@/utils/pace";

/**
 * Pace-vs-temperature scatter with an overlaid least-squares trend line.
 * Extracted into its own file so the Recharts render tree can be lazy-loaded
 * (next/dynamic, ssr:false) exactly like the page's other charts.
 *
 * Presentation-only: it receives the already-built {x: tempF, y: paceSecPerMile}
 * points and the two trend-line endpoints (or null to skip the line). Y is
 * inverted (reversed) so faster paces sit higher — matching PaceTrendChart.
 */
export interface TempScatterPoint {
  x: number; // temperature °F
  y: number; // seconds per mile
}

export function PaceTemperatureChart({
  points,
  trendLine,
}: {
  points: TempScatterPoint[];
  trendLine: TempScatterPoint[] | null;
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
        <XAxis
          type="number"
          dataKey="x"
          name="Temperature"
          unit="°F"
          domain={["dataMin - 3", "dataMax + 3"]}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${Math.round(v)}°`}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="Pace"
          reversed
          domain={["dataMin - 20", "dataMax + 20"]}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={50}
          tickFormatter={(v: number) => formatPaceLabel(v)}
        />
        <ZAxis range={[45, 45]} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value, name) =>
            name === "Pace"
              ? [formatPaceLabel(Number(value)) + " /mi", "Pace"]
              : [`${Math.round(Number(value))}°F`, "Temp"]
          }
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
        <Scatter
          data={points}
          fill="var(--color-chart-pace)"
          fillOpacity={0.7}
          name="Pace"
          isAnimationActive={false}
        />
        {trendLine && (
          <Line
            data={trendLine}
            dataKey="y"
            stroke="var(--color-chart-primary)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={false}
            legendType="none"
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
