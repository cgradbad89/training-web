"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  onHealthMetricsSnapshot,
  fetchAllHealthMetrics,
  fetchHealthMetricsRange,
  fetchHourlyHeartRate,
  fetchHealthGoals,
  type HealthGoals,
  type HealthMetric,
  type HourlyHeartRate,
} from "@/services/healthMetrics";
import dynamic from "next/dynamic";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";
import { HealthSkeleton } from "./HealthSkeleton";
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
  ChevronLeft,
  ChevronRight,
  Settings,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { HealthGoalsModal } from "@/components/HealthGoalsModal";
import {
  ActivityRings,
  RING_COLORS,
  RING_LABELS,
  RING_UNITS,
  fmtRingNumber,
  type RingDatum,
} from "@/components/ActivityRings";
import { RingGoalEditorModal } from "@/components/health/RingGoalEditorModal";
import { RingCalendar } from "@/components/health/RingCalendar";
import { RingKpiCard } from "@/components/health/RingKpiCard";
import { fetchHealthGoals as fetchRingGoalVersions } from "@/services/healthGoals";
import {
  RING_METRICS,
  dailyRingProgress,
  eachDate,
  onPaceFraction,
  periodRingProgress,
  resolveGoalForDate,
  ringDailyAverage,
  type HealthGoalDoc,
  type RingMetric,
} from "@/lib/ringMath";
import { weekToDateWindow } from "@/utils/dates";
import {
  evaluateMetricGoal,
  evaluateWeightGoal,
  evaluateBMIGoal,
  type GoalStatus,
} from "@/utils/goalEvaluation";

// Recharts-backed charts are lazy-loaded (client-only) so this chart-heavy
// route ships less JS on initial load; a ChartSkeleton holds each chart's space
// while its chunk streams in. TrendChart is the page's own generic trend chart
// extracted verbatim (same props/behavior/colors); the sleep and hourly-HR
// charts are likewise extracted and lazy-imported.
const TrendChart = dynamic(
  () => import("./HealthTrendChart").then((m) => m.HealthTrendChart),
  { ssr: false, loading: () => <ChartSkeleton height={112} /> },
);
const SleepByDowChart = dynamic(
  () => import("./SleepByDowChart").then((m) => m.SleepByDowChart),
  { ssr: false, loading: () => <ChartSkeleton height={180} /> },
);
const HourlyHRChart = dynamic(
  () => import("./HourlyHRChart").then((m) => m.HourlyHRChart),
  { ssr: false, loading: () => <ChartSkeleton height={220} /> },
);

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

/** Local "YYYY-MM-DD" for today — matches the Firestore doc.date format. */
function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a local "YYYY-MM-DD" string to a local-midnight Date. */
function parseIsoDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift a "YYYY-MM-DD" string by N calendar days (local). */
function shiftISODate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return "th";
  const last = n % 10;
  if (last === 1) return "st";
  if (last === 2) return "nd";
  if (last === 3) return "rd";
  return "th";
}

/** Format "YYYY-MM-DD" → "May 18th" (no year). */
function formatDateOrdinal(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const day = d.getDate();
  return `${month} ${day}${ordinalSuffix(day)}`;
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
  subtitle,
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
  /** Optional small italic line beneath the today value (e.g. "as of May 15")
   *  used when the displayed value falls back to the most recent prior day. */
  subtitle?: string;
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
      {/* subtitle and goalText share the bottom-margin slot; keep mb-3 stable */}
      {(subtitle || goalText) ? (
        <div className="mb-3">
          {subtitle && (
            <p className="text-[11px] text-textSecondary italic">{subtitle}</p>
          )}
          {goalText && (
            <p className="text-xs text-textSecondary">{goalText}</p>
          )}
        </div>
      ) : (
        <div className="mb-3" />
      )}

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

// TrendChart moved to ./HealthTrendChart and lazy-imported above (as TrendChart).

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

export type TimeRange = "today" | "30d" | "60d" | "90d" | "ytd" | "all";

const TIME_RANGE_OPTIONS: readonly TimeRange[] = [
  "30d",
  "60d",
  "90d",
  "ytd",
  "all",
];

// Sleep Summary gets a "Today" option (single-day snapshot) the other trend
// charts don't — a one-day point is meaningful for the bedtime/wake tile but
// not for the trend lines.
const SLEEP_SUMMARY_RANGE_OPTIONS: readonly TimeRange[] = [
  "today",
  "30d",
  "60d",
  "90d",
  "ytd",
  "all",
];

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  today: "Today",
  "30d": "30D",
  "60d": "60D",
  "90d": "90D",
  ytd: "YTD",
  all: "All",
};

const TIME_RANGE_STORAGE_KEY = "health_time_range";

