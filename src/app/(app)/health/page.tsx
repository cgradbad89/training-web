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
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl border border-border p-4">
      <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
        {title}
      </p>
      {children}
    </div>
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

  /** Weight chart series — filter out invalid readings */
  function weightChartSeries() {
    return chartData.map((m) => ({
      date: m.date,
      value: isValidWeight(m.weight_lbs) ? m.weight_lbs : undefined,
    }));
  }

  /** Compute tight Y domain for weight charts */
  function weightDomain(
    series: { value: number | undefined }[]
  ): [number, number] | undefined {
    const vals = series
      .map((d) => d.value)
      .filter((v): v is number => v !== undefined && v > 0);
    if (vals.length < 2) return undefined;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return [Math.floor(min - 2), Math.ceil(max + 2)];
  }

  const weight90Series = useMemo(() => weightChartSeries(), [chartData]);
  const weight90Domain = useMemo(() => weightDomain(weight90Series), [weight90Series]);

  // All-time weight series (filtered)
  const weightAllSeries = useMemo(
    () => allMetrics.map((m) => ({
      date: m.date,
      value: isValidWeight(m.weight_lbs) ? m.weight_lbs : undefined,
    })),
    [allMetrics]
  );
  const weightAllDomain = useMemo(() => weightDomain(weightAllSeries), [weightAllSeries]);

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

  // All-time resting HR — filter outliers, zoom domain
  const { allTimeHRSeries, allTimeHRMin, allTimeHRMax } = useMemo(() => {
    const series = allMetrics
      .map((m) => ({ date: m.date, value: m.resting_hr }))
      .filter(
        (d) => d.value !== undefined && d.value >= 40 && d.value <= 120
      );
    const values = allMetrics
      .map((m) => m.resting_hr)
      .filter(
        (v): v is number =>
          v !== undefined && v >= 40 && v <= 120 && isFinite(v)
      );
    const min =
      values.length > 0
        ? Math.floor(Math.min(...values) - 3)
        : 50;
    const max =
      values.length > 0
        ? Math.ceil(Math.max(...values) + 3)
        : 100;
    return { allTimeHRSeries: series, allTimeHRMin: min, allTimeHRMax: max };
  }, [allMetrics]);

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
              <ChartCard title="Weight — Last 90 Days">
                <TrendChart
                  data={weight90Series}
                  label="Weight"
                  color={getColor("weight")}
                  formatter={(v) => `${v.toFixed(1)} lb`}
                  yDomain={weight90Domain}
                  yTickFormatter={(v) => `${Math.round(v)} lb`}
                  refValue={goals?.weight?.goal}
                  refLabel={goals?.weight ? `Goal ${goals.weight.goal} lbs` : undefined}
                />
              </ChartCard>
            )}
            {selectedKpis.has("bmi") && (
              <ChartCard title="BMI — Last 90 Days">
                <TrendChart
                  data={toChartSeries("bmi")}
                  label="BMI"
                  color={getColor("bmi")}
                  formatter={(v) => v.toFixed(1)}
                />
              </ChartCard>
            )}
            {selectedKpis.has("resting_hr") && (
              <>
                <ChartCard title="Resting HR — Last 90 Days">
                  <TrendChart
                    data={toChartSeries("resting_hr")}
                    label="Resting HR"
                    color={getColor("hr")}
                    formatter={(v) => `${Math.round(v)} bpm`}
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
              <ChartCard title="Daily Steps — Last 90 Days">
                <TrendChart
                  data={toChartSeries("steps")}
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
                />
              </ChartCard>
            )}
            {selectedKpis.has("exercise_mins") && (
              <ChartCard title="Exercise Mins — Last 90 Days">
                <TrendChart
                  data={toChartSeries("exercise_mins")}
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
                />
              </ChartCard>
            )}
            {selectedKpis.has("move_calories") && (
              <ChartCard title="Move Calories — Last 90 Days">
                <TrendChart
                  data={toChartSeries("move_calories")}
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
                />
              </ChartCard>
            )}
            {selectedKpis.has("stand_hours") && (
              <ChartCard title="Stand Hours — Last 90 Days">
                <TrendChart
                  data={toChartSeries("stand_hours")}
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
              <ChartCard title="Sleep Duration — Last 90 Days">
                <TrendChart
                  data={toChartSeries("sleep_total_hours")}
                  label="Sleep"
                  color={getColor("sleep")}
                  formatter={(v) => formatHours(v)}
                  refValue={goals?.sleep?.goal}
                  refLabel={goals?.sleep ? `Goal ${goals.sleep.goal}h` : undefined}
                />
              </ChartCard>
            )}
            {selectedKpis.has("sleep_awake_mins") && (
              <ChartCard title="Awake Time — Last 90 Days">
                <TrendChart
                  data={toChartSeries("sleep_awake_mins")}
                  label="Awake"
                  color="#6b7280"
                  formatter={(v) => `${Math.round(v)} min`}
                  refValue={goals?.awakeMins?.goal}
                  refLabel={
                    goals?.awakeMins
                      ? `Goal ≤${goals.awakeMins.goal} min`
                      : undefined
                  }
                />
              </ChartCard>
            )}
            {selectedKpis.has("brush_count") && (
              <ChartCard title="Daily Brushing Sessions — Last 90 Days">
                <TrendChart
                  data={toChartSeries("brush_count")}
                  label="Sessions"
                  color={getColor("brush")}
                  formatter={(v) => `${v.toFixed(1)}x`}
                  refValue={goals?.brushing?.goal}
                  refLabel={goals?.brushing ? `Goal ${goals.brushing.goal}x` : undefined}
                  type="bar"
                />
              </ChartCard>
            )}
            {selectedKpis.has("brush_avg_duration_mins") && (
              <ChartCard title="Avg Brush Duration — Last 90 Days">
                <TrendChart
                  data={toChartSeries("brush_avg_duration_mins")}
                  label="Avg Brush"
                  color={getColor("brush")}
                  formatter={(v) => `${v.toFixed(1)} min`}
                  refValue={goals?.avgBrushMins?.goal}
                  refLabel={
                    goals?.avgBrushMins
                      ? `Goal ${goals.avgBrushMins.goal} min`
                      : undefined
                  }
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

      {/* ── Long-term trends ─────────────────────────────────────── */}
      {allMetrics.length > 90 && (
        <Section title="Long-Term Trends">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-card rounded-2xl border border-border p-4">
              <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
                Resting HR — All Time
              </p>
              <TrendChart
                data={allTimeHRSeries}
                label="Resting HR"
                color={getColor("hr")}
                formatter={(v) => `${Math.round(v)} bpm`}
                yDomain={[allTimeHRMin, allTimeHRMax]}
                yTickFormatter={(v) => `${Math.round(v)}`}
              />
            </div>
            <div className="bg-card rounded-2xl border border-border p-4">
              <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
                Weight — All Time
              </p>
              <TrendChart
                data={weightAllSeries}
                label="Weight"
                color={getColor("weight")}
                formatter={(v) => `${v.toFixed(1)} lb`}
                yDomain={weightAllDomain}
                yTickFormatter={(v) => `${Math.round(v)} lb`}
              />
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
