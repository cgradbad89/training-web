"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";
import { Target, TrendingUp, Calendar, AlertTriangle } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchPlans } from "@/services/plans";
import { fetchRaces } from "@/services/races";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { applyOverride } from "@/types/workoutOverride";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningPlan } from "@/types/plan";
import { type Race, RACE_DISTANCE_MILES, RACE_DISTANCE_LABELS } from "@/types/race";
import { formatPace, formatMiles } from "@/utils/pace";
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

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.ceil((target.getTime() - now.getTime()) / 86400000);
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-widest text-textSecondary mb-4">
      {children}
    </h2>
  );
}

function SectionHeader({ icon: Icon, title }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon size={18} className="text-primary" />
      <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    </div>
  );
}

// ─── Race Prediction Card ────────────────────────────────────────────────────

interface PredictionCardProps {
  label: string;
  distanceMiles: number;
  fit: RiegelFit | null;
  targetPace?: number;
}

function PredictionCard({ label, distanceMiles, fit, targetPace }: PredictionCardProps) {
  const predicted = fit ? predictSeconds(fit, distanceMiles) : null;
  const predictedPace = predicted && distanceMiles > 0 ? predicted / distanceMiles : null;
  const confidence = fit ? riegelConfidenceLabel(fit) : null;

  const vsTarget = predicted && targetPace && targetPace > 0
    ? predicted - targetPace * distanceMiles
    : null;

  const confidenceLevel: "good" | "ok" | "low" =
    confidence === "High" ? "good" : confidence === "Medium" ? "ok" : "low";

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
          {label}
        </p>
        {confidence && (
          <MetricBadge label="Fit" value={confidence} level={confidenceLevel} />
        )}
      </div>

      {predicted ? (
        <>
          <p className="text-3xl font-bold text-textPrimary tabular-nums">
            {formatRaceTime(predicted)}
          </p>
          <p className="text-sm text-textSecondary mt-1">
            {formatRacePace(predicted, distanceMiles)}
          </p>

          {vsTarget !== null && (
            <p className="text-xs mt-2">
              {vsTarget <= 0 ? (
                <span className="text-success">
                  {formatRaceTime(Math.abs(vsTarget))} under target
                </span>
              ) : (
                <span className="text-danger">
                  {formatRaceTime(vsTarget)} over target
                </span>
              )}
            </p>
          )}

          <p className="text-xs text-textSecondary mt-2">
            Based on {fit!.n} efforts (R² {fit!.r2.toFixed(2)})
          </p>
        </>
      ) : (
        <p className="text-sm text-textSecondary">
          Not enough recent run data for prediction.
          Need 4+ qualifying runs in the last 8 weeks.
        </p>
      )}
    </Card>
  );
}

// ─── Weekly Plan Adherence Chart ─────────────────────────────────────────────

interface WeekAdherenceData {
  label: string;
  planned: number;
  actual: number;
  weekNumber: number;
}

