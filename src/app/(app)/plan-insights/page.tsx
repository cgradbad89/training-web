"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Target, TrendingUp, Calendar, AlertTriangle, Shield, Layers, BotMessageSquare, Table2, ChevronDown, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { useAuth } from "@/hooks/useAuth";
import { useAppData } from "@/contexts/AppDataContext";
import { applyOverride } from "@/types/workoutOverride";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningPlan, type PlanRunType, isRunningPlan } from "@/types/plan";
import {
  RACE_DISTANCE_MILES,
  RACE_DISTANCE_LABELS,
  HALF_MARATHON_MILES,
} from "@/types/race";
import { formatPace, formatMiles } from "@/utils/pace";
import {
  resolveDisplayLoad,
  MIN_RUN_MILES_FOR_AVG,
} from "@/utils/trainingLoad";
import {
  weekStart as getWeekStart,
  parseLocalDate,
  daysUntil,
} from "@/utils/dates";
import {
  predictSeconds,
  formatRaceTime,
  formatRacePace,
  riegelConfidenceLabel,
  type RiegelFit,
} from "@/utils/riegelFit";
import { buildPlanAdherence } from "@/utils/planAdherence";
import {
  buildActualVsPlannedWeeks,
  distanceDelta,
  paceDelta,
  RUN_TYPE_LABELS,
  type DeltaTone,
} from "@/utils/planActualTable";
import {
  PlanAdherenceChart,
  type WeekAdherenceData,
} from "@/components/charts/PlanAdherenceChart";
import { PlanRunLoadChart } from "@/components/charts/PlanRunLoadChart";
import { PredictionTrendChart } from "@/components/charts/PredictionTrendChart";
import { predictRaceTime, buildPredictionTrend } from "@/utils/racePrediction";
import { buildAnchoredPredictionProjection } from "@/utils/predictionTrend";
import { buildBestEffortSegments } from "@/utils/bestEffortExtraction";
import { hydrateFastFinishSplits } from "@/services/fastFinishSplits";
import { CTL_IMPACT_SEED_DAYS } from "@/utils/runImpact";
import {
  buildDailyLoadMap,
  buildLoadEwmaSeries,
  valueNWeeksAgo,
  trendVsPast,
} from "@/utils/trainingLoadSeries";
import {
  computeConsistencyScore,
  computeConsistencyAdjustmentPct,
  applyConsistencyAdjustment,
} from "@/utils/planConsistency";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Maps an Actual-vs-Planned delta tone to its text token class. Direction
 *  rules live in planActualTable (faster pace / longer distance = positive). */
const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  positive: "text-success",
  negative: "text-danger",
  neutral: "text-textSecondary",
};

