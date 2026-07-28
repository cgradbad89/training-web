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
import { TrendWindow } from "@/lib/paceRangeTrend";
import {
  buildRunAnalysisTrend,
  runsInBucket,
  type RunAnalysisWorkout,
  type RunAnalysisMetric,
  type RunAnalysisPoint,
} from "@/lib/runAnalysisTrend";
import { RunBucketTable } from "@/components/insights/RunBucketTable";

// ── Metric selector (single-select). "Run Analysis" merges the old Pace by
//    Distance + Efficiency Trend into one chart. ──
const METRIC_OPTIONS: ReadonlyArray<{
  value: RunAnalysisMetric;
  label: string;
}> = [
  { value: "pace", label: "Pace" },
  { value: "cadence", label: "Cadence" },
  { value: "efficiencyScore", label: "Efficiency score" },
  { value: "load", label: "Load" },
  { value: "heartRate", label: "Heart rate" },
];

// Time-window pills — value + short label (identical to the retired Pace by
// Distance section so the control reads the same).
const WINDOW_OPTIONS: ReadonlyArray<{ value: TrendWindow; label: string }> = [
  { value: "1m", label: "1 mo" },
  { value: "2m", label: "2 mo" },
  { value: "3m", label: "3 mo" },
  { value: "6m", label: "6 mo" },
  { value: "12m", label: "12 mo" },
  { value: "ytd", label: "YTD" },
];

// Fixed distance-bucket presets (do not invent other boundaries). The default
// [3,5] range matches none of these, so no quick-filter is active on mount.
const DISTANCE_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  min: number;
  max: number;
}> = [
  { key: "short", label: "Short", min: 0, max: 5 },
  { key: "mid", label: "Mid", min: 5, max: 10 },
  { key: "long", label: "Long", min: 10, max: 15 },
];

const SLIDER_MIN = 0;
const SLIDER_MAX = 15;
const SLIDER_STEP = 0.5;

/** Below this many non-null points the trend isn't meaningful yet. */
const MIN_POINTS_WITH_DATA = 3;

// ── Per-metric display formatting ────────────────────────────────────────────

/** M:SS of a positive second magnitude (delta display; formatPaceLabel guards
 *  <=0, so magnitudes are formatted here directly). */
function formatSecondsMagnitude(absSeconds: number): string {
  const total = Math.round(absSeconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Signed integer, e.g. +4 / -3 / +0. */
function signedInt(n: number): string {
  const r = Math.round(n);
  return r >= 0 ? `+${r}` : `${r}`;
}

/** The headline "Avg …" clause for the current metric + average value. */
function formatAvg(metric: RunAnalysisMetric, avgValue: number): string {
  switch (metric) {
    case "pace":
      return `Avg pace ${formatPaceLabel(avgValue)}/mi`;
    case "cadence":
      return `Avg cadence ${Math.round(avgValue)} spm`;
    case "heartRate":
      return `Avg HR ${Math.round(avgValue)} bpm`;
    case "load":
      return `Avg load ${Math.round(avgValue)}`;
    case "efficiencyScore":
      return `Avg efficiency ${Math.round(avgValue)}`;
  }
}

/** The "· … vs start of range" delta clause, or "" when delta is null. */
function formatDelta(metric: RunAnalysisMetric, delta: number | null): string {
  if (delta == null) return "";
  let body: string;
  if (metric === "pace") {
    // Negative delta = faster (good). Round for the zero check.
    const secs = Math.round(delta);
    if (secs === 0) body = "no change";
    else if (secs < 0) body = `${formatSecondsMagnitude(-secs)} faster`;
    else body = `${formatSecondsMagnitude(secs)} slower`;
  } else if (metric === "cadence") {
    body = `${signedInt(delta)} spm`;
  } else if (metric === "heartRate") {
    body = `${signedInt(delta)} bpm`;
  } else if (metric === "efficiencyScore") {
    body = `${signedInt(delta)} pts`;
  } else {
    body = signedInt(delta); // load — plain integer, matching TrainingLoadBadge
  }
  return ` · ${body} vs start of range`;
}

/** Tooltip value line for a bucket. */
function formatTooltipValue(metric: RunAnalysisMetric, value: number): string {
  switch (metric) {
    case "pace":
      return `${formatPaceLabel(value)} /mi`;
    case "cadence":
      return `${Math.round(value)} spm`;
    case "heartRate":
      return `${Math.round(value)} bpm`;
    case "load":
      return `${Math.round(value)}`;
    case "efficiencyScore":
      return `${Math.round(value)}`;
  }
}

/** The subset of Recharts' dot render-prop payload this chart reads. */
interface DotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: RunAnalysisPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: RunAnalysisPoint }>;
  metric: RunAnalysisMetric;
}