function PlanAdherenceChart({ data }: { data: WeekAdherenceData[] }) {
  if (data.length === 0) return null;

  return (
    <Card>
      <CardTitle>Weekly Mileage — Plan vs Actual</CardTitle>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart
          data={data}
          barGap={2}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={30}
          />
          <Tooltip
            formatter={(v, name) => [
              `${Number(v).toFixed(1)} mi`,
              name === "planned" ? "Planned" : "Actual",
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="planned" fill="#93c5fd" radius={[4, 4, 0, 0]} name="planned" />
          <Bar dataKey="actual" fill="#2563eb" radius={[4, 4, 0, 0]} name="actual" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-3 text-xs text-textSecondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-[#93c5fd]" /> Planned
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-[#2563eb]" /> Actual
        </span>
      </div>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PlanInsightsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [plans, setPlans] = useState<RunningPlan[]>([]);
  const [races, setRaces] = useState<Race[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;

    setLoading(true);
    Promise.all([
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchAllOverrides(uid),
      fetchPlans(uid),
      fetchRaces(uid),
    ])
      .then(([wkts, overrides, plansList, racesList]) => {
        // Apply overrides and filter excluded
        const processed = wkts
          .map((w) => applyOverride(w, overrides[w.workoutId] ?? null))
          .filter((w) => !overrides[w.workoutId]?.isExcluded);
        setWorkouts(processed);
        setPlans(plansList);
        setRaces(racesList);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid]);

  // Active plan — the one marked isActive, or most recently started
  const activePlan = useMemo(() => {
    const active = plans.find((p) => p.isActive);
    if (active) return active;
    return plans.length > 0
      ? plans.sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
      : null;
  }, [plans]);

  // Active race — the upcoming soonest, or most recent past
  const activeRace = useMemo(() => {
    const now = new Date().toISOString().split("T")[0];
    const upcoming = races
      .filter((r) => r.raceDate >= now)
      .sort((a, b) => a.raceDate.localeCompare(b.raceDate));
    if (upcoming.length > 0) return upcoming[0];
    const past = races.sort((a, b) => b.raceDate.localeCompare(a.raceDate));
    return past[0] ?? null;
  }, [races]);

  // Race distance in miles
  const raceDistanceMiles = useMemo(() => {
    if (!activeRace) return 13.109;
    if (activeRace.raceDistance === "custom") return activeRace.customDistanceMiles ?? 13.109;
    return RACE_DISTANCE_MILES[activeRace.raceDistance] ?? 13.109;
  }, [activeRace]);

  // Runs only
  const runs = useMemo(() => workouts.filter((w) => w.isRunLike), [workouts]);

  // Riegel fit for race prediction
  const raceFit = useMemo(() => {
    const efforts = buildQualifyingEfforts(
      runs.map((r) => ({
        workoutId: r.workoutId,
        distanceMiles: r.distanceMiles,
        durationSeconds: r.durationSeconds,
        startDate: r.startDate,
        activityType: r.activityType,
        sourceName: r.sourceName,
      })),
      56
    );
    return fitRiegel(efforts, raceDistanceMiles, 0, { min: 0.9, max: 1.3 });
  }, [runs, raceDistanceMiles]);

  // 5K fit
  const fiveKFit = useMemo(() => {
    const efforts = buildQualifyingEfforts(
      runs.map((r) => ({
        workoutId: r.workoutId,
        distanceMiles: r.distanceMiles,
        durationSeconds: r.durationSeconds,
        startDate: r.startDate,
        activityType: r.activityType,
        sourceName: r.sourceName,
      })),
      56
    );
    return fitRiegel(efforts, 3.107, 0, { min: 0.9, max: 1.3 });
  }, [runs]);

  // Plan adherence — weekly planned vs actual
  const adherenceData = useMemo<WeekAdherenceData[]>(() => {
    if (!activePlan) return [];

    const planStart = new Date(activePlan.startDate);
    const now = new Date();
    const currentWeekStart = getWeekStart(now);

    return activePlan.weeks
      .filter((_, idx) => {
        const ws = new Date(planStart);
        ws.setDate(ws.getDate() + idx * 7);
        return ws <= currentWeekStart;
      })
      .map((week, idx) => {
        const ws = new Date(planStart);
        ws.setDate(ws.getDate() + idx * 7);
        const we = new Date(ws);
        we.setDate(ws.getDate() + 6);
        we.setHours(23, 59, 59, 999);

        const planned = week.entries.reduce((s, e) => s + e.distanceMiles, 0);
        const actual = runs
          .filter((r) => {
            const d = r.startDate;
            return d >= ws && d <= we;
          })
          .reduce((s, r) => s + r.distanceMiles, 0);

        return {
          label: `W${week.weekNumber}`,
          planned,
          actual,
          weekNumber: week.weekNumber,
        };
      });
  }, [activePlan, runs]);

  // Plan summary stats
  const planStats = useMemo(() => {
    if (adherenceData.length === 0) return null;

    const totalPlanned = adherenceData.reduce((s, w) => s + w.planned, 0);
    const totalActual = adherenceData.reduce((s, w) => s + w.actual, 0);
    const weeksHit = adherenceData.filter((w) => w.planned > 0 && w.actual >= w.planned * 0.85).length;
    const weeksWithPlan = adherenceData.filter((w) => w.planned > 0).length;
    const adherencePct = weeksWithPlan > 0 ? (weeksHit / weeksWithPlan) * 100 : 0;

    return {
      totalPlanned,
      totalActual,
      weeksCompleted: adherenceData.length,
      totalWeeks: activePlan?.weeks.length ?? 0,
      weeksHit,
      weeksWithPlan,
      adherencePct,
    };
  }, [adherenceData, activePlan]);

  // Current week in plan
  const currentPlanWeek = useMemo(() => {
    if (!activePlan) return null;
    const planStart = new Date(activePlan.startDate);
    const now = new Date();
    const weekIndex = Math.floor(
      (getWeekStart(now).getTime() - planStart.getTime()) / (7 * 86400000)
    );
    if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return null;
    return activePlan.weeks[weekIndex];
  }, [activePlan]);

  // This week's actual mileage
  const thisWeekMiles = useMemo(() => {
    const ws = getWeekStart(new Date());
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    we.setHours(23, 59, 59, 999);
    return runs
      .filter((r) => r.startDate >= ws && r.startDate <= we)
      .reduce((s, r) => s + r.distanceMiles, 0);
  }, [runs]);

  const thisWeekPlanned = currentPlanWeek
    ? currentPlanWeek.entries.reduce((s, e) => s + e.distanceMiles, 0)
    : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const raceDistanceLabel = activeRace
    ? RACE_DISTANCE_LABELS[activeRace.raceDistance] ?? activeRace.raceDistance
    : "Half Marathon";

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl">
      <h1 className="text-2xl font-bold text-textPrimary">Plan Insights</h1>

      {/* ── Race Predictions ─────────────────────────────── */}
      <SectionHeader icon={Target} title="Race Predictions" />

      {activeRace && (
        <Card className="bg-primary/5 border-primary/20">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-textPrimary">{activeRace.name}</p>
              <p className="text-xs text-textSecondary">
                {raceDistanceLabel} · {new Date(activeRace.raceDate).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-primary tabular-nums">
                {Math.max(0, daysUntil(activeRace.raceDate))}
              </p>
              <p className="text-xs text-textSecondary">days away</p>
            </div>
          </div>
          {activeRace.targetPaceSecondsPerMile && activeRace.targetPaceSecondsPerMile > 0 && (
            <p className="text-xs text-textSecondary mt-2">
              Target: {formatPace(activeRace.targetPaceSecondsPerMile)} /mi →{" "}
              {formatRaceTime(activeRace.targetPaceSecondsPerMile * raceDistanceMiles)}
            </p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PredictionCard
          label={raceDistanceLabel + " Prediction"}
          distanceMiles={raceDistanceMiles}
          fit={raceFit}
          targetPace={activeRace?.targetPaceSecondsPerMile}
        />
        <PredictionCard
          label="5K Prediction"
          distanceMiles={3.107}
          fit={fiveKFit}
        />
      </div>

      {!raceFit && !fiveKFit && (
        <Card className="border-warning/30">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-textPrimary">Not enough data for predictions</p>
              <p className="text-xs text-textSecondary mt-1">
                Race predictions require at least 4 qualifying runs in the last 8 weeks.
                Keep logging runs and predictions will appear automatically.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* ── Plan Progress ────────────────────────────────── */}
      {activePlan && (
        <>
          <SectionHeader icon={Calendar} title={`Plan: ${activePlan.name}`} />

          {/* Summary stats row */}
          {planStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
                  Progress
                </p>
                <p className="text-2xl font-bold text-textPrimary">
                  {planStats.weeksCompleted}
                  <span className="text-sm font-normal text-textSecondary ml-1">
                    / {planStats.totalWeeks} wks
                  </span>
                </p>
              </Card>
              <Card>
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
                  Adherence
                </p>
                <p className="text-2xl font-bold text-textPrimary">
                  {planStats.adherencePct.toFixed(0)}%
                </p>
                <p className="text-xs text-textSecondary mt-1">
                  {planStats.weeksHit} of {planStats.weeksWithPlan} weeks hit target
                </p>
              </Card>
              <Card>
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
                  Total Planned
                </p>
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {planStats.totalPlanned.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              </Card>
              <Card>
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
                  Total Actual
                </p>
                <p className={`text-2xl font-bold tabular-nums ${
                  planStats.totalActual >= planStats.totalPlanned * 0.85
                    ? "text-success"
                    : "text-textPrimary"
                }`}>
                  {planStats.totalActual.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              </Card>
            </div>
          )}

          {/* This week progress bar */}
          {currentPlanWeek && thisWeekPlanned > 0 && (
            <Card>
              <div className="flex justify-between items-center mb-2">
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
                  This Week — Week {currentPlanWeek.weekNumber}
                </p>
                <p className="text-sm text-textSecondary tabular-nums">
                  {thisWeekMiles.toFixed(1)} / {thisWeekPlanned.toFixed(1)} mi
                </p>
              </div>
              <div className="h-3 bg-surface rounded-full overflow-hidden border border-border">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    thisWeekMiles >= thisWeekPlanned ? "bg-success" : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(100, (thisWeekMiles / thisWeekPlanned) * 100)}%` }}
                />
              </div>
            </Card>
          )}

          {/* Plan vs Actual chart */}
          <PlanAdherenceChart data={adherenceData} />
        </>
      )}

      {!activePlan && (
        <Card>
          <EmptyState
            title="No active training plan"
            description="Create a plan to see weekly adherence tracking and mileage insights."
          />
        </Card>
      )}

      {/* ── Training Trend ───────────────────────────────── */}
      <SectionHeader icon={TrendingUp} title="Recent Trends" />

      {runs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
              Last 30 Days
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {runs
                .filter((r) => r.startDate >= new Date(Date.now() - 30 * 86400000))
                .reduce((s, r) => s + r.distanceMiles, 0)
                .toFixed(1)}
              <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
            </p>
            <p className="text-xs text-textSecondary mt-1">
              {runs.filter((r) => r.startDate >= new Date(Date.now() - 30 * 86400000)).length} runs
            </p>
          </Card>
          <Card>
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
              Avg Run Distance
            </p>
            {(() => {
              const recent = runs.filter((r) => r.startDate >= new Date(Date.now() - 30 * 86400000));
              const avg = recent.length > 0
                ? recent.reduce((s, r) => s + r.distanceMiles, 0) / recent.length
                : 0;
              return (
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {avg.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              );
            })()}
          </Card>
          <Card>
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
              Longest Run (8 wks)
            </p>
            {(() => {
              const recent = runs.filter((r) => r.startDate >= new Date(Date.now() - 56 * 86400000));
              const longest = recent.length > 0
                ? Math.max(...recent.map((r) => r.distanceMiles))
                : 0;
              return (
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {longest.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              );
            })()}
          </Card>
        </div>
      )}
    </div>
  );
}
