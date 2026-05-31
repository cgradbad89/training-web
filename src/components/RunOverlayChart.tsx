"use client";

import React, { useMemo } from "react";
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

const METERS_PER_MILE = 1609.344;
const EARTH_RADIUS_MI = 3958.8;
const METERS_TO_FEET = 3.28084;

/** Downsample threshold — routes denser than this are strided down for responsiveness. */
const MAX_CHART_POINTS = 300;

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
  const { data, hasHR } = useMemo<{
    data: OverlayDatum[];
    hasHR: boolean;
  }>(() => {
    if (points.length < 2) return { data: [], hasHR: false };

    // Cumulative distance for every point.
    const cumMiles: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const c = points[i];
      cumMiles.push(cumMiles[i - 1] + haversineMi(p.lat, p.lng, c.lat, c.lng));
    }

    const full: OverlayDatum[] = points.map((p, i) => {
      const paceRaw = p.speed != null ? mpsToSecPerMile(p.speed) : 0;
      const pace = paceRaw > 0 && paceRaw <= MAX_PACE ? paceRaw : null;
      // perPointGap[i-1] is the segment ending at point i.
      const gapRaw = i > 0 ? perPointGap[i - 1]?.gradeAdjPaceSecPerMile : undefined;
      const gap = gapRaw != null && gapRaw > 0 && gapRaw <= MAX_PACE ? gapRaw : null;
      const hr =
        p.hr != null && p.hr >= MIN_HR && p.hr <= MAX_HR ? p.hr : null;
      return {
        distanceMiles: cumMiles[i],
        elevationFt: p.altitude * METERS_TO_FEET,
        pace,
        gap,
        hr,
      };
    });

    // Downsample very dense routes for chart responsiveness.
    let sampled = full;
    if (full.length > MAX_CHART_POINTS) {
      const stride = Math.ceil(full.length / MAX_CHART_POINTS);
      sampled = full.filter((_, i) => i % stride === 0 || i === full.length - 1);
    }

    const hrCount = sampled.filter((d) => d.hr != null).length;
    return { data: sampled, hasHR: hrCount >= 2 };
  }, [points, perPointGap]);

  if (data.length < 2) return null;

  // Shared left-axis (reversed) domain for pace + GAP, from a robust
  // percentile range so glitch spikes don't crush the real band.
  const paceVals = data.flatMap((d) =>
    [d.pace, d.gap].filter((v): v is number => v != null)
  );
  const paceDomain = computePaceAxisDomain(paceVals);
  const [paceDomainMin, paceDomainMax] = paceDomain;

  // Display copy: pace/GAP values outside the domain become null so Recharts
  // draws a line BREAK (gap) instead of a clamped full-height spike. Source
  // pace/GAP arrays are untouched; elevation + HR series are unchanged.
  const paceSeries = nullifyOutliers(
    data.map((d) => d.pace),
    paceDomain
  );
  const gapSeries = nullifyOutliers(
    data.map((d) => d.gap),
    paceDomain
  );
  const displayData = data.map((d, i) => ({
    ...d,
    pace: paceSeries[i],
    gap: gapSeries[i],
  }));

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-textPrimary">
          Elevation, Pace &amp; HR
        </h2>
        {!hasHR && (
          <span className="text-xs text-textSecondary">
            Per-point HR not available for this run
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={displayData}
          margin={{ left: 12, right: 8, top: 8, bottom: 0 }}
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
            tickFormatter={(v: number) => formatPace(v)}
            tick={{ fontSize: 11, fill: "var(--color-chart-axis)" }}
            tickLine={false}
            axisLine={false}
            width={68}
            label={{
              value: "Pace /mi",
              angle: -90,
              position: "insideLeft",
              offset: 0,
              style: {
                fontSize: 11,
                fill: "var(--color-chart-axis)",
                textAnchor: "middle",
              },
            }}
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
          {hasHR && (
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
        <LegendDot color="var(--color-chart-warning)" label="GAP" dashed />
        {hasHR && <LegendDot color="var(--color-chart-hr)" label="HR" />}
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
