"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  onHealthMetricsSnapshot,
  onAllHealthMetricsSnapshot,
  fetchHourlyHeartRate,
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
} from "lucide-react";

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

// ── Conditional status colors ────────────────────────────────────────────────

type MetricStatus = "green" | "yellow" | "red" | "neutral";

function getStatus(
  metric: keyof HealthMetric,
  value: number | undefined | null
): MetricStatus {
  if (value === undefined || value === null || !isFinite(value))
    return "neutral";

  switch (metric) {
    // Weight: ≤170 green, ≤173 yellow, >173 red
    case "weight_lbs":
      if (value <= 170) return "green";
      if (value <= 173) return "yellow";
      return "red";

    // BMI: ≤24.9 green, ≤26 yellow, >26 red
    case "bmi":
      if (value <= 24.9) return "green";
      if (value <= 26) return "yellow";
      return "red";

    // Resting HR: ≤67 green, ≤73 yellow (68-73 range), >73 red
    case "resting_hr":
      if (value <= 67) return "green";
      if (value <= 73) return "yellow";
      return "red";

    // Steps: ≥10000 green, ≥7000 yellow, <7000 red
    case "steps":
      if (value >= 10000) return "green";
      if (value >= 7000) return "yellow";
      return "red";

    // Exercise mins: ≥45 green, ≥30 yellow, <30 red
    case "exercise_mins":
      if (value >= 45) return "green";
      if (value >= 30) return "yellow";
      return "red";

    // Move calories: ≥800 green, ≥600 yellow, <600 red
    case "move_calories":
      if (value >= 800) return "green";
      if (value >= 600) return "yellow";
      return "red";

    // Stand hours: ≥12 green, ≥8 yellow, <8 red
    case "stand_hours":
      if (value >= 12) return "green";
      if (value >= 8) return "yellow";
      return "red";

    // Sleep hours: ≥7 green, ≥6 yellow, <6 red
    case "sleep_total_hours":
      if (value >= 7) return "green";
      if (value >= 6) return "yellow";
      return "red";

    // Sleep awake mins: ≤20 green, ≤40 yellow, >40 red
    case "sleep_awake_mins":
      if (value <= 20) return "green";
      if (value <= 40) return "yellow";
      return "red";

    // Brush count: ≥2 green, ≥1 yellow, <1 red
    case "brush_count":
      if (value >= 2) return "green";
      if (value >= 1) return "yellow";
      return "red";

    // Brush duration: ≥2 mins green, ≥1.5 yellow, <1.5 red
    case "brush_avg_duration_mins":
      if (value >= 2) return "green";
      if (value >= 1.5) return "yellow";
      return "red";

    default:
      return "neutral";
  }
}

function statusColor(status: MetricStatus): string {
  switch (status) {
    case "green":
      return "#16a34a";
    case "yellow":
      return "#d97706";
    case "red":
      return "#dc2626";
    default:
      return "";
  }
}

