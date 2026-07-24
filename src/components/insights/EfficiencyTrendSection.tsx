"use client";

import React, { useMemo } from "react";
import { Gauge } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  buildEfficiencyTrend,
  buildDistanceBucketSummary,
  type EfficiencyWorkout,
  type DistanceBucket,
} from "@/utils/efficiencyScore";

const BUCKET_LABELS: Record<DistanceBucket, string> = {
  short: "Short · <5 mi",
  mid: "Mid · 5–9 mi",
  long: "Long · 10+ mi",
};

/** Below this many weeks with scored runs, the trend isn't meaningful yet. */
const MIN_WEEKS_WITH_DATA = 3;

/** ISO YYYY-MM-DD (local Monday) → "Jul 7" — matches Vo2TrendChart's axis. */
function formatWeekLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Fraction (0.09) → signed percent string ("+9%", "-4%", "0%"). */
function signedPct(fraction: number): string {
  const pct = Math.round(fraction * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/**
 * Race Readiness → Efficiency Trend: a weekly average-efficiency line plus a
 * distance-bucket breakdown, both derived from the passed (already-fetched)
 * workouts array. No Firestore reads. Chart conventions mirror Vo2TrendChart
 * (CSS-variable colors, prefers-color-scheme dark mode, no .dark class).
 */
export function EfficiencyTrendSection({
  workouts,
  restingHr,
  maxHr,
}: {
  workouts: EfficiencyWorkout[];
  restingHr: number;
  maxHr: number;
}): React.JSX.Element {
  const trend = useMemo(
    () => buildEfficiencyTrend(workouts, restingHr, maxHr),
    [workouts, restingHr, maxHr]
  );
  const buckets = useMemo(
    () => buildDistanceBucketSummary(workouts, restingHr, maxHr),
    [workouts, restingHr, maxHr]
  );

  const weeksWithData = trend.filter((t) => t.scoredRunCount > 0).length;
  const chartData = useMemo(
    () =>
      trend.map((t) => ({
        week: formatWeekLabel(t.weekStartDate),
        score: t.avgScore, // null → gap (connectNulls=false)
      })),
    [trend]
  );

  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        <Gauge size={18} className="text-primary" />
        <h2 className="text-lg font-bold text-textPrimary">Efficiency Trend</h2>
      </div>

      <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
        {weeksWithData < MIN_WEEKS_WITH_DATA ? (
          <p className="text-sm text-textSecondary text-center py-8">
            Not enough scored runs yet to show a trend.
          </p>
        ) : (
          <>
            <p className="text-xs text-textSecondary mb-4">
              Weekly average efficiency score (speed per heartbeat vs your own
              rolling baseline). Higher is more efficient.
            </p>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--color-border)"
                />
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={32}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip
                  formatter={(v) => [`${Math.round(Number(v))}`, "Efficiency"]}
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
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="var(--color-chart-primary)"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls={false}
                  name="Efficiency"
                />
              </LineChart>
            </ResponsiveContainer>

            <div className="grid grid-cols-3 gap-3 mt-5">
              {buckets.map((b) => {
                const hasData =
                  b.scoredRunCount > 0 && b.avgPercentDeltaVsBaseline != null;
                return (
                  <div
                    key={b.bucket}
                    className="flex flex-col items-center text-center rounded-xl border border-border bg-surface p-3"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-textSecondary">
                      {BUCKET_LABELS[b.bucket]}
                    </p>
                    <p className="text-xl font-bold tabular-nums text-textPrimary mt-1">
                      {hasData
                        ? signedPct(b.avgPercentDeltaVsBaseline as number)
                        : "—"}
                    </p>
                    <p className="text-[10px] text-textSecondary mt-0.5">
                      {b.scoredRunCount}{" "}
                      {b.scoredRunCount === 1 ? "run" : "runs"}
                    </p>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
