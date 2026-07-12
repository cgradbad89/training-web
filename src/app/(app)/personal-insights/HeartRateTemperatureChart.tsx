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
import { type TempScatterPoint } from "./PaceTemperatureChart";

/**
 * Heart-rate-vs-temperature scatter with an overlaid least-squares trend line.
 * Its own file for the same lazy-load reason as PaceTemperatureChart. Y is a
 * normal (higher = higher HR) numeric axis in bpm.
 */
export function HeartRateTemperatureChart({
  points,
  trendLine,
}: {
  points: TempScatterPoint[]; // x: tempF, y: avg bpm
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
          name="Heart rate"
          unit=" bpm"
          domain={["dataMin - 5", "dataMax + 5"]}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={40}
          tickFormatter={(v: number) => `${Math.round(v)}`}
        />
        <ZAxis range={[45, 45]} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value, name) =>
            name === "Heart rate"
              ? [`${Math.round(Number(value))} bpm`, "Avg HR"]
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
          fill="var(--color-chart-hr)"
          fillOpacity={0.7}
          name="Heart rate"
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
