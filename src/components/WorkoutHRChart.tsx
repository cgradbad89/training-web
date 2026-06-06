"use client";

import React, { useMemo } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  buildHRChartData,
  formatElapsedMMSS,
  HR_CHART_MIN_HR,
  HR_CHART_MAX_HR,
  type HRChartDatum,
} from "@/utils/workoutHRChart";

interface WorkoutHRChartProps {
  samples: { timestamp: string; hr: number }[];
}

function HRTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: HRChartDatum }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">{formatElapsedMMSS(d.timeSec)}</p>
      <p className="text-textSecondary">HR: {Math.round(d.hr)} bpm</p>
    </div>
  );
}

/**
 * Full-workout heart-rate line for NON-ROUTE workouts (HIIT/OTF/strength),
 * sourced from the hrStream subcollection. RAW HR (no smoothing — interval
 * spikes are the point). Y-axis uses the fixed [40, 220] domain to match
 * RunOverlayChart's HR domain. Renders nothing when fewer than 2 valid samples
 * remain after filtering.
 */
export default function WorkoutHRChart({ samples }: WorkoutHRChartProps) {
  // Hook BEFORE any early return (React #310).
  const data = useMemo(() => buildHRChartData(samples), [samples]);

  if (data.length < 2) return null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-sm font-semibold text-textPrimary mb-3">Heart Rate</h2>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart
          data={data}
          margin={{ left: 12, right: 8, top: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
          <XAxis
            dataKey="timeSec"
            type="number"
            domain={[0, "dataMax"]}
            tickFormatter={(v: number) => formatElapsedMMSS(v)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[HR_CHART_MIN_HR, HR_CHART_MAX_HR]}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={32}
            unit=""
          />
          <Tooltip content={<HRTooltip />} />
          <Line
            type="monotone"
            dataKey="hr"
            stroke="var(--color-chart-hr)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
