"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { ChevronLeft, ChevronRight, Timer, Trophy, TrendingUp, BotMessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { WorkoutTrendsSection } from "@/components/WorkoutTrendsSection";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { applyOverride } from "@/types/workoutOverride";
import { type HealthWorkout } from "@/types/healthWorkout";
import { formatPace } from "@/utils/pace";
import { weekStart as getWeekStart } from "@/utils/dates";
import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
  formatRaceTime,
  formatRacePace,
  riegelConfidenceLabel,
  type RiegelFit,
} from "@/utils/riegelFit";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon size={18} className="text-primary" />
      <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    </div>
  );
}

function formatPaceLabel(secPerMile: number): string {
  if (!isFinite(secPerMile) || secPerMile <= 0) return "—";
  const total = Math.round(secPerMile);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatTotalTime(totalSeconds: number): string {
  if (!isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.round(totalSeconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PersonalInsightsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const router = useRouter();

  function askCoach(question: string) {
    router.push(`/coach?q=${encodeURIComponent(question)}`);
  }

  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => {
    if (!uid) return;

    setLoading(true);
    Promise.all([fetchHealthWorkouts(uid, { limitCount: 500 }), fetchAllOverrides(uid)])
      .then(([wkts, overrides]) => {
        const processed = wkts
          .map((w) => applyOverride(w, overrides[w.workoutId] ?? null))
          .filter((w) => !overrides[w.workoutId]?.isExcluded);
        setWorkouts(processed);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid]);


  const runs = useMemo(() => workouts.filter((w) => w.isRunLike), [workouts]);

  // ── Available years ─────────────────────────────────────────────────────────

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    runs.forEach((r) => years.add(r.startDate.getFullYear()));
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [runs]);

  // ── Riegel Predictions ──────────────────────────────────────────────────────

  const runInputs = useMemo(
    () =>
      runs.map((r) => ({
        workoutId: r.workoutId,
        distanceMiles: r.distanceMiles,
        durationSeconds: r.durationSeconds,
        startDate: r.startDate,
        activityType: r.activityType,
        sourceName: r.sourceName,
      })),
    [runs]
  );

  const fit5k = useMemo(() => {
    const efforts = buildQualifyingEfforts(runInputs, 56);
    return fitRiegel(efforts, 3.1069, 0, { min: 0.9, max: 1.3 });
  }, [runInputs]);

  const fitLong = useMemo(() => {
    const efforts = buildQualifyingEfforts(runInputs, 56);
    return fitRiegel(efforts, 13.109, 3.0, { min: 1.05, max: 1.18 });
  }, [runInputs]);

  const t5k = fit5k ? predictSeconds(fit5k, 3.1069) : null;
  const t10 = fitLong ? predictSeconds(fitLong, 10.0) : null;
  const tHalf = fitLong ? predictSeconds(fitLong, 13.109) : null;
  const tMar = fitLong ? predictSeconds(fitLong, 26.219) : null;

  function overallConfidence(f5k: RiegelFit | null, fLong: RiegelFit | null): string {
    if (!fLong) return "Limited Data";
    if (fLong.n >= 6 && fLong.r2 >= 0.55) return "High";
    if (fLong.n >= 4 && fLong.r2 >= 0.45) return "Moderate";
    return "Limited Data";
  }

  const confidence = overallConfidence(fit5k, fitLong);
  const confidenceLevel: "good" | "ok" | "low" =
    confidence === "High" ? "good" : confidence === "Moderate" ? "ok" : "low";

  // ── Personal Records by Year ────────────────────────────────────────────────

  const prBuckets = [
    { label: "~1 mi", filter: (m: number) => m >= 0.9 && m < 1.15 },
    { label: "1–3 mi", filter: (m: number) => m >= 1.0 && m < 3.0 },
    { label: "3–6 mi", filter: (m: number) => m >= 3.0 && m < 6.0 },
    { label: "6–7 mi", filter: (m: number) => m >= 6.0 && m < 7.0 },
    { label: "7–10 mi", filter: (m: number) => m >= 7.0 && m < 10.0 },
    { label: "10+ mi", filter: (m: number) => m >= 10.0 },
  ];

  // Specific run distance PRs
  const specificDistances = [
    { label: "5K", targetMiles: 3.107, tolerance: 0.3 },
    { label: "5 Miles", targetMiles: 5.0, tolerance: 0.5 },
    { label: "10K", targetMiles: 6.214, tolerance: 0.5 },
    { label: "10 Miles", targetMiles: 10.0, tolerance: 0.75 },
    { label: "15K", targetMiles: 9.321, tolerance: 0.75 },
    { label: "Half Marathon", targetMiles: 13.109, tolerance: 1.0 },
  ];

  const yearRuns = useMemo(
    () => runs.filter((r) => r.startDate.getFullYear() === selectedYear),
    [runs, selectedYear]
  );

  const prs = useMemo(
    () =>
      prBuckets.map((bucket) => {
        const qualifying = yearRuns
          .filter((r) => r.distanceMiles > 0 && bucket.filter(r.distanceMiles))
          .map((r) => {
            const pace = r.durationSeconds / r.distanceMiles;
            return { pace, miles: r.distanceMiles, date: r.startDate };
          })
          .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

        if (qualifying.length === 0) return null;
        return qualifying.reduce((best, cur) => (cur.pace < best.pace ? cur : best));
      }),
    [yearRuns]
  );

  // Specific run distance PRs (fastest avg pace for qualifying runs)
  const specificPrs = useMemo(
    () =>
      specificDistances.map((dist) => {
        const candidates = yearRuns
          .filter(
            (r) =>
              r.distanceMiles >= dist.targetMiles - dist.tolerance &&
              r.distanceMiles <= dist.targetMiles + dist.tolerance &&
              r.durationSeconds > 0
          )
          .map((r) => ({
            pace: r.durationSeconds / r.distanceMiles,
            totalSeconds: r.durationSeconds,
            miles: r.distanceMiles,
            date: r.startDate,
          }))
          .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

        if (candidates.length === 0) return null;
        return candidates.reduce((best, cur) =>
          cur.pace < best.pace ? cur : best
        );
      }),
    [yearRuns]
  );

  // ── Pace Trends (last 8 weeks) ─────────────────────────────────────────────

  const paceTrendData = useMemo(() => {
    const nowDate = new Date();
    const currentMonday = getWeekStart(nowDate);

    return Array.from({ length: 8 }, (_, i) => {
      const weekDate = new Date(currentMonday);
      weekDate.setDate(weekDate.getDate() - (7 - i) * 7);
      const weekEndDate = new Date(weekDate);
      weekEndDate.setDate(weekDate.getDate() + 6);
      weekEndDate.setHours(23, 59, 59, 999);

      const weekRuns = runs.filter((r) => r.startDate >= weekDate && r.startDate <= weekEndDate);

      function avgPace(bucket: HealthWorkout[]): number | null {
        let totalSec = 0,
          totalMi = 0;
        bucket.forEach((r) => {
          if (r.distanceMiles <= 0) return;
          const sec = r.durationSeconds / r.distanceMiles;
          if (!isFinite(sec) || sec <= 0) return;
          totalSec += sec * r.distanceMiles;
          totalMi += r.distanceMiles;
        });
        return totalMi > 0 ? totalSec / totalMi : null;
      }

      const short = weekRuns.filter((r) => r.distanceMiles >= 1 && r.distanceMiles < 3);
      const medium = weekRuns.filter((r) => r.distanceMiles >= 3 && r.distanceMiles < 6);
      const long = weekRuns.filter((r) => r.distanceMiles >= 6);

      const label = weekDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

      return {
        label,
        short: avgPace(short),
        medium: avgPace(medium),
        long: avgPace(long),
      };
    });
  }, [runs]);

  const hasPaceTrend = paceTrendData.some((w) => w.short || w.medium || w.long);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const predictions = [
    { label: "5K", distance: 3.1069, time: t5k },
    { label: "10 Miler", distance: 10.0, time: t10 },
    { label: "Half Marathon", distance: 13.109, time: tHalf },
    { label: "Marathon", distance: 26.219, time: tMar },
  ];

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-textPrimary">Personal Insights</h1>
        <button
          onClick={() => askCoach(
            'Analyze my personal running trends and fitness ' +
            'progression. What do my pace trends, PRs, and ' +
            'predicted race times suggest about my fitness ' +
            'development over time?'
          )}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
        >
          <BotMessageSquare className="w-4 h-4" />
          Ask AI Coach
        </button>
      </div>

      {/* ── Predicted Race Times ─────────────────────────── */}
      <SectionHeader icon={Timer} title="Predicted Race Times" />

      <Card>
        <div className="flex items-center justify-between mb-5">
          <p className="text-xs text-textSecondary">Based on last 8 weeks of training</p>
          <MetricBadge label="Confidence" value={confidence} level={confidenceLevel} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {predictions.map((p) => (
            <div key={p.label} className="text-center">
              <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
                {p.label}
              </p>
              <p className="text-2xl font-bold text-textPrimary tabular-nums">
                {formatRaceTime(p.time)}
              </p>
              <p className="text-xs text-textSecondary mt-1">
                {p.time ? formatRacePace(p.time, p.distance) : "—"}
              </p>
            </div>
          ))}
        </div>

        {!fitLong && !fit5k && (
          <p className="text-xs text-textSecondary mt-4 text-center">
            Need 4+ qualifying runs in the last 8 weeks for predictions.
          </p>
        )}

        {fitLong && (
          <p className="text-xs text-textSecondary mt-4 text-center">
            Model: {fitLong.n} efforts, R² {fitLong.r2.toFixed(2)}, exponent{" "}
            {fitLong.k.toFixed(3)}
          </p>
        )}
        <button
          onClick={() => askCoach(
            'Based on my predicted race times, how realistic is ' +
            'my half marathon goal? What training would most ' +
            'improve my predicted finish time?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my race predictions
        </button>
      </Card>

      {/* ── Personal Records by Year ─────────────────────── */}
      <SectionHeader icon={Trophy} title="Personal Records by Year" />

      <Card>
        {/* Year selector */}
        <div className="flex items-center justify-center gap-4 mb-5">
          <button
            onClick={() => setSelectedYear((y) => y - 1)}
            disabled={!availableYears.includes(selectedYear - 1)}
            className="p-1 rounded-lg hover:bg-surface disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={20} className="text-textSecondary" />
          </button>
          <span className="text-lg font-bold text-textPrimary tabular-nums w-16 text-center">
            {selectedYear}
          </span>
          <button
            onClick={() => setSelectedYear((y) => y + 1)}
            disabled={selectedYear >= new Date().getFullYear()}
            className="p-1 rounded-lg hover:bg-surface disabled:opacity-30 transition-colors"
          >
            <ChevronRight size={20} className="text-textSecondary" />
          </button>
        </div>

        {/* Section 1: Mile Range PRs */}
        <p className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-3">
          Best Pace by Distance
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-textSecondary font-medium">Distance</th>
                <th className="text-center py-2 text-textSecondary font-medium">Best Pace</th>
                <th className="text-center py-2 text-textSecondary font-medium">Distance</th>
                <th className="text-center py-2 text-textSecondary font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {prBuckets.map((bucket, idx) => {
                const pr = prs[idx];
                return (
                  <tr key={bucket.label} className="border-b border-border/50">
                    <td className="py-3 text-textSecondary font-medium">{bucket.label}</td>
                    {pr ? (
                      <>
                        <td className="py-3 text-center font-semibold text-textPrimary tabular-nums">
                          {formatPaceLabel(pr.pace)} /mi
                        </td>
                        <td className="py-3 text-center text-textSecondary tabular-nums">
                          {pr.miles.toFixed(2)} mi
                        </td>
                        <td className="py-3 text-center text-textSecondary">
                          {pr.date.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-center text-textSecondary">—</td>
                        <td className="py-3 text-center text-textSecondary">—</td>
                        <td className="py-3 text-center text-textSecondary">—</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Section 2: Specific Run PRs */}
        <p className="text-xs font-semibold text-textSecondary uppercase tracking-widest mt-6 mb-3">
          Specific Runs
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-textSecondary font-medium">Distance</th>
                <th className="text-center py-2 text-textSecondary font-medium">Time</th>
                <th className="text-center py-2 text-textSecondary font-medium">Pace</th>
                <th className="text-center py-2 text-textSecondary font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {specificDistances.map((dist, idx) => {
                const pr = specificPrs[idx];
                return (
                  <tr key={dist.label} className="border-b border-border/50">
                    <td className="py-3 text-textSecondary font-medium">{dist.label}</td>
                    {pr ? (
                      <>
                        <td className="py-3 text-center font-semibold text-textPrimary tabular-nums">
                          {formatTotalTime(pr.totalSeconds)}
                        </td>
                        <td className="py-3 text-center text-textSecondary tabular-nums">
                          {formatPaceLabel(pr.pace)} /mi
                        </td>
                        <td className="py-3 text-center text-textSecondary">
                          {pr.date.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-center text-textSecondary">—</td>
                        <td className="py-3 text-center text-textSecondary">—</td>
                        <td className="py-3 text-center text-textSecondary">—</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-textSecondary mt-3 text-center">
          {yearRuns.length} runs in {selectedYear}
        </p>
        <button
          onClick={() => askCoach(
            'What do my personal records across distances suggest ' +
            'about my fitness trajectory? Am I improving, plateauing, ' +
            'or declining? What should I do differently?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my PRs and trends
        </button>
      </Card>

      {/* ── Pace Trends (Last 8 Weeks) ───────────────────── */}
      <SectionHeader icon={TrendingUp} title="Pace Trends — Last 8 Weeks" />

      {hasPaceTrend ? (
        <Card>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={paceTrendData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
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
                formatter={(v) => [formatPaceLabel(Number(v)) + " /mi"]}
                labelFormatter={(l) => `Week of ${l}`}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value) =>
                  value === "short" ? "Short (1-3 mi)" : value === "medium" ? "Medium (3-6 mi)" : "Long (6+ mi)"
                }
              />
              <Line
                type="monotone"
                dataKey="short"
                stroke="#f97316"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="short"
              />
              <Line
                type="monotone"
                dataKey="medium"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="medium"
              />
              <Line
                type="monotone"
                dataKey="long"
                stroke="#16a34a"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="long"
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-textSecondary mt-3 text-center">
            Lower on chart = faster pace. Gaps indicate no runs in that bucket for the week.
          </p>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-textSecondary text-center">
            Not enough recent data for pace trends. Keep logging runs!
          </p>
        </Card>
      )}

      {/* ── Workout Trends (Phase 3) ────────────────────── */}
      {uid && <WorkoutTrendsSection uid={uid} workouts={workouts} />}
    </div>
  );
}
