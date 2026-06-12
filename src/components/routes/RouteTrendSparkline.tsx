"use client";

import { useMemo } from "react";
import { LineChart, Line, YAxis, ResponsiveContainer } from "recharts";

import { type MatchedRunSummary } from "@/utils/routePerformance";
import {
  selectRouteTrendRuns,
  paceTrendDirection,
} from "@/utils/routeTrendRuns";

/**
 * Pace sparkline for a route card. Window via selectRouteTrendRuns; renders
 * nothing below 3 runs in the window. Line is --positive (chart-success) when
 * the most-recent pace beats the earliest in the window, else --caution
 * (chart-warning). Y is inverted so faster reads visually higher.
 */
export function RouteTrendSparkline({ runs }: { runs: MatchedRunSummary[] }) {
  const windowRuns = useMemo(() => selectRouteTrendRuns(runs), [runs]);
  const direction = paceTrendDirection(windowRuns);

  if (windowRuns.length < 3) return null;

  const paces = windowRuns.map((r) => r.paceSeconds);
  const min = Math.min(...paces);
  const max = Math.max(...paces);
  const pad = Math.max(5, (max - min) * 0.15);

  const improving = direction === "improving";
  const stroke = improving
    ? "var(--color-chart-success)"
    : "var(--color-chart-warning)";

  return (
    <div className="flex flex-col gap-1">
      <div className="h-12 w-full">
        <ResponsiveContainer width="100%" height={48}>
          <LineChart
            data={windowRuns}
            margin={{ top: 4, right: 2, bottom: 4, left: 2 }}
          >
            {/* Inverted: lower sec/mi (faster) plots higher. No axes shown. */}
            <YAxis hide reversed domain={[min - pad, max + pad]} />
            <Line
              type="monotone"
              dataKey="paceSeconds"
              stroke={stroke}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <span className="text-[10px] text-textSecondary">
        {improving ? "Improving pace" : "Pace trend"} &middot;{" "}
        {windowRuns.length} runs
      </span>
    </div>
  );
}
