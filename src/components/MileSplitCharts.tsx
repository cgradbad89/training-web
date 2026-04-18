"use client";

import React, { useMemo } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { type MileSplit } from "@/utils/mileSplits";
import { formatPace } from "@/utils/pace";

// ─── Pace Bar Chart ─────────────────────────────────────────────────────────

interface PaceChartDatum {
  label: string;
  pace: number;
}

function PaceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: PaceChartDatum }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">{d.label}</p>
      <p className="text-textSecondary">{formatPace(d.pace)} /mi</p>
    </div>
  );
}

function PaceBarChart({ splits }: { splits: MileSplit[] }) {
  const data = useMemo<PaceChartDatum[]>(() => {
    return splits
      .filter((s) => s.paceSecPerMile > 0 && s.paceSecPerMile <= 1800)
      .map((s) => ({
        label: s.isPartial
          ? `Mile ${s.mile} (${s.segmentMiles.toFixed(1)})`
          : `Mile ${s.mile}`,
        pace: s.paceSecPerMile,
      }));
  }, [splits]);

  if (data.length === 0) return null;

  const paces = data.map((d) => d.pace);
  const minPace = Math.min(...paces);
  const maxPace = Math.max(...paces);
  const domainMin = Math.max(0, Math.floor((minPace - 30) / 10) * 10);
  const domainMax = Math.ceil((maxPace + 30) / 10) * 10;

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-sm font-semibold text-textPrimary mb-3">
        Pace by Mile
      </h2>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tickFormatter={(v: number) => formatPace(v)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip content={<PaceTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
          <Bar dataKey="pace" radius={[6, 6, 0, 0]} fill="var(--color-chart-pace)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── HR Line Chart ──────────────────────────────────────────────────────────

interface HRChartDatum {
  label: string;
  bpm: number;
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
      <p className="font-medium text-textPrimary">{d.label}</p>
      <p className="text-textSecondary">{Math.round(d.bpm)} bpm</p>
    </div>
  );
}

function HRLineChart({ splits }: { splits: MileSplit[] }) {
  const data = useMemo<HRChartDatum[]>(() => {
    return splits
      .filter((s) => s.avgBpm != null && s.avgBpm >= 40 && s.avgBpm <= 220)
      .map((s) => ({
        label: s.isPartial
          ? `Mile ${s.mile} (${s.segmentMiles.toFixed(1)})`
          : `Mile ${s.mile}`,
        bpm: s.avgBpm!,
      }));
  }, [splits]);

  if (data.length < 2) {
    return (
      <div className="bg-card rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold text-textPrimary mb-2">
          Heart Rate by Mile
        </h2>
        <p className="text-sm text-textSecondary">
          Heart rate data not yet available for this run
        </p>
      </div>
    );
  }

  const bpms = data.map((d) => d.bpm);
  const domainMin = Math.floor(Math.min(...bpms) - 5);
  const domainMax = Math.ceil(Math.max(...bpms) + 5);

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-sm font-semibold text-textPrimary mb-3">
        Heart Rate by Mile
      </h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            tickFormatter={(v: number) => `${Math.round(v)}`}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={45}
          />
          <Tooltip content={<HRTooltip />} />
          <Line
            type="monotone"
            dataKey="bpm"
            stroke="var(--color-chart-hr)"
            strokeWidth={2}
            dot={{ r: 4, fill: 'var(--color-chart-hr)' }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Combined export ────────────────────────────────────────────────────────

interface MileSplitChartsProps {
  splits: MileSplit[];
  hasRoute: boolean;
}

export function MileSplitCharts({ splits, hasRoute }: MileSplitChartsProps) {
  if (!hasRoute || splits.length === 0) return null;

  const hasHRData = splits.some((s) => s.avgBpm != null && s.avgBpm >= 40 && s.avgBpm <= 220);

  return (
    <div className="space-y-4">
      <PaceBarChart splits={splits} />
      {hasHRData && <HRLineChart splits={splits} />}
    </div>
  );
}
