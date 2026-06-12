"use client";

import { useEffect, useMemo } from "react";
import { X } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

import { MatchedRunsList } from "@/components/MatchedRunsList";
import { type MatchedRunSummary } from "@/utils/routePerformance";
import {
  selectRouteTrendRuns,
  paceTrendDirection,
} from "@/utils/routeTrendRuns";
import { formatPace } from "@/utils/pace";
import { parseLocalDate } from "@/utils/dates";

interface RouteTrendDrawerProps {
  /** The route's nominal distance (cluster representative). */
  distanceMiles: number;
  /** ALL matched runs in the group (the drawer windows them itself). */
  runs: MatchedRunSummary[];
  onClose: () => void;
}

function shortDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function shortDateWithYear(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Routes-page trend drawer: full pace-trend chart (inverted y — faster is
 * higher), best-pace reference line, stats tiles, and the shared
 * MatchedRunsList inline. Right panel (400px) on desktop, 70vh bottom sheet
 * below lg. Backdrop / ✕ / Escape close.
 */
export function RouteTrendDrawer({
  distanceMiles,
  runs,
  onClose,
}: RouteTrendDrawerProps) {
  const windowRuns = useMemo(() => selectRouteTrendRuns(runs), [runs]);
  const direction = paceTrendDirection(windowRuns);

  // Escape closes.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // Route best = fastest across ALL matched runs (matches the card's "Best
  // Pace" stat), shown in the header, stats tile, and the chart's "Best"
  // reference line. The chart's y-domain is extended to include it so the
  // line is always visible even when the best run falls outside the window.
  const best = useMemo(
    () =>
      runs.reduce<MatchedRunSummary | null>(
        (acc, r) => (acc == null || r.paceSeconds < acc.paceSeconds ? r : acc),
        null
      ),
    [runs]
  );
  const mostRecent = useMemo(
    () =>
      runs.reduce<MatchedRunSummary | null>(
        (acc, r) => (acc == null || r.date > acc.date ? r : acc),
        null
      ),
    [runs]
  );

  const chartData = useMemo(
    () =>
      windowRuns.map((r) => ({
        ...r,
        dateLabel: shortDate(r.date),
      })),
    [windowRuns]
  );

  const improving = direction === "improving";
  const lineStroke = improving
    ? "var(--color-chart-success)"
    : "var(--color-chart-warning)";

  const paceValues = windowRuns.map((r) => r.paceSeconds);
  if (best) paceValues.push(best.paceSeconds);
  const minPace = paceValues.length > 0 ? Math.min(...paceValues) : 0;
  const maxPace = paceValues.length > 0 ? Math.max(...paceValues) : 0;
  const pad = Math.max(10, (maxPace - minPace) * 0.12);
  // ~5 evenly spaced x ticks: show every (k+1)th label.
  const tickInterval = Math.max(0, Math.ceil(chartData.length / 5) - 1);

  const listRuns = useMemo(
    () => [...runs].sort((a, b) => b.date.localeCompare(a.date)),
    [runs]
  );

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Bottom sheet (< lg) / right panel (≥ lg) */}
      <div
        role="dialog"
        aria-label="Route pace trend"
        className="absolute inset-x-0 bottom-0 h-[70vh] rounded-t-2xl border-t border-border bg-card shadow-xl flex flex-col lg:inset-x-auto lg:right-0 lg:top-0 lg:bottom-0 lg:h-auto lg:w-[400px] lg:rounded-none lg:border-t-0 lg:border-l"
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-border shrink-0">
          <span className="text-sm font-semibold bg-primary/10 text-primary px-2.5 py-0.5 rounded-full shrink-0">
            {distanceMiles.toFixed(1)} mi
          </span>
          <span className="text-sm font-bold text-textPrimary flex-1 truncate">
            {best ? `Best pace: ${formatPace(best.paceSeconds)} /mi` : "Pace trend"}
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface transition-colors text-textSecondary shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {/* Trend chart */}
          {chartData.length >= 2 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="dateLabel"
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval={tickInterval}
                />
                {/* Inverted: faster pace (lower sec/mi) plots higher. */}
                <YAxis
                  reversed
                  domain={[minPace - pad, maxPace + pad]}
                  tick={{ fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v: number) => formatPace(v)}
                />
                <Tooltip
                  formatter={(v) => [`${formatPace(Number(v))} /mi`, "Pace"]}
                  labelFormatter={(label) => String(label)}
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
                {best && (
                  <ReferenceLine
                    y={best.paceSeconds}
                    stroke="var(--color-chart-success)"
                    strokeDasharray="5 4"
                    label={{
                      value: "Best",
                      position: "insideBottomRight",
                      style: {
                        fontSize: 10,
                        fill: "var(--color-chart-success)",
                      },
                    }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="paceSeconds"
                  stroke={lineStroke}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-textSecondary py-8 text-center">
              Not enough runs in the trend window for a chart.
            </p>
          )}

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-surface rounded-xl p-3 flex flex-col gap-0.5">
              <span className="text-[10px] text-textSecondary uppercase tracking-wide">
                Best pace
              </span>
              <span className="text-sm font-bold text-textPrimary tabular-nums">
                {best ? formatPace(best.paceSeconds) : "—"}
              </span>
              <span className="text-[10px] text-textSecondary">
                {best ? shortDateWithYear(best.date) : ""}
              </span>
            </div>
            <div className="bg-surface rounded-xl p-3 flex flex-col gap-0.5">
              <span className="text-[10px] text-textSecondary uppercase tracking-wide">
                Most recent
              </span>
              <span className="text-sm font-bold text-textPrimary tabular-nums">
                {mostRecent ? formatPace(mostRecent.paceSeconds) : "—"}
              </span>
              <span className="text-[10px] text-textSecondary">
                {mostRecent ? shortDateWithYear(mostRecent.date) : ""}
              </span>
            </div>
            <div className="bg-surface rounded-xl p-3 flex flex-col gap-0.5">
              <span className="text-[10px] text-textSecondary uppercase tracking-wide">
                Runs in window
              </span>
              <span className="text-sm font-bold text-textPrimary tabular-nums">
                {windowRuns.length}
              </span>
              <span className="text-[10px] text-textSecondary">
                of {runs.length} matched
              </span>
            </div>
          </div>

          {/* Shared matched-runs list, inline */}
          <MatchedRunsList
            variant="inline"
            runs={listRuns}
            onClose={onClose}
            title={`Matched runs · ${distanceMiles.toFixed(1)} mi route`}
          />
        </div>
      </div>
    </div>
  );
}