function isTimeRange(v: unknown): v is TimeRange {
  return (
    v === "today" ||
    v === "30d" ||
    v === "60d" ||
    v === "90d" ||
    v === "ytd" ||
    v === "all"
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
  options = TIME_RANGE_OPTIONS,
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
  size?: "default" | "sm";
  options?: readonly TimeRange[];
}) {
  const compact = size === "sm";
  const base = compact
    ? "text-[10px] px-2 h-6 rounded-md"
    : "text-xs px-3 h-7 rounded-lg";
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {options.map((r) => {
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

// ── Health page tabs + ring timeframe ───────────────────────────────────────

type HealthTab = "today" | "calendar" | "trends";

const HEALTH_TABS: { value: HealthTab; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "calendar", label: "Calendar" },
  { value: "trends", label: "Trends" },
];

type RingTimeframe = "today" | "7d" | "30d" | "ytd";

const RING_TIMEFRAME_OPTIONS: { value: RingTimeframe; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "This Week" },
  { value: "30d", label: "30D" },
  { value: "ytd", label: "YTD" },
];

/** Total period numbers vs. daily-average numbers (multi-day timeframes only). */
type RingValueMode = "total" | "avg";

const RING_VALUE_MODE_OPTIONS: { value: RingValueMode; label: string }[] = [
  { value: "total", label: "Total" },
  { value: "avg", label: "Daily Avg" },
];

/** All KPI fields that have a chart section on the Trends tab. */
const TREND_FIELDS: readonly string[] = [
  ...BODY_KPIS,
  ...ACTIVITY_KPIS,
  ...RECOVERY_KPIS,
];

/** Per-ring KPI card order on the Today tab (mockup: Move first). */
const RING_KPI_ORDER: readonly RingMetric[] = [
  "move_calories",
  "exercise_mins",
  "stand_hours",
  "steps",
  "sleep_total_hours",
];

/** Raw per-metric ring stats — one computation feeds the hero rings AND the
 * per-ring KPI cards so the two surfaces can never disagree. */
interface RingStat {
  metric: RingMetric;
  label: string;
  color: string;
  progress: number;
  actual: number;
  goalTotal: number;
  /** Daily-average value over the elapsed window (= actual on Today). */
  avgValue: number;
  /** Daily-average goal over the elapsed window (= goalTotal on Today). */
  avgGoal: number;
  /** Expected-progress tick position for period rings (undefined on Today). */
  onPaceFraction?: number;
}

/** Segmented pill-group for the Today / Calendar / Trends tabs. */
function HealthTabsBar({
  value,
  onChange,
}: {
  value: HealthTab;
  onChange: (t: HealthTab) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-xl p-1">
      {HEALTH_TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            aria-pressed={active}
            className={`text-sm px-4 h-8 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented pill-group for the ring timeframe (Today / 7D / 30D / YTD). */
function RingTimeframeSelector({
  value,
  onChange,
}: {
  value: RingTimeframe;
  onChange: (v: RingTimeframe) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {RING_TIMEFRAME_OPTIONS.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`text-xs px-3 h-7 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented pill-group for Total vs Daily Avg (shown only on multi-day timeframes). */
function RingValueModeSelector({
  value,
  onChange,
}: {
  value: RingValueMode;
  onChange: (v: RingValueMode) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
      {RING_VALUE_MODE_OPTIONS.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`text-xs px-3 h-7 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {o.label}
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
  if (range === "today") {
    const today = localTodayIsoDate();
    return sorted.filter((m) => m.date === today);
  }
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
  ytdMetrics: HealthMetric[]
): HealthMetric[] {
  if (range === "ytd" || range === "all") return ytdMetrics;
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

// ── Sleep Column Tooltip ──────────────────────────────────────────────────────

/** Inline ⓘ tooltip for sleep table column headers. Fixed-positioned to escape
 *  any overflow-hidden containers (same pattern as TrainingLoadBadge's tooltip). */
function SleepColumnTooltip({ title, body }: { title: string; body: string }) {
  const iconRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  function computePos() {
    if (!iconRef.current) return null
    const rect = iconRef.current.getBoundingClientRect()
    return { top: rect.top - 8, left: rect.left + rect.width / 2 }
  }

  return (
    <span className="inline-flex items-center">
      <button
        ref={iconRef}
        type="button"
        className="text-[10px] text-textSecondary cursor-help ml-0.5 outline-none leading-none select-none"
        tabIndex={-1}
        onMouseEnter={() => setPos(computePos())}
        onMouseLeave={() => setPos(null)}
        aria-label={title}
      >
        ⓘ
      </button>
      {pos && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 9999,
          }}
          className="w-44 bg-card border border-border rounded-lg p-3 shadow-lg pointer-events-none"
        >
          <p className="font-medium text-textPrimary mb-1 text-xs">{title}</p>
          <p className="text-textSecondary text-[11px]">{body}</p>
        </div>
      )}
    </span>
  )
}

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
  summaryMetrics: HealthMetric[];
  summaryRange: TimeRange;
  onSummaryRangeChange: (r: TimeRange) => void;
}

/**
 * Two-part sleep section rendered when the Sleep KPI is selected:
 *   A. Avg Sleep by Day of Week — Recharts bar chart, bars colored by
 *      sleep-goal status when a goal is set.
 *   B. Bedtime / Wake Time / Duration table — circular-mean averaged
 *      bedtimes and wake times per weekday.
 */
function SleepAnalytics({
  metrics,
  sleepGoal,
  summaryMetrics,
  summaryRange,
  onSummaryRangeChange,
}: SleepAnalyticsProps) {
  // ── Overall summary (circular-mean bedtime / wake, arithmetic mean duration) ──
  const summary = useMemo(() => {
    const daysWithData = summaryMetrics.filter(
      (m) => typeof m.sleep_total_hours === "number" && m.sleep_total_hours > 0
    );
    // "Today" is a single-day snapshot, so one night of data is enough; the
    // multi-day ranges still require ≥3 to average meaningfully.
    const minDays = summaryRange === "today" ? 1 : 3;
    if (daysWithData.length < minDays) return null;

    const avgDuration =
      daysWithData.reduce((s, m) => s + (m.sleep_total_hours as number), 0) /
      daysWithData.length;

    const bedDates = summaryMetrics
      .filter((m): m is HealthMetric & { sleep_start: string } =>
        typeof m.sleep_start === "string"
      )
      .map((m) => new Date(m.sleep_start))
      .filter((d) => !Number.isNaN(d.getTime()));

    const wakeDates = summaryMetrics
      .filter((m): m is HealthMetric & { sleep_end: string } =>
        typeof m.sleep_end === "string"
      )
      .map((m) => new Date(m.sleep_end))
      .filter((d) => !Number.isNaN(d.getTime()));

    return {
      avgDuration,
      avgBedtime: circularMeanTime(bedDates),
      avgWakeTime: circularMeanTime(wakeDates),
    };
  }, [summaryMetrics, summaryRange]);

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

  // On the single-day "Today" snapshot these are exact values, not averages.
  const isTodaySummary = summaryRange === "today";
  const bedtimeLabel = isTodaySummary ? "Bedtime" : "Avg Bedtime";
  const wakeLabel = isTodaySummary ? "Wake Time" : "Avg Wake Time";
  const durationLabel = isTodaySummary ? "Duration" : "Avg Duration";

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
      <ChartCard
        title="SLEEP SUMMARY"
        actions={
          <TimeRangeSelector
            size="sm"
            options={SLEEP_SUMMARY_RANGE_OPTIONS}
            value={summaryRange}
            onChange={onSummaryRangeChange}
          />
        }
      >
        {summary === null ? (
          <div className="h-[72px] flex items-center justify-center">
            <p className="text-xs text-textSecondary">
              {isTodaySummary
                ? "No sleep data for today"
                : "Not enough sleep data for this range"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 divide-x divide-border pt-1">
            <div className="pr-4">
              <p className="text-xl font-bold text-textPrimary tabular-nums">
                {formatTimeOfDay(summary.avgBedtime)}
              </p>
              <p className="text-[11px] text-textSecondary mt-0.5">{bedtimeLabel}</p>
            </div>
            <div className="px-4">
              <p className="text-xl font-bold text-textPrimary tabular-nums">
                {formatTimeOfDay(summary.avgWakeTime)}
              </p>
              <p className="text-[11px] text-textSecondary mt-0.5">{wakeLabel}</p>
            </div>
            <div className="pl-4">
              <p className="text-xl font-bold text-textPrimary tabular-nums">
                {summary.avgDuration.toFixed(1)} hrs
              </p>
              <p className="text-[11px] text-textSecondary mt-0.5">{durationLabel}</p>
            </div>
          </div>
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
                  <th className="text-left py-2 px-2">
                    <span className="inline-flex items-center">
                      Avg Bedtime
                      <SleepColumnTooltip
                        title="Avg Bedtime"
                        body="The average time you went to bed the night before this day. e.g. Monday's bedtime = Sunday night"
                      />
                    </span>
                  </th>
                  <th className="text-left py-2 px-2">
                    <span className="inline-flex items-center">
                      Avg Wake Time
                      <SleepColumnTooltip
                        title="Avg Wake Time"
                        body="The average time you woke up on this day. e.g. Monday's wake time = Monday morning"
                      />
                    </span>
                  </th>
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
            <p className="text-[11px] text-textSecondary mt-2">
              Bedtime shown is the night before each day. Wake time is the morning of each day.
            </p>
          </div>
        )}
      </ChartCard>

      <ChartCard title="Avg Sleep by Day of Week">
        {!hasAnyHours ? (
          <div className="h-[180px] flex items-center justify-center">
            <p className="text-xs text-textSecondary">Not enough sleep data yet</p>
          </div>
        ) : (
          <SleepByDowChart
            data={perDay.map((d) => ({
              day: d.day,
              avg: d.avgHours ?? 0,
              fill: statusChartColor(statusFor(d.avgHours)),
            }))}
            domain={tightDomain(perDay.map((d) => d.avgHours)) ?? ["auto", "auto"]}
          />
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
  const [ytdMetrics, setYtdMetrics] = useState<HealthMetric[]>([]);
  const [ytdFetched, setYtdFetched] = useState(false);
  const [hourlyHR, setHourlyHR] = useState<HourlyHeartRate | null>(null);
  const [hourlyHRLoading, setHourlyHRLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [goals, setGoals] = useState<HealthGoals | null>(null);
  const [goalsModalOpen, setGoalsModalOpen] = useState(false);

  // ── Tabs + activity rings state ─────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<HealthTab>("today");
  const [ringTimeframe, setRingTimeframe] = useState<RingTimeframe>("today");
  const [ringMode, setRingMode] = useState<RingValueMode>("total");
  const [ringGoals, setRingGoals] = useState<HealthGoalDoc[]>([]);
  const [ringGoalEditorOpen, setRingGoalEditorOpen] = useState(false);
  // Metric whose Trends section should be scrolled into view after a ring /
  // KPI-card click (or ?metric= deep link) lands on the Trends tab.
  const [pendingTrendMetric, setPendingTrendMetric] = useState<string | null>(
    null
  );

  // Deep link support: /health?tab=trends&metric=steps (used by dashboard
  // ring clicks). Mirrors the coach page's useSearchParams pattern.
  const searchParams = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "today" || tab === "calendar" || tab === "trends") {
      setActiveTab(tab);
    }
    const metric = searchParams.get("metric");
    if (metric && TREND_FIELDS.includes(metric)) {
      setActiveTab("trends");
      setSelectedKpis((prev) => {
        const next = new Set(prev);
        next.add(metric);
        return next;
      });
      setPendingTrendMetric(metric);
    }
  }, [searchParams]);

  // Date navigator — the day whose stats / 7-day / 30-day averages are shown
  // in the KPI tiles. Initialised null on first render to avoid SSR/client
  // hydration mismatch on timezone boundaries, then set to local today after
  // mount. Capped to a 30-day-back window.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  useEffect(() => {
    if (selectedDate === null) setSelectedDate(todayISO());
  }, [selectedDate]);

  // One-time fetch for user-defined health goals.
  useEffect(() => {
    if (!userId) return;
    fetchHealthGoals(userId)
      .then(setGoals)
      .catch((err) => console.error("Health goals fetch error:", err));
  }, [userId]);

  // One-time fetch for the effective-dated ring goal versions
  // (users/{uid}/healthGoals — separate from the settings doc above).
  useEffect(() => {
    if (!userId) return;
    fetchRingGoalVersions(userId)
      .then(setRingGoals)
      .catch((err) => console.error("Ring goals fetch error:", err));
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

  // ── Calendar tab: month-cached healthMetrics fetches ────────────────────
  // The RingCalendar reports its visible range; we fetch whole months that
  // haven't been fetched yet (one getDocs per month, matching the existing
  // range-fetch pattern) and cache them so flipping views/months back never
  // refetches. metrics90's live docs are overlaid so recent days stay fresh.
  const [calendarMetrics, setCalendarMetrics] = useState<
    Map<string, HealthMetric>
  >(new Map());
  const fetchedCalMonthsRef = useRef<Set<string>>(new Set());

  const handleCalendarRange = useCallback(
    (start: string, end: string) => {
      if (!userId) return;
      // Month keys ("YYYY-MM") spanned by [start..end].
      const months: string[] = [];
      let y = Number(start.slice(0, 4));
      let m = Number(start.slice(5, 7));
      const endKey = end.slice(0, 7);
      let key = start.slice(0, 7);
      while (key <= endKey) {
        months.push(key);
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
        key = `${y}-${String(m).padStart(2, "0")}`;
      }
      const missing = months.filter(
        (k) => !fetchedCalMonthsRef.current.has(k)
      );
      if (missing.length === 0) return;
      for (const k of missing) fetchedCalMonthsRef.current.add(k);
      Promise.all(
        missing.map((k) => {
          const [yy, mm] = k.split("-").map(Number);
          const monthEnd = new Date(yy, mm, 0).getDate();
          return fetchHealthMetricsRange(
            userId,
            `${k}-01`,
            `${k}-${String(monthEnd).padStart(2, "0")}`
          );
        })
      )
        .then((results) => {
          setCalendarMetrics((prev) => {
            const next = new Map(prev);
            for (const docs of results)
              for (const d of docs) next.set(d.date, d);
            return next;
          });
        })
        .catch((err) => {
          console.error("[health calendar] range fetch error:", err);
          // Un-mark so the next view change can retry.
          for (const k of missing) fetchedCalMonthsRef.current.delete(k);
        });
    },
    [userId]
  );

  // Cached months + live last-90-days docs (live wins for overlapping dates).
  const calendarMetricsLive = useMemo(() => {
    const merged = new Map(calendarMetrics);
    for (const m of metrics90) merged.set(m.date, m);
    return merged;
  }, [calendarMetrics, metrics90]);

  // Ring / KPI-card click → Trends tab, with the metric's chart selected
  // and scrolled into view once it has rendered.
  const goToTrend = useCallback((field: string) => {
    setSelectedKpis((prev) => {
      const next = new Set(prev);
      next.add(field);
      return next;
    });
    setActiveTab("trends");
    setPendingTrendMetric(field);
  }, []);

  useEffect(() => {
    if (activeTab !== "trends" || !pendingTrendMetric) return;
    const id = `trend-${pendingTrendMetric}`;
    // Defer one tick so the Trends tab (and the newly selected chart) has
    // rendered before we measure/scroll.
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      setPendingTrendMetric(null);
    }, 100);
    return () => clearTimeout(t);
  }, [activeTab, pendingTrendMetric]);

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

  const needsYtd =
    globalRange === "ytd" ||
    globalRange === "all" ||
    ringTimeframe === "ytd" ||
    Object.values(chartRanges).some((r) => r === "ytd" || r === "all");

  // Lazy-load all-time metrics for YTD/All charts
  useEffect(() => {
    if (!userId || !needsYtd || ytdFetched) return;
    setYtdFetched(true);
    fetchAllHealthMetrics(userId)
      .then((data) => setYtdMetrics(data))
      .catch((err) => console.error("YTD health metrics error:", err));
  }, [userId, needsYtd, ytdFetched, chartRanges]);

  // One-time fetch for hourly heart rate averages
  useEffect(() => {
    if (!userId) return;
    setHourlyHRLoading(true);
    fetchHourlyHeartRate(userId)
      .then((data) => setHourlyHR(data))
      .catch((err) => console.error("Hourly HR fetch error:", err))
      .finally(() => setHourlyHRLoading(false));
  }, [userId]);

  // Anchor for stats — the user-selected date, falling back to today on the
  // first render (pre-mount, selectedDate is null to avoid hydration drift).
  const anchorDate = selectedDate ?? todayISO();

  // Stats for the selected day. The 90-day listener covers the 30-day-back
  // navigation cap, so we filter from cached data — no extra query needed.
  const today = metrics90.find((m) => m.date === anchorDate) ?? null;
  const windowStart7 = shiftISODate(anchorDate, -6);
  const windowStart30 = shiftISODate(anchorDate, -29);
  const last7 = metrics90.filter(
    (m) => m.date >= windowStart7 && m.date <= anchorDate
  );
  const last30 = metrics90.filter(
    (m) => m.date >= windowStart30 && m.date <= anchorDate
  );

  // ── Today-only fallback for weight / BMI / resting HR ──────────────────────
  // When the user is viewing today but today's doc is missing a value for one
  // of these three KPIs, surface the most recent prior recorded value with a
  // small "as of <date>" subtitle. Fallback is DISPLAY-ONLY — never injected
  // into 7/30-day averages (those continue to come from last7/last30 with
  // their existing Boolean/isValidWeight filters, which already exclude
  // missing fields). Past-day navigation never uses the fallback.
  const isViewingToday = anchorDate === todayISO();
  const isPositiveNumber = (v: unknown): v is number =>
    typeof v === "number" && v > 0 && isFinite(v);
  function findFallback<T extends number>(
    field: keyof HealthMetric,
    isValid: (v: unknown) => v is T
  ): { value: T; fromDate: string } | null {
    if (!isViewingToday) return null;
    // metrics90 is descending by date — first match before anchorDate wins.
    for (const m of metrics90) {
      if (m.date >= anchorDate) continue;
      const v = m[field];
      if (isValid(v)) return { value: v, fromDate: m.date };
    }
    return null;
  }
  const isValidWeightAny = (v: unknown): v is number =>
    typeof v === "number" && isValidWeight(v);
  const weightFallback = !isValidWeight(today?.weight_lbs)
    ? findFallback("weight_lbs", isValidWeightAny)
    : null;
  const bmiFallback = !isPositiveNumber(today?.bmi)
    ? findFallback("bmi", isPositiveNumber)
    : null;
  const restingHrFallback = !isPositiveNumber(today?.resting_hr)
    ? findFallback("resting_hr", isPositiveNumber)
    : null;

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

  // ── Ring timeframe ranges + period values (Today tab) ───────────────────
  // All ranges are to-date, ending at the anchor date (= today unless the
  // user stepped back with the day navigator). YTD = Jan 1 → anchor.
  const ringRange = useMemo(() => {
    if (ringTimeframe === "7d") {
      // "This Week" = Monday-start week-to-date: the Monday of the anchor's
      // week through the anchor itself (future days in the week excluded).
      // weekToDateWindow reuses the canonical weekStart boundary — the same
      // one the dashboard hero + Week Score use, so there is one week
      // definition app-wide.
      const { start, end } = weekToDateWindow(anchorDate);
      return { start, end };
    }
    if (ringTimeframe === "30d")
      return { start: shiftISODate(anchorDate, -29), end: anchorDate };
    if (ringTimeframe === "ytd")
      return { start: `${anchorDate.slice(0, 4)}-01-01`, end: anchorDate };
    return { start: anchorDate, end: anchorDate };
  }, [ringTimeframe, anchorDate]);

  // Docs inside the ring range. The 90-day listener covers Today/7D/30D;
  // YTD reads from the all-time listener that already powers trend charts.
  const tfDocs = useMemo(() => {
    const src = ringTimeframe === "ytd" ? ytdMetrics : metrics90;
    return src.filter(
      (m) => m.date >= ringRange.start && m.date <= ringRange.end
    );
  }, [ringTimeframe, ringRange, metrics90, ytdMetrics]);

  // Period daily average over the ring range (existing avg logic,
  // parameterized by range instead of fixed 7/30-day windows).
  const tfAvg = (key: keyof HealthMetric) =>
    avg(tfDocs.map((m) => m[key] as number).filter(Boolean));
  const tfAvgWeight = avg(tfDocs.map((m) => m.weight_lbs).filter(isValidWeight));

  const isTodayTimeframe = ringTimeframe === "today";
  const tfSubtitle = isTodayTimeframe
    ? undefined
    : ringTimeframe === "7d"
      ? "This week daily avg"
      : ringTimeframe === "30d"
        ? "30-day daily avg"
        : "YTD daily avg";

  // Per-metric ring stats (outer → inner = RING_METRICS). The SINGLE source
  // for value/goal/progress per timeframe — the hero rings and the per-ring
  // KPI cards are both derived from this; never add a second math path.
  const ringStats: RingStat[] = useMemo(() => {
    // Full-period end for the on-pace tick: "This Week" (7d) runs to its
    // Sunday so the tick sits at elapsed/7 mid-week; the trailing 30d window
    // already ends at the range end (fully elapsed → fraction 1 → tick
    // hidden); YTD's full period runs to Dec 31 while actuals stay capped at
    // the anchor.
    const tickEnd =
      ringTimeframe === "ytd"
        ? `${anchorDate.slice(0, 4)}-12-31`
        : ringTimeframe === "7d"
          ? // Full Mon–Sun week so the on-pace tick sits at elapsed/7 mid-week
            // (week-to-date actuals stay capped at the anchor via ringRange.end).
            weekToDateWindow(anchorDate).weekEnd
          : ringRange.end;
    const onPace =
      ringTimeframe === "today"
        ? undefined
        : onPaceFraction(ringRange.start, tickEnd, todayISO());
    return RING_METRICS.map((metric) => {
      let progress: number;
      let actual: number;
      let goalTotal: number;
      // Daily-average value/goal over the elapsed window. On Today they collapse
      // to the single-day actual/goal (the avg toggle is hidden there anyway).
      let avgValue: number;
      let avgGoal: number;
      if (ringTimeframe === "today") {
        const value = today?.[metric];
        goalTotal = resolveGoalForDate(ringGoals, metric, anchorDate);
        actual = typeof value === "number" && value > 0 ? value : 0;
        progress = dailyRingProgress(value, goalTotal);
        avgValue = actual;
        avgGoal = goalTotal;
      } else {
        const days = tfDocs.map((m) => ({
          date: m.date,
          value: (m[metric] as number | undefined) ?? null,
        }));
        progress = periodRingProgress(
          days,
          ringGoals,
          metric,
          ringRange.start,
          ringRange.end
        );
        actual = days.reduce(
          (s, d) => s + (d.value != null && d.value > 0 ? d.value : 0),
          0
        );
        const dailyGoals = eachDate(ringRange.start, ringRange.end).map((date) =>
          resolveGoalForDate(ringGoals, metric, date)
        );
        goalTotal = dailyGoals.reduce((s, g) => s + g, 0);
        const avg = ringDailyAverage({
          periodTotal: actual,
          periodStart: parseIsoDate(ringRange.start),
          periodEnd: parseIsoDate(ringRange.end),
          dailyGoals,
          today: new Date(),
        });
        avgValue = avg.avgValue;
        avgGoal = avg.avgGoal;
      }
      return {
        metric,
        label: RING_LABELS[metric],
        color: RING_COLORS[metric],
        progress,
        actual,
        goalTotal,
        avgValue,
        avgGoal,
        onPaceFraction: onPace,
      };
    });
  }, [ringTimeframe, ringGoals, today, anchorDate, tfDocs, ringRange]);

  // Hero ring data, derived from ringStats.
  // Avg mode only applies to multi-day timeframes; Today always shows totals.
  const showAvg = ringMode === "avg" && ringTimeframe !== "today";
  const ringData: RingDatum[] = useMemo(
    () =>
      ringStats.map((s) => ({
        metric: s.metric,
        label: s.label,
        progress: s.progress,
        color: s.color,
        valueLabel: showAvg
          ? `avg ${fmtRingNumber(s.metric, s.avgValue)} / ${fmtRingNumber(s.metric, s.avgGoal)}${RING_UNITS[s.metric]} per day`
          : `${fmtRingNumber(s.metric, s.actual)} / ${fmtRingNumber(s.metric, s.goalTotal)}${RING_UNITS[s.metric]}`,
        onPaceFraction: s.onPaceFraction,
      })),
    [ringStats, showAvg]
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
      const src = sourceForRange(range, metrics90, ytdMetrics);
      const filtered = filterMetricsByRange(src, range);
      const data = filtered.map((m) => ({ date: m.date, value: accessor(m) }));
      const domain = tightDomain(data.map((d) => d.value));
      return { data, domain, range };
    },
    [rangeFor, metrics90, ytdMetrics]
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
      sourceForRange(range, metrics90, ytdMetrics),
      range
    );
  }, [rangeFor, metrics90, ytdMetrics]);

  // Sleep summary tile has its own independent range override.
  const sleepSummaryMetrics = useMemo(() => {
    const range = rangeFor("sleep_summary");
    return filterMetricsByRange(
      sourceForRange(range, metrics90, ytdMetrics),
      range
    );
  }, [rangeFor, metrics90, ytdMetrics]);

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

  // ── Displayed value per metric (follows the ring timeframe) ────────────
  // Today → the anchor day's value (with the weight/BMI/HR "as of" fallback);
  // 7D/30D/YTD → the period daily average over the ring range. Statuses are
  // evaluated against whichever value is displayed.
  const dispWeight = isTodayTimeframe
    ? (todayWeight ?? weightFallback?.value)
    : (tfAvgWeight ?? undefined);
  const dispBmi = isTodayTimeframe
    ? (isPositiveNumber(today?.bmi) ? today?.bmi : bmiFallback?.value)
    : (tfAvg("bmi") ?? undefined);
  const dispRestingHr = isTodayTimeframe
    ? (isPositiveNumber(today?.resting_hr)
        ? today?.resting_hr
        : restingHrFallback?.value)
    : (tfAvg("resting_hr") ?? undefined);
  const dispSteps = isTodayTimeframe
    ? today?.steps
    : (tfAvg("steps") ?? undefined);
  const dispExercise = isTodayTimeframe
    ? today?.exercise_mins
    : (tfAvg("exercise_mins") ?? undefined);
  const dispMoveCal = isTodayTimeframe
    ? today?.move_calories
    : (tfAvg("move_calories") ?? undefined);
  const dispStand = isTodayTimeframe
    ? today?.stand_hours
    : (tfAvg("stand_hours") ?? undefined);
  const dispSleep = isTodayTimeframe
    ? today?.sleep_total_hours
    : (tfAvg("sleep_total_hours") ?? undefined);
  const dispAwake = isTodayTimeframe
    ? today?.sleep_awake_mins
    : (tfAvg("sleep_awake_mins") ?? undefined);
  const dispBrushCount = isTodayTimeframe
    ? today?.brush_count
    : (tfAvg("brush_count") ?? undefined);
  const dispAvgBrush = isTodayTimeframe
    ? today?.brush_avg_duration_mins
    : (tfAvg("brush_avg_duration_mins") ?? undefined);

  const weightStatus: GoalStatus = statusOrNeutral(goals?.weight, (g) =>
    dispWeight !== undefined
      ? evaluateWeightGoal(dispWeight, g.goal, g.tolerance, g.warningPct, g.dangerPct)
      : "neutral"
  );
  const weightGoalText = goals?.weight
    ? `Goal: ${(goals.weight.goal - goals.weight.tolerance).toFixed(1)}–${(goals.weight.goal + goals.weight.tolerance).toFixed(1)} lbs`
    : undefined;

  const bmiStatus: GoalStatus = statusOrNeutral(goals?.bmi, (g) =>
    dispBmi !== undefined
      ? evaluateBMIGoal(dispBmi, g.min, g.max, g.warningPct, g.dangerPct)
      : "neutral"
  );
  const bmiGoalText = goals?.bmi
    ? `Goal: ${goals.bmi.min}–${goals.bmi.max}`
    : undefined;

  const hrStatus: GoalStatus = statusOrNeutral(goals?.restingHR, (g) =>
    dispRestingHr !== undefined
      ? evaluateMetricGoal(dispRestingHr, g.goal, "lower", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const hrGoalText = goals?.restingHR
    ? `Goal: ≤${goals.restingHR.goal} bpm`
    : undefined;

  const stepsStatus: GoalStatus = statusOrNeutral(goals?.steps, (g) =>
    dispSteps !== undefined
      ? evaluateMetricGoal(dispSteps, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const stepsGoalText = goals?.steps
    ? `Goal: ≥${Math.round(goals.steps.goal).toLocaleString()} steps`
    : undefined;

  const sleepStatus: GoalStatus = statusOrNeutral(goals?.sleep, (g) =>
    dispSleep !== undefined
      ? evaluateMetricGoal(dispSleep, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const sleepGoalText = goals?.sleep
    ? `Goal: ≥${goals.sleep.goal} h`
    : undefined;

  const brushingStatus: GoalStatus = statusOrNeutral(goals?.brushing, (g) =>
    dispBrushCount !== undefined
      ? evaluateMetricGoal(dispBrushCount, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const brushingGoalText = goals?.brushing
    ? `Goal: ≥${goals.brushing.goal}/day`
    : undefined;

  // ── Five remaining metrics (extended schema) ──────────────────────────
  const exerciseStatus: GoalStatus = statusOrNeutral(goals?.exerciseMins, (g) =>
    dispExercise !== undefined
      ? evaluateMetricGoal(dispExercise, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const exerciseGoalText = goals?.exerciseMins
    ? `Goal: ≥${goals.exerciseMins.goal} mins`
    : undefined;

  const moveCalStatus: GoalStatus = statusOrNeutral(goals?.moveCalories, (g) =>
    dispMoveCal !== undefined
      ? evaluateMetricGoal(dispMoveCal, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const moveCalGoalText = goals?.moveCalories
    ? `Goal: ≥${Math.round(goals.moveCalories.goal).toLocaleString()} kcal`
    : undefined;

  const standStatus: GoalStatus = statusOrNeutral(goals?.standHours, (g) =>
    dispStand !== undefined
      ? evaluateMetricGoal(dispStand, g.goal, "higher", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const standGoalText = goals?.standHours
    ? `Goal: ≥${goals.standHours.goal} hrs`
    : undefined;

  // Awake mins — lower is better
  const awakeStatus: GoalStatus = statusOrNeutral(goals?.awakeMins, (g) =>
    dispAwake !== undefined
      ? evaluateMetricGoal(dispAwake, g.goal, "lower", g.warningPct, g.dangerPct)
      : "neutral"
  );
  const awakeGoalText = goals?.awakeMins
    ? `Goal: ≤${goals.awakeMins.goal} mins`
    : undefined;

  const avgBrushStatus: GoalStatus = statusOrNeutral(goals?.avgBrushMins, (g) =>
    dispAvgBrush !== undefined
      ? evaluateMetricGoal(dispAvgBrush, g.goal, "higher", g.warningPct, g.dangerPct)
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
    return <HealthSkeleton />;
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
          {activeTab === "today" && selectedDate && (() => {
            const todayStr = todayISO();
            const minDate = shiftISODate(todayStr, -30);
            const atToday = selectedDate === todayStr;
            const atMinBound = selectedDate <= minDate;
            return (
              <div className="hidden sm:flex items-center gap-1 text-sm text-textSecondary">
                {!atMinBound ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDate((d) => shiftISODate(d ?? todayStr, -1))
                    }
                    aria-label="Previous day"
                    className="p-1 rounded hover:bg-surface hover:text-textPrimary transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                ) : (
                  // Reserve space to keep the date label position stable
                  <span className="w-6" aria-hidden />
                )}
                <span className="tabular-nums min-w-[72px] text-center">
                  {formatDateOrdinal(selectedDate)}
                </span>
                {!atToday ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDate((d) => shiftISODate(d ?? todayStr, 1))
                    }
                    aria-label="Next day"
                    className="p-1 rounded hover:bg-surface hover:text-textPrimary transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                ) : (
                  <span className="w-6" aria-hidden />
                )}
              </div>
            );
          })()}
          {activeTab === "trends" && (
            <>
              <TimeRangeSelector value={globalRange} onChange={setGlobalRange} />
              <button
                type="button"
                onClick={() => setGoalsModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-sm text-textPrimary hover:bg-surface transition-colors"
              >
                <Target className="w-4 h-4 text-textSecondary" />
                Set Goals
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs: Today | Calendar | Trends */}
      <div className="mb-6 overflow-x-auto">
        <HealthTabsBar value={activeTab} onChange={setActiveTab} />
      </div>

      {/* ── Today tab ─────────────────────────────────────────────── */}
      {activeTab === "today" && (
        <>
          {/* Hero rings + timeframe selector + ring-goal editor */}
          <div className="bg-card rounded-2xl border border-border p-5 mb-8">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-5">
              <div className="flex items-center gap-2 flex-wrap">
                <RingTimeframeSelector
                  value={ringTimeframe}
                  onChange={setRingTimeframe}
                />
                {/* Total ↔ Daily Avg — only meaningful on multi-day timeframes. */}
                {!isTodayTimeframe && (
                  <RingValueModeSelector value={ringMode} onChange={setRingMode} />
                )}
              </div>
              <button
                type="button"
                onClick={() => setRingGoalEditorOpen(true)}
                aria-label="Edit ring goals"
                title="Edit ring goals"
                className="p-2 rounded-xl border border-border text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>
            <ActivityRings
              rings={ringData}
              size={220}
              showLegend
              onRingClick={goToTrend}
            />
          </div>

          {/* Per-ring KPI cards — same stats as the hero legend; tap → Trends */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            {RING_KPI_ORDER.map((metric) => {
              const stat = ringStats.find((s) => s.metric === metric);
              if (!stat) return null;
              return (
                <RingKpiCard
                  key={metric}
                  metric={metric}
                  label={stat.label}
                  value={showAvg ? stat.avgValue : stat.actual}
                  goal={showAvg ? stat.avgGoal : stat.goalTotal}
                  progress={stat.progress}
                  color={stat.color}
                  valueFormatter={(v) =>
                    `${fmtRingNumber(metric, v)}${RING_UNITS[metric]}${showAvg ? "/day" : ""}`
                  }
                  onClick={() => goToTrend(metric)}
                />
              );
            })}
          </div>

        </>
      )}

      {/* ── Calendar tab ───────────────────────────────────────────── */}
      {activeTab === "calendar" && (
        <RingCalendar
          metricsByDate={calendarMetricsLive}
          goals={ringGoals}
          onVisibleRangeChange={handleCalendarRange}
          onMetricClick={goToTrend}
        />
      )}

      {activeTab === "trends" && (
      <>

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
                today={dispWeight}
                avg7={a7Weight}
                avg30={a30Weight}
                formatter={(v) => (v ? `${v.toFixed(1)} lb` : "—")}
                status={weightStatus}
                goalText={weightGoalText}
                subtitle={
                  isTodayTimeframe
                    ? weightFallback
                      ? `as of ${formatDate(weightFallback.fromDate)}`
                      : undefined
                    : tfSubtitle
                }
                onToggle={() => goToTrend("weight_lbs")}
              />
              <KpiCard
                icon={TrendingUp}
                label="BMI"
                color={getColor("bmi")}
                today={dispBmi}
                avg7={a7("bmi")}
                avg30={a30("bmi")}
                formatter={(v) => (v ? v.toFixed(1) : "—")}
                status={bmiStatus}
                goalText={bmiGoalText}
                subtitle={
                  isTodayTimeframe
                    ? bmiFallback
                      ? `as of ${formatDate(bmiFallback.fromDate)}`
                      : undefined
                    : tfSubtitle
                }
                onToggle={() => goToTrend("bmi")}
              />
              <KpiCard
                icon={Heart}
                label="Resting HR"
                color={getColor("hr")}
                today={dispRestingHr}
                avg7={a7("resting_hr")}
                avg30={a30("resting_hr")}
                formatter={(v) => (v ? `${Math.round(v)} bpm` : "—")}
                status={hrStatus}
                goalText={hrGoalText}
                subtitle={
                  isTodayTimeframe
                    ? restingHrFallback
                      ? `as of ${formatDate(restingHrFallback.fromDate)}`
                      : undefined
                    : tfSubtitle
                }
                onToggle={() => goToTrend("resting_hr")}
              />
            </div>
        {!sectionAnyActive(BODY_KPIS) && (
          <p className="text-xs text-textSecondary">
            No charts selected — use “All”, or tap a KPI card above.
          </p>
        )}
        {sectionAnyActive(BODY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("weight_lbs") && (
              <div id="trend-weight_lbs" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("bmi") && (
              <div id="trend-bmi" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("resting_hr") && (
              <div
                id="trend-resting_hr"
                className="scroll-mt-24 flex flex-col gap-4"
              >
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
                    <HourlyHRChart
                      data={hourlyHRChartData}
                      domain={hourlyHRDomain}
                    />
                  )}
                </div>
              </div>
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
                today={dispSteps}
                avg7={a7("steps")}
                avg30={a30("steps")}
                formatter={(v) => (v ? Math.round(v).toLocaleString() : "—")}
                status={stepsStatus}
                goalText={stepsGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("steps")}
              />
              <KpiCard
                icon={Clock}
                label="Exercise Mins"
                color={getColor("exercise")}
                today={dispExercise}
                avg7={a7("exercise_mins")}
                avg30={a30("exercise_mins")}
                formatter={(v) => (v !== undefined ? `${Math.round(v)} min` : "—")}
                status={exerciseStatus}
                goalText={exerciseGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("exercise_mins")}
              />
              <KpiCard
                icon={Zap}
                label="Move Calories"
                color={getColor("calories")}
                today={dispMoveCal}
                avg7={a7("move_calories")}
                avg30={a30("move_calories")}
                formatter={(v) => (v !== undefined ? `${Math.round(v)} kcal` : "—")}
                status={moveCalStatus}
                goalText={moveCalGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("move_calories")}
              />
              <KpiCard
                icon={PersonStanding}
                label="Stand Hours"
                color={getColor("stand")}
                today={dispStand}
                avg7={a7("stand_hours")}
                avg30={a30("stand_hours")}
                formatter={(v) => (v !== undefined ? `${Math.round(v)}h` : "—")}
                status={standStatus}
                goalText={standGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("stand_hours")}
              />
            </div>
        {!sectionAnyActive(ACTIVITY_KPIS) && (
          <p className="text-xs text-textSecondary">
            No charts selected — use “All”, or tap a KPI card above.
          </p>
        )}
        {sectionAnyActive(ACTIVITY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("steps") && (
              <div id="trend-steps" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("exercise_mins") && (
              <div id="trend-exercise_mins" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("move_calories") && (
              <div id="trend-move_calories" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("stand_hours") && (
              <div id="trend-stand_hours" className="scroll-mt-24">
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
              </div>
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
                today={dispSleep}
                avg7={a7("sleep_total_hours")}
                avg30={a30("sleep_total_hours")}
                formatter={(v) => formatHours(v)}
                status={sleepStatus}
                goalText={sleepGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("sleep_total_hours")}
              />
              <KpiCard
                icon={Moon}
                label="Awake Time"
                color="#6b7280"
                today={dispAwake}
                avg7={a7("sleep_awake_mins")}
                avg30={a30("sleep_awake_mins")}
                formatter={(v) => (v !== undefined ? `${Math.round(v)} min` : "—")}
                status={awakeStatus}
                goalText={awakeGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("sleep_awake_mins")}
              />
              <KpiCard
                icon={SmilePlus}
                label="Brushing Sessions"
                color={getColor("brush")}
                today={dispBrushCount}
                avg7={a7("brush_count")}
                avg30={a30("brush_count")}
                formatter={(v) => (v !== undefined ? `${v.toFixed(1)}x` : "—")}
                status={brushingStatus}
                goalText={brushingGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("brush_count")}
              />
              <KpiCard
                icon={Clock}
                label="Avg Brush Time"
                color={getColor("brush")}
                today={dispAvgBrush}
                avg7={a7("brush_avg_duration_mins")}
                avg30={a30("brush_avg_duration_mins")}
                formatter={(v) => (v !== undefined ? `${v.toFixed(1)} min` : "—")}
                status={avgBrushStatus}
                goalText={avgBrushGoalText}
                subtitle={tfSubtitle}
                onToggle={() => goToTrend("brush_avg_duration_mins")}
              />
            </div>
        {!sectionAnyActive(RECOVERY_KPIS) && (
          <p className="text-xs text-textSecondary">
            No charts selected — use “All”, or tap a KPI card above.
          </p>
        )}
        {sectionAnyActive(RECOVERY_KPIS) && (
          <div className="flex flex-col gap-4 transition-all duration-200">
            {selectedKpis.has("sleep_total_hours") && (
              <div
                id="trend-sleep_total_hours"
                className="scroll-mt-24 flex flex-col gap-4"
              >
                <SleepAnalytics
                  metrics={sleepAnalyticsMetrics}
                  sleepGoal={goals?.sleep}
                  summaryMetrics={sleepSummaryMetrics}
                  summaryRange={rangeFor("sleep_summary")}
                  onSummaryRangeChange={(r) => setChartRange("sleep_summary", r)}
                />
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
              </div>
            )}
            {selectedKpis.has("sleep_awake_mins") && (
              <div id="trend-sleep_awake_mins" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("brush_count") && (
              <div id="trend-brush_count" className="scroll-mt-24">
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
              </div>
            )}
            {selectedKpis.has("brush_avg_duration_mins") && (
              <div id="trend-brush_avg_duration_mins" className="scroll-mt-24">
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
              </div>
            )}
          </div>
        )}
      </Section>
      </>
      )}

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

      {/* Ring goals editor — appends a new effective-dated version */}
      {userId && (
        <RingGoalEditorModal
          isOpen={ringGoalEditorOpen}
          uid={userId}
          goals={ringGoals}
          onClose={() => setRingGoalEditorOpen(false)}
          onSaved={(doc) => setRingGoals((prev) => [...prev, doc])}
        />
      )}

    </div>
  );
}