/** Parse a finish-time string ("H:MM:SS" or "M:SS") into seconds. */
function parseResultToSeconds(result: string): number | null {
  const parts = result.trim().split(":").map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((n) => !isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PlanInsightsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const router = useRouter();

  function askCoach(question: string) {
    router.push(`/coach?q=${encodeURIComponent(question)}`);
  }

  // Shared cross-page data now comes from AppDataContext instead of a per-page
  // Promise.all fetch.
  const {
    workouts: rawWorkouts,
    overrides,
    plans: allPlans,
    races,
    maxHr,
    restingHr,
    workoutsLoading,
  } = useAppData();

  // Apply overrides and drop excluded workouts — same processing the old
  // per-page fetch did inline before setting local state.
  const workouts = useMemo(
    () =>
      rawWorkouts
        .map((w) => applyOverride(w, overrides[w.workoutId] ?? null))
        .filter((w) => !overrides[w.workoutId]?.isExcluded),
    [rawWorkouts, overrides]
  );
  const plans = useMemo(() => allPlans.filter(isRunningPlan), [allPlans]);
  const loading = workoutsLoading;
  // Runs with fast-finish `mileSplits` hydrated (route-derived pace + per-mile
  // HR), for the HR-gated best-effort pipeline. Null until the async hydration
  // resolves; the segments fall back to the full-run-only path meanwhile.
  const [hydratedRuns, setHydratedRuns] = useState<HealthWorkout[] | null>(null);

  // ── Race-driven page state ─────────────────────────────────────────────────
  // Plan Insights is keyed off a user-selected race. By default we pick the
  // user's goal race (race.isActive); falling back to the soonest upcoming
  // race, then the most recent past race.
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);

  // Sorted race list for the picker — upcoming first (asc), then past (desc).
  const sortedRaces = useMemo(() => {
    const upcoming = races
      .filter((r) => daysUntil(r.raceDate) >= 0)
      .sort((a, b) => a.raceDate.localeCompare(b.raceDate));
    const past = races
      .filter((r) => daysUntil(r.raceDate) < 0)
      .sort((a, b) => b.raceDate.localeCompare(a.raceDate));
    return [...upcoming, ...past];
  }, [races]);

  // Default selection: goal race → soonest upcoming → most recent past.
  useEffect(() => {
    if (selectedRaceId) return;
    if (sortedRaces.length === 0) return;
    const goal = sortedRaces.find((r) => r.isActive);
    setSelectedRaceId((goal ?? sortedRaces[0]).id);
  }, [sortedRaces, selectedRaceId]);

  // Currently-viewed race (replaces the old activeRace useMemo).
  const activeRace = useMemo(
    () => races.find((r) => r.id === selectedRaceId) ?? null,
    [races, selectedRaceId]
  );

  // Plan linked to the selected race (replaces the old user-active-plan logic).
  const activePlan = useMemo<RunningPlan | null>(() => {
    if (!activeRace?.linkedPlanId) return null;
    return plans.find((p) => p.id === activeRace.linkedPlanId) ?? null;
  }, [plans, activeRace]);

  // Date cutoff for all run-based stats. Set to the END of race day so that
  // a run completed on race day itself (e.g. the actual race) is INCLUDED in
  // the plan totals, while runs after race day are excluded.
  const raceDateCutoff = useMemo<Date | null>(() => {
    if (!activeRace) return null;
    const d = parseLocalDate(activeRace.raceDate);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [activeRace]);

  // A race counts as past if its calendar day is on or before today
  // (string-compare ISO YYYY-MM-DD avoids timezone/midnight edge cases).
  // This lets today's race show the Actual Performance tile all day.
  const isPastRace = useMemo(() => {
    if (!activeRace) return false;
    return daysUntil(activeRace.raceDate) <= 0;
  }, [activeRace]);

  // TEMP debug: log PNC race fields so we can confirm what's set on the doc
  // when the Actual Performance tile is missing. Remove once verified.
  useEffect(() => {
    if (activeRace?.name?.includes("PNC")) {
      // eslint-disable-next-line no-console
      console.log("[PlanInsights] PNC race data:", {
        isPastRace,
        actualRunId: activeRace.actualRunId,
        actualRunDurationSeconds: activeRace.actualRunDurationSeconds,
        actualRunDistanceMiles: activeRace.actualRunDistanceMiles,
        actualRunAvgPace: activeRace.actualRunAvgPace,
        actualRunDate: activeRace.actualRunDate,
        raceDate: activeRace.raceDate,
      });
    }
  }, [activeRace, isPastRace]);

  // Race distance in miles
  const raceDistanceMiles = useMemo(() => {
    if (!activeRace) return null;
    if (activeRace.raceDistance === "custom") return activeRace.customDistanceMiles ?? null;
    return RACE_DISTANCE_MILES[activeRace.raceDistance] ?? null;
  }, [activeRace]);

  // Runs only — filtered to the race-date cutoff so post-race runs never
  // contaminate stats for a historical race. Future races: cutoff = race day,
  // so behaviour is unchanged for upcoming races.
  const runs = useMemo(() => {
    const all = workouts.filter((w) => w.isRunLike);
    if (!raceDateCutoff) return all;
    return all.filter((w) => w.startDate < raceDateCutoff);
  }, [workouts, raceDateCutoff]);

  // Hydrate fast-finish mileSplits for the recency-window runs (route-derived
  // pace + per-mile HR), behind the cheap avgBpm pre-filter so route reads are
  // spent only on runs with a genuinely hard mile. Read-only.
  useEffect(() => {
    if (!uid || runs.length === 0) {
      setHydratedRuns(null);
      return;
    }
    let cancelled = false;
    hydrateFastFinishSplits(uid, runs, { maxHr, restingHr })
      .then((res) => {
        if (!cancelled) setHydratedRuns(res.runs);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid, runs, maxHr, restingHr]);

  // Riegel fit for race prediction
  // Race inputs for ±1-day RACE-tier matching — shared by the live prediction
  // and the weekly prediction trend so both anchor on the same races.
  const raceInputs = useMemo(
    () =>
      races
        .map((r) => {
          const distance =
            r.raceDistance === "custom"
              ? r.customDistanceMiles ?? 0
              : RACE_DISTANCE_MILES[r.raceDistance] ?? 0;
          return { raceDate: r.raceDate, distanceMiles: distance };
        })
        .filter((r) => r.distanceMiles > 0),
    [races]
  );

  // HR-gated best-effort segments folded into the prediction (half+ targets
  // only). Full-run efforts derive purely from the already-loaded runs (no extra
  // reads); fast-finish / continuous efforts use the hydrated mileSplits set
  // (see the hydration effect above), whose avgBpm pre-filter keeps route reads
  // to the handful of runs with a genuinely hard mile. selectCeilingEfforts keeps
  // the fastest full-run/fixed-window effort per distance ≥5mi, while fast-finish
  // segments use their own shorter floor. See src/utils/bestEffortExtraction.ts.
  // HR anchors come from prefs.
  const bestEffortSegments = useMemo(() => {
    if (!raceDistanceMiles || raceDistanceMiles < HALF_MARATHON_MILES) return [];
    // Shared recipe — identical to the Run Detail impact tile so the two never
    // diverge. Uses the fast-finish-hydrated run set when available (route-derived
    // per-mile pace + HR), falling back to the full-run-only path until hydration
    // resolves. asOf = now for the live card; the per-week trend re-filters by
    // date inside predictRaceTime.
    return buildBestEffortSegments(
      hydratedRuns ?? runs,
      new Date(),
      maxHr,
      restingHr
    );
  }, [hydratedRuns, runs, raceDistanceMiles, maxHr, restingHr]);

  // Riegel fit for the LIVE race prediction (asOf = now). Routed through the
  // shared pure predictRaceTime so the card and the weekly trend can never
  // diverge; asOf defaults to now, reproducing the prior inline fit exactly.
  // (predictRaceTime applies the same race-anchored long-run model: races
  // dominate while fresh, 5-week half-life decay, k-clamp [1.04, 1.10] for HM+.)
  // Best-effort segments are folded in as high-weight race-effort efforts.
  // One prediction call feeds BOTH the card's fit and the projection's anchor,
  // so the dashed line can never diverge from the displayed number.
  const livePrediction = useMemo(() => {
    if (!raceDistanceMiles) return null;
    return predictRaceTime(runs, {
      raceDistanceMiles,
      races: raceInputs,
      bestEffortSegments,
    });
  }, [runs, raceDistanceMiles, raceInputs, bestEffortSegments]);
  const raceFit = livePrediction?.fit ?? null;
  const liveBaselineSeconds = livePrediction?.predictedSeconds ?? null;

  // Goal finish (seconds) from the race's target pace — the trend's reference
  // line; null when no target is set.
  const goalSeconds = useMemo(
    () =>
      activeRace?.targetPaceSecondsPerMile &&
      activeRace.targetPaceSecondsPerMile > 0 &&
      raceDistanceMiles
        ? activeRace.targetPaceSecondsPerMile * raceDistanceMiles
        : null,
    [activeRace, raceDistanceMiles]
  );

  // Weekly prediction trend — predicted finish recomputed as of each plan
  // week's end (in-memory, no storage). Empty without a plan + race distance.
  const predictionTrend = useMemo(() => {
    if (!activePlan || !raceDistanceMiles) return [];
    return buildPredictionTrend(activePlan, runs, {
      raceDistanceMiles,
      races: raceInputs,
      goalSeconds,
      bestEffortSegments,
    });
  }, [activePlan, runs, raceDistanceMiles, raceInputs, goalSeconds, bestEffortSegments]);

  // Plan-completion projection — dashed line extending the trend to race day.
  // Anchored to today's live prediction (liveBaselineSeconds) with the raw
  // blended signal applying only a bounded ±MAX_PROJECTION_ADJUSTMENT_PCT nudge,
  // so easy planned volume can't drag the number away from actual fitness. Empty
  // for past races / no remaining entries / no live prediction → the chart
  // renders the historical line only. See predictionTrend.ts.
  const predictionProjection = useMemo(() => {
    if (!activePlan || !raceDistanceMiles || !activeRace) return [];
    return buildAnchoredPredictionProjection({
      plan: activePlan,
      historicalRuns: runs,
      params: { raceDistanceMiles, races: raceInputs, bestEffortSegments },
      raceDate: parseLocalDate(activeRace.raceDate),
      liveBaselineSeconds,
    });
  }, [activePlan, runs, raceDistanceMiles, raceInputs, bestEffortSegments, activeRace, liveBaselineSeconds]);

  // Plan adherence — weekly planned vs actual (±1 day matching). Single source
  // is buildPlanAdherence; the page passes throughDate = getWeekStart(now) to
  // keep its historical "elapsed weeks only" behavior. The chart shape
  // (WeekAdherenceData) is mapped from the util's per-week result.
  const adherence = useMemo(() => {
    if (!activePlan) return null;
    return buildPlanAdherence(activePlan, runs, {
      maxHr,
      restingHr,
      throughDate: getWeekStart(new Date()),
    });
  }, [activePlan, runs, maxHr, restingHr]);

  const adherenceData = useMemo<WeekAdherenceData[]>(() => {
    if (!adherence) return [];
    return adherence.weeks.map((w) => ({
      label: w.label,
      planned: w.plannedMiles,
      actual: w.actualMiles,
      weekNumber: w.weekNumber,
      runLoad: w.runLoad,
    }));
  }, [adherence]);

  // Plan summary stats
  const planStats = useMemo(() => {
    if (!adherence || adherence.weeks.length === 0) return null;

    const weeksWithPlan = adherence.weeks.filter((w) => w.plannedMiles > 0).length;
    const adherencePct =
      weeksWithPlan > 0 ? (adherence.weeksHitTarget / weeksWithPlan) * 100 : 0;

    // Avg weekly run load across elapsed plan weeks. Sum of per-week run load
    // ÷ number of elapsed weeks. Null only when there are zero qualifying runs
    // anywhere in the elapsed plan window.
    const totalRunLoad = adherence.weeks.reduce((s, w) => s + w.runLoad, 0);
    const avgWeeklyRunLoad =
      totalRunLoad > 0 && adherence.weeks.length > 0
        ? Math.round(totalRunLoad / adherence.weeks.length)
        : null;

    return {
      totalPlanned: adherence.totalPlannedMiles,
      totalActual: adherence.totalActualMiles,
      weeksCompleted: adherence.weeks.length,
      totalWeeks: activePlan?.weeks.length ?? 0,
      weeksHit: adherence.weeksHitTarget,
      weeksWithPlan,
      adherencePct,
      avgWeeklyRunLoad,
    };
  }, [adherence, activePlan]);

  // CTL ramp-trend health for the plan-completion projection's consistency
  // credit (see src/utils/planConsistency.ts). Reuses the SAME 42d/7d EWMA
  // machinery and 4-week lookback Personal Insights already uses for its own
  // CTL trend arrows, seeded the same way computeRunImpact's computeCtlImpact
  // does (CTL_IMPACT_SEED_DAYS=180) — no new fitness model. `workouts` (not
  // `runs`) matches buildDailyLoadMap's convention of counting both run and
  // non-run load into totalLoad.
  const ctlTrend = useMemo(() => {
    if (workouts.length === 0) return null;
    const today = new Date();
    const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const earliestMs = workouts.reduce(
      (min, w) => Math.min(min, w.startDate.getTime()),
      Infinity
    );
    const seedFromWindow = new Date(todayLocal);
    seedFromWindow.setDate(todayLocal.getDate() - (CTL_IMPACT_SEED_DAYS - 1));
    const earliest = new Date(earliestMs);
    const seedStart =
      isFinite(earliestMs) && earliest > seedFromWindow
        ? new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate())
        : seedFromWindow;
    const dailyMap = buildDailyLoadMap(workouts, maxHr, restingHr);
    const series = buildLoadEwmaSeries(dailyMap, seedStart, todayLocal);
    const last = series[series.length - 1];
    const ctl4wAgo = valueNWeeksAgo(series, 4, "ctl");
    return last && ctl4wAgo != null ? trendVsPast(last.ctl, ctl4wAgo) : null;
  }, [workouts, maxHr, restingHr]);

  // Consistency credit — a SEPARATE, bounded (±2%) post-hoc adjustment on top
  // of the anchored projection, computed ONCE (today) and applied uniformly
  // to every future week. Never folded into the Riegel fit itself. See
  // src/utils/planConsistency.ts for the full blend/bound rationale.
  const consistencyScore = useMemo(() => {
    if (!planStats) return 0;
    return computeConsistencyScore({
      weeksHitTarget: planStats.weeksHit,
      weeksWithPlan: planStats.weeksWithPlan,
      ctlTrend,
    });
  }, [planStats, ctlTrend]);

  const consistencyAdjustmentPct = useMemo(
    () => computeConsistencyAdjustmentPct(consistencyScore),
    [consistencyScore]
  );

  // The chart-consumed projection — the anchored series with the consistency
  // credit applied as a pure wrapping step. buildAnchoredPredictionProjection
  // itself (predictionProjection above) is never modified.
  const finalPredictionProjection = useMemo(
    () => applyConsistencyAdjustment(predictionProjection, consistencyAdjustmentPct),
    [predictionProjection, consistencyAdjustmentPct]
  );

  // Current week in plan
  const currentPlanWeek = useMemo(() => {
    if (!activePlan) return null;
    const planStart = parseLocalDate(activePlan.startDate);
    const now = new Date();
    const weekIndex = Math.floor(
      (getWeekStart(now).getTime() - planStart.getTime()) / (7 * 86400000)
    );
    if (weekIndex < 0 || weekIndex >= activePlan.weeks.length) return null;
    return activePlan.weeks[weekIndex];
  }, [activePlan]);

  // ── Actual vs Planned table (collapsible week groups) ──────────────────────
  // In-memory derivation only — buildActualVsPlannedWeeks reuses the canonical
  // matchPlanToActual / statusForRunEntry engine. No Firestore writes. All hooks
  // here precede the `loading` early return (React error #310).
  const actualVsPlannedWeeks = useMemo(() => {
    if (!activePlan) return [];
    return buildActualVsPlannedWeeks(activePlan, runs);
  }, [activePlan, runs]);

  // Default-expanded week: the current plan week (same date math as
  // currentPlanWeek), falling back to the most-recent week when the plan is
  // finished or hasn't started.
  const defaultExpandedWeekIndex = useMemo<number | null>(() => {
    if (!activePlan || actualVsPlannedWeeks.length === 0) return null;
    const planStart = parseLocalDate(activePlan.startDate);
    const wi = Math.floor(
      (getWeekStart(new Date()).getTime() - planStart.getTime()) / (7 * 86400000)
    );
    if (wi >= 0 && wi < actualVsPlannedWeeks.length) return wi;
    return actualVsPlannedWeeks[actualVsPlannedWeeks.length - 1].weekIndex;
  }, [activePlan, actualVsPlannedWeeks]);

  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(new Set());
  const seededExpandedPlanId = useRef<string | null>(null);

  // Seed the default-expanded week once per plan; re-seeds when the selected
  // race's linked plan changes. Manual toggles afterward are preserved.
  useEffect(() => {
    const planId = activePlan?.id ?? null;
    if (!planId || defaultExpandedWeekIndex == null) return;
    if (seededExpandedPlanId.current === planId) return;
    setExpandedWeeks(new Set([defaultExpandedWeekIndex]));
    seededExpandedPlanId.current = planId;
  }, [activePlan, defaultExpandedWeekIndex]);

  function toggleWeek(weekIndex: number) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(weekIndex)) next.delete(weekIndex);
      else next.add(weekIndex);
      return next;
    });
  }

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

  // ── Recent Trends time frame: active plan start → today ────────────────────
  // Replaces the previous hardcoded 30-day (and 56-day) lookbacks. All Recent
  // Trends KPIs share this single cutoff/label so they describe one window.
  // Resolution order:
  //   1) activePlan.startDate (ISO, Monday-normalized) — always present on a
  //      linked RunningPlan, so this is the live path.
  //   2) earliest scheduled week's startDateLabel — defensive only; the field
  //      is not on the current PlanWeek type, so it's read via a cast and is
  //      tolerated if future data carries it.
  //   3) 30-day fallback (e.g. race with no linked plan), with a warning.
  const planStartDate = useMemo<Date | null>(() => {
    if (activePlan?.startDate) {
      const d = parseLocalDate(activePlan.startDate);
      if (!isNaN(d.getTime())) return d;
    }
    if (activePlan?.weeks?.length) {
      const sorted = [...activePlan.weeks].sort(
        (a, b) => a.weekNumber - b.weekNumber
      );
      const label = (sorted[0] as { startDateLabel?: string })?.startDateLabel;
      if (label) {
        const parsed = new Date(`${label} ${new Date().getFullYear()}`);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    }
    console.warn(
      "Plan Insights: could not resolve plan start date, falling back to 30-day window"
    );
    return null;
  }, [activePlan]);

  const trendCutoffMs = planStartDate
    ? planStartDate.getTime()
    : Date.now() - 30 * 24 * 60 * 60 * 1000;

  const trendLabel = planStartDate
    ? `Since plan start · ${planStartDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })}`
    : "Last 30 days";

  // runs[].startDate is a Date here; the instanceof branch is the live path.
  // The string / Timestamp branches are defensive for other shapes.
  const trendRuns = runs.filter((r) => {
    const ms =
      r.startDate instanceof Date
        ? r.startDate.getTime()
        : typeof r.startDate === "string"
          ? new Date(r.startDate).getTime()
          : (r.startDate as { toMillis?: () => number })?.toMillis?.() ?? 0;
    return ms >= trendCutoffMs;
  });

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

  const planStartMs = activePlan
    ? parseLocalDate(activePlan.startDate).getTime()
    : 0;

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

  function avgLoadStr(bucket: HealthWorkout[]): string {
    // Training Load (TRIMP) per run, averaged — same source as the runs
    // list and dashboard Load badge. Runs under MIN_RUN_MILES_FOR_AVG are
    // dropped so aborted / short runs don't skew the bucket average; their
    // individual badges still appear elsewhere in the app.
    const vals = bucket
      .filter((r) => r.distanceMiles >= MIN_RUN_MILES_FOR_AVG)
      .map((r) => resolveDisplayLoad(r, maxHr, restingHr))
      .filter((v): v is number => v != null && isFinite(v));
    if (vals.length === 0) return "—";
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return String(Math.round(avg));
  }

  function avgHRStr(bucket: HealthWorkout[]): string {
    const vals = bucket
      .map((r) => r.avgHeartRate)
      .filter((v): v is number => v !== null && v !== undefined && v > 0 && isFinite(v));
    if (vals.length === 0) return "—";
    return `${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)} bpm`;
  }

  const runTypePace = [shortRuns, mediumRuns, longRuns2].map(avgPaceStr);
  const runTypeLoad = [shortRuns, mediumRuns, longRuns2].map(avgLoadStr);
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
    <div className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl mx-auto">
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

      {/* ── Race picker ──────────────────────────────────── */}
      {sortedRaces.length === 0 ? (
        <Card>
          <EmptyState
            title="No races yet"
            description="Add a race on the Races page to see plan insights."
          />
        </Card>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="race-picker" className="text-sm text-textSecondary">
            Viewing:
          </label>
          <select
            id="race-picker"
            value={selectedRaceId ?? ""}
            onChange={(e) => setSelectedRaceId(e.target.value)}
            className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-textPrimary"
          >
            {sortedRaces.map((race) => {
              const dateLabel = parseLocalDate(race.raceDate).toLocaleDateString(
                "en-US",
                { month: "short", day: "numeric", year: "numeric" }
              );
              return (
                <option key={race.id} value={race.id}>
                  {race.name} · {dateLabel}
                  {race.isActive ? " ★" : ""}
                </option>
              );
            })}
          </select>
          {activeRace?.isActive && (
            <span className="text-xs font-medium text-success bg-success/10 px-2 py-0.5 rounded-full">
              Goal Race
            </span>
          )}
          {isPastRace && (
            <span className="text-xs font-medium text-textSecondary bg-surface px-2 py-0.5 rounded-full">
              Past Race
            </span>
          )}
        </div>
      )}

      {/* ── Race Predictions ─────────────────────────────── */}
      {activeRace && (
        <>
          <SectionHeader icon={Target} title="Race Predictions" />

          <Card className="bg-primary/5 border-primary/20">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-textPrimary">{activeRace.name}</p>
                <p className="text-xs text-textSecondary">
                  {raceDistanceLabel} · {parseLocalDate(activeRace.raceDate).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-primary tabular-nums">
                  {isPastRace
                    ? Math.abs(daysUntil(activeRace.raceDate))
                    : Math.max(0, daysUntil(activeRace.raceDate))}
                </p>
                <p className="text-xs text-textSecondary">
                  {isPastRace ? "days ago" : "days away"}
                </p>
              </div>
            </div>

            {/* Target — shown whenever set */}
            {activeRace.targetPaceSecondsPerMile && activeRace.targetPaceSecondsPerMile > 0 && raceDistanceMiles && (
              <p className="text-xs text-textSecondary mt-2">
                Target: {formatPace(activeRace.targetPaceSecondsPerMile)} /mi →{" "}
                {formatRaceTime(activeRace.targetPaceSecondsPerMile * raceDistanceMiles)}
              </p>
            )}

            {/* Actual — shown for past races with EITHER a linked run OR a
                manually-entered result string ("H:MM:SS"). Linked-run fields
                take priority; result string is a fallback for races recorded
                before the run-linking feature existed. Sub-fields render "—"
                individually when missing; pace is derived from duration and
                whichever distance source is available. */}
            {isPastRace && (activeRace.actualRunId || activeRace.result) && (() => {
              const actualSec =
                activeRace.actualRunDurationSeconds ??
                (activeRace.result ? parseResultToSeconds(activeRace.result) : null);
              // Distance to use for pace derivation: prefer the linked run's
              // recorded distance, fall back to the race's registered distance.
              const milesForPace =
                activeRace.actualRunDistanceMiles && activeRace.actualRunDistanceMiles > 0
                  ? activeRace.actualRunDistanceMiles
                  : raceDistanceMiles && raceDistanceMiles > 0
                    ? raceDistanceMiles
                    : null;
              const actualPace =
                activeRace.actualRunAvgPace && activeRace.actualRunAvgPace > 0
                  ? activeRace.actualRunAvgPace
                  : actualSec != null && milesForPace
                    ? actualSec / milesForPace
                    : null;
              const targetSec =
                activeRace.targetPaceSecondsPerMile && activeRace.targetPaceSecondsPerMile > 0 && raceDistanceMiles
                  ? activeRace.targetPaceSecondsPerMile * raceDistanceMiles
                  : null;
              const beatTarget =
                actualSec != null && targetSec != null && actualSec <= targetSec;
              const actualColorClass =
                actualSec != null && targetSec != null
                  ? beatTarget
                    ? "text-success font-medium"
                    : "text-warning font-medium"
                  : "text-textPrimary font-medium";

              return (
                <>
                  <p className="text-xs mt-1">
                    <span className="text-textSecondary">Actual: </span>
                    {actualSec != null ? (
                      <span className={actualColorClass}>
                        {actualPace != null ? `${formatPace(actualPace)} /mi → ` : ""}
                        {formatRaceTime(actualSec)}
                      </span>
                    ) : (
                      <span className="text-textSecondary">—</span>
                    )}
                  </p>

                  {/* Delta vs target */}
                  {actualSec != null && targetSec != null && (
                    <p className={`text-xs mt-1 ${beatTarget ? "text-success" : "text-warning"}`}>
                      {beatTarget
                        ? `✓ ${formatRaceTime(targetSec - actualSec)} under target`
                        : `${formatRaceTime(actualSec - targetSec)} over target`}
                    </p>
                  )}

                  {/* Delta vs prediction (preserved from removed tile) */}
                  {actualSec != null && raceFit && raceDistanceMiles && (() => {
                    const predictedSec = predictSeconds(raceFit, raceDistanceMiles);
                    const diff = predictedSec - actualSec;
                    const isUnder = diff >= 0;
                    return (
                      <p
                        className={`text-xs mt-1 ${
                          isUnder ? "text-success" : "text-textSecondary"
                        }`}
                      >
                        {formatRaceTime(Math.abs(diff))} {isUnder ? "faster" : "slower"} than predicted
                      </p>
                    );
                  })()}
                </>
              );
            })()}
          </Card>

          {raceDistanceMiles && (
            <PredictionCard
              label={raceDistanceLabel + " Prediction"}
              distanceMiles={raceDistanceMiles}
              fit={raceFit}
              targetPace={activeRace?.targetPaceSecondsPerMile}
            />
          )}

          {!raceFit && (
            <Card className="border-warning/30">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-textPrimary">Not enough data for predictions</p>
                  <p className="text-xs text-textSecondary mt-1">
                    Race predictions require at least 4 qualifying runs
                    {isPastRace ? " before the race" : " in the last 8 weeks"}.
                    {isPastRace
                      ? ""
                      : " Keep logging runs and predictions will appear automatically."}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Weekly predicted-finish trend vs. goal (recomputed each plan week).
              Only present with a linked plan + race distance; the chart itself
              shows a "not enough data yet" state until ≥2 weeks can predict. */}
          {predictionTrend.length > 0 && (
            <PredictionTrendChart
              data={predictionTrend}
              projection={finalPredictionProjection}
              consistencyCreditPct={Math.abs(consistencyAdjustmentPct) * 100}
            />
          )}
        </>
      )}

      {/* ── Plan Progress ────────────────────────────────── */}
      {activeRace && activePlan && (
        <>
          <SectionHeader icon={Calendar} title={`Plan: ${activePlan.name}`} />

          {/* Summary stats row */}
          {planStats && (
            // 5-card row: widened from md:grid-cols-4 → md:grid-cols-5 so the
            // new Avg Weekly Run Load KPI fits on one row at md+. On small
            // screens it stays 2-col and wraps naturally.
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
              <Card>
                <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
                  Avg Weekly Run Load
                </p>
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {planStats.avgWeeklyRunLoad != null
                    ? planStats.avgWeeklyRunLoad.toLocaleString()
                    : "—"}
                </p>
                <p className="text-xs text-textSecondary mt-1">
                  score · runs only
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

          {/* ── Actual vs Planned table ──────────────────────────────────────
              Per-run planned-vs-actual distance, pace, and actual avg HR,
              grouped into collapsible week rows with weighted-pace subtotals.
              Pure in-memory derivation via buildActualVsPlannedWeeks (reuses the
              canonical matching engine). */}
          <SectionHeader icon={Table2} title="Actual vs Planned" />

          <div className="bg-card rounded-2xl border border-border p-6">
            <p className="text-xs text-textSecondary mb-4">
              <span className="text-success font-medium">Positive</span> = on/ahead of plan ·{" "}
              <span className="text-danger font-medium">Negative</span> = behind plan ·{" "}
              <span className="text-textSecondary font-medium">Neutral</span> = rest/missed
            </p>

            {actualVsPlannedWeeks.some((w) => w.rows.length > 0) ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-textSecondary font-medium">Run</th>
                      <th className="text-left py-2 text-textSecondary font-medium">Type</th>
                      <th className="text-right py-2 text-textSecondary font-medium">Distance</th>
                      <th className="text-right py-2 text-textSecondary font-medium">Pace</th>
                      <th className="text-right py-2 text-textSecondary font-medium">Avg HR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actualVsPlannedWeeks.map((week) => {
                      const expanded = expandedWeeks.has(week.weekIndex);
                      const wkDist = distanceDelta(
                        week.plannedDistanceTotal,
                        week.actualDistanceTotal
                      );
                      const wkPace = paceDelta(
                        week.plannedPaceAvgSecPerMile,
                        week.actualPaceAvgSecPerMile
                      );
                      return (
                        <React.Fragment key={week.weekIndex}>
                          {/* Week subtotal / collapse toggle */}
                          <tr
                            className="border-b border-border bg-surface cursor-pointer select-none"
                            onClick={() => toggleWeek(week.weekIndex)}
                          >
                            <td colSpan={2} className="py-2.5 pr-2 font-semibold text-textPrimary">
                              <span className="inline-flex items-center gap-1.5">
                                {expanded ? (
                                  <ChevronDown size={15} className="text-textSecondary" />
                                ) : (
                                  <ChevronRight size={15} className="text-textSecondary" />
                                )}
                                {week.weekLabel}
                                <span className="font-normal text-textSecondary">
                                  · {week.dateRangeLabel}
                                </span>
                              </span>
                            </td>
                            <td className="py-2.5 text-right tabular-nums text-textPrimary">
                              {week.plannedDistanceTotal.toFixed(1)} /{" "}
                              {week.actualDistanceTotal.toFixed(1)}
                              {wkDist && (
                                <span className={`ml-1.5 text-xs ${DELTA_TONE_CLASS[wkDist.tone]}`}>
                                  {wkDist.label}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 text-right tabular-nums text-textPrimary">
                              {week.plannedPaceAvgSecPerMile != null
                                ? formatPace(week.plannedPaceAvgSecPerMile)
                                : "—"}{" "}
                              /{" "}
                              {week.actualPaceAvgSecPerMile != null
                                ? formatPace(week.actualPaceAvgSecPerMile)
                                : "—"}
                              {wkPace && (
                                <span className={`ml-1.5 text-xs ${DELTA_TONE_CLASS[wkPace.tone]}`}>
                                  {wkPace.label}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 text-right text-textSecondary">—</td>
                          </tr>

                          {/* Run rows */}
                          {expanded &&
                            week.rows.map((row, i) => {
                              const isActive =
                                row.status === "met" || row.status === "partial";
                              const labelClass = isActive
                                ? "text-textPrimary"
                                : "text-textSecondary";
                              const dDist = distanceDelta(
                                row.plannedDistanceMiles,
                                row.actualDistanceMiles
                              );
                              const dPace = paceDelta(
                                row.plannedPaceSecPerMile,
                                row.actualPaceSecPerMile
                              );
                              return (
                                <tr
                                  key={`${week.weekIndex}-${i}`}
                                  className="border-b border-border/50"
                                >
                                  <td className={`py-2 ${labelClass}`}>
                                    {row.weekday}{" "}
                                    <span className="text-textSecondary">{row.dateLabel}</span>
                                  </td>
                                  <td className={`py-2 ${labelClass}`}>
                                    {RUN_TYPE_LABELS[row.runType as PlanRunType] ??
                                      (row.runType || "—")}
                                  </td>
                                  {/* Distance — planned / actual + delta */}
                                  <td className="py-2 text-right tabular-nums">
                                    <span className={labelClass}>
                                      {row.plannedDistanceMiles != null
                                        ? row.plannedDistanceMiles.toFixed(1)
                                        : "—"}{" "}
                                      /{" "}
                                      {row.actualDistanceMiles != null
                                        ? row.actualDistanceMiles.toFixed(1)
                                        : "—"}
                                    </span>
                                    {dDist && (
                                      <span
                                        className={`ml-1.5 text-xs ${DELTA_TONE_CLASS[dDist.tone]}`}
                                      >
                                        {dDist.label}
                                      </span>
                                    )}
                                  </td>
                                  {/* Pace — planned / actual + inverted delta */}
                                  <td className="py-2 text-right tabular-nums">
                                    <span className={labelClass}>
                                      {row.plannedPaceSecPerMile != null
                                        ? formatPace(row.plannedPaceSecPerMile)
                                        : "—"}{" "}
                                      /{" "}
                                      {row.actualPaceSecPerMile != null
                                        ? formatPace(row.actualPaceSecPerMile)
                                        : "—"}
                                    </span>
                                    {dPace && (
                                      <span
                                        className={`ml-1.5 text-xs ${DELTA_TONE_CLASS[dPace.tone]}`}
                                      >
                                        {dPace.label}
                                      </span>
                                    )}
                                  </td>
                                  {/* Avg HR — run-level only, no conditional color */}
                                  <td className={`py-2 text-right tabular-nums ${labelClass}`}>
                                    {row.actualAvgHr != null ? Math.round(row.actualAvgHr) : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="No planned runs to compare yet"
                description="Once this plan has scheduled runs, they'll appear here with planned-vs-actual splits."
              />
            )}
          </div>

          {/* Weekly Run Load chart — shares adherenceData so the week buckets
              and x-axis domain line up with the mileage chart above. */}
          <PlanRunLoadChart data={adherenceData} />
        </>
      )}

      {activeRace && !activePlan && (
        <Card>
          <EmptyState
            title="No training plan linked to this race"
            description="Open this race on the Races page and pick a Training Plan to see weekly adherence tracking and mileage insights here."
          />
        </Card>
      )}

      {activeRace && (
        <>
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
                { label: "Avg Load", values: runTypeLoad },
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
            'and long runs — what does the training load and pace ' +
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
              {trendLabel}
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {trendRuns
                .reduce((s, r) => s + r.distanceMiles, 0)
                .toFixed(1)}
              <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
            </p>
            <p className="text-xs text-textSecondary mt-1">
              {trendRuns.length} runs
            </p>
          </Card>
          <Card>
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
              Avg Run Distance
            </p>
            {(() => {
              const avg = trendRuns.length > 0
                ? trendRuns.reduce((s, r) => s + r.distanceMiles, 0) / trendRuns.length
                : 0;
              return (
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {avg.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              );
            })()}
            <p className="text-xs text-textSecondary mt-1">{trendLabel}</p>
          </Card>
          <Card>
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-1">
              Longest Run
            </p>
            {(() => {
              const longest = trendRuns.length > 0
                ? Math.max(...trendRuns.map((r) => r.distanceMiles))
                : 0;
              return (
                <p className="text-2xl font-bold text-textPrimary tabular-nums">
                  {longest.toFixed(1)}
                  <span className="text-sm font-normal text-textSecondary ml-1">mi</span>
                </p>
              );
            })()}
            <p className="text-xs text-textSecondary mt-1">{trendLabel}</p>
          </Card>
        </div>
      )}
        </>
      )}
    </div>
  );
}
