"use client";

import React, { useMemo, useState } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { type RoutePoint } from "@/services/routes";
import { type GapPoint } from "@/utils/gradeAdjustedPace";
import { formatPace, mpsToSecPerMile } from "@/utils/pace";
import { computePaceAxisDomain, nullifyOutliers } from "@/utils/paceAxisDomain";
import { rollingAverage, SMOOTH_WINDOW_SEC } from "@/utils/smoothSeries";

const METERS_PER_MILE = 1609.344;
const EARTH_RADIUS_MI = 3958.8;
const METERS_TO_FEET = 3.28084;

/** Downsample threshold — routes denser than this are strided down for responsiveness. */
const MAX_CHART_POINTS = 200;

/**
 * GAP gets a wider smoothing window than pace: grade-adjustment amplifies
 * altitude/grade noise more than raw speed, so the pace window (35s) still
 * leaves GAP visibly oscillating. 60s damps it without erasing sustained hills.
 * Pace stays at SMOOTH_WINDOW_SEC (35s).
 */
const GAP_SMOOTH_WINDOW_SEC = 60;

/**
 * Elevation gets a LIGHT centered smoothing window so the altitude trace isn't
 * the only jagged line on the chart. 20s is lighter than pace (25s) / GAP (60s)
 * — enough to settle GPS vertical jitter without flattening real hills.
 * Display-only: the Total Ascent KPI reads the device `elevationGainM`, not this.
 */
const ELEV_SMOOTH_WINDOW_SEC = 20;

// Anomaly filters (consistent with existing charts)
const MAX_PACE = 1800; // sec/mi
const MIN_HR = 40;
const MAX_HR = 220;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

function haversineMi(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

interface OverlayDatum {
  distanceMiles: number;
  /** Seconds since the start of the run (for time-windowed smoothing) */
  timeSec: number;
  elevationFt: number;
  pace: number | null;
  gap: number | null;
  hr: number | null;
}

interface RunOverlayChartProps {
  points: RoutePoint[];
  perPointGap: GapPoint[];
}

function OverlayTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: OverlayDatum }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">
        {d.distanceMiles.toFixed(2)} mi
      </p>
      <p className="text-textSecondary">
        Elevation: {Math.round(d.elevationFt)} ft
      </p>
      {d.pace != null && (
        <p className="text-textSecondary">Pace: {formatPace(d.pace)} /mi</p>
      )}
      {d.gap != null && (
        <p className="text-textSecondary">GAP: {formatPace(d.gap)} /mi</p>
      )}
      {d.hr != null && (
        <p className="text-textSecondary">HR: {Math.round(d.hr)} bpm</p>
      )}
    </div>
  );
}