function ChartTooltip({ active, payload, metric }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  if (d.value == null) return null;
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
      <p style={{ color: "var(--color-textSecondary)" }}>{d.bucketLabel}</p>
      <p style={{ color: "var(--color-textPrimary)", fontWeight: 600 }}>
        {formatTooltipValue(metric, d.value)}
      </p>
      <p style={{ color: "var(--color-textSecondary)" }}>
        {d.runCount} {d.runCount === 1 ? "run" : "runs"}
      </p>
    </div>
  );
}

interface RunAnalysisSectionProps {
  workouts: RunAnalysisWorkout[];
  restingHr: number;
  maxHr: number;
}

export function RunAnalysisSection({
  workouts,
  restingHr,
  maxHr,
}: RunAnalysisSectionProps): React.JSX.Element {
  // ── State (ALL hooks before any early return — React #310 guard) ──
  const [metric, setMetric] = React.useState<RunAnalysisMetric>("pace");
  const [window, setWindow] = React.useState<TrendWindow>("3m");
  const [minMiles, setMinMiles] = React.useState(3);
  const [maxMiles, setMaxMiles] = React.useState(5);
  // Clicked bucket (by its local YYYY-MM-DD period start) + table visibility.
  const [selectedBucketStartDate, setSelectedBucketStartDate] = React.useState<
    string | null
  >(null);
  const [showTable, setShowTable] = React.useState(false);

  const points = useMemo(
    () =>
      buildRunAnalysisTrend(
        workouts,
        metric,
        minMiles,
        maxMiles,
        window,
        restingHr,
        maxHr
      ),
    [workouts, metric, minMiles, maxMiles, window, restingHr, maxHr]
  );

  // Non-null values drive the headline + empty-state threshold.
  const nonNull = useMemo(
    () => points.filter((p) => p.value != null) as (RunAnalysisPoint & {
      value: number;
    })[],
    [points]
  );

  // A bucket selected under the OLD filters may not exist under the new ones, so
  // any filter change clears the selection and closes the table — stale rows must
  // never survive a filter change. Keyed on every filter input, so a future filter
  // control can't forget to reset. (On mount this writes the values they already
  // hold, so React bails out without an extra render.)
  React.useEffect(() => {
    setSelectedBucketStartDate(null);
    setShowTable(false);
  }, [metric, window, minMiles, maxMiles]);

  // Gated on showTable so the bucket isn't re-filtered on every render while the
  // table is hidden. Derives from selectedBucketStartDate, so clicking a DIFFERENT
  // dot while the table is open swaps the rows in place — no second button click.
  const bucketRuns = useMemo(() => {
    if (!showTable || selectedBucketStartDate == null) return [];
    return runsInBucket(
      workouts,
      selectedBucketStartDate,
      window,
      minMiles,
      maxMiles
    );
  }, [showTable, selectedBucketStartDate, workouts, window, minMiles, maxMiles]);

  const selectedLabel =
    points.find((p) => p.bucketStartDate === selectedBucketStartDate)
      ?.bucketLabel ?? "";

  const avgValue =
    nonNull.length > 0
      ? nonNull.reduce((sum, p) => sum + p.value, 0) / nonNull.length
      : null;

  // Chronological first vs last non-null value; null delta when < 2 points.
  const trendDelta =
    nonNull.length >= 2
      ? nonNull[nonNull.length - 1].value - nonNull[0].value
      : null;

  const isEmpty = nonNull.length < MIN_POINTS_WITH_DATA;
  const isPace = metric === "pace";

  const yDomain: [string | number, string | number] = isPace
    ? ["dataMin - 30", "dataMax + 30"]
    : metric === "efficiencyScore"
      ? [0, 100]
      : ["auto", "auto"];

  const headline =
    avgValue != null
      ? `${formatAvg(metric, avgValue)}${formatDelta(metric, trendDelta)}`
      : "";

  // ── Distance quick-filter helpers ──
  function isPresetActive(min: number, max: number): boolean {
    return minMiles === min && maxMiles === max;
  }
  function applyPreset(min: number, max: number) {
    setMinMiles(min);
    setMaxMiles(max);
  }
  function handleMin(v: number) {
    setMinMiles(Math.min(v, maxMiles - SLIDER_STEP));
  }
  function handleMax(v: number) {
    setMaxMiles(Math.max(v, minMiles + SLIDER_STEP));
  }

  const fillLeft = ((minMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;
  const fillRight = ((maxMiles - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100;

  // Custom dot: clickable, and visibly ringed when its bucket is selected. Null
  // buckets render an empty <g> — no dot and nothing to click, matching
  // connectNulls={false}'s gap. Recharts clones the returned element, so a null
  // return would warn; an empty group is the no-op.
  function renderDot(props: DotRenderProps): React.ReactElement {
    const { cx, cy, payload, index } = props;
    const key = payload?.bucketStartDate ?? `dot-${index}`;
    if (
      payload == null ||
      payload.value == null ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy)
    ) {
      return <g key={key} />;
    }
    const selected = payload.bucketStartDate === selectedBucketStartDate;
    const bucketStartDate = payload.bucketStartDate;
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={selected ? 7 : 3}
        fill="var(--color-chart-primary)"
        stroke={selected ? "var(--color-card)" : "none"}
        strokeWidth={selected ? 3 : 0}
        style={{ cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          setSelectedBucketStartDate(bucketStartDate);
        }}
      />
    );
  }

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-lg font-bold text-textPrimary">Run Analysis</h2>
      <p className="text-xs text-textSecondary mt-1 mb-4">
        Trend one metric over time for runs whose total distance falls within the
        selected range
      </p>

      {/* Metric selector */}
      <div className="flex flex-wrap gap-2 mb-4">
        {METRIC_OPTIONS.map((opt) => {
          const active = metric === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => setMetric(opt.value)}
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

      {/* Time-window selector */}
      <div className="flex flex-wrap gap-2 mb-4">
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

      {/* Distance quick-filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        {DISTANCE_PRESETS.map((preset) => {
          const active = isPresetActive(preset.min, preset.max);
          return (
            <button
              key={preset.key}
              type="button"
              aria-pressed={active}
              onClick={() => applyPreset(preset.min, preset.max)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                active
                  ? "bg-primary text-white"
                  : "bg-surface text-textSecondary hover:text-textPrimary"
              }`}
            >
              {preset.label} · {preset.min}–{preset.max} mi
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

      {isEmpty ? (
        <p className="text-sm text-textSecondary text-center py-8">
          Not enough runs in this range yet to show a trend.
        </p>
      ) : (
        <>
          {/* Headline summary */}
          <p className="text-sm font-semibold text-textPrimary mb-3 tabular-nums">
            {headline}
          </p>

          {/* Trend chart */}
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={points}
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="bucketLabel"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                reversed={isPace}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={
                  isPace ? (v: number) => formatPaceLabel(v) : undefined
                }
                width={isPace ? 50 : 40}
              />
              <Tooltip content={<ChartTooltip metric={metric} />} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-chart-primary)"
                strokeWidth={2}
                dot={renderDot}
                isAnimationActive={false}
                // Matches WeeklyLoadTile: the default hover dot would visually
                // compete with the custom selected-dot ring.
                activeDot={false}
                connectNulls={false}
                name={metric}
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-textSecondary mt-3 text-center">
            {isPace
              ? "Lower on chart = faster · gaps are weeks/months with no qualifying runs"
              : "Gaps are weeks/months with no qualifying runs"}
          </p>

          {/* Before anything is selected the dots have no visible affordance, so
              a hint carries discoverability (same copy pattern/styling as
              WeeklyLoadTile's "Tap a point to view that week"). Once a bucket IS
              selected the hint has done its job and the toggle takes the slot —
              a ternary so the two can never render together. */}
          {selectedBucketStartDate === null ? (
            <p className="text-[10px] text-textSecondary text-center mt-1">
              Tap a point to view those runs
            </p>
          ) : (
            <div className="flex justify-end mt-3">
              <button
                type="button"
                aria-expanded={showTable}
                onClick={() => setShowTable((v) => !v)}
                className="px-3 py-1 rounded-full text-xs font-medium bg-primary text-white transition-colors"
              >
                {showTable ? "Hide runs" : "Show runs"}
              </button>
            </div>
          )}

          {showTable && selectedBucketStartDate !== null && (
            <RunBucketTable
              runs={bucketRuns}
              allWorkouts={workouts}
              bucketLabel={selectedLabel}
              runCount={bucketRuns.length}
              restingHr={restingHr}
              maxHr={maxHr}
            />
          )}
        </>
      )}

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
