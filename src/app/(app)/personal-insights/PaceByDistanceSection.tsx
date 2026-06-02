"use client";

import React, { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

import { formatPaceLabel } from "@/utils/pace";
import {
  computePaceRangeTrend,
  type PaceRangeRun,
  type TrendWindow,
} from "@/lib/paceRangeTrend";

// Time-window pills — value + short label.
const WINDOW_OPTIONS: ReadonlyArray<{ value: TrendWindow; label: string }> = [
  { value: "1m", label: "1 mo" },
  { value: "2m", label: "2 mo" },
  { value: "3m", label: "3 mo" },
  { value: "6m", label: "6 mo" },
  { value: "12m", label: "12 mo" },
  { value: "ytd", label: "YTD" },
];

const SLIDER_MIN = 0;
const SLIDER_MAX = 15;
const SLIDER_STEP = 0.5;

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-xl p-3 text-center">
      <p className="text-[11px] font-semibold text-textSecondary uppercase tracking-wide">
        {label}
      </p>
      <p className="text-xl font-bold text-textPrimary tabular-nums mt-1">
        {value}
      </p>
    </div>
  );
}

interface ChartDatum {
  label: string;
  avgPaceSeconds: number;
  runCount: number;
}

function ChartTooltip({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
  granularity: "week" | "month";
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  const periodWord = granularity === "week" ? "Week of " : "";
  return (
    <div
      style={{
        fontSize: 12,
        backgroundColor: "var(--color-chart-tooltip-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "0.375rem",
        padding: "6px 10px",
      }}
    >
      <p style={{ color: "var(--color-textSecondary)" }}>
        {periodWord}
        {d.label}
      </p>
      <p style={{ color: "var(--color-textPrimary)", fontWeight: 600 }}>
        {formatPaceLabel(d.avgPaceSeconds)} /mi
      </p>
      <p style={{ color: "var(--color-textSecondary)" }}>
        {d.runCount} {d.runCount === 1 ? "run" : "runs"}
      </p>
    </div>
  );
}

export function PaceByDistanceSection({
  runs,
}: {
  runs: PaceRangeRun[];
}): React.JSX.Element {
  // ── State (all hooks before any early return — React #310 guard) ──
  const [minMiles, setMinMiles] = React.useState(3);
  const [maxMiles, setMaxMiles] = React.useState(5);
  const [window, setWindow] = React.useState<TrendWindow>("3m");

  const result = useMemo(
    () => computePaceRangeTrend(runs, minMiles, maxMiles, window, new Date()),
    [runs, minMiles, maxMiles, window]
  );

  const chartData: ChartDatum[] = result.points.map((p) => ({
    label: p.label,
    avgPaceSeconds: p.avgPaceSeconds,
    runCount: p.runCount,
  }));

  // Emphasize the lowest plotted point (fastest avg pace = best in range).
  let lowestIndex = -1;
  for (let i = 0; i < chartData.length; i++) {
    if (
      lowestIndex === -1 ||
      chartData[i].avgPaceSeconds < chartData[lowestIndex].avgPaceSeconds
    ) {
      lowestIndex = i;
    }
  }

  const windowAvgLabel =
    result.windowAvgPaceSeconds != null
      ? `${formatPaceLabel(result.windowAvgPaceSeconds)} /mi`
      : "—";
  const bestLabel =
    result.bestRun != null
      ? `${formatPaceLabel(result.bestRun.paceSeconds)} /mi`
      : "—";

  const granularityCaption =
    result.granularity === "week"
      ? "Weekly average pace"
      : "Monthly average pace";

  // Selected-range track fill (percent of the 0–15 mi span).
  const fillLeft = ((minMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
  const fillRight = ((maxMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;

  function handleMin(v: number) {
    // Handles cannot cross: keep min at least one step below max.
    setMinMiles(Math.min(v, maxMiles - SLIDER_STEP));
  }
  function handleMax(v: number) {
    setMaxMiles(Math.max(v, minMiles + SLIDER_STEP));
  }

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-lg font-bold text-textPrimary">Pace by distance</h2>
      <p className="text-xs text-textSecondary mt-1 mb-4">
        Runs whose total distance falls within the selected range
      </p>

      {/* Time-window selector */}
      <div className="flex flex-wrap gap-2 mb-5">
        {WINDOW_OPTIONS.map((opt) => {
          const active = window === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => setWindow(opt.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                active
                  ? "bg-primary text-white"
                  : "bg-surface text-textSecondary hover:text-textPrimary"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Dual-handle mileage slider */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-textSecondary">
            Distance range
          </span>
          <span className="text-sm font-semibold text-textPrimary tabular-nums">
            {minMiles.toFixed(1)} – {maxMiles.toFixed(1)} mi
          </span>
        </div>
        <div className="dual-range relative h-5">
          {/* Track */}
          <div className="absolute top-1/2 -translate-y-1/2 w-full h-1.5 rounded-full bg-surface" />
          {/* Selected range */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-primary"
            style={{ left: `${fillLeft}%`, right: `${100 - fillRight}%` }}
          />
          <input
            type="range"
            aria-label="Minimum distance (miles)"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={SLIDER_STEP}
            value={minMiles}
            onChange={(e) => handleMin(Number(e.target.value))}
          />
          <input
            type="range"
            aria-label="Maximum distance (miles)"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={SLIDER_STEP}
            value={maxMiles}
            onChange={(e) => handleMax(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatCard label="Avg pace (window)" value={windowAvgLabel} />
        <StatCard label="Best in range" value={bestLabel} />
        <StatCard label="Runs in range" value={String(result.totalRunCount)} />
      </div>

      {/* Trend chart */}
      <ResponsiveContainer width="100%" height={220}>
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
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={["dataMin - 30", "dataMax + 30"]}
            reversed
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => formatPaceLabel(v)}
            width={50}
          />
          <Tooltip
            content={<ChartTooltip granularity={result.granularity} />}
          />
          <Line
            type="monotone"
            dataKey="avgPaceSeconds"
            stroke="var(--color-chart-primary)"
            strokeWidth={2}
            connectNulls
            name="avgPaceSeconds"
            dot={(props: { cx?: number; cy?: number; index?: number }) => {
              const { cx, cy, index } = props;
              if (cx == null || cy == null) {
                return <g key={`dot-${index ?? "x"}`} />;
              }
              const emphasized = index === lowestIndex;
              return (
                <circle
                  key={`dot-${index ?? "x"}`}
                  cx={cx}
                  cy={cy}
                  r={emphasized ? 6 : 3}
                  fill={
                    emphasized
                      ? "var(--color-chart-primary)"
                      : "var(--color-card)"
                  }
                  stroke="var(--color-chart-primary)"
                  strokeWidth={2}
                />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-textSecondary mt-3 text-center">
        {granularityCaption} · lower on chart = faster
      </p>

      <style jsx>{`
        .dual-range input[type="range"] {
          -webkit-appearance: none;
          appearance: none;
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          background: transparent;
          pointer-events: none;
        }
        .dual-range input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          pointer-events: auto;
          height: 18px;
          width: 18px;
          border-radius: 9999px;
          background: var(--color-primary);
          border: 2px solid var(--color-card);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
          cursor: pointer;
        }
        .dual-range input[type="range"]::-moz-range-thumb {
          pointer-events: auto;
          height: 18px;
          width: 18px;
          border-radius: 9999px;
          background: var(--color-primary);
          border: 2px solid var(--color-card);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
          cursor: pointer;
        }
        .dual-range input[type="range"]::-moz-range-track {
          background: transparent;
        }
      `}</style>
    </div>
  );
}
