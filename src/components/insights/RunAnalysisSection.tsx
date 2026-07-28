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
} from "@/lib/runAnalysisTrend";
import { RunBucketTable } from "@/components/insights/RunBucketTable";
import { useIsDesktop } from "@/hooks/useMediaQuery";

// ── Metric selector (multi-select, capped at 2). "Run Analysis" merges the old
//    Pace by Distance + Efficiency Trend into one chart; selecting a SECOND
//    metric overlays it on its own right-hand y-axis. ──
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

/** At most two metrics may be overlaid — one per y-axis. A third axis has
 *  nowhere to go, and three unrelated scales on one plot stop being readable. */
const MAX_SELECTED_METRICS = 2;

/** Line/axis/pill color per selection slot. Index 0 = first-selected (primary,
 *  left axis), index 1 = second-selected (secondary, right axis). Both tokens
 *  are already defined for light AND dark in globals.css. */
const SERIES_COLORS = [
  "var(--color-chart-primary)",
  "var(--color-chart-secondary)",
] as const;

/**
 * One chart row: a bucket's label/date plus BOTH metrics' values for it.
 *
 * `runCount` is a single shared field, not one per metric — buildRunAnalysisTrend's
 * runCount is metric-agnostic (every distance+window-matched run, whether or not
 * the metric was computable), so two calls over the same window/distance filters
 * always report the same count for a given bucket.
 */
export interface RunAnalysisComparePoint {
  bucketLabel: string;
  bucketStartDate: string;
  primaryValue: number | null;
  /** null when only one metric is selected, or when the second metric has no
   *  qualifying run in this bucket. */
  secondaryValue: number | null;
  runCount: number;
}

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

/** Per-metric y-axis shape, so the SAME rules apply whether a metric lands on
 *  the left (primary) or the right (secondary) axis — the axis config follows
 *  the metric, never the slot. */
function axisConfigFor(metric: RunAnalysisMetric): {
  domain: [string | number, string | number];
  reversed: boolean;
  tickFormatter: ((v: number) => string) | undefined;
  width: number;
} {
  const isPace = metric === "pace";
  return {
    domain: isPace
      ? ["dataMin - 30", "dataMax + 30"]
      : metric === "efficiencyScore"
        ? [0, 100]
        : ["auto", "auto"],
    reversed: isPace,
    tickFormatter: isPace ? (v: number) => formatPaceLabel(v) : undefined,
    width: isPace ? 50 : 40,
  };
}

/** Average + first-to-last delta over the non-null values of ONE series.
 *  `count` gates the empty state. Delta is null below 2 points. */
function summarize(values: ReadonlyArray<number | null>): {
  avg: number | null;
  delta: number | null;
  count: number;
} {
  const nn = values.filter((v): v is number => v != null);
  if (nn.length === 0) return { avg: null, delta: null, count: 0 };
  return {
    avg: nn.reduce((sum, v) => sum + v, 0) / nn.length,
    delta: nn.length >= 2 ? nn[nn.length - 1] - nn[0] : null,
    count: nn.length,
  };
}

/** The subset of Recharts' dot render-prop payload this chart reads. */
interface DotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: RunAnalysisComparePoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: RunAnalysisComparePoint }>;
  metrics: ReadonlyArray<RunAnalysisMetric>;
}