export function RunOverlayChart({ points, perPointGap }: RunOverlayChartProps) {
  // Series visibility toggles — both default OFF, so the chart opens showing
  // only Pace + Elevation (both always-on). In-memory ONLY: this resets to
  // both-off on every remount / page load and is never persisted (no Firestore,
  // localStorage, or settings). Declared before any early return so the hook
  // order is stable (React Rules of Hooks / error #310).
  const [showGap, setShowGap] = useState(false);
  const [showHr, setShowHr] = useState(false);

  // Build the chart series. ORDER MATTERS: the pace-axis domain, outlier-
  // nulling, and rollingAverage all run on the FULL-resolution (~1Hz) point
  // array, and ONLY THEN is the smoothed result stride-decimated for render.
  // Decimating first (the old order) spaced points ~duration/200s apart, which
  // collapsed the 25s pace / 60s GAP / 20s elevation windows to ~1 sample on
  // runs longer than ~42min — the moving average became a no-op and raw GPS
  // jitter rendered unchanged. Smoothing the dense array first, then sampling an
  // already-smooth curve, stays smooth at any run length and costs nothing extra
  // at render (still ≤ MAX_CHART_POINTS on screen). For short runs (≤ ~3min, no
  // decimation) this is identical to the old path.
  const { displayData, paceDomain, hasHR } = useMemo<{
    displayData: OverlayDatum[];
    paceDomain: [number, number];
    hasHR: boolean;
  }>(() => {
    if (points.length < 2) {
      return {
        displayData: [],
        paceDomain: computePaceAxisDomain([]),
        hasHR: false,
      };
    }

    // Cumulative distance for every point.
    const cumMiles: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const c = points[i];
      cumMiles.push(cumMiles[i - 1] + haversineMi(p.lat, p.lng, c.lat, c.lng));
    }

    const baseMs = new Date(points[0].timestamp).getTime();
    const full: OverlayDatum[] = points.map((p, i) => {
      const paceRaw = p.speed != null ? mpsToSecPerMile(p.speed) : 0;
      const pace = paceRaw > 0 && paceRaw <= MAX_PACE ? paceRaw : null;
      // perPointGap[i-1] is the segment ending at point i.
      const gapRaw = i > 0 ? perPointGap[i - 1]?.gradeAdjPaceSecPerMile : undefined;
      const gap = gapRaw != null && gapRaw > 0 && gapRaw <= MAX_PACE ? gapRaw : null;
      const hr =
        p.hr != null && p.hr >= MIN_HR && p.hr <= MAX_HR ? p.hr : null;
      const tMs = new Date(p.timestamp).getTime();
      return {
        distanceMiles: cumMiles[i],
        timeSec: Number.isFinite(tMs - baseMs) ? (tMs - baseMs) / 1000 : NaN,
        elevationFt: p.altitude * METERS_TO_FEET,
        pace,
        gap,
        hr,
      };
    });

    // Shared left-axis (reversed) domain for pace + GAP, from a robust
    // percentile range so glitch spikes don't crush the real band. Computed on
    // the FULL series so the p5–p95 band reflects the true per-point
    // distribution, not the decimated subset.
    const paceVals = full.flatMap((d) =>
      [d.pace, d.gap].filter((v): v is number => v != null)
    );
    const domain = computePaceAxisDomain(paceVals);

    // Outlier-null on the FULL series: pace/GAP values outside the domain become
    // null so Recharts draws a line BREAK (gap) instead of a clamped full-height
    // spike. Nulling BEFORE smoothing keeps glitch points out of the moving
    // average and stops smoothing from bridging the breaks (connectNulls=false).
    const paceSeries = nullifyOutliers(
      full.map((d) => d.pace),
      domain
    );
    const gapSeries = nullifyOutliers(
      full.map((d) => d.gap),
      domain
    );

    // Smooth pace, GAP, and elevation on the FULL (~1Hz) array using real
    // per-point timestamps, so each window actually spans ~25s / 60s / 20s of
    // samples. GAP uses a wider window than pace (grade-adjustment amplifies
    // noise); elevation a lighter one. HR and the underlying GAP (KPI /
    // per-mile) are untouched. Elevation is always finite (altitude defaults to
    // 0), so a valid series never gains a null — the `?? d.elevationFt` below is
    // defensive only.
    const timeSec = full.map((d) => d.timeSec);
    const smoothedPace = rollingAverage(paceSeries, SMOOTH_WINDOW_SEC, timeSec);
    const smoothedGap = rollingAverage(gapSeries, GAP_SMOOTH_WINDOW_SEC, timeSec);
    const smoothedElev = rollingAverage(
      full.map((d) => d.elevationFt),
      ELEV_SMOOTH_WINDOW_SEC,
      timeSec
    );

    const smoothedFull: OverlayDatum[] = full.map((d, i) => ({
      ...d,
      elevationFt: smoothedElev[i] ?? d.elevationFt,
      pace: smoothedPace[i],
      gap: smoothedGap[i],
    }));

    // Downsample the ALREADY-SMOOTHED series for chart responsiveness. Stride
    // math is unchanged — every stride-th point plus always the last, so the
    // line still reaches the end of the run — it just operates on the smoothed
    // array now instead of the raw one.
    let sampled = smoothedFull;
    if (smoothedFull.length > MAX_CHART_POINTS) {
      const stride = Math.ceil(smoothedFull.length / MAX_CHART_POINTS);
      sampled = smoothedFull.filter(
        (_, i) => i % stride === 0 || i === smoothedFull.length - 1
      );
    }

    const hrCount = sampled.filter((d) => d.hr != null).length;
    return { displayData: sampled, paceDomain: domain, hasHR: hrCount >= 2 };
  }, [points, perPointGap]);

  if (displayData.length < 2) return null;

  const [paceDomainMin, paceDomainMax] = paceDomain;

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h2 className="text-sm font-semibold text-textPrimary">
          Elevation, Pace &amp; HR
        </h2>
        <div className="flex items-center gap-2">
          {!hasHR && (
            <span className="text-xs text-textSecondary">
              Per-point HR not available for this run
            </span>
          )}
          <SeriesToggle
            label="GAP"
            color="var(--color-chart-warning)"
            active={showGap}
            onClick={() => setShowGap((v) => !v)}
          />
          <SeriesToggle
            label="HR"
            color="var(--color-chart-hr)"
            active={hasHR && showHr}
            disabled={!hasHR}
            onClick={() => setShowHr((v) => !v)}
          />
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={displayData}
          margin={{ left: 2, right: 8, top: 8, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
          <XAxis
            dataKey="distanceMiles"
            type="number"
            domain={[0, "dataMax"]}
            tickFormatter={(v: number) => v.toFixed(1)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          {/* Pace + GAP: left axis, reversed so faster = higher.
              Outliers are nulled (line break), so no allowDataOverflow needed. */}
          <YAxis
            yAxisId="pace"
            type="number"
            domain={[paceDomainMin, paceDomainMax]}
            reversed
            tickFormatter={(v: number) => (Number.isFinite(v) ? formatPace(v) : "")}
            tick={{ fontSize: 11, fill: "var(--color-chart-axis)" }}
            tickMargin={6}
            tickLine={false}
            axisLine={false}
            // Axis is HIDDEN (width=0): the tooltip surfaces pace on tap/hover,
            // so the left-side tick labels add no at-a-glance value and were
            // eating ~21% of the ~268px mobile container. hide + width=0 reclaim
            // that band so the plot fills nearly to the card padding. The axis
            // still EXISTS (yAxisId="pace") for the pace/GAP <Line> data mapping
            // and `reversed` (faster = higher); only its rendering is suppressed.
            hide
            width={0}
          />
          {/* Elevation: right axis, feet */}
          <YAxis
            yAxisId="elev"
            orientation="right"
            tickFormatter={(v: number) => `${Math.round(v)}`}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
            unit=" ft"
          />
          {/* HR: hidden secondary axis */}
          <YAxis
            yAxisId="hr"
            domain={[MIN_HR, MAX_HR]}
            hide
          />
          <Tooltip content={<OverlayTooltip />} />
          <Area
            yAxisId="elev"
            type="monotone"
            dataKey="elevationFt"
            stroke="var(--color-chart-teal)"
            strokeWidth={1}
            fill="var(--color-chart-teal)"
            fillOpacity={0.12}
            isAnimationActive={false}
          />
          <Line
            yAxisId="pace"
            type="monotone"
            dataKey="pace"
            stroke="var(--color-chart-pace)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          {showGap && (
            <Line
              yAxisId="pace"
              type="monotone"
              dataKey="gap"
              stroke="var(--color-chart-warning)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
          {hasHR && showHr && (
            <Line
              yAxisId="hr"
              type="monotone"
              dataKey="hr"
              stroke="var(--color-chart-hr)"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-4 mt-3 text-xs text-textSecondary">
        <LegendDot color="var(--color-chart-pace)" label="Pace" />
        {showGap && (
          <LegendDot color="var(--color-chart-warning)" label="GAP" dashed />
        )}
        {hasHR && showHr && (
          <LegendDot color="var(--color-chart-hr)" label="HR" />
        )}
        <LegendDot color="var(--color-chart-teal)" label="Elevation (ft)" />
      </div>
    </div>
  );
}

function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block w-4 h-0.5 rounded"
        style={{
          backgroundColor: dashed ? "transparent" : color,
          borderTop: dashed ? `2px dashed ${color}` : undefined,
        }}
      />
      {label}
    </span>
  );
}

/**
 * Small pill toggle for an optional chart series (GAP / HR). ON reflects the
 * series' chart color token (text + border + a faint tint so it stays legible
 * in both light and dark mode); OFF is muted. `disabled` renders a muted,
 * non-interactive pill — used for HR when the run has no per-point HR data.
 */
function SeriesToggle({
  label,
  color,
  active,
  disabled,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
        disabled
          ? "border-border text-textSecondary opacity-50 cursor-not-allowed"
          : active
            ? ""
            : "border-border text-textSecondary hover:text-textPrimary"
      }`}
      style={
        active && !disabled
          ? {
              color,
              borderColor: color,
              backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
            }
          : undefined
      }
    >
      {label}
    </button>
  );
}
