"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  onHealthMetricsSnapshot,
  onAllHealthMetricsSnapshot,
  fetchHourlyHeartRate,
  fetchHealthGoals,
  type HealthGoals,
  type HealthMetric,
  type HourlyHeartRate,
} from "@/services/healthMetrics";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  Heart,
  Moon,
  Footprints,
  Zap,
  Scale,
  Clock,
  SmilePlus,
  TrendingUp,
  RefreshCw,
  PersonStanding,
  Target,
  Check,
} from "lucide-react";
import { HealthGoalsModal } from "@/components/HealthGoalsModal";
import {
  evaluateMetricGoal,
  evaluateWeightGoal,
  evaluateBMIGoal,
  type GoalStatus,
} from "@/utils/goalEvaluation";

// ── Helpers ──────────────────────────────────────────────────────────────────

function avg(values: number[]): number | null {
  const valid = values.filter((v) => v > 0 && isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatHours(h: number | undefined): string {
  if (!h) return "—";
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

function getColor(metric: string): string {
  const colors: Record<string, string> = {
    weight:   "var(--color-chart-primary)",
    bmi:      "var(--color-chart-secondary)",
    hr:       "var(--color-chart-hr)",
    steps:    "var(--color-chart-success)",
    exercise: "var(--color-chart-orange)",
    calories: "var(--color-chart-warning)",
    stand:    "var(--color-chart-cyan)",
    sleep:    "var(--color-recovery)",
    brush:    "var(--color-chart-teal)",
  };
  return colors[metric] ?? "var(--color-chart-primary)";
}

/** Filter out bad weight readings below 155 lb */
function isValidWeight(w: number | undefined): w is number {
  return w !== undefined && w >= 155;
}

// ── Selectable KPIs ────────────────────────────────────────────────────────
//
// Section → list of KPI field names (HealthMetric keys). Drives both the
// "All / None" buttons per section and the conditional graph areas below
// each section's tile grid.

const BODY_KPIS     = ["weight_lbs", "bmi", "resting_hr"] as const;
const ACTIVITY_KPIS = ["steps", "exercise_mins", "move_calories", "stand_hours"] as const;
const RECOVERY_KPIS = [
  "sleep_total_hours",
  "sleep_awake_mins",
  "brush_count",
  "brush_avg_duration_mins",
] as const;

const DEFAULT_SELECTED: readonly string[] = [
  "weight_lbs",
  "resting_hr",
  "steps",
  "sleep_total_hours",
  "brush_count",
];

const KPI_SELECTION_STORAGE_KEY = "health_selected_kpis";

function loadInitialSelectedKpis(): Set<string> {
  if (typeof window === "undefined") return new Set(DEFAULT_SELECTED);
  try {
    const stored = window.localStorage.getItem(KPI_SELECTION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === "string"));
      }
    }
  } catch {
    // localStorage unavailable / quota / parse error → fall back to defaults
  }
  return new Set(DEFAULT_SELECTED);
}

// ── Goal-driven status colors ────────────────────────────────────────────────
//
// Hardcoded thresholds were removed in favor of the user-defined HealthGoals
// system. A KPI without a configured goal renders as "neutral" (no coloring).
// See src/utils/goalEvaluation.ts and src/components/HealthGoalsModal.tsx.

function statusColor(status: GoalStatus): string {
  switch (status) {
    case "success": return "var(--color-success)";
    case "warning": return "var(--color-warning)";
    case "danger":  return "var(--color-danger)";
    default:        return "";
  }
}

function statusBg(status: GoalStatus): string {
  switch (status) {
    case "success": return "color-mix(in srgb, var(--color-success) 8%, transparent)";
    case "warning": return "color-mix(in srgb, var(--color-warning) 8%, transparent)";
    case "danger":  return "color-mix(in srgb, var(--color-danger) 8%, transparent)";
    default:        return "";
  }
}

/** CSS var for the status color (used for chart fills). */
function statusChartColor(status: GoalStatus): string {
  switch (status) {
    case "success": return "var(--color-success)";
    case "warning": return "var(--color-warning)";
    case "danger":  return "var(--color-danger)";
    default:        return "var(--color-chart-primary)";
  }
}

// ── Sleep time-of-day helpers ────────────────────────────────────────────────
//
// Bedtime/wake-time averages use a true circular mean (sin/cos → atan2) so
// times clustering around midnight (e.g. 23:40, 00:10, 01:15) don't average
// to mid-afternoon. Inputs are ISO 8601 UTC strings written by the iOS app;
// JavaScript's Date constructor handles the UTC→local conversion, and we
// format for display with toLocaleTimeString.