function ChartTooltip({ active, payload, metrics }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  // Both lines share one data row, so either entry's payload carries every
  // metric's value — read [0] rather than iterating Recharts' series entries.
  const d = payload[0].payload;
  const values = [d.primaryValue, d.secondaryValue];
  // Nothing to say about a bucket where neither selected metric resolved.
  if (values.every((v) => v == null)) return null;
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
      {metrics.map((m, i) => {
        const v = values[i];
        if (v == null) return null;
        return (
          <p
            key={m}
            style={{
              // Single-metric keeps the plain primary-text headline it has
              // today; only a 2-metric tooltip needs color to disambiguate.
              color:
                metrics.length > 1
                  ? SERIES_COLORS[i]
                  : "var(--color-textPrimary)",
              fontWeight: 600,
            }}
          >
            {formatTooltipValue(m, v)}
          </p>
        );
      })}
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
  // Click ORDER is the slot assignment: [0] is primary (left axis), [1] is
  // secondary (right axis). Never empty, never longer than MAX_SELECTED_METRICS.
  const [selectedMetrics, setSelectedMetrics] = React.useState<
    RunAnalysisMetric[]
  >(["pace"]);
  const [window, setWindow] = React.useState<TrendWindow>("3m");
  const [minMiles, setMinMiles] = React.useState(3);
  const [maxMiles, setMaxMiles] = React.useState(5);
  // Clicked bucket (by its local YYYY-MM-DD period start) + table visibility.
  const [selectedBucketStartDate, setSelectedBucketStartDate] = React.useState<
    string | null
  >(null);
  const [showTable, setShowTable] = React.useState(false);

  // Recharts renders ticks as raw SVG <text>, so the breakpoint has to reach it
  // as a prop — a Tailwind responsive class cannot target them.
  const isDesktop = useIsDesktop();

  const isDual = selectedMetrics.length > 1;

  const points = useMemo<RunAnalysisComparePoint[]>(() => {
    // ONE `now` for every series: buildRunAnalysisTrend defaults it to
    // new Date(), and two independent defaults could straddle a period boundary
    // and hand back misaligned bucket sets. Passing it explicitly removes that.
    const now = new Date();
    const series = selectedMetrics.map((m) =>
      buildRunAnalysisTrend(
        workouts,
        m,
        minMiles,
        maxMiles,
        window,
        restingHr,
        maxHr,
        now
      )
    );
    const primary = series[0] ?? [];
    // Keyed by bucketStartDate rather than zipped by index: the bucketing is
    // metric-independent so the two arrays ARE aligned, but a map is correct by
    // construction instead of correct-by-assumption, at the same O(n).
    const secondaryByBucket =
      series.length > 1
        ? new Map(series[1].map((p) => [p.bucketStartDate, p.value]))
        : null;

    return primary.map((p) => ({
      bucketLabel: p.bucketLabel,
      bucketStartDate: p.bucketStartDate,
      primaryValue: p.value,
      secondaryValue: secondaryByBucket?.get(p.bucketStartDate) ?? null,
      runCount: p.runCount,
    }));
  }, [workouts, selectedMetrics, minMiles, maxMiles, window, restingHr, maxHr]);

  // A bucket selected under the OLD filters may not exist under the new ones, so
  // any filter change clears the selection and closes the table — stale rows must
  // never survive a filter change. Keyed on every filter input, so a future filter
  // control can't forget to reset. (On mount this writes the values they already
  // hold, so React bails out without an extra render.) selectedMetrics is compared
  // by REFERENCE, which is exactly right: toggleMetric returns the previous array
  // unchanged on a no-op, so a rejected click doesn't clear the selection.
  React.useEffect(() => {
    setSelectedBucketStartDate(null);
    setShowTable(false);
  }, [selectedMetrics, window, minMiles, maxMiles]);

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

  // One headline per selected metric, each summarizing its OWN series.
  const headlines = selectedMetrics.map((m, i) => {
    const values = points.map((p) =>
      i === 0 ? p.primaryValue : p.secondaryValue
    );
    const { avg, delta } = summarize(values);
    return {
      metric: m,
      color: SERIES_COLORS[i],
      text: avg != null ? `${formatAvg(m, avg)}${formatDelta(m, delta)}` : "",
    };
  });

  // Gated on the PRIMARY series only, so single-metric behavior is untouched and
  // adding a sparse second metric can never blank out a chart that was rendering.
  const isEmpty =
    summarize(points.map((p) => p.primaryValue)).count < MIN_POINTS_WITH_DATA;

  // The reversed-axis caption applies if pace is on EITHER axis.
  const hasPace = selectedMetrics.includes("pace");

  const primaryAxis = axisConfigFor(selectedMetrics[0]);
  const secondaryAxis = isDual ? axisConfigFor(selectedMetrics[1]) : null;

  // Absent (not `undefined`) when single-metric, so the chart keeps Recharts'
  // default single-axis wiring exactly as it did before this feature.
  const primaryAxisId = isDual ? { yAxisId: "primary" } : {};

  // ── Metric multi-select ──
  // Both rejection paths return `prev` UNCHANGED, so React bails out of the
  // re-render and the filter-reset effect above doesn't fire.
  function toggleMetric(m: RunAnalysisMetric) {
    setSelectedMetrics((prev) => {
      if (prev.includes(m)) {
        // Never deselect down to zero — the chart always plots something.
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== m);
      }
      // At the cap, a click on a third metric is a no-op: silently swapping out
      // someone's earlier pick would be a surprising way to lose a comparison.
      if (prev.length >= MAX_SELECTED_METRICS) return prev;
      return [...prev, m];
    });
  }

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
  //
  // Parameterized by value-key + color rather than forked per line: selection is
  // bucket-keyed and metric-agnostic, so BOTH lines' dots select the same bucket
  // and the click handler is identical. Whichever dot is on top receives the
  // click when the two overlap — either one writes the same bucketStartDate, so
  // no de-duplication is needed.
  function dotRenderer(
    valueKey: "primaryValue" | "secondaryValue",
    color: string
  ) {
    return function renderDot(props: DotRenderProps): React.ReactElement {
      const { cx, cy, payload, index } = props;
      const key = `${valueKey}-${payload?.bucketStartDate ?? index}`;
      if (
        payload == null ||
        payload[valueKey] == null ||
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
          fill={color}
          stroke={selected ? "var(--color-card)" : "none"}
          strokeWidth={selected ? 3 : 0}
          style={{ cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            setSelectedBucketStartDate(bucketStartDate);
          }}
        />
      );
    };
  }

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <h2 className="text-lg font-bold text-textPrimary">Run Analysis</h2>
      <p className="text-xs text-textSecondary mt-1 mb-4">
        Trend up to two metrics over time for runs whose total distance falls
        within the selected range
      </p>

      {/* Metric selector — multi-select, capped at 2. An active pill wears its
          own line's color, which is what makes a separate chart legend
          unnecessary. */}
      <div className="flex flex-wrap gap-2 mb-4">
        {METRIC_OPTIONS.map((opt) => {
          const slot = selectedMetrics.indexOf(opt.value);
          const active = slot >= 0;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => toggleMetric(opt.value)}
              // Inline style, not a Tailwind class: the color is a CSS custom
              // property chosen at runtime by selection slot.
              style={
                active ? { backgroundColor: SERIES_COLORS[slot] } : undefined
              }
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                active
                  ? "text-white"
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
          {/* Headline summary — one line per selected metric. With a single
              metric this collapses to exactly the previous single headline
              (no color dot, same text). */}
          <div className="mb-3 space-y-1">
            {headlines.map((h) => (
              <p
                key={h.metric}
                className="text-sm font-semibold text-textPrimary tabular-nums flex items-center gap-2"
              >
                {isDual && (
                  <span
                    aria-hidden="true"
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: h.color }}
                  />
                )}
                {h.text}
              </p>
            ))}
          </div>

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
                {...primaryAxisId}
                domain={primaryAxis.domain}
                reversed={primaryAxis.reversed}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={primaryAxis.tickFormatter}
                width={primaryAxis.width}
              />
              {/* Second metric's own scale, right-hand side — same yAxisId +
                  orientation="right" pairing as RunOverlayChart. `reversed` is
                  per-axis, so pace-on-the-right still reads faster = higher
                  even when the left axis is a non-reversed metric.
                  Below md the tick labels would eat ~40px of a ~270px plot, so
                  they're dropped there and the axis width collapses with them —
                  the colored line plus its own headline stat still carry the
                  value. At width 0 Recharts stops PAINTING the axis group but
                  still resolves its scale, so the secondary line and its dots
                  plot identically (asserted in the dual-metric suite). */}
              {isDual && secondaryAxis && (
                <YAxis
                  yAxisId="secondary"
                  orientation="right"
                  domain={secondaryAxis.domain}
                  reversed={secondaryAxis.reversed}
                  tick={isDesktop ? { fontSize: 10 } : false}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={secondaryAxis.tickFormatter}
                  width={isDesktop ? secondaryAxis.width : 0}
                />
              )}
              <Tooltip content={<ChartTooltip metrics={selectedMetrics} />} />
              <Line
                {...primaryAxisId}
                type="monotone"
                dataKey="primaryValue"
                stroke={SERIES_COLORS[0]}
                strokeWidth={2}
                dot={dotRenderer("primaryValue", SERIES_COLORS[0])}
                isAnimationActive={false}
                // Matches WeeklyLoadTile: the default hover dot would visually
                // compete with the custom selected-dot ring.
                activeDot={false}
                connectNulls={false}
                name={selectedMetrics[0]}
              />
              {isDual && (
                <Line
                  yAxisId="secondary"
                  type="monotone"
                  dataKey="secondaryValue"
                  stroke={SERIES_COLORS[1]}
                  strokeWidth={2}
                  dot={dotRenderer("secondaryValue", SERIES_COLORS[1])}
                  isAnimationActive={false}
                  activeDot={false}
                  connectNulls={false}
                  name={selectedMetrics[1]}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-textSecondary mt-3 text-center">
            {hasPace
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
