"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { formatRaceTime } from "@/utils/riegelFit";
import { type PredictionTrendPoint } from "@/utils/racePrediction";

/**
 * Predicted race finish recomputed at each plan week vs. the goal finish.
 * Lower = faster, so a line falling toward the goal reference means the gap is
 * closing week over week. Styling on CSS-variable tokens; null weeks break the
 * line (no fabricated points). Renders a graceful empty state until ≥2 weeks
 * have a prediction.
 */
export function PredictionTrendChart({ data }: { data: PredictionTrendPoint[] }) {
  const predicted = data.filter(
    (d): d is PredictionTrendPoint & { predictedSeconds: number } =>
      d.predictedSeconds != null,
  );
  const goalSeconds = data.find((d) => d.goalSeconds != null)?.goalSeconds ?? null;

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-1">
        Predicted Finish — Plan Progress
      </h2>
      <p className="text-xs text-textSecondary mb-3">
        Predicted finish recomputed each week vs. your goal (lower is faster).
      </p>
      {children}
    </div>
  );

  // Need at least two predicted weeks for a trend to read as a trend.
  if (predicted.length < 2) {
    return (
      <Shell>
        <p className="text-sm text-textSecondary py-6 text-center">
          Not enough data yet — keep logging runs and the weekly prediction trend
          will appear once at least two plan weeks can be predicted.
        </p>
      </Shell>
    );
  }

  // Y domain padded to include both the predicted range and the goal line.
  const values = predicted.map((d) => d.predictedSeconds);
  if (goalSeconds != null) values.push(goalSeconds);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(30, (hi - lo) * 0.08);
  const domain: [number, number] = [Math.max(0, lo - pad), hi + pad];

  return (
    <Shell>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="var(--color-border)"
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={domain}
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={56}
            tickFormatter={(v: number) => formatRaceTime(v)}
            label={{
              value: "Finish (h:mm:ss)",
              angle: -90,
              position: "insideLeft",
              style: { fontSize: 10, fill: "var(--color-textSecondary)" },
            }}
          />
          <Tooltip
            formatter={(v) => [formatRaceTime(Number(v)), "Predicted"]}
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
          {goalSeconds != null && (
            <ReferenceLine
              y={goalSeconds}
              stroke="var(--color-chart-success)"
              strokeDasharray="5 4"
              label={{
                value: `Goal ${formatRaceTime(goalSeconds)}`,
                position: "insideTopRight",
                style: { fontSize: 10, fill: "var(--color-chart-success)" },
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="predictedSeconds"
            stroke="var(--color-chart-primary)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls={false}
            name="Predicted"
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Shell>
  );
}