/** Average a set of times-of-day using a circular mean. Returns null for empty input. */
function circularMeanTime(
  dates: Date[]
): { hours: number; minutes: number } | null {
  if (dates.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const d of dates) {
    const min = d.getHours() * 60 + d.getMinutes();
    const angle = (min / 1440) * 2 * Math.PI;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  const meanAngle = Math.atan2(sumSin, sumCos);
  const normalized = meanAngle < 0 ? meanAngle + 2 * Math.PI : meanAngle;
  const meanMin = (normalized / (2 * Math.PI)) * 1440;
  return {
    hours: Math.floor(meanMin / 60) % 24,
    minutes: Math.round(meanMin % 60) % 60,
  };
}

/** Format a {hours, minutes} as "H:MM AM/PM" in the user's locale. */
function formatTimeOfDay(hm: { hours: number; minutes: number } | null): string {
  if (!hm) return "—";
  const d = new Date();
  d.setHours(hm.hours, hm.minutes, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon,
  label,
  today,
  avg7,
  avg30,
  color,
  formatter,
  status = "neutral",
  goalText,
  selected = false,
  onToggle,
}: {
  icon: React.ComponentType<{
    className?: string;
    style?: React.CSSProperties;
  }>;
  label: string;
  today: number | undefined;
  avg7: number | null;
  avg30: number | null;
  color: string;
  formatter: (v: number | undefined) => string;
  status?: GoalStatus;
  /** Optional goal summary shown beneath the today value (e.g. "Goal: 170–176 lbs"). */
  goalText?: string;
  /** True when this KPI's chart is currently shown in its section's graph area. */
  selected?: boolean;
  /** Optional click handler to toggle chart visibility. When omitted, the
   * tile is non-interactive (back-compat for any callers not opting in). */
  onToggle?: () => void;
}) {
  const sc = statusColor(status);
  const sb = statusBg(status);
  const iconColor = status !== "neutral" ? sc : color;
  const iconBg =
    status !== "neutral" ? sb : `color-mix(in srgb, ${color} 10%, transparent)`;

  const interactive = !!onToggle;
  // Selected/unselected only changes presentation when the tile is interactive.
  // Status border colors (success/warning/danger) win over the selection ring
  // because they convey goal state — but we still add the ring on selection
  // for visual confirmation, layered on top.

  return (
    <div
      className={`relative bg-card rounded-2xl border border-border p-4 transition-colors ${
        interactive ? "cursor-pointer" : ""
      } ${selected ? "ring-2 ring-primary" : ""}`}
      style={{
        borderColor: status !== "neutral" ? sc : undefined,
        backgroundColor:
          selected && status === "neutral"
            ? "color-mix(in srgb, var(--color-primary) 5%, transparent)"
            : status !== "neutral"
              ? sb
              : undefined,
      }}
      onClick={interactive ? onToggle : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? selected : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      {selected && (
        <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary text-white text-[10px] flex items-center justify-center">
          <Check className="w-2.5 h-2.5" strokeWidth={3} />
        </div>
      )}
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: iconBg }}
        >
          <Icon className="w-4 h-4" style={{ color: iconColor }} />
        </div>
        <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
          {label}
        </p>
      </div>

      <p
        className="text-2xl font-bold mb-1"
        style={{ color: status !== "neutral" ? sc : undefined }}
      >
        {formatter(today)}
      </p>
      {goalText && (
        <p className="text-xs text-textSecondary mb-3">{goalText}</p>
      )}
      {!goalText && <div className="mb-3" />}

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-surface rounded-xl p-2 text-center">
          <p className="text-xs text-textSecondary mb-0.5">7-day avg</p>
          <p className="text-sm font-semibold text-textPrimary">
            {avg7 !== null ? formatter(avg7) : "—"}
          </p>
        </div>
        <div className="bg-surface rounded-xl p-2 text-center">
          <p className="text-xs text-textSecondary mb-0.5">30-day avg</p>
          <p className="text-sm font-semibold text-textPrimary">
            {avg30 !== null ? formatter(avg30) : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Trend Chart ───────────────────────────────────────────────────────────────

function TrendChart({
  data,
  label,
  color,
  formatter,
  refValue,
  refLabel,
  type = "line",
  yDomain,
  yTickFormatter,
}: {
  data: { date: string; value: number | undefined }[];
  label: string;
  color: string;
  formatter?: (v: number) => string;
  refValue?: number;
  refLabel?: string;
  type?: "line" | "bar";
  yDomain?: [number, number];
  yTickFormatter?: (v: number) => string;
}) {
  const filtered = data.filter(
    (d) => d.value !== undefined && d.value > 0
  );
  if (filtered.length < 2) {
    return (
      <div className="h-28 flex items-center justify-center">
        <p className="text-xs text-textSecondary">Not enough data</p>
      </div>
    );
  }

  const fmt = formatter ?? ((v: number) => String(v));
  const yFmt = yTickFormatter ?? fmt;
  const chartMargin = { top: 4, right: 8, bottom: 0, left: 8 };

  if (type === "bar") {
    return (
      <ResponsiveContainer width="100%" height={112}>
        <BarChart data={filtered} margin={chartMargin}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
            tickFormatter={formatDate}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
            tickFormatter={yFmt}
            axisLine={false}
            tickLine={false}
            width={52}
            domain={yDomain}
          />
          <Tooltip
            formatter={(v) => [fmt(Number(v)), label]}
            labelFormatter={(v) => formatDate(String(v))}
            contentStyle={{
              fontSize: 11,
              borderRadius: 8,
              backgroundColor: 'var(--color-chart-tooltip-bg)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-textPrimary)',
            }}
            labelStyle={{ color: 'var(--color-textSecondary)' }}
            itemStyle={{ color: 'var(--color-textPrimary)' }}
          />
          {refValue && (
            <ReferenceLine
              y={refValue}
              stroke={color}
              strokeDasharray="4 2"
              strokeOpacity={0.5}
              label={{ value: refLabel, fontSize: 9, fill: color }}
            />
          )}
          <Bar
            dataKey="value"
            fill={color}
            radius={[3, 3, 0, 0]}
            fillOpacity={0.85}
          />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={112}>
      <LineChart data={filtered} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
          tickFormatter={formatDate}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
          tickFormatter={fmt}
          axisLine={false}
          tickLine={false}
          width={52}
          domain={yDomain}
        />
        <Tooltip
          formatter={(v) => [fmt(Number(v)), label]}
          labelFormatter={(v) => formatDate(String(v))}
          contentStyle={{
            fontSize: 11,
            borderRadius: 8,
            backgroundColor: 'var(--color-chart-tooltip-bg)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-textPrimary)',
          }}
          labelStyle={{ color: 'var(--color-textSecondary)' }}
          itemStyle={{ color: 'var(--color-textPrimary)' }}
        />
        {refValue && (
          <ReferenceLine
            y={refValue}
            stroke={color}
            strokeDasharray="4 2"
            strokeOpacity={0.5}
            label={{ value: refLabel, fontSize: 9, fill: color }}
          />
        )}
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-textSecondary uppercase tracking-widest">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </div>
  );
}

/** Card chrome around a chart in the graph area below a section's tiles. */
function ChartCard({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
          {title}
        </p>
        {actions}
      </div>
      {children}
    </div>
  );
}

// ── Time Range Filter ────────────────────────────────────────────────────────

export type TimeRange = "30d" | "60d" | "90d" | "ytd" | "all";

const TIME_RANGE_OPTIONS: readonly TimeRange[] = [
  "30d",
  "60d",
  "90d",
  "ytd",
  "all",
];

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "30d": "30D",
  "60d": "60D",
  "90d": "90D",
  ytd: "YTD",
  all: "All",
};

const TIME_RANGE_STORAGE_KEY = "health_time_range";

function isTimeRange(v: unknown): v is TimeRange {
  return (
    v === "30d" || v === "60d" || v === "90d" || v === "ytd" || v === "all"
  );
}

function loadInitialGlobalRange(): TimeRange {
  if (typeof window === "undefined") return "30d";
  try {
    const stored = window.localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    if (isTimeRange(stored)) return stored;
  } catch {
    // localStorage unavailable / quota / parse — silent
  }
  return "30d";
}

/** Segmented pill-group for picking a time range. Two sizes: default (header) and "sm" (per-chart). */
function TimeRangeSelector({
  value,
  onChange,
  size = "default",
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
  size?: "default" | "sm";
}) {
  const compact = size === "sm";
  const base = compact
    ? "text-[10px] px-2 h-6 rounded-md"
    : "text-xs px-3 h-7 rounded-lg";
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {TIME_RANGE_OPTIONS.map((r) => {
        const active = r === value;
        return (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            aria-pressed={active}
            className={`${base} font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {TIME_RANGE_LABELS[r]}
          </button>
        );
      })}
    </div>
  );
}

/** "YYYY-MM-DD" for today (local). */
function localTodayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Filter healthMetrics docs to the chosen range. Docs are returned ASC by `date`. */
function filterMetricsByRange(
  metrics: HealthMetric[],
  range: TimeRange
): HealthMetric[] {
  const sorted = [...metrics].sort((a, b) => a.date.localeCompare(b.date));
  if (range === "all") return sorted;
  if (range === "ytd") {
    const now = new Date();
    const jan1 = `${now.getFullYear()}-01-01`;
    return sorted.filter((m) => m.date >= jan1);
  }
  const days = range === "30d" ? 30 : range === "60d" ? 60 : 90;
  const now = new Date();
  now.setDate(now.getDate() - days);
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const dy = String(now.getDate()).padStart(2, "0");
  const cutoff = `${y}-${mo}-${dy}`;
  return sorted.filter((m) => m.date >= cutoff);
}

/** Pick the right source array for a given range — avoids pulling large data unnecessarily. */
function sourceForRange(
  range: TimeRange,
  metrics90: HealthMetric[],
  allMetrics: HealthMetric[]
): HealthMetric[] {
  if (range === "ytd" || range === "all") return allMetrics;
  return metrics90;
}

/**
 * Tight [min, max] Y-axis domain with 10% padding around the observed
 * range. Returns undefined for sparse data (<2 points) so Recharts can
 * auto-handle it gracefully.
 */
function tightDomain(
  values: (number | null | undefined)[],
  padding = 0.1
): [number, number] | undefined {
  const valid = values.filter(
    (v): v is number => v != null && !Number.isNaN(v) && Number.isFinite(v)
  );
  if (valid.length < 2) return undefined;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  return [
    Math.floor(min - range * padding),
    Math.ceil(max + range * padding),
  ];
}

// Suppress unused-var warning for localTodayIsoDate — it's a reserved helper
// for future range calcs; tightDomain uses its own math.
void localTodayIsoDate;

// ── Sleep Analytics ──────────────────────────────────────────────────────────

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** 0=Mon … 6=Sun from a YYYY-MM-DD doc date (parsed as LOCAL midnight). */
function dayOfWeekFromIsoDate(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return (dt.getDay() + 6) % 7;
}

interface SleepAnalyticsProps {
  metrics: HealthMetric[];
  sleepGoal?: { goal: number; warningPct?: number; dangerPct?: number };
}

/**
 * Two-part sleep section rendered when the Sleep KPI is selected:
 *   A. Avg Sleep by Day of Week — Recharts bar chart, bars colored by
 *      sleep-goal status when a goal is set.
 *   B. Bedtime / Wake Time / Duration table — circular-mean averaged
 *      bedtimes and wake times per weekday.
 */
function SleepAnalytics({ metrics, sleepGoal }: SleepAnalyticsProps) {
  const perDay = useMemo(() => {
    // index 0..6 = Mon..Sun
    const hours: number[][] = Array.from({ length: 7 }, () => []);
    const bedStarts: Date[][] = Array.from({ length: 7 }, () => []);
    const wakeEnds: Date[][] = Array.from({ length: 7 }, () => []);

    for (const m of metrics) {
      const dow = dayOfWeekFromIsoDate(m.date);
      if (typeof m.sleep_total_hours === "number" && m.sleep_total_hours > 0) {
        hours[dow].push(m.sleep_total_hours);
      }
      if (m.sleep_start) {
        const d = new Date(m.sleep_start);
        if (!Number.isNaN(d.getTime())) bedStarts[dow].push(d);
      }
      if (m.sleep_end) {
        const d = new Date(m.sleep_end);
        if (!Number.isNaN(d.getTime())) wakeEnds[dow].push(d);
      }
    }

    return DOW_LABELS.map((day, dow) => {
      const hrs = hours[dow];
      const avgHours =
        hrs.length > 0 ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
      const avgBed = circularMeanTime(bedStarts[dow]);
      const avgWake = circularMeanTime(wakeEnds[dow]);
      return { day, dow, avgHours, avgBed, avgWake };
    });
  }, [metrics]);

  const hasAnyHours = perDay.some((d) => d.avgHours !== null);
  const hasAnyTimes = perDay.some((d) => d.avgBed !== null || d.avgWake !== null);

  function statusFor(avgHours: number | null): GoalStatus {
    if (avgHours == null || !sleepGoal) return "neutral";
    return evaluateMetricGoal(
      avgHours,
      sleepGoal.goal,
      "higher",
      sleepGoal.warningPct,
      sleepGoal.dangerPct
    );
  }

  return (
    <>
      <ChartCard title="Avg Sleep by Day of Week">
        {!hasAnyHours ? (
          <div className="h-[180px] flex items-center justify-center">
            <p className="text-xs text-textSecondary">Not enough sleep data yet</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart
              data={perDay.map((d) => ({ day: d.day, avg: d.avgHours ?? 0 }))}
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-chart-grid)"
              />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={
                  tightDomain(perDay.map((d) => d.avgHours)) ?? ["auto", "auto"]
                }
                tick={{ fontSize: 10, fill: "var(--color-chart-axis)" }}
                axisLine={false}
                tickLine={false}
                width={28}
                tickFormatter={(v: number) => `${v}h`}
              />
              <Tooltip
                formatter={(v, _name, { payload }) => {
                  const dayLabel =
                    payload && typeof payload === "object" && "day" in payload
                      ? (payload as { day: string }).day
                      : "";
                  return [`${Number(v).toFixed(1)} hrs avg on ${dayLabel}`, "Sleep"];
                }}
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 8,
                  backgroundColor: "var(--color-chart-tooltip-bg)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-textPrimary)",
                }}
                labelStyle={{ color: "var(--color-textSecondary)" }}
                itemStyle={{ color: "var(--color-textPrimary)" }}
              />
              <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                {perDay.map((d, i) => (
                  <Cell key={i} fill={statusChartColor(statusFor(d.avgHours))} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="Bedtime & Wake Time">
        {!hasAnyTimes ? (
          <div className="h-[180px] flex items-center justify-center">
            <p className="text-xs text-textSecondary">
              No bedtime / wake-time data yet
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
                  <th className="text-left py-2 pr-2">Day</th>
                  <th className="text-left py-2 px-2">Avg Bedtime</th>
                  <th className="text-left py-2 px-2">Avg Wake Time</th>
                  <th className="text-left py-2 pl-2">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {perDay.map((row) => {
                  const status = statusFor(row.avgHours);
                  const durationColor =
                    status === "neutral" ? "text-textPrimary" : statusColor(status);
                  return (
                    <tr key={row.day} className="border-t border-border">
                      <td className="py-2 pr-2 font-medium text-textPrimary">{row.day}</td>
                      <td className="py-2 px-2 text-textPrimary tabular-nums">
                        {formatTimeOfDay(row.avgBed)}
                      </td>
                      <td className="py-2 px-2 text-textPrimary tabular-nums">
                        {formatTimeOfDay(row.avgWake)}
                      </td>
                      <td className={`py-2 pl-2 tabular-nums font-semibold ${durationColor}`}>
                        {row.avgHours != null ? `${row.avgHours.toFixed(1)} hrs` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>
    </>
  );
}

/** Per-section "All / None" controls in the section header. */
function SectionActions({
  onSelectAll,
  onClear,
}: {
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex gap-3 text-xs text-textSecondary">
      <button
        type="button"
        onClick={onSelectAll}
        className="hover:text-primary transition-colors"
      >
        All
      </button>
      <button
        type="button"
        onClick={onClear}
        className="hover:text-danger transition-colors"
      >
        None
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const { user } = useAuth();
  const userId = user?.uid ?? "";

  const [metrics90, setMetrics90] = useState<HealthMetric[]>([]);
  const [allMetrics, setAllMetrics] = useState<HealthMetric[]>([]);
  const [hourlyHR, setHourlyHR] = useState<HourlyHeartRate | null>(null);
  const [hourlyHRLoading, setHourlyHRLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [goals, setGoals] = useState<HealthGoals | null>(null);
  const [goalsModalOpen, setGoalsModalOpen] = useState(false);

  // One-time fetch for user-defined health goals.
  useEffect(() => {
    if (!userId) return;
    fetchHealthGoals(userId)
      .then(setGoals)
      .catch((err) => console.error("Health goals fetch error:", err));
  }, [userId]);

  // ── KPI graph selection (persisted in localStorage) ────────────────────
  const [selectedKpis, setSelectedKpis] = useState<Set<string>>(
    () => loadInitialSelectedKpis()
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        KPI_SELECTION_STORAGE_KEY,
        JSON.stringify([...selectedKpis])
      );
    } catch {
      // localStorage unavailable / quota — silent
    }
  }, [selectedKpis]);

  const toggleKpi = useCallback((field: string) => {
    setSelectedKpis((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }, []);

  const selectAllInSection = useCallback((fields: readonly string[]) => {
    setSelectedKpis((prev) => {
      const next = new Set(prev);
      for (const f of fields) next.add(f);
      return next;
    });
  }, []);

  const clearSection = useCallback((fields: readonly string[]) => {
    setSelectedKpis((prev) => {
      const next = new Set(prev);
      for (const f of fields) next.delete(f);
      return next;
    });
  }, []);

  const sectionAnyActive = (fields: readonly string[]) =>
    fields.some((f) => selectedKpis.has(f));

  // ── Time range filter (global + per-chart overrides) ──────────────────
  // Global range persisted in localStorage. Per-chart overrides live in a
  // Map keyed by chart id; when the global range changes we clear overrides
  // so every chart snaps back to the new global (spec: "sync all chart
  // ranges to global on globalRange change").
  const [globalRange, setGlobalRange] = useState<TimeRange>(
    () => loadInitialGlobalRange()
  );
  const [chartRanges, setChartRanges] = useState<Record<string, TimeRange>>({});

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TIME_RANGE_STORAGE_KEY, globalRange);
    } catch {
      // silent
    }
    // Reset per-chart overrides so all charts follow the new global range.
    setChartRanges({});
  }, [globalRange]);

  const rangeFor = useCallback(
    (key: string): TimeRange => chartRanges[key] ?? globalRange,
    [chartRanges, globalRange]
  );

  const setChartRange = useCallback((key: string, range: TimeRange) => {
    setChartRanges((prev) => ({ ...prev, [key]: range }));
  }, []);

  // Real-time listener for last-90-days health metrics
  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    const unsub = onHealthMetricsSnapshot(
      userId,
      90,
      (m90) => {
        setMetrics90(m90);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [userId]);

  // Real-time listener for all-time health metrics (for trend charts)
  useEffect(() => {
    if (!userId) return;
    const unsub = onAllHealthMetricsSnapshot(
      userId,
      (all) => setAllMetrics(all),
      (err) => console.error("All-time health metrics error:", err)
    );
    return () => unsub();
  }, [userId]);

  // One-time fetch for hourly heart rate averages
  useEffect(() => {
    if (!userId) return;
    setHourlyHRLoading(true);
    fetchHourlyHeartRate(userId)
      .then((data) => setHourlyHR(data))
      .catch((err) => console.error("Hourly HR fetch error:", err))
      .finally(() => setHourlyHRLoading(false));
  }, [userId]);

  // Most recent day with any data
  const today = metrics90[0];
  const last7 = metrics90.slice(0, 7);
  const last30 = metrics90.slice(0, 30);

  // Averages (weight uses isValidWeight filter)
  const a7 = (key: keyof HealthMetric) =>
    avg(last7.map((m) => m[key] as number).filter(Boolean));
  const a30 = (key: keyof HealthMetric) =>
    avg(last30.map((m) => m[key] as number).filter(Boolean));

  const a7Weight = avg(
    last7.map((m) => m.weight_lbs).filter(isValidWeight)
  );
  const a30Weight = avg(
    last30.map((m) => m.weight_lbs).filter(isValidWeight)
  );

  // Chart data — last 90 days ascending
  const chartData = useMemo(() => [...metrics90].reverse(), [metrics90]);

  function toChartSeries(key: keyof HealthMetric) {
    return chartData.map((m) => ({
      date: m.date,
      value: m[key] as number | undefined,
    }));
  }

  // Per-chart data slice: given the effective range + an accessor, build
  // the Recharts {date, value}[] series + tight Y-axis domain.
  const buildSlice = useCallback(
    (
      key: string,
      accessor: (m: HealthMetric) => number | undefined
    ): {
      data: { date: string; value: number | undefined }[];
      domain: [number, number] | undefined;
      range: TimeRange;
    } => {
      const range = rangeFor(key);
      const src = sourceForRange(range, metrics90, allMetrics);
      const filtered = filterMetricsByRange(src, range);
      const data = filtered.map((m) => ({ date: m.date, value: accessor(m) }));
      const domain = tightDomain(data.map((d) => d.value));
      return { data, domain, range };
    },
    [rangeFor, metrics90, allMetrics]
  );

  // Chart slices — one per selectable KPI. Sleep analytics uses the sleep
  // slice's range too so bedtime/wake analysis follows the same filter.
  const weightSlice     = buildSlice("weight_lbs", (m) => isValidWeight(m.weight_lbs) ? m.weight_lbs : undefined);
  const bmiSlice        = buildSlice("bmi", (m) => m.bmi);
  const hrSlice         = buildSlice("resting_hr", (m) => m.resting_hr);
  const stepsSlice      = buildSlice("steps", (m) => m.steps);
  const exerciseSlice   = buildSlice("exercise_mins", (m) => m.exercise_mins);
  const moveCalSlice    = buildSlice("move_calories", (m) => m.move_calories);
  const standSlice      = buildSlice("stand_hours", (m) => m.stand_hours);
  const sleepSlice      = buildSlice("sleep_total_hours", (m) => m.sleep_total_hours);
  const awakeSlice      = buildSlice("sleep_awake_mins", (m) => m.sleep_awake_mins);
  const brushSlice      = buildSlice("brush_count", (m) => m.brush_count);
  const avgBrushSlice   = buildSlice("brush_avg_duration_mins", (m) => m.brush_avg_duration_mins);

  // Sleep analytics operates on the same filtered data slice as the sleep
  // KPI so bedtime/wake averages respect the user's range selection.
  const sleepAnalyticsMetrics = useMemo(() => {
    const range = rangeFor("sleep_total_hours");
    return filterMetricsByRange(
      sourceForRange(range, metrics90, allMetrics),
      range
    );
  }, [rangeFor, metrics90, allMetrics]);

  // Hourly HR chart data
  const hourlyHRChartData = useMemo(() => {
    if (!hourlyHR) return [];
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: formatHour(hour),
      bpm: hourlyHR.hourlyAvgBpm[String(hour)] ?? null,
    })).filter((d): d is { hour: number; label: string; bpm: number } => d.bpm !== null);
  }, [hourlyHR]);

  const hourlyHRDomain = useMemo((): [number, number] | undefined => {
    const vals = hourlyHRChartData.map((d) => d.bpm);
    if (vals.length < 2) return undefined;
    return [Math.floor(Math.min(...vals) - 3), Math.ceil(Math.max(...vals) + 3)];
  }, [hourlyHRChartData]);

  const hourlyHRLastSync = useMemo(() => {
    if (!hourlyHR?.updatedAt) return null;
    const ts = hourlyHR.updatedAt.toDate();
    return ts.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [hourlyHR]);

  // Today's weight display — only show if valid
  const todayWeight = isValidWeight(today?.weight_lbs)
    ? today.weight_lbs
    : undefined;

  // ── Goal-driven status + display text per metric ───────────────────────
  function statusOrNeutral<T>(
    enabled: T | undefined,
    compute: (g: T) => GoalStatus
  ): GoalStatus {
    return enabled ? compute(enabled) : "neutral";
  }

  const weightStatus: GoalStatus = statusOrNeutral(goals?.weight, (g) =>
    todayWeight !== undefined
      ? evaluateWeightGoal(todayWeight, g.goal, g.tolerance, g.warningPct, g.dangerPct)
      : "neutral"
  );
  const weightGoalText = goals?.weight
    ? `Goal: ${(goals.weight.goal - goals.weight.tolerance).toFixed(1)}–${(goals.weight.goal + goals.weight.tolerance).toFixed(1)} lbs`
    : undefined;

  const bmiStatus: GoalStatus = statusOrNeutral(goals?.bmi, (g) =>
    today?.bmi !== undefined
      ? evaluateBMIGoal(today.bmi, g.min, g.max, g.warningPct, g.dangerPct)
      : "neutral"
  );
  const bmiGoalText = goals?.bmi
    ? `Goal: ${goals.bmi.min}–${goals.bmi.max}`
    : undefined;

  const hrStatus: GoalStatus = statusOrNeutral(goals?.restingHR, (g) =>
    today?.resting_hr !== undefined
      ? evaluateMetricGoal(today.resting_hr, g.goal, "lower", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const hrGoalText = goals?.restingHR
    ? `Goal: ≤${goals.restingHR.goal} bpm`
    : undefined;

  const stepsStatus: GoalStatus = statusOrNeutral(goals?.steps, (g) =>
    today?.steps !== undefined
      ? evaluateMetricGoal(today.steps, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const stepsGoalText = goals?.steps
    ? `Goal: ≥${Math.round(goals.steps.goal).toLocaleString()} steps`
    : undefined;

  const sleepStatus: GoalStatus = statusOrNeutral(goals?.sleep, (g) =>
    today?.sleep_total_hours !== undefined
      ? evaluateMetricGoal(today.sleep_total_hours, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const sleepGoalText = goals?.sleep
    ? `Goal: ≥${goals.sleep.goal} h`
    : undefined;

  const brushingStatus: GoalStatus = statusOrNeutral(goals?.brushing, (g) =>
    today?.brush_count !== undefined
      ? evaluateMetricGoal(today.brush_count, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const brushingGoalText = goals?.brushing
    ? `Goal: ≥${goals.brushing.goal}/day`
    : undefined;

  // ── Five remaining metrics (extended schema) ──────────────────────────
  const exerciseStatus: GoalStatus = statusOrNeutral(goals?.exerciseMins, (g) =>
    today?.exercise_mins !== undefined
      ? evaluateMetricGoal(today.exercise_mins, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const exerciseGoalText = goals?.exerciseMins
    ? `Goal: ≥${goals.exerciseMins.goal} mins`
    : undefined;

  const moveCalStatus: GoalStatus = statusOrNeutral(goals?.moveCalories, (g) =>
    today?.move_calories !== undefined
      ? evaluateMetricGoal(today.move_calories, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const moveCalGoalText = goals?.moveCalories
    ? `Goal: ≥${Math.round(goals.moveCalories.goal).toLocaleString()} kcal`
    : undefined;

  const standStatus: GoalStatus = statusOrNeutral(goals?.standHours, (g) =>
    today?.stand_hours !== undefined
      ? evaluateMetricGoal(today.stand_hours, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const standGoalText = goals?.standHours
    ? `Goal: ≥${goals.standHours.goal} hrs`
    : undefined;

  // Awake mins — lower is better
  const awakeStatus: GoalStatus = statusOrNeutral(goals?.awakeMins, (g) =>
    today?.sleep_awake_mins !== undefined
      ? evaluateMetricGoal(today.sleep_awake_mins, g.goal, "lower", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const awakeGoalText = goals?.awakeMins
    ? `Goal: ≤${goals.awakeMins.goal} mins`
    : undefined;

  const avgBrushStatus: GoalStatus = statusOrNeutral(goals?.avgBrushMins, (g) =>
    today?.brush_avg_duration_mins !== undefined
      ? evaluateMetricGoal(today.brush_avg_duration_mins, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const avgBrushGoalText = goals?.avgBrushMins
    ? `Goal: ≥${goals.avgBrushMins.goal} mins`
    : undefined;

  // Last synced
  const lastSynced = today?.syncedAt
    ? new Date(today.syncedAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <p className="text-danger text-sm">
          Error loading health data: {error}
        </p>
      </div>
    );
  }

  if (!today && metrics90.length === 0) {
    return (
      <div className="p-8 text-center">
        <Heart className="w-12 h-12 text-textSecondary mx-auto mb-3" />
        <h2 className="text-lg font-bold text-textPrimary mb-2">
          No health data yet
        </h2>
        <p className="text-sm text-textSecondary max-w-xs mx-auto">
          Open the iOS app and tap <strong>Sync Health Data</strong> in
          Settings to sync your HealthKit data here.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-textPrimary">Health</h1>
          {lastSynced && (
            <p className="text-xs text-textSecondary mt-0.5 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              Last synced {lastSynced}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {today && (
            <p className="text-sm text-textSecondary hidden sm:block">
              Data from {formatDate(today.date)}
            </p>
          )}
          <TimeRangeSelector value={globalRange} onChange={setGlobalRange} />
          <button
            type="button"
            onClick={() => setGoalsModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-sm text-textPrimary hover:bg-surface transition-colors"
          >
            <Target className="w-4 h-4 text-textSecondary" />
            Set Goals
          </button>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────── */}
      <Section
        title="Body"
        actions={
          <SectionActions
            onSelectAll={() => selectAllInSection(BODY_KPIS)}
            onClear={() => clearSection(BODY_KPIS)}
          />
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
          <KpiCard
            icon={Scale}
            label="Weight"
            color={getColor("weight")}
            today={todayWeight}
            avg7={a7Weight}
            avg30={a30Weight}
            formatter={(v) => (v ? `${v.toFixed(1)} lb` : "—")}
            status={weightStatus}
            goalText={weightGoalText}
            selected={selectedKpis.has("weight_lbs")}
            onToggle={() => toggleKpi("weight_lbs")}
          />
          <KpiCard
            icon={TrendingUp}
            label="BMI"
            color={getColor("bmi")}
            today={today?.bmi}
            avg7={a7("bmi")}
            avg30={a30("bmi")}
            formatter={(v) => (v ? v.toFixed(1) : "—")}
            status={bmiStatus}
            goalText={bmiGoalText}
            selected={selectedKpis.has("bmi")}
            onToggle={() => toggleKpi("bmi")}
          />
          <KpiCard
            icon={Heart}
            label="Resting HR"
            color={getColor("hr")}
            today={today?.resting_hr}
            avg7={a7("resting_hr")}
            avg30={a30("resting_hr")}
            formatter={(v) => (v ? `${Math.round(v)} bpm` : "—")}
            status={hrStatus}
            goalText={hrGoalText}
            selected={selectedKpis.has("resting_hr")}
            onToggle={() => toggleKpi("resting_hr")}
          />
        </div>

        {sectionAnyActive(BODY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("weight_lbs") && (
              <ChartCard
                title="Weight"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={weightSlice.range}
                    onChange={(r) => setChartRange("weight_lbs", r)}
                  />
                }
              >
                <TrendChart
                  data={weightSlice.data}
                  label="Weight"
                  color={getColor("weight")}
                  formatter={(v) => `${v.toFixed(1)} lb`}
                  yDomain={weightSlice.domain}
                  yTickFormatter={(v) => `${Math.round(v)} lb`}
                  refValue={goals?.weight?.goal}
                  refLabel={goals?.weight ? `Goal ${goals.weight.goal} lbs` : undefined}
                />
              </ChartCard>
            )}
            {selectedKpis.has("bmi") && (
              <ChartCard
                title="BMI"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={bmiSlice.range}
                    onChange={(r) => setChartRange("bmi", r)}
                  />
                }
              >
                <TrendChart
                  data={bmiSlice.data}
                  label="BMI"
                  color={getColor("bmi")}
                  formatter={(v) => v.toFixed(1)}
                  yDomain={bmiSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("resting_hr") && (
              <>
                <ChartCard
                  title="Resting HR"
                  actions={
                    <TimeRangeSelector
                      size="sm"
                      value={hrSlice.range}
                      onChange={(r) => setChartRange("resting_hr", r)}
                    />
                  }
                >
                  <TrendChart
                    data={hrSlice.data}
                    label="Resting HR"
                    color={getColor("hr")}
                    formatter={(v) => `${Math.round(v)} bpm`}
                    yDomain={hrSlice.domain}
                    yTickFormatter={(v) => `${Math.round(v)}`}
                  />
                </ChartCard>
                <div className="bg-card rounded-2xl border border-border p-4">
                  <div className="mb-3">
                    <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
                      Heart Rate by Time of Day
                    </p>
                    <p className="text-xs text-textSecondary mt-0.5">
                      30-day average HR
                      {hourlyHRLastSync ? ` · last sync ${hourlyHRLastSync}` : ""}
                    </p>
                  </div>
                  {hourlyHRLoading ? (
                    <div className="h-[220px] flex items-center justify-center">
                      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : hourlyHRChartData.length < 2 ? (
                    <div className="h-[220px] flex items-center justify-center">
                      <p className="text-xs text-textSecondary text-center max-w-xs">
                        Heart rate data by time of day will appear after your iOS app syncs
                      </p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={hourlyHRChartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 9, fill: "var(--color-chart-axis)" }}
                          interval={2}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fontSize: 9, fill: "var(--color-chart-axis)" }}
                          tickFormatter={(v: number) => `${Math.round(v)}`}
                          axisLine={false}
                          tickLine={false}
                          width={45}
                          domain={hourlyHRDomain}
                        />
                        <Tooltip
                          formatter={(v) => [`${Math.round(Number(v))} bpm`, "Heart Rate"]}
                          labelFormatter={(label) => `at ${String(label)}`}
                          contentStyle={{
                            fontSize: 11,
                            borderRadius: 8,
                            backgroundColor: "var(--color-chart-tooltip-bg)",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-textPrimary)",
                          }}
                          labelStyle={{ color: "var(--color-textSecondary)" }}
                          itemStyle={{ color: "var(--color-textPrimary)" }}
                        />
                        <Line
                          type="monotone"
                          dataKey="bpm"
                          stroke={getColor("hr")}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Section>

      {/* ── Activity ─────────────────────────────────────────────── */}
      <Section
        title="Activity"
        actions={
          <SectionActions
            onSelectAll={() => selectAllInSection(ACTIVITY_KPIS)}
            onClear={() => clearSection(ACTIVITY_KPIS)}
          />
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <KpiCard
            icon={Footprints}
            label="Steps"
            color={getColor("steps")}
            today={today?.steps}
            avg7={a7("steps")}
            avg30={a30("steps")}
            formatter={(v) => (v ? Math.round(v).toLocaleString() : "—")}
            status={stepsStatus}
            goalText={stepsGoalText}
            selected={selectedKpis.has("steps")}
            onToggle={() => toggleKpi("steps")}
          />
          <KpiCard
            icon={Clock}
            label="Exercise Mins"
            color={getColor("exercise")}
            today={today?.exercise_mins}
            avg7={a7("exercise_mins")}
            avg30={a30("exercise_mins")}
            formatter={(v) => (v !== undefined ? `${Math.round(v)} min` : "—")}
            status={exerciseStatus}
            goalText={exerciseGoalText}
            selected={selectedKpis.has("exercise_mins")}
            onToggle={() => toggleKpi("exercise_mins")}
          />
          <KpiCard
            icon={Zap}
            label="Move Calories"
            color={getColor("calories")}
            today={today?.move_calories}
            avg7={a7("move_calories")}
            avg30={a30("move_calories")}
            formatter={(v) => (v !== undefined ? `${Math.round(v)} kcal` : "—")}
            status={moveCalStatus}
            goalText={moveCalGoalText}
            selected={selectedKpis.has("move_calories")}
            onToggle={() => toggleKpi("move_calories")}
          />
          <KpiCard
            icon={PersonStanding}
            label="Stand Hours"
            color={getColor("stand")}
            today={today?.stand_hours}
            avg7={a7("stand_hours")}
            avg30={a30("stand_hours")}
            formatter={(v) => (v !== undefined ? `${Math.round(v)}h` : "—")}
            status={standStatus}
            goalText={standGoalText}
            selected={selectedKpis.has("stand_hours")}
            onToggle={() => toggleKpi("stand_hours")}
          />
        </div>

        {sectionAnyActive(ACTIVITY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("steps") && (
              <ChartCard
                title="Daily Steps"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={stepsSlice.range}
                    onChange={(r) => setChartRange("steps", r)}
                  />
                }
              >
                <TrendChart
                  data={stepsSlice.data}
                  label="Steps"
                  color={getColor("steps")}
                  formatter={(v) => Math.round(v).toLocaleString()}
                  refValue={goals?.steps?.goal}
                  refLabel={
                    goals?.steps
                      ? `Goal ${Math.round(goals.steps.goal).toLocaleString()}`
                      : undefined
                  }
                  type="bar"
                  yDomain={stepsSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("exercise_mins") && (
              <ChartCard
                title="Exercise Mins"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={exerciseSlice.range}
                    onChange={(r) => setChartRange("exercise_mins", r)}
                  />
                }
              >
                <TrendChart
                  data={exerciseSlice.data}
                  label="Exercise"
                  color={getColor("exercise")}
                  formatter={(v) => `${Math.round(v)} min`}
                  refValue={goals?.exerciseMins?.goal}
                  refLabel={
                    goals?.exerciseMins
                      ? `Goal ${goals.exerciseMins.goal} min`
                      : undefined
                  }
                  type="bar"
                  yDomain={exerciseSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("move_calories") && (
              <ChartCard
                title="Move Calories"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={moveCalSlice.range}
                    onChange={(r) => setChartRange("move_calories", r)}
                  />
                }
              >
                <TrendChart
                  data={moveCalSlice.data}
                  label="Move Calories"
                  color={getColor("calories")}
                  formatter={(v) => `${Math.round(v)} kcal`}
                  refValue={goals?.moveCalories?.goal}
                  refLabel={
                    goals?.moveCalories
                      ? `Goal ${Math.round(goals.moveCalories.goal)} kcal`
                      : undefined
                  }
                  type="bar"
                  yDomain={moveCalSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("stand_hours") && (
              <ChartCard
                title="Stand Hours"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={standSlice.range}
                    onChange={(r) => setChartRange("stand_hours", r)}
                  />
                }
              >
                <TrendChart
                  data={standSlice.data}
                  label="Stand Hours"
                  color={getColor("stand")}
                  formatter={(v) => `${Math.round(v)}h`}
                  refValue={goals?.standHours?.goal}
                  refLabel={
                    goals?.standHours
                      ? `Goal ${goals.standHours.goal}h`
                      : undefined
                  }
                  type="bar"
                  yDomain={standSlice.domain}
                />
              </ChartCard>
            )}
          </div>
        )}
      </Section>

      {/* ── Recovery (Sleep + Oral Care combined) ───────────────── */}
      <Section
        title="Recovery"
        actions={
          <SectionActions
            onSelectAll={() => selectAllInSection(RECOVERY_KPIS)}
            onClear={() => clearSection(RECOVERY_KPIS)}
          />
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <KpiCard
            icon={Moon}
            label="Total Sleep"
            color={getColor("sleep")}
            today={today?.sleep_total_hours}
            avg7={a7("sleep_total_hours")}
            avg30={a30("sleep_total_hours")}
            formatter={(v) => formatHours(v)}
            status={sleepStatus}
            goalText={sleepGoalText}
            selected={selectedKpis.has("sleep_total_hours")}
            onToggle={() => toggleKpi("sleep_total_hours")}
          />
          <KpiCard
            icon={Moon}
            label="Awake Time"
            color="#6b7280"
            today={today?.sleep_awake_mins}
            avg7={a7("sleep_awake_mins")}
            avg30={a30("sleep_awake_mins")}
            formatter={(v) => (v !== undefined ? `${Math.round(v)} min` : "—")}
            status={awakeStatus}
            goalText={awakeGoalText}
            selected={selectedKpis.has("sleep_awake_mins")}
            onToggle={() => toggleKpi("sleep_awake_mins")}
          />
          <KpiCard
            icon={SmilePlus}
            label="Brushing Sessions"
            color={getColor("brush")}
            today={today?.brush_count}
            avg7={a7("brush_count")}
            avg30={a30("brush_count")}
            // Use !== undefined so a real 0 value (no brushing yet today)
            // renders "0.0x" alongside its danger-colored tile rather than
            // showing "—" — which previously created a confusing colored-but-
            // dashless display when today's brush_count was 0.
            formatter={(v) => (v !== undefined ? `${v.toFixed(1)}x` : "—")}
            status={brushingStatus}
            goalText={brushingGoalText}
            selected={selectedKpis.has("brush_count")}
            onToggle={() => toggleKpi("brush_count")}
          />
          <KpiCard
            icon={Clock}
            label="Avg Brush Time"
            color={getColor("brush")}
            today={today?.brush_avg_duration_mins}
            avg7={a7("brush_avg_duration_mins")}
            avg30={a30("brush_avg_duration_mins")}
            formatter={(v) => (v !== undefined ? `${v.toFixed(1)} min` : "—")}
            status={avgBrushStatus}
            goalText={avgBrushGoalText}
            selected={selectedKpis.has("brush_avg_duration_mins")}
            onToggle={() => toggleKpi("brush_avg_duration_mins")}
          />
        </div>

        {sectionAnyActive(RECOVERY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("sleep_total_hours") && (
              <>
                <ChartCard
                  title="Sleep Duration"
                  actions={
                    <TimeRangeSelector
                      size="sm"
                      value={sleepSlice.range}
                      onChange={(r) => setChartRange("sleep_total_hours", r)}
                    />
                  }
                >
                  <TrendChart
                    data={sleepSlice.data}
                    label="Sleep"
                    color={getColor("sleep")}
                    formatter={(v) => formatHours(v)}
                    refValue={goals?.sleep?.goal}
                    refLabel={goals?.sleep ? `Goal ${goals.sleep.goal}h` : undefined}
                    yDomain={sleepSlice.domain}
                  />
                </ChartCard>
                <SleepAnalytics
                  metrics={sleepAnalyticsMetrics}
                  sleepGoal={goals?.sleep}
                />
              </>
            )}
            {selectedKpis.has("sleep_awake_mins") && (
              <ChartCard
                title="Awake Time"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={awakeSlice.range}
                    onChange={(r) => setChartRange("sleep_awake_mins", r)}
                  />
                }
              >
                <TrendChart
                  data={awakeSlice.data}
                  label="Awake"
                  color="#6b7280"
                  formatter={(v) => `${Math.round(v)} min`}
                  refValue={goals?.awakeMins?.goal}
                  refLabel={
                    goals?.awakeMins
                      ? `Goal ≤${goals.awakeMins.goal} min`
                      : undefined
                  }
                  yDomain={awakeSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("brush_count") && (
              <ChartCard
                title="Daily Brushing Sessions"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={brushSlice.range}
                    onChange={(r) => setChartRange("brush_count", r)}
                  />
                }
              >
                <TrendChart
                  data={brushSlice.data}
                  label="Sessions"
                  color={getColor("brush")}
                  formatter={(v) => `${v.toFixed(1)}x`}
                  refValue={goals?.brushing?.goal}
                  refLabel={goals?.brushing ? `Goal ${goals.brushing.goal}x` : undefined}
                  type="bar"
                  yDomain={brushSlice.domain}
                />
              </ChartCard>
            )}
            {selectedKpis.has("brush_avg_duration_mins") && (
              <ChartCard
                title="Avg Brush Duration"
                actions={
                  <TimeRangeSelector
                    size="sm"
                    value={avgBrushSlice.range}
                    onChange={(r) => setChartRange("brush_avg_duration_mins", r)}
                  />
                }
              >
                <TrendChart
                  data={avgBrushSlice.data}
                  label="Avg Brush"
                  color={getColor("brush")}
                  formatter={(v) => `${v.toFixed(1)} min`}
                  refValue={goals?.avgBrushMins?.goal}
                  refLabel={
                    goals?.avgBrushMins
                      ? `Goal ${goals.avgBrushMins.goal} min`
                      : undefined
                  }
                  yDomain={avgBrushSlice.domain}
                />
              </ChartCard>
            )}
          </div>
        )}
      </Section>

      {/* Health Goals modal — set/edit/clear all goals */}
      {userId && (
        <HealthGoalsModal
          isOpen={goalsModalOpen}
          uid={userId}
          initialGoals={goals}
          onClose={() => setGoalsModalOpen(false)}
          onSaved={(g) => setGoals(g)}
          onCleared={() => setGoals(null)}
        />
      )}

    </div>
  );
}