function statusBg(status: MetricStatus): string {
  switch (status) {
    case "green":
      return "rgba(22,163,74,0.08)";
    case "yellow":
      return "rgba(217,119,6,0.08)";
    case "red":
      return "rgba(220,38,38,0.08)";
    default:
      return "";
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
  status?: MetricStatus;
}) {
  const sc = statusColor(status);
  const sb = statusBg(status);
  const iconColor = status !== "neutral" ? sc : color;
  const iconBg =
    status !== "neutral" ? sb : `color-mix(in srgb, ${color} 10%, transparent)`;

  return (
    <div
      className="bg-card rounded-2xl border p-4"
      style={{
        borderColor: status !== "neutral" ? sc : undefined,
        backgroundColor: status !== "neutral" ? sb : undefined,
      }}
    >
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
        className="text-2xl font-bold mb-3"
        style={{ color: status !== "neutral" ? sc : undefined }}
      >
        {formatter(today)}
      </p>

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
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-4">
        {title}
      </h2>
      {children}
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-textPrimary">Health</h1>
          {lastSynced && (
            <p className="text-xs text-textSecondary mt-0.5 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />
              Last synced {lastSynced}
            </p>
          )}
        </div>
        {today && (
          <p className="text-sm text-textSecondary">
            Data from {formatDate(today.date)}
          </p>
        )}
      </div>

      {/* ── Body Metrics ─────────────────────────────────────────── */}
      <Section title="Body">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <KpiCard
            icon={Scale}
            label="Weight"
            color={getColor("weight")}
            today={todayWeight}
            avg7={a7Weight}
            avg30={a30Weight}
            formatter={(v) => (v ? `${v.toFixed(1)} lb` : "—")}
            status={getStatus("weight_lbs", todayWeight)}
          />
          <KpiCard
            icon={TrendingUp}
            label="BMI"
            color={getColor("bmi")}
            today={today?.bmi}
            avg7={a7("bmi")}
            avg30={a30("bmi")}
            formatter={(v) => (v ? v.toFixed(1) : "—")}
            status={getStatus("bmi", today?.bmi)}
          />
          <KpiCard
            icon={Heart}
            label="Resting HR"
            color={getColor("hr")}
            today={today?.resting_hr}
            avg7={a7("resting_hr")}
            avg30={a30("resting_hr")}
            formatter={(v) => (v ? `${Math.round(v)} bpm` : "—")}
            status={getStatus("resting_hr", today?.resting_hr)}
          />
        </div>

        <div className="bg-card rounded-2xl border border-border p-4 mb-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
            Weight — Last 90 Days
          </p>
          <TrendChart
            data={weight90Series}
            label="Weight"
            color={getColor("weight")}
            formatter={(v) => `${v.toFixed(1)} lb`}
            yDomain={weight90Domain}
            yTickFormatter={(v) => `${Math.round(v)} lb`}
          />
        </div>

        {/* Hourly Heart Rate by Time of Day */}
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="mb-3">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
              Heart Rate by Time of Day
            </p>
            <p className="text-xs text-textSecondary mt-0.5">
              30-day average HR{hourlyHRLastSync ? ` · last sync ${hourlyHRLastSync}` : ""}
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
                  tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
                  interval={2}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'var(--color-chart-axis)' }}
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
                    backgroundColor: 'var(--color-chart-tooltip-bg)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-textPrimary)',
                  }}
                  labelStyle={{ color: 'var(--color-textSecondary)' }}
                  itemStyle={{ color: 'var(--color-textPrimary)' }}
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
      </Section>

      {/* ── Activity ─────────────────────────────────────────────── */}
      <Section title="Activity">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <KpiCard
            icon={Footprints}
            label="Steps"
            color={getColor("steps")}
            today={today?.steps}
            avg7={a7("steps")}
            avg30={a30("steps")}
            formatter={(v) => (v ? Math.round(v).toLocaleString() : "—")}
            status={getStatus("steps", today?.steps)}
          />
          <KpiCard
            icon={Clock}
            label="Exercise Mins"
            color={getColor("exercise")}
            today={today?.exercise_mins}
            avg7={a7("exercise_mins")}
            avg30={a30("exercise_mins")}
            formatter={(v) => (v ? `${Math.round(v)} min` : "—")}
            status={getStatus("exercise_mins", today?.exercise_mins)}
          />
          <KpiCard
            icon={Zap}
            label="Move Calories"
            color={getColor("calories")}
            today={today?.move_calories}
            avg7={a7("move_calories")}
            avg30={a30("move_calories")}
            formatter={(v) => (v ? `${Math.round(v)} kcal` : "—")}
            status={getStatus("move_calories", today?.move_calories)}
          />
          <KpiCard
            icon={PersonStanding}
            label="Stand Hours"
            color={getColor("stand")}
            today={today?.stand_hours}
            avg7={a7("stand_hours")}
            avg30={a30("stand_hours")}
            formatter={(v) => (v ? `${Math.round(v)}h` : "—")}
            status={getStatus("stand_hours", today?.stand_hours)}
          />
        </div>

        <div className="bg-card rounded-2xl border border-border p-4 mb-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
            Daily Steps — Last 90 Days
          </p>
          <TrendChart
            data={toChartSeries("steps")}
            label="Steps"
            color={getColor("steps")}
            formatter={(v) => Math.round(v).toLocaleString()}
            refValue={10000}
            refLabel="10k goal"
            type="bar"
          />
        </div>

        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
              Stand Hours — Last 90 Days
            </p>
            <p className="text-sm font-semibold text-textPrimary">
              Today:{" "}
              {today?.stand_hours !== undefined
                ? `${today.stand_hours}h`
                : "—"}
            </p>
          </div>
          <TrendChart
            data={toChartSeries("stand_hours")}
            label="Stand Hours"
            color={getColor("stand")}
            formatter={(v) => `${Math.round(v)}h`}
            refValue={12}
            refLabel="12h goal"
            type="bar"
          />
        </div>
      </Section>

      {/* ── Sleep ────────────────────────────────────────────────── */}
      <Section title="Sleep">
        <div className="grid grid-cols-2 gap-4 mb-6">
          <KpiCard
            icon={Moon}
            label="Total Sleep"
            color={getColor("sleep")}
            today={today?.sleep_total_hours}
            avg7={a7("sleep_total_hours")}
            avg30={a30("sleep_total_hours")}
            formatter={(v) => formatHours(v)}
            status={getStatus("sleep_total_hours", today?.sleep_total_hours)}
          />
          <KpiCard
            icon={Moon}
            label="Awake Time"
            color="#6b7280"
            today={today?.sleep_awake_mins}
            avg7={a7("sleep_awake_mins")}
            avg30={a30("sleep_awake_mins")}
            formatter={(v) => (v ? `${Math.round(v)} min` : "—")}
            status={getStatus("sleep_awake_mins", today?.sleep_awake_mins)}
          />
        </div>

        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
            Sleep Duration — Last 90 Days
          </p>
          <TrendChart
            data={toChartSeries("sleep_total_hours")}
            label="Sleep"
            color={getColor("sleep")}
            formatter={(v) => formatHours(v)}
            refValue={8}
            refLabel="8h goal"
          />
        </div>
      </Section>

      {/* ── Oral Care ────────────────────────────────────────────── */}
      <Section title="Oral Care">
        <div className="grid grid-cols-2 gap-4 mb-6">
          <KpiCard
            icon={SmilePlus}
            label="Brushing Sessions"
            color={getColor("brush")}
            today={today?.brush_count}
            avg7={a7("brush_count")}
            avg30={a30("brush_count")}
            formatter={(v) => (v ? `${v.toFixed(1)}x` : "—")}
            status={getStatus("brush_count", today?.brush_count)}
          />
          <KpiCard
            icon={Clock}
            label="Avg Brush Time"
            color={getColor("brush")}
            today={today?.brush_avg_duration_mins}
            avg7={a7("brush_avg_duration_mins")}
            avg30={a30("brush_avg_duration_mins")}
            formatter={(v) => (v ? `${v.toFixed(1)} min` : "—")}
            status={getStatus("brush_avg_duration_mins", today?.brush_avg_duration_mins)}
          />
        </div>

        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-3">
            Daily Brushing Sessions — Last 90 Days
          </p>
          <TrendChart
            data={toChartSeries("brush_count")}
            label="Sessions"
            color={getColor("brush")}
            formatter={(v) => `${v.toFixed(1)}x`}
            refValue={2}
            refLabel="2x goal"
            type="bar"
          />
        </div>
      </Section>

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
