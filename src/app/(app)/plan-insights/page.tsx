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
import { Target, TrendingUp, Calendar, AlertTriangle, Shield, Layers, BotMessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";

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
import { type RunningPlan, isRunningPlan } from "@/types/plan";
import { type Race, RACE_DISTANCE_MILES, RACE_DISTANCE_LABELS } from "@/types/race";
import { formatPace, formatMiles } from "@/utils/pace";
import { efficiencyDisplayScore } from "@/utils/metrics";
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
import { matchPlanToActual } from "@/utils/planMatching";

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
            contentStyle={{
              fontSize: 12,
              backgroundColor: 'var(--color-chart-tooltip-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: '0.375rem',
              color: 'var(--color-textPrimary)',
            }}
            labelStyle={{ color: 'var(--color-textSecondary)' }}
            itemStyle={{ color: 'var(--color-textPrimary)' }}
          />
          <Bar dataKey="planned" fill="var(--color-chart-primary-muted)" radius={[4, 4, 0, 0]} name="planned" />
          <Bar dataKey="actual" fill="var(--color-chart-primary)" radius={[4, 4, 0, 0]} name="actual" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-3 text-xs text-textSecondary">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'var(--color-chart-primary-muted)' }} /> Planned
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'var(--color-chart-primary)' }} /> Actual
        </span>
      </div>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PlanInsightsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const router = useRouter();

  function askCoach(question: string) {
    router.push(`/coach?q=${encodeURIComponent(question)}`);
  }

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
        setPlans(plansList.filter(isRunningPlan));
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
    if (!activeRace) return null;
    if (activeRace.raceDistance === "custom") return activeRace.customDistanceMiles ?? null;
    return RACE_DISTANCE_MILES[activeRace.raceDistance] ?? null;
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
    if (!raceDistanceMiles) return null;
    return fitRiegel(efforts, raceDistanceMiles, 0, { min: 0.9, max: 1.3 });
  }, [runs, raceDistanceMiles]);

  // Plan adherence — weekly planned vs actual (uses ±1 day matching)
  const adherenceData = useMemo<WeekAdherenceData[]>(() => {
    if (!activePlan) return [];

    const planStart = new Date(activePlan.startDate);
    const now = new Date();
    const currentWeekStart = getWeekStart(now);

    // Use the matching engine so ±1 day tolerance is applied consistently
    const matchMap = matchPlanToActual(activePlan, runs);

    return activePlan.weeks
      .filter((_, idx) => {
        const ws = new Date(planStart);
        ws.setDate(ws.getDate() + idx * 7);
        return ws <= currentWeekStart;
      })
      .map((week) => {
        const runEntries = week.entries.filter((e) => e.runType !== "rest");
        const planned = runEntries.reduce((s, e) => s + e.distanceMiles, 0);

        // Sum actual miles from matched runs (each run matched at most once)
        const matchedIds = new Set<string>();
        let actual = 0;
        for (const e of runEntries) {
          const m = matchMap.get(e.id);
          if (m && !matchedIds.has(m.activity.workoutId)) {
            actual += m.activity.distanceMiles;
            matchedIds.add(m.activity.workoutId);
          }
        }

        // Also count unmatched runs that fall within the week's date range
        // (bonus/extra runs not tied to any planned session)
        const ws = new Date(planStart);
        ws.setDate(ws.getDate() + (week.weekNumber - 1) * 7);
        const we = new Date(ws);
        we.setDate(ws.getDate() + 6);
        we.setHours(23, 59, 59, 999);

        for (const r of runs) {
          if (matchedIds.has(r.workoutId)) continue;
          if (!r.isRunLike) continue;
          if (r.startDate >= ws && r.startDate <= we) {
            actual += r.distanceMiles;
            matchedIds.add(r.workoutId);
          }
        }

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

  // ── Half Marathon Readiness computations ──────────────────────────────────

  function toMs(d: Date): number {
    return d.getTime();
  }

  const nowMs = Date.now();
  const runsLast56 = runs.filter((r) => nowMs - toMs(r.startDate) < 56 * 86400000);

  const longRunsSorted = runsLast56
    .filter((r) => r.distanceMiles >= 6)
    .sort((a, b) => toMs(b.startDate) - toMs(a.startDate));

  type ReadinessStatus = "onTrack" | "building" | "needsWork" | "insufficient";
  interface ReadinessIndicator {
    title: string;
    status: ReadinessStatus;
    detail: string;
  }

  const longRunReadiness: ReadinessIndicator = (() => {
    const recent = longRunsSorted[0];
    if (!recent)
      return {
        title: "Long Run Readiness",
        status: "insufficient",
        detail: "Need a long run (6+ mi) in the last 8 weeks.",
      };
    const mi = recent.distanceMiles;
    return {
      title: "Long Run Readiness",
      status: mi >= 9.5 ? "onTrack" : mi >= 8.0 ? "building" : "needsWork",
      detail: `Longest recent run: ${mi.toFixed(1)} mi`,
    };
  })();

  const weeklyMilesMap = new Map<string, number>();
  runs.forEach((r) => {
    const d = new Date(toMs(r.startDate));
    const day = d.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const key = monday.toISOString().split("T")[0];
    weeklyMilesMap.set(key, (weeklyMilesMap.get(key) ?? 0) + r.distanceMiles);
  });

  const thisMondayStr = (() => {
    const d = new Date();
    const day = d.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().split("T")[0];
  })();

  const completedWeeks = Array.from(weeklyMilesMap.entries())
    .filter(([k]) => k < thisMondayStr)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 4)
    .map(([, miles]) => miles);

  const volumeReadiness: ReadinessIndicator = (() => {
    if (completedWeeks.filter((m) => m > 0).length < 3)
      return {
        title: "Volume Readiness",
        status: "insufficient",
        detail: "Need more recent weekly mileage data.",
      };
    const avg = completedWeeks.reduce((a, b) => a + b, 0) / completedWeeks.length;
    const trend = (completedWeeks[0] ?? 0) - (completedWeeks[completedWeeks.length - 1] ?? 0);
    const detail =
      trend >= 2.0
        ? "Recent weekly mileage is building"
        : trend <= -2.0
          ? "Recent weekly mileage has dipped"
          : `Recent avg: ${avg.toFixed(1)} mi/week`;
    return {
      title: "Volume Readiness",
      status: avg >= 16 ? "onTrack" : avg >= 12 ? "building" : "needsWork",
      detail,
    };
  })();

  const paceReadiness: ReadinessIndicator = (() => {
    if (!raceFit || !raceDistanceMiles)
      return {
        title: "Pace Readiness",
        status: "insufficient",
        detail: "Need more recent runs of 3+ miles.",
      };
    const conf = riegelConfidenceLabel(raceFit);
    const predicted = predictSeconds(raceFit, raceDistanceMiles);
    const predStr = formatRaceTime(predicted);
    const distLabel = activeRace ? RACE_DISTANCE_LABELS[activeRace.raceDistance] : "race";
    return {
      title: "Pace Readiness",
      status: conf === "High" ? "onTrack" : conf === "Medium" ? "building" : "needsWork",
      detail: `Predicted ${distLabel}: ${predStr}`,
    };
  })();

  const driftValues = longRunsSorted
    .slice(0, 4)
    .map((r) => r.hrDriftPct)
    .filter((v): v is number => v !== null && v !== undefined && isFinite(v));

  const durabilityReadiness: ReadinessIndicator = (() => {
    if (driftValues.length < 3)
      return {
        title: "Durability Readiness",
        status: "insufficient",
        detail: "Need more long-run HR drift data.",
      };
    const avg = driftValues.reduce((a, b) => a + b, 0) / driftValues.length;
    const delta = driftValues[0] - driftValues[driftValues.length - 1];
    const detail =
      delta <= -1.0
        ? "Long-run drift is improving"
        : avg > 8.0
          ? "Long-run drift remains elevated"
          : `Avg long-run drift: ${avg.toFixed(1)}%`;
    return {
      title: "Durability Readiness",
      status: avg <= 6.0 ? "onTrack" : avg <= 8.5 ? "building" : "needsWork",
      detail,
    };
  })();

  const readinessIndicators: ReadinessIndicator[] = [
    longRunReadiness,
    volumeReadiness,
    paceReadiness,
    durabilityReadiness,
  ].filter((i) => i.status !== "insufficient");

  const overallReadiness = (() => {
    const scored = readinessIndicators;
    const onTrack = scored.filter((i) => i.status === "onTrack").length;
    const needsWork = scored.filter((i) => i.status === "needsWork").length;
    if (scored.length === 0)
      return { label: "Building", status: "building", detail: "Based on limited recent data." };
    if (needsWork >= 2)
      return {
        label: "Needs Work",
        status: "needsWork",
        detail: "Multiple readiness areas still need work.",
      };
    if (onTrack >= 2 && needsWork === 0)
      return {
        label: "On Track",
        status: "onTrack",
        detail: "Current performance trends support half marathon readiness.",
      };
    return { label: "Building", status: "building", detail: "Current readiness signals are mixed." };
  })();

  // ── Performance by Run Type (plan period) ─────────────────────────────────

  const planStartMs = activePlan ? new Date(activePlan.startDate).getTime() : 0;

  const planPeriodRuns = planStartMs > 0
    ? runs.filter((r) => toMs(r.startDate) >= planStartMs)
    : runs;

  const shortRuns = planPeriodRuns.filter((r) => r.distanceMiles >= 1 && r.distanceMiles < 3);
  const mediumRuns = planPeriodRuns.filter((r) => r.distanceMiles >= 3 && r.distanceMiles < 6);
  const longRuns2 = planPeriodRuns.filter((r) => r.distanceMiles >= 6);

  function avgPaceStr(bucket: HealthWorkout[]): string {
    let totalSec = 0,
      totalMi = 0;
    bucket.forEach((r) => {
      const mi = r.distanceMiles;
      if (mi <= 0) return;
      const sec = r.durationSeconds / mi;
      if (!isFinite(sec) || sec <= 0) return;
      totalSec += sec * mi;
      totalMi += mi;
    });
    if (totalMi === 0) return "—";
    const pace = totalSec / totalMi;
    return `${Math.floor(pace / 60)}:${String(Math.round(pace % 60)).padStart(2, "0")} /mi`;
  }

  function avgEffStr(bucket: HealthWorkout[]): string {
    // Use efficiencyDisplayScore (1–10 scale) matching runs page normalization
    const vals = bucket
      .map((r) => {
        if (!r.avgSpeedMPS || !r.avgHeartRate || r.avgSpeedMPS <= 0 || r.avgHeartRate <= 0)
          return null;
        return efficiencyDisplayScore(r.avgSpeedMPS, r.avgHeartRate);
      })
      .filter((v): v is number => v !== null && v > 0 && isFinite(v));
    if (vals.length === 0) return "—";
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return avg.toFixed(1);
  }

  function avgHRStr(bucket: HealthWorkout[]): string {
    const vals = bucket
      .map((r) => r.avgHeartRate)
      .filter((v): v is number => v !== null && v !== undefined && v > 0 && isFinite(v));
    if (vals.length === 0) return "—";
    return `${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)} bpm`;
  }

  const runTypePace = [shortRuns, mediumRuns, longRuns2].map(avgPaceStr);
  const runTypeEfficiency = [shortRuns, mediumRuns, longRuns2].map(avgEffStr);
  const runTypeHR = [shortRuns, mediumRuns, longRuns2].map(avgHRStr);
  const runTypeCount = [shortRuns, mediumRuns, longRuns2].map((b) =>
    b.length > 0 ? String(b.length) : "—"
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const raceDistanceLabel = activeRace
    ? RACE_DISTANCE_LABELS[activeRace.raceDistance] ?? activeRace.raceDistance
    : "Race";

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-textPrimary">Plan Insights</h1>
        <button
          onClick={() => askCoach(
            'Analyze my training plan adherence and progress. ' +
            'Am I on track for my race goal? What should I ' +
            'focus on in the coming weeks?'
          )}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
        >
          <BotMessageSquare className="w-4 h-4" />
          Ask AI Coach
        </button>
      </div>

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
          {activeRace.targetPaceSecondsPerMile && activeRace.targetPaceSecondsPerMile > 0 && raceDistanceMiles && (
            <p className="text-xs text-textSecondary mt-2">
              Target: {formatPace(activeRace.targetPaceSecondsPerMile)} /mi →{" "}
              {formatRaceTime(activeRace.targetPaceSecondsPerMile * raceDistanceMiles)}
            </p>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {raceDistanceMiles && (
          <PredictionCard
            label={raceDistanceLabel + " Prediction"}
            distanceMiles={raceDistanceMiles}
            fit={raceFit}
            targetPace={activeRace?.targetPaceSecondsPerMile}
          />
        )}
      </div>

      {!raceFit && (
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

      {/* ── Half Marathon Readiness ─────────────────────────── */}
      <SectionHeader icon={Shield} title={`${raceDistanceLabel} Readiness`} />

      <div className="bg-card rounded-2xl border border-border p-6">
        {/* Overall badge */}
        <div className="flex items-center gap-3 mb-5">
          <span
            className={`px-3 py-1 rounded-full text-sm font-bold ${
              overallReadiness.status === "onTrack"
                ? "bg-success/10 text-success"
                : overallReadiness.status === "building"
                  ? "bg-warning/10 text-warning"
                  : overallReadiness.status === "needsWork"
                    ? "bg-danger/10 text-danger"
                    : "bg-surface text-textSecondary"
            }`}
          >
            {overallReadiness.label}
          </span>
          <p className="text-sm text-textSecondary flex-1">{overallReadiness.detail}</p>
        </div>

        {/* 2x2 indicator grid */}
        {readinessIndicators.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {readinessIndicators.map((indicator) => (
              <div
                key={indicator.title}
                className="bg-surface rounded-xl border border-border p-4"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      indicator.status === "onTrack"
                        ? "bg-success"
                        : indicator.status === "building"
                          ? "bg-warning"
                          : indicator.status === "needsWork"
                            ? "bg-danger"
                            : "bg-border"
                    }`}
                  />
                  <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
                    {indicator.title}
                  </p>
                </div>
                <p className="text-xs text-textSecondary mt-1">{indicator.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-textSecondary">
            Not enough recent data to assess readiness. Keep logging runs!
          </p>
        )}
        <button
          onClick={() => askCoach(
            'What does my current readiness signal suggest? ' +
            'How should I adjust my training given my long run ' +
            'distance, volume, and pace readiness?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my readiness
        </button>
      </div>

      {/* ── Performance by Run Type ─────────────────────────── */}
      <SectionHeader icon={Layers} title="Performance by Run Type" />

      <div className="bg-card rounded-2xl border border-border p-6">
        <p className="text-xs text-textSecondary mb-4">
          {activePlan ? "During plan period" : "All time"}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-textSecondary font-medium w-36">Metric</th>
                <th className="text-center py-2 text-textSecondary font-medium">Short (1–3 mi)</th>
                <th className="text-center py-2 text-textSecondary font-medium">Medium (3–6 mi)</th>
                <th className="text-center py-2 text-textSecondary font-medium">Long (6+ mi)</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: "Avg Pace", values: runTypePace },
                { label: "Avg Efficiency", values: runTypeEfficiency },
                { label: "Avg HR", values: runTypeHR },
                { label: "Run Count", values: runTypeCount },
              ].map((row) => (
                <tr key={row.label} className="border-b border-border/50">
                  <td className="py-3 text-textSecondary font-medium">{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className="py-3 text-center font-semibold text-textPrimary">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          onClick={() => askCoach(
            'Looking at my performance across short, medium, ' +
            'and long runs — what does the efficiency and pace ' +
            'data suggest about where I should focus my training?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my run performance
        </button>
      </div>

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
