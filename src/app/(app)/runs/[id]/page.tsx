"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeft, Pencil, RotateCcw } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { MileSplitsTable } from "@/components/MileSplitsTable";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";
import { ZoneBreakdown } from "@/components/ZoneBreakdown";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatBlock } from "@/components/ui/StatBlock";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { WeatherTile } from "@/components/runs/WeatherTile";
import { RoutePerformanceSection } from "@/components/runs/RoutePerformanceSection";
import { RunImpactSection } from "@/components/runs/RunImpactSection";
import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import {
  backfillRouteClusterIds,
  computeAndStoreBestEfforts,
  fetchHealthWorkout,
  fetchHealthWorkoutsInRange,
  fetchLatestWorkoutId,
  fetchWorkoutsByRouteCluster,
  saveRouteClusterId,
  saveRunDetailCaches,
  saveWeatherForWorkout,
  type RunDetailCacheWrites,
} from "@/services/healthWorkouts";
import { type RoutePoint } from "@/services/routes";
import { getRoutePoints } from "@/utils/routeCache";
import { hydrateFastFinishSplits } from "@/services/fastFinishSplits";
import { fetchUserSettings } from "@/services/userSettings";
import { fetchRaces } from "@/services/races";
import { fetchShoes, fetchManualShoeAssignmentsMap, saveManualAssignments } from "@/services/shoes";
import { useResolvedShoeAssignment } from "@/hooks/useResolvedShoeAssignment";
import {
  fetchOverride,
  fetchAllOverrides,
  saveOverride,
  deleteOverride,
  excludeWorkout,
  restoreWorkout,
} from "@/services/workoutOverrides";
import {
  type HealthWorkout,
} from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";
import {
  type WorkoutOverride,
  applyOverride,
} from "@/types/workoutOverride";
import { formatPace, formatDuration } from "@/utils/pace";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { buildRunTitleMap, findActiveRunningPlan } from "@/utils/runPlanTitle";
import { fetchPlans } from "@/services/plans";
import { type RunningPlan } from "@/types/plan";
import {
  distanceBucket,
  driftLevel,
} from "@/utils/metrics";
import { computeMileSplits, type MileSplit } from "@/utils/mileSplits";
import {
  computeRunGap,
  selectGapDisplay,
  type RunGap,
} from "@/utils/gradeAdjustedPace";
import {
  deriveEffectiveHasRoute,
  isRoutePresent,
  isRouteSyncing,
} from "@/utils/routeAvailability";
import {
  resolveMaxHr,
  resolveRestingHr,
  resolveDisplayLoad,
} from "@/utils/trainingLoad";
import {
  deriveRouteClusterId,
  isNolocClusterId,
} from "@/utils/routeClusterId";
import {
  computeOverlayChartCache,
  gapByPointFromPerPoint,
} from "@/utils/overlayChartCache";
import {
  splitsFromCachedDocs,
  cachedGapPerMile,
  mileSplitCacheWrites,
} from "@/utils/mileSplitDocs";
import { simplifyPolyline } from "@/utils/simplifyPolyline";
import { computeZoneBreakdown } from "@/utils/zoneBreakdown";
import { routeCachesComplete } from "@/utils/runDetailCacheGate";
import {
  computeRoutePerformance,
  toMatchedRunSummaries,
} from "@/utils/routePerformance";
import {
  computeRunImpact,
  computeCtlImpact,
  computeCtlImpactFromCache,
  CTL_IMPACT_SEED_DAYS,
  type CtlImpact,
} from "@/utils/runImpact";
import {
  recentImpactWindowStart,
  ctlSeedWindowStart,
  planTitleWindow,
} from "@/utils/runDetailQueryWindows";
import {
  isAggregatedStatsStale,
  reviveAggregatedStatsDates,
  type AggregatedStatsDoc,
} from "@/utils/aggregatedStats";
import { parseLocalDate } from "@/utils/dates";
import { type Race, RACE_DISTANCE_MILES } from "@/types/race";
import { type UserSettings } from "@/types/userSettings";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  getMileSplits,
  saveMileSplitCache,
  type MileSplitDoc,
} from "@/utils/mileSplitsCache";
import { fetchWeatherForRun } from "@/lib/weather";

const RunMap = dynamic(() => import("@/components/RunMap"), { ssr: false });

// Recharts-backed charts are lazy-loaded (client-only) so the run-detail route
// ships less JS up front; a ChartSkeleton holds each chart's space while the
// chunk streams in. Props/behavior/colors unchanged.
const MileSplitCharts = dynamic(
  () => import("@/components/MileSplitCharts").then((m) => m.MileSplitCharts),
  { ssr: false, loading: () => <ChartSkeleton height={300} /> },
);
const RunOverlayChart = dynamic(
  () => import("@/components/RunOverlayChart").then((m) => m.RunOverlayChart),
  { ssr: false, loading: () => <ChartSkeleton height={320} /> },
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Douglas–Peucker tolerance (metres) for the cached map path. 3 m keeps every
 * turn visually intact while collapsing dense straight-line runs of GPS points.
 * TUNABLE — product owner may adjust after a visual review of routed runs.
 */
const SIMPLIFY_TOLERANCE_METERS = 3;

function getDriftBadgeLevel(
  workout: HealthWorkout
): "good" | "ok" | "high" | "neutral" {
  if (workout.hrDriftPct == null) return "neutral";
  return driftLevel(
    workout.hrDriftPct,
    distanceBucket(workout.distanceMiles)
  );
}

function parseDuration(s: string): number | null {
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workoutId = params.id as string;
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [workout, setWorkout] = useState<HealthWorkout | null>(null);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>(
    {}
  );
  const [override, setOverride] = useState<WorkoutOverride | null>(null);
  const [perMileHR, setPerMileHR] = useState<Record<number, number>>({});
  // Raw mileSplits subcollection docs (null until read) and the splits rebuilt
  // from them when the cache is complete (null = cache miss → compute from
  // route points and write back). basisMiles records the authoritative
  // distance the cached splits were computed against, so an in-session
  // distance edit falls back to a fresh computation.
  const [mileSplitDocs, setMileSplitDocs] = useState<MileSplitDoc[] | null>(
    null
  );
  const [cachedSplits, setCachedSplits] = useState<{
    splits: MileSplit[];
    basisMiles: number;
  } | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>();
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(true);
  const [activeRunningPlan, setActiveRunningPlan] = useState<RunningPlan | null>(null);

  // Route Performance + Run Impact data — loaded in a SEPARATE, non-blocking
  // effect so the core run view never waits on the all-workouts query.
  const [allWorkoutsRaw, setAllWorkoutsRaw] = useState<HealthWorkout[] | null>(
    null
  );
  const [allOverrides, setAllOverrides] = useState<Record<
    string,
    WorkoutOverride
  > | null>(null);
  const [races, setRaces] = useState<Race[]>([]);
  // Plan-title mapping data source: a narrow ±2-day window around the VIEWED
  // run's date (not today), so this run gets the same plan-entry label the Runs
  // list shows even when it falls outside the account's most recent workouts.
  const [planWindowWorkouts, setPlanWindowWorkouts] = useState<
    HealthWorkout[] | null
  >(null);
  // Route Performance data source: the runs sharing this run's deterministic
  // routeClusterId (narrow where-query — replaces the geographic clustering
  // over the all-workouts scan). clusterBackfillDone gates the query so the
  // one-time lazy ID backfill lands before membership is read.
  const [clusterRuns, setClusterRuns] = useState<HealthWorkout[] | null>(null);
  const [clusterBackfillDone, setClusterBackfillDone] = useState(false);
  // Insights run set with fast-finish `mileSplits` hydrated (route-derived pace +
  // per-mile HR). Null until the async hydration resolves; the impact tile falls
  // back to the full-run-only prediction meanwhile.
  const [hydratedInsightsRuns, setHydratedInsightsRuns] = useState<
    HealthWorkout[] | null
  >(null);

  // Edit panel state
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formDistance, setFormDistance] = useState("");
  const [formDuration, setFormDuration] = useState("");
  const [formRunType, setFormRunType] = useState("");
  const [selectedShoeId, setSelectedShoeId] = useState<string | null>(null);

  // Exclude state
  const [excluding, setExcluding] = useState(false);
  const [showExcludeConfirm, setShowExcludeConfirm] = useState(false);

  // Unsaved-changes warning for the edit form
  const editFormDirty = isEditing && (
    formDistance !== "" ||
    formDuration !== "" ||
    formRunType !== "" ||
    selectedShoeId !== (assignments[workoutId] ?? null)
  );
  useUnsavedChanges(editFormDirty);

  // Compute mile splits unconditionally (before early returns) to satisfy Rules of Hooks
  const displayWorkoutForSplits = workout ? applyOverride(workout, override) : null;
  const mileSplits = useMemo<MileSplit[]>(
    () => {
      // Cached path: splits persisted on the mileSplits subcollection are used
      // verbatim when their distance basis still matches (an in-session
      // distance edit invalidates them and falls through to the fresh
      // computation below).
      if (
        cachedSplits &&
        displayWorkoutForSplits &&
        Math.abs(cachedSplits.basisMiles - displayWorkoutForSplits.distanceMiles) <=
          0.005
      ) {
        return cachedSplits.splits;
      }
      if (routePoints.length < 2 || !displayWorkoutForSplits) return [];
      const computed = computeMileSplits(
        routePoints,
        displayWorkoutForSplits.avgHeartRate,
        displayWorkoutForSplits.distanceMiles
      );
      // Merge in per-mile HR from iOS-synced subcollection
      return computed.map((split) => ({
        ...split,
        avgBpm: perMileHR[split.mile] ?? undefined,
      }));
    },
    [cachedSplits, routePoints, displayWorkoutForSplits, perMileHR]
  );

  // Compute grade-adjusted pace once from the already-fetched route points.
  // (No new Firestore read.) Kept before any early return per Rules of Hooks.
  const runGap = useMemo<RunGap>(
    () => {
      if (routePoints.length < 2 || !displayWorkoutForSplits) {
        return {
          runGapSecPerMile: 0,
          perPointGap: [],
          perMileGapSecPerMile: [],
          netRiseM: null,
          aggregateGradeFlat: false,
        };
      }
      return computeRunGap(
        routePoints,
        displayWorkoutForSplits.distanceMiles,
        displayWorkoutForSplits.durationSeconds,
        displayWorkoutForSplits.avgPaceSecPerMile
      );
    },
    [routePoints, displayWorkoutForSplits]
  );

  // Per-mile GAP for the Mile Splits table: the cached subcollection column
  // (index = mile-1) when every mile has it and its basis still matches,
  // otherwise the freshly computed series. Kept before any early return.
  const gapPerMile = useMemo<number[]>(() => {
    if (mileSplitDocs && displayWorkoutForSplits) {
      const cached = cachedGapPerMile(
        mileSplitDocs,
        displayWorkoutForSplits.distanceMiles
      );
      if (cached) return cached;
    }
    return runGap.perMileGapSecPerMile;
  }, [mileSplitDocs, displayWorkoutForSplits, runGap]);

  // NET elevation (ft) for the elevation KPI's secondary line. Prefer the live
  // GAP computation (Total cumulative ascent and Net stay consistent); on the
  // route-skip (cache-hit) path runGap has no geometry, so fall back to the
  // cached gapNetRiseM persisted alongside the GAP KPI. Negative = net descent.
  // Hidden when unavailable (no NaN).
  const netRiseM =
    runGap.netRiseM != null
      ? runGap.netRiseM
      : displayWorkoutForSplits?.gapNetRiseM ?? null;
  const netRiseFt = netRiseM != null ? Math.round(netRiseM * 3.28084) : null;
  const netElevationLabel =
    netRiseFt != null
      ? `Net ${netRiseFt > 0 ? "+" : netRiseFt < 0 ? "−" : ""}${Math.abs(
          netRiseFt
        )} ft`
      : undefined;

  // Resolve the shoe the SAME way the listing page does: auto-assign rules
  // overlaid with the manual map (manual wins, incl. explicit "no shoe").
  // Hook called unconditionally before any early return; null workout → null.
  const resolvedShoeId = useResolvedShoeAssignment(
    displayWorkoutForSplits,
    shoes,
    assignments
  );
  const resolvedMaxHR = resolveMaxHr(userSettings);
  const resolvedRestingHR = resolveRestingHr(userSettings);

  useEffect(() => {
    if (!uid || !workoutId) return;
    let cancelled = false;
    setLoading(true);
    setRouteLoading(true);

    void (async () => {
      // ── Wave 1: core doc + shoe/override/settings, and the mileSplits
      //    subcollection. All cheap (a single doc get + a small subcollection);
      //    none is the big `route` read. These decide whether the route read is
      //    needed at all, so they run first.
      let core: {
        w: HealthWorkout | null;
        o: WorkoutOverride | null;
        settings: UserSettings | null | undefined;
      } | null = null;
      try {
        const [w, s, a, o, settings] = await Promise.all([
          fetchHealthWorkout(uid, workoutId),
          fetchShoes(uid),
          fetchManualShoeAssignmentsMap(uid),
          fetchOverride(uid, workoutId),
          fetchUserSettings(uid),
        ]);
        if (cancelled) return;
        setWorkout(w);
        setShoes(s);
        setAssignments(a);
        setOverride(o);
        setUserSettings(settings);
        core = { w, o, settings };
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (cancelled) return;
      if (!core || !core.w) {
        if (!cancelled) setRouteLoading(false);
        return;
      }
      const { w, o, settings } = core;

      // mileSplits subcollection (per-mile HR + the web app's cached
      // distance/pace/GAP). For routeless workouts this is empty and safe.
      let splits: MileSplitDoc[] | null = null;
      try {
        splits = await getMileSplits(uid, workoutId);
        if (cancelled) return;
        setMileSplitDocs(splits);
        const hrMap: Record<number, number> = {};
        splits.forEach((data) => {
          if (data.avgBpm && (data.sampleCount as number) >= 2) {
            hrMap[data.mile as number] = data.avgBpm as number;
          }
        });
        setPerMileHR(hrMap);
      } catch (err) {
        console.error(err);
      }

      const authoritativeMiles =
        o?.distanceMilesOverride ?? w.distanceMiles ?? 0;
      const maxHr = resolveMaxHr(settings);
      const thresholdPace = settings?.thresholdPaceSecPerMile ?? null;
      // A distance/duration override changes GAP + the mile basis; the KPI GAP
      // cache carries no basis, so any such override forces a live recompute
      // from the route regardless of what is cached.
      const basisOverride =
        o?.distanceMilesOverride != null || o?.durationSecondsOverride != null;
      const splitsHaveGap =
        splits != null && cachedGapPerMile(splits, authoritativeMiles) != null;

      // ── Route-fetch gate. Skip the big `route` read only when every
      //    route-derived cache the page renders is present & fresh AND there is
      //    no basis override. Otherwise fetch once and back-fill the gaps.
      const needsRoute =
        basisOverride || !routeCachesComplete(w, { maxHr, thresholdPace, splitsHaveGap });

      if (!needsRoute) {
        if (splits) {
          const cached = splitsFromCachedDocs(splits, authoritativeMiles);
          if (cached) {
            setCachedSplits({ splits: cached, basisMiles: authoritativeMiles });
          }
        }
        // Fully cached — render map/GAP/zones/splits from the doc; no route read.
        if (!cancelled) {
          setRoutePoints([]);
          setRouteLoading(false);
        }
        return;
      }

      // ── Cache miss: read the route once, render live, and back-fill.
      let points: RoutePoint[] | null = null;
      try {
        points = await getRoutePoints(uid, workoutId);
        if (cancelled) return;
        setRoutePoints(points);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setRouteLoading(false);
      }
      if (cancelled || !points) return;

      // Cached splits validation (distance/pace/HR) — unchanged.
      if (splits && isRoutePresent(points.length)) {
        const cached = splitsFromCachedDocs(splits, authoritativeMiles);
        if (cached) {
          setCachedSplits({ splits: cached, basisMiles: authoritativeMiles });
        }
      }

      // Weather backfill: a GPS run with no stored weather gets its start
      // conditions fetched and persisted. Failures are swallowed.
      if (w.weather == null && points.length > 0) {
        fetchWeatherForRun(points[0].lat, points[0].lng, w.startDate)
          .then((weather) => {
            if (cancelled || !weather) return;
            setWorkout((current) =>
              current ? { ...current, weather } : current
            );
            saveWeatherForWorkout(uid, workoutId, weather).catch(console.error);
          })
          .catch(console.error);
      }

      if (isRoutePresent(points.length)) {
        // Natural new-run hook: best efforts computed here (route already read).
        if (w.bestEfforts === undefined) {
          computeAndStoreBestEfforts(uid, workoutId, points)
            .then((bestEfforts) => {
              if (!cancelled) {
                setWorkout((current) =>
                  current ? { ...current, bestEfforts } : current
                );
              }
            })
            .catch(console.error);
        }

        // Deterministic route-cluster ID (raw distance; noloc re-derived).
        if (
          w.isRunLike &&
          (w.routeClusterId === undefined || isNolocClusterId(w.routeClusterId))
        ) {
          const clusterId = deriveRouteClusterId(w.distanceMiles, {
            lat: points[0].lat,
            lng: points[0].lng,
          });
          if (clusterId !== w.routeClusterId) {
            saveRouteClusterId(uid, workoutId, clusterId)
              .then(() => {
                if (!cancelled) {
                  setWorkout((current) =>
                    current ? { ...current, routeClusterId: clusterId } : current
                  );
                }
              })
              .catch(console.error);
          }
        }

        // ── Route-derived caches computed from the SAME route read and merge-
        //    written back in one pass. GAP is computed once (from RAW workout
        //    values) and reused for the KPI, the overlay per-point series, and
        //    (via the mile-split cache effect) the per-mile column. Skipped for
        //    a still-syncing partial route (routeComplete === false).
        if (w.routeComplete !== false) {
          const rawGap = computeRunGap(
            points,
            w.distanceMiles,
            w.durationSeconds,
            w.avgPaceSecPerMile
          );
          const updates: RunDetailCacheWrites = {};

          const overlay = w.overlayChartCache;
          const overlayStale =
            overlay === undefined ||
            overlay.sourcePointCount !== points.length ||
            overlay.gapSecPerMile.length !== overlay.distancesMiles.length;
          if (overlayStale) {
            const gapByPoint = gapByPointFromPerPoint(
              rawGap.perPointGap,
              points.length
            );
            const chartCache = computeOverlayChartCache(points, gapByPoint);
            if (chartCache) updates.overlayChartCache = chartCache;
          }

          // KPI GAP: cache the value AND its two sublabel signals (net rise +
          // flat flag) together, so a legacy gapSecPerMile-only doc self-heals
          // the missing sublabels on this one route read. Cache only when there
          // is no basis override (needsRoute is already true in that case, so
          // this branch never runs then anyway). gapNetRiseM may be null — a
          // valid cached value (stripUndefined keeps null), distinct from the
          // "never cached" undefined the gate treats as incomplete.
          const gapKpiCacheMissing =
            w.gapSecPerMile === undefined ||
            w.gapNetRiseM === undefined ||
            w.gapAggregateGradeFlat === undefined;
          if (
            gapKpiCacheMissing &&
            !basisOverride &&
            rawGap.runGapSecPerMile > 0
          ) {
            updates.gapSecPerMile = rawGap.runGapSecPerMile;
            updates.gapNetRiseM = rawGap.netRiseM;
            updates.gapAggregateGradeFlat = rawGap.aggregateGradeFlat;
          }

          const zb = w.zoneBreakdown;
          const zoneStale =
            zb === undefined ||
            zb.maxHr !== maxHr ||
            zb.thresholdPaceSecPerMile !== thresholdPace;
          if (zoneStale) {
            updates.zoneBreakdown = computeZoneBreakdown(
              points,
              maxHr,
              thresholdPace
            );
          }

          if (w.simplifiedPath === undefined) {
            updates.simplifiedPath = simplifyPolyline(
              points,
              SIMPLIFY_TOLERANCE_METERS
            );
          }

          if (Object.keys(updates).length > 0) {
            saveRunDetailCaches(uid, workoutId, updates)
              .then(() => {
                if (!cancelled) {
                  setWorkout((current) =>
                    current ? { ...current, ...updates } : current
                  );
                }
              })
              .catch(console.error);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid, workoutId]);

  // ── Route Performance + Run Impact data (deferred, non-blocking) ──────────
  // Two narrow, purpose-specific reads replace the old unconditional 500-doc
  // cap: a 56-day recency window (feeds the prediction impact, fast-finish
  // hydration, and the routeClusterId backfill) and a ±2-day window around the
  // VIEWED run's date (feeds plan-title mapping). No new collections/rules.
  const runStartMs = workout ? workout.startDate.getTime() : null;
  useEffect(() => {
    if (!uid || runStartMs == null) return;
    let cancelled = false;

    const recentSince = recentImpactWindowStart(new Date());
    const planWin = planTitleWindow(new Date(runStartMs));

    Promise.all([
      fetchHealthWorkoutsInRange(uid, recentSince),
      fetchAllOverrides(uid),
      fetchRaces(uid),
      fetchHealthWorkoutsInRange(uid, planWin.start, planWin.end),
    ])
      .then(([recent, overrides, fetchedRaces, planWorkouts]) => {
        if (cancelled) return;
        setAllWorkoutsRaw(recent);
        setAllOverrides(overrides);
        setRaces(fetchedRaces);
        setPlanWindowWorkouts(planWorkouts);

        // One-time lazy migration: assign routeClusterId to any run-like,
        // routed workout still missing it (start-point read + merge write per
        // missing run — the SAME per-run start-point read the old geographic
        // clustering paid on every view). Fed by the 56-day recency window (the
        // closest still-running superset); any run viewed also self-heals its
        // own ID in Wave 1 above. Gates the narrow cluster query so first-view
        // membership is complete.
        backfillRouteClusterIds(uid, recent)
          .catch(console.error)
          .then(() => {
            if (!cancelled) setClusterBackfillDone(true);
          });
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid, runStartMs]);

  // Route Performance membership — one narrow equality query on the current
  // run's deterministic routeClusterId (typically a handful of docs) instead
  // of geographic clustering over the all-workouts scan. Always accurate: the
  // ranking is recomputed from the queried docs on every view; nothing about
  // the aggregate is cached.
  const currentClusterId = workout?.routeClusterId ?? null;
  useEffect(() => {
    if (!uid || !currentClusterId || !clusterBackfillDone) return;
    let cancelled = false;
    fetchWorkoutsByRouteCluster(uid, currentClusterId)
      .then((runs) => {
        if (!cancelled) setClusterRuns(runs);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid, currentClusterId, clusterBackfillDone]);

  // Insights run set — overrides applied, excluded filtered (the same shaping
  // Personal/Plan Insights use), so the prediction here matches those pages.
  const workoutsForInsights = useMemo(() => {
    if (!allWorkoutsRaw || !allOverrides) return null;
    return allWorkoutsRaw
      .map((w) => applyOverride(w, allOverrides[w.workoutId] ?? null))
      .filter((w) => !allOverrides[w.workoutId]?.isExcluded);
  }, [allWorkoutsRaw, allOverrides]);

  // Hydrate fast-finish mileSplits across the recency-window insights runs (not
  // just the viewed run), so the impact tile credits an easy-start / hard-finish
  // run the whole-run HR gate rejects. The avgBpm pre-filter keeps route reads to
  // runs with a genuinely hard mile; route reads are cached. Read-only.
  useEffect(() => {
    if (!uid || !workoutsForInsights) {
      setHydratedInsightsRuns(null);
      return;
    }
    let cancelled = false;
    hydrateFastFinishSplits(uid, workoutsForInsights, {
      maxHr: resolvedMaxHR,
      restingHr: resolvedRestingHR,
    })
      .then((res) => {
        if (!cancelled) setHydratedInsightsRuns(res.runs);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid, workoutsForInsights, resolvedMaxHR, resolvedRestingHR]);

  const matchedSummaries = useMemo(
    () =>
      clusterRuns
        ? toMatchedRunSummaries(clusterRuns, resolvedMaxHR, resolvedRestingHR)
        : [],
    [clusterRuns, resolvedMaxHR, resolvedRestingHR]
  );

  const routePerformance = useMemo(
    () => computeRoutePerformance(workoutId, matchedSummaries),
    [workoutId, matchedSummaries]
  );

  // The route's nominal distance = the fastest matched run's distance (the
  // same "representative run" rule clusterRoutesGeographic used).
  const routeDistanceMiles = useMemo(() => {
    if (!clusterRuns || clusterRuns.length === 0) return null;
    const rep = [...clusterRuns].sort(
      (a, b) => (a.avgPaceSecPerMile ?? 999) - (b.avgPaceSecPerMile ?? 999)
    )[0];
    return rep.distanceMiles ?? 0;
  }, [clusterRuns]);

  // Write freshly computed mile splits (distance/pace/GAP) back to the
  // mileSplits subcollection (once per workout+distance basis) so the next view
  // reads them instead of recomputing from the full route. Skipped only when
  // BOTH the splits AND the per-mile GAP are already cached at the current
  // basis, while the route is still partially syncing, or before the
  // subcollection docs are known (their IDs are the merge targets). When only
  // the GAP is missing (a run cached by an earlier build), the write still
  // fires — but not until the route points are present so a real GAP series is
  // available (never persist an all-zero GAP).
  const wroteMileCacheFor = useRef<string | null>(null);
  useEffect(() => {
    if (!uid || !workout || !displayWorkoutForSplits) return;
    if (workout.routeComplete === false) return;
    if (mileSplitDocs === null || mileSplits.length === 0) return;
    const basisMiles = displayWorkoutForSplits.distanceMiles;
    const splitsCached =
      cachedSplits && Math.abs(cachedSplits.basisMiles - basisMiles) <= 0.005;
    const gapCached = cachedGapPerMile(mileSplitDocs, basisMiles) != null;
    if (splitsCached && gapCached) {
      return; // fully cached — nothing new to persist
    }
    // Need a real GAP series to persist when it isn't cached yet.
    if (!gapCached && routePoints.length < 2) return;
    const writeKey = `${workoutId}:${basisMiles}`;
    if (wroteMileCacheFor.current === writeKey) return;
    wroteMileCacheFor.current = writeKey;
    saveMileSplitCache(
      uid,
      workoutId,
      mileSplitCacheWrites(mileSplits, gapPerMile, mileSplitDocs, basisMiles)
    ).catch(console.error);
  }, [
    uid,
    workoutId,
    workout,
    displayWorkoutForSplits,
    cachedSplits,
    mileSplitDocs,
    mileSplits,
    gapPerMile,
    routePoints,
  ]);

  // Active goal race + its distance/inputs (same mapping Plan Insights uses).
  const activeRace = useMemo(
    () => races.find((r) => r.isActive) ?? null,
    [races]
  );
  const raceDistanceMiles = useMemo(() => {
    if (!activeRace) return null;
    if (activeRace.raceDistance === "custom")
      return activeRace.customDistanceMiles ?? null;
    return RACE_DISTANCE_MILES[activeRace.raceDistance] ?? null;
  }, [activeRace]);
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

  // Prediction impact — runs only, capped at end of race day (parity with
  // Plan Insights; for an upcoming race the cutoff is in the future → no-op).
  // Routes through computeRunImpact, which folds the SAME §7b HR-gated
  // best-effort segments the dashboard uses (per-set, incl. the fast-finish
  // segments hydrated above), so the "with" number matches the dashboard's
  // projection.
  const predictionImpact = useMemo(() => {
    const insightsRuns = hydratedInsightsRuns ?? workoutsForInsights;
    if (!insightsRuns || !activeRace || !raceDistanceMiles) return null;
    const cutoff = parseLocalDate(activeRace.raceDate);
    cutoff.setHours(23, 59, 59, 999);
    const predictionRuns = insightsRuns.filter(
      (w) => w.isRunLike && w.startDate <= cutoff
    );
    return computeRunImpact(
      predictionRuns,
      workoutId,
      { raceDistanceMiles, races: raceInputs },
      resolvedMaxHR,
      resolvedRestingHR
    );
  }, [
    hydratedInsightsRuns,
    workoutsForInsights,
    activeRace,
    raceDistanceMiles,
    raceInputs,
    workoutId,
    resolvedMaxHR,
    resolvedRestingHR,
  ]);

  // CTL impact — read from the cached aggregatedStats training-load series when
  // it is FRESH (isAggregatedStatsStale === false), subtracting this run's own
  // decayed EWMA contribution mathematically (no 180-day read). This page never
  // triggers an aggregatedStats recompute: on a stale/absent cache it falls back
  // to the live computeCtlImpact over a dedicated 180-day seed read so the EWMA
  // keeps its full window. Freshness is checked against the latest workout id
  // (a 1-doc read), independent of the narrowed recency window (which may be
  // empty for an inactive user).
  const [ctlImpact, setCtlImpact] = useState<CtlImpact | null>(null);
  const runLoadV2 = workout?.trainingLoadV2 ?? null;
  const runAvgHr = workout?.avgHeartRate ?? null;
  useEffect(() => {
    if (!uid || !workout) {
      setCtlImpact(null);
      return;
    }
    let cancelled = false;
    const viewedRun = applyOverride(workout, override);

    void (async () => {
      const [statsSnap, latestWorkoutId] = await Promise.all([
        getDoc(doc(db, `users/${uid}/insights/aggregatedStats`)),
        fetchLatestWorkoutId(uid),
      ]);
      if (cancelled) return;

      const cached = statsSnap.exists()
        ? reviveAggregatedStatsDates(statsSnap.data() as AggregatedStatsDoc)
        : null;

      // Fresh cache → linear cache subtraction (no full workout read).
      if (cached && !isAggregatedStatsStale(cached, latestWorkoutId)) {
        const fromCache = computeCtlImpactFromCache(
          viewedRun,
          cached.trainingLoad.series,
          resolvedMaxHR,
          resolvedRestingHR
        );
        if (!cancelled) setCtlImpact(fromCache);
        return;
      }

      // Stale/absent → live compute over a dedicated 180-day window (overrides
      // applied + excluded filtered, matching the insights run shaping). Never
      // recomputes/writes aggregatedStats.
      const [seedWorkouts, overrides] = await Promise.all([
        fetchHealthWorkoutsInRange(uid, ctlSeedWindowStart(new Date())),
        fetchAllOverrides(uid),
      ]);
      if (cancelled) return;
      const shaped = seedWorkouts
        .map((w) => applyOverride(w, overrides[w.workoutId] ?? null))
        .filter((w) => !overrides[w.workoutId]?.isExcluded);
      const live = computeCtlImpact(
        shaped,
        workoutId,
        resolvedMaxHR,
        resolvedRestingHR
      );
      if (!cancelled) setCtlImpact(live);
    })().catch((err) => {
      if (!cancelled) console.error("[ctlImpact]", err);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uid,
    workoutId,
    runStartMs,
    runLoadV2,
    runAvgHr,
    override,
    resolvedMaxHR,
    resolvedRestingHR,
  ]);

  // Active running plan → priority-1 plan label. Cheap one-shot fetch; the
  // match is computed over the deferred all-workouts set so this run gets the
  // SAME entry assignment the Runs list shows.
  useEffect(() => {
    if (!uid) return;
    fetchPlans(uid)
      .then((plans) => setActiveRunningPlan(findActiveRunningPlan(plans)))
      .catch((err) => console.error("[fetchPlans]", err));
  }, [uid]);

  const runTitleMap = useMemo(
    () => buildRunTitleMap(activeRunningPlan, planWindowWorkouts ?? []),
    [activeRunningPlan, planWindowWorkouts]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!workout) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-textSecondary">Workout not found</p>
        <button
          onClick={() => router.back()}
          className="text-primary text-sm font-medium"
        >
          Go back
        </button>
      </div>
    );
  }

  // Apply override for display
  const displayWorkout = applyOverride(workout, override);
  const matchedPlanEntry = runTitleMap.get(displayWorkout.workoutId) ?? null;
  // Cached simplified map path (>= 2 pts). Present ⇒ the route existed and was
  // read on an earlier view, so it also proves route availability on a
  // route-skip render where routePoints is empty.
  const cachedMapPath =
    displayWorkout.simplifiedPath && displayWorkout.simplifiedPath.length >= 2
      ? displayWorkout.simplifiedPath
      : null;
  // Derive route availability from the DATA, not just the parent flag. The iOS
  // headless sync can leave `hasRoute: false` on a doc that nonetheless has a
  // populated `route` subcollection; once we've read >= 2 points (or cached a
  // simplified path from an earlier read), render the run as routed regardless
  // of the flag. (< 2 points and no cache → unchanged no-route UI.)
  const effectiveHasRoute =
    deriveEffectiveHasRoute(displayWorkout.hasRoute, routePoints.length) ||
    cachedMapPath != null;
  // A renderable route path exists from either the freshly read points or the
  // cached simplified path (the route-skip render path).
  const hasRoutePath = routePoints.length > 0 || cachedMapPath != null;
  // Display-only hint: iOS marks an in-progress route with `routeComplete:
  // false`. We still render every point we have — this never gates rendering.
  // Absent (legacy) or true → no hint.
  const routeSyncing = isRouteSyncing(displayWorkout.routeComplete);
  const isExcluded = override?.isExcluded === true;
  const hasOverrides =
    override != null &&
    (override.distanceMilesOverride != null ||
      override.durationSecondsOverride != null ||
      override.runTypeOverride != null);

  // Shoe assignment — resolved above via useResolvedShoeAssignment so the
  // detail page matches the listing page (auto-rule overlay; manual wins).
  const assignedShoeId = resolvedShoeId;
  const assignedShoe = shoes.find((s) => s.id === assignedShoeId) ?? null;
  const shoeName = assignedShoe
    ? assignedShoe.name ||
      `${assignedShoe.brand} ${assignedShoe.model}`.trim()
    : null;
  const activeShoes = shoes.filter((s) => !s.isRetired);

  // Date formatting
  const startDate = new Date(displayWorkout.startDate);
  const dateDisplay = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeDisplay = startDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  // Combined meta-row format: "Sat Jun 7 · 6:42 AM". Strip the comma en-US adds
  // after the short weekday; native Intl only, no date library.
  const dateTimeDisplay = `${dateDisplay.replace(",", "")} · ${timeDisplay}`;

  // HR Drift
  const driftBadgeLevel = getDriftBadgeLevel(displayWorkout);
  const driftStr =
    displayWorkout.hrDriftPct != null
      ? `${displayWorkout.hrDriftPct.toFixed(1)}%`
      : "\u2014";

  // Edit form handlers
  function openEdit() {
    setFormDistance(
      override?.distanceMilesOverride != null
        ? String(override.distanceMilesOverride)
        : ""
    );
    setFormDuration(
      override?.durationSecondsOverride != null
        ? formatDuration(override.durationSecondsOverride)
        : ""
    );
    setFormRunType(override?.runTypeOverride ?? displayWorkout.displayType);
    setSelectedShoeId(assignedShoeId);
    setIsEditing(true);
  }

  async function handleSave() {
    if (!uid || !workout) return;
    setSaving(true);
    const overrideObj: WorkoutOverride = {
      workoutId: workout.workoutId,
      userId: uid,
      isExcluded: override?.isExcluded ?? false,
      excludedAt: override?.excludedAt ?? null,
      excludedReason: override?.excludedReason ?? null,
      distanceMilesOverride: formDistance ? Number(formDistance) : null,
      durationSecondsOverride: formDuration
        ? parseDuration(formDuration)
        : null,
      runTypeOverride:
        formRunType !== workout.displayType ? formRunType : null,
      updatedAt: new Date().toISOString(),
    };
    await saveOverride(uid, overrideObj);
    setOverride(overrideObj);
    if (selectedShoeId !== assignedShoeId) {
      await saveManualAssignments(uid, { [workout.workoutId]: selectedShoeId });
      setAssignments((prev) => ({ ...prev, [workout.workoutId]: selectedShoeId }));
    }
    setIsEditing(false);
    setSaving(false);
  }

  async function handleReset() {
    if (!uid) return;
    setSaving(true);
    if (override?.isExcluded) {
      await saveOverride(uid, {
        ...override,
        distanceMilesOverride: null,
        durationSecondsOverride: null,
        runTypeOverride: null,
      });
      setOverride({
        ...override,
        distanceMilesOverride: null,
        durationSecondsOverride: null,
        runTypeOverride: null,
      });
    } else {
      await deleteOverride(uid, workoutId);
      setOverride(null);
    }
    setIsEditing(false);
    setSaving(false);
  }

  async function handleExclude() {
    if (!uid) return;
    setExcluding(true);
    await excludeWorkout(uid, workoutId);
    const updated = await fetchOverride(uid, workoutId);
    setOverride(updated);
    setShowExcludeConfirm(false);
    setExcluding(false);
  }

  async function handleRestore() {
    if (!uid) return;
    setExcluding(true);
    await restoreWorkout(uid, workoutId);
    const updated = await fetchOverride(uid, workoutId);
    setOverride(updated);
    setExcluding(false);
  }

  // Live pace preview
  const previewPace = (() => {
    const dist = formDistance ? Number(formDistance) : null;
    const dur = formDuration ? parseDuration(formDuration) : null;
    const effectiveDist = dist ?? displayWorkout.distanceMiles;
    const effectiveDur = dur ?? displayWorkout.durationSeconds;
    if (effectiveDist && effectiveDist > 0 && effectiveDur > 0) {
      return formatPace(effectiveDur / effectiveDist);
    }
    return null;
  })();

  return (
    <div className="max-w-4xl mx-auto px-2 py-4 lg:px-6 lg:py-6 flex flex-col gap-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-xl hover:bg-surface transition-colors text-textSecondary"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <h1 className="text-lg font-bold text-textPrimary truncate">
            {resolveActivityTitle({
              activityType: displayWorkout.displayType,
              distanceMiles: displayWorkout.distanceMiles,
              matchedPlanEntry,
            })}{" "}
            &middot; {dateDisplay}
          </h1>
          {hasOverrides && (
            <span className="text-[10px] bg-warning/15 text-warning px-2 py-0.5 rounded-full font-semibold shrink-0">
              Edited
            </span>
          )}
          {isExcluded && (
            <span className="text-[10px] bg-danger/15 text-danger px-2 py-0.5 rounded-full font-semibold shrink-0">
              Excluded
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {shoeName && (
            <span className="text-xs bg-success/10 text-success px-2.5 py-1 rounded-full font-medium">
              {shoeName}
            </span>
          )}
          {!isEditing && (
            <button
              onClick={openEdit}
              className="p-2 rounded-xl hover:bg-surface transition-colors text-textSecondary"
              title="Edit workout"
            >
              <Pencil size={16} />
            </button>
          )}
          {isExcluded ? (
            <button
              onClick={handleRestore}
              disabled={excluding}
              className="text-xs text-primary font-medium hover:underline disabled:opacity-50"
            >
              Restore
            </button>
          ) : (
            <button
              onClick={() => setShowExcludeConfirm(true)}
              className="text-xs text-danger font-medium hover:underline"
            >
              Exclude
            </button>
          )}
        </div>
      </div>

      {/* ── Exclude confirm ─────────────────────────────────── */}
      <ConfirmDialog
        isOpen={showExcludeConfirm}
        title="Exclude this run?"
        message="This run will be hidden from your stats and insights. You can un-exclude it later."
        confirmLabel="Exclude"
        confirmVariant="danger"
        onConfirm={handleExclude}
        onCancel={() => setShowExcludeConfirm(false)}
        loading={excluding}
      />

      {/* ── Edit Panel ──────────────────────────────────────── */}
      {isEditing && (
        <div className="bg-card rounded-2xl border border-border p-5">
          <h2 className="text-sm font-semibold text-textPrimary mb-1">
            Edit Workout Data
          </h2>
          <p className="text-xs text-textSecondary mb-4">
            Overrides are layered on top of HealthKit data. Original data is
            preserved and can be restored anytime.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-textSecondary block mb-1">
                Distance (mi)
              </label>
              <input
                type="number"
                step="0.01"
                value={formDistance}
                onChange={(e) => setFormDistance(e.target.value)}
                placeholder={workout.distanceMiles.toFixed(2)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <span className="text-[10px] text-textSecondary mt-0.5 block">
                Original: {workout.distanceMiles.toFixed(2)} mi
              </span>
            </div>
            <div>
              <label className="text-xs text-textSecondary block mb-1">
                Duration (H:MM:SS or M:SS)
              </label>
              <input
                type="text"
                value={formDuration}
                onChange={(e) => setFormDuration(e.target.value)}
                placeholder={formatDuration(workout.durationSeconds)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <span className="text-[10px] text-textSecondary mt-0.5 block">
                Original: {formatDuration(workout.durationSeconds)}
              </span>
            </div>
          </div>

          {workout.isRunLike && (
            <div className="mt-4">
              <label className="text-xs text-textSecondary block mb-1.5">
                Run Type
              </label>
              <div className="flex gap-2 flex-wrap">
                {["Run", "Treadmill Run", "OTF", "Long Run"].map((type) => (
                  <button
                    key={type}
                    onClick={() => setFormRunType(type)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-full transition-colors ${
                      formRunType === type
                        ? "bg-primary text-white"
                        : "border border-border text-textSecondary hover:text-textPrimary"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <label className="text-xs text-textSecondary block mb-1">
              Shoe
            </label>
            {activeShoes.length === 0 ? (
              <p className="text-sm text-textSecondary">
                No shoes registered —{" "}
                <a href="/shoes" className="text-primary hover:underline">
                  add shoes on the Shoes page
                </a>
              </p>
            ) : (
              <select
                value={selectedShoeId ?? ""}
                onChange={(e) => setSelectedShoeId(e.target.value || null)}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">— No shoe —</option>
                {activeShoes.map((shoe) => {
                  const name = shoe.name || `${shoe.brand} ${shoe.model}`.trim();
                  return (
                    <option key={shoe.id} value={shoe.id}>
                      {name}{shoe.brand && shoe.name ? ` · ${shoe.brand}` : ""}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {previewPace && (formDistance || formDuration) && (
            <p className="text-sm text-primary font-medium mt-3">
              New pace: {previewPace} /mi
            </p>
          )}

          <div className="flex gap-2 mt-4 pt-4 border-t border-border">
            <button
              onClick={() => setIsEditing(false)}
              className="px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
            {hasOverrides && (
              <button
                onClick={handleReset}
                disabled={saving}
                className="flex items-center gap-1 px-4 py-2 text-sm text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors disabled:opacity-50 ml-auto"
              >
                <RotateCcw size={14} />
                Reset to Original
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Stats Grid ──────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-5">
          <StatBlock
            label="Distance"
            value={
              displayWorkout.distanceMiles > 0
                ? displayWorkout.distanceMiles.toFixed(2)
                : "\u2014"
            }
            unit={displayWorkout.distanceMiles > 0 ? "mi" : undefined}
          />
          <StatBlock
            label="Pace"
            value={
              displayWorkout.avgPaceSecPerMile
                ? formatPace(displayWorkout.avgPaceSecPerMile)
                : "\u2014"
            }
            unit={displayWorkout.avgPaceSecPerMile ? "/mi" : undefined}
          />
          {(() => {
            // Prefer the cached run-level GAP (no route read) when there is no
            // distance/duration override \u2014 the cache carries no basis, so an
            // override falls back to the live route computation. Dead-band/flat
            // runs show the actual pace labelled "flat"; "\u2014" is reserved for
            // runs with no route/elevation data at all. On the route-skip path
            // the cached gapAggregateGradeFlat flag drives the "flat" sublabel,
            // mirroring selectGapDisplay on the live-compute path.
            const useCachedGap =
              override?.distanceMilesOverride == null &&
              override?.durationSecondsOverride == null &&
              displayWorkout.gapSecPerMile != null &&
              displayWorkout.gapSecPerMile > 0 &&
              runGap.runGapSecPerMile <= 0;
            const gapDisplay = useCachedGap
              ? displayWorkout.gapAggregateGradeFlat
                ? {
                    mode: "flat" as const,
                    paceSecPerMile: displayWorkout.gapSecPerMile!,
                  }
                : {
                    mode: "value" as const,
                    paceSecPerMile: displayWorkout.gapSecPerMile!,
                  }
              : selectGapDisplay(runGap);
            return (
              <StatBlock
                label="GAP"
                value={
                  gapDisplay.mode === "none"
                    ? "\u2014"
                    : formatPace(gapDisplay.paceSecPerMile)
                }
                unit={gapDisplay.mode === "none" ? undefined : "/mi"}
                sublabel={gapDisplay.mode === "flat" ? "flat" : undefined}
              />
            );
          })()}
          <StatBlock
            label="Duration"
            value={formatDuration(displayWorkout.durationSeconds)}
          />
          <StatBlock
            label="Avg HR"
            value={
              displayWorkout.avgHeartRate
                ? Math.round(displayWorkout.avgHeartRate).toString()
                : "\u2014"
            }
            unit={displayWorkout.avgHeartRate ? "bpm" : undefined}
          />
          <StatBlock
            label="Calories"
            value={
              displayWorkout.calories
                ? Math.round(displayWorkout.calories).toString()
                : "\u2014"
            }
            unit={displayWorkout.calories ? "kcal" : undefined}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-textSecondary uppercase tracking-wide">
              Training Load
            </span>
            <TrainingLoadBadge
              score={resolveDisplayLoad(
                displayWorkout,
                resolvedMaxHR,
                resolvedRestingHR
              )}
              avgHeartRate={displayWorkout.avgHeartRate}
              activityType={displayWorkout.activityType}
              maxHr={resolvedMaxHR}
              restingHr={resolvedRestingHR}
              durationSeconds={displayWorkout.durationSeconds}
              trainingLoadMethod={displayWorkout.trainingLoadMethod}
              size="large"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-textSecondary uppercase tracking-wide flex items-center">
              HR Drift
              <InfoTooltip
                ariaLabel="About HR Drift"
                content={
                  <div className="flex flex-col gap-1.5">
                    <p>
                      <strong>HR Drift</strong> measures the percentage change in heart rate between the first and second halves of your run.
                    </p>
                    <p>
                      Thresholds are mileage-dependent and evaluate absolute drift:
                    </p>
                    <ul className="list-disc pl-3.5 space-y-0.5 mt-0.5">
                      <li><strong>1–3 mi:</strong> Good ≤5%, OK ≤10%</li>
                      <li><strong>3–6 mi:</strong> Good ≤7%, OK ≤12%</li>
                      <li><strong>6+ mi:</strong> Good ≤10%, OK ≤15%</li>
                    </ul>
                  </div>
                }
              />
            </span>
            <MetricBadge
              label="Drift"
              value={driftStr}
              level={driftStr === "\u2014" ? "neutral" : driftBadgeLevel}
            />
          </div>
          <StatBlock
            label="Cadence"
            value={
              displayWorkout.cadenceSPM != null
                ? Math.round(displayWorkout.cadenceSPM).toString()
                : "\u2014"
            }
            unit={displayWorkout.cadenceSPM != null ? "spm" : undefined}
          />
        </div>

        {/* Second row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mt-5 pt-5 border-t border-border items-start">
          <StatBlock
            label="Total Ascent"
            value={
              displayWorkout.elevationGainM != null
                ? Math.round(displayWorkout.elevationGainM * 3.28084).toString()
                : "\u2014"
            }
            unit={displayWorkout.elevationGainM != null ? "ft" : undefined}
            sublabel={netElevationLabel}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-textSecondary uppercase tracking-wide">
              {"Date & Time"}
            </span>
            <span className="text-sm font-medium text-textPrimary">
              {dateTimeDisplay}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-textSecondary uppercase tracking-wide">Shoe</span>
            {assignedShoe ? (
              <>
                <span className="text-sm font-semibold text-textPrimary leading-tight">
                  {assignedShoe.name || `${assignedShoe.brand} ${assignedShoe.model}`.trim()}
                </span>
                {assignedShoe.brand && assignedShoe.name && (
                  <span className="text-xs text-textSecondary">{assignedShoe.brand}</span>
                )}
              </>
            ) : (
              <span className="text-sm text-textSecondary italic">No shoe assigned</span>
            )}
          </div>
          {displayWorkout.weather && (
            <WeatherTile weather={displayWorkout.weather} />
          )}
        </div>
      </div>

      {/* ── PR Badges ───────────────────────────────────────── */}
      {displayWorkout.prBadges && displayWorkout.prBadges.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {displayWorkout.prBadges.map((badge) => (
            <span
              key={badge}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-500 border border-amber-500/25"
            >
              🏅 {badge}
            </span>
          ))}
        </div>
      )}

      {/* ── Route Performance (renders only when matched to a ≥2-run group) ─ */}
      {routePerformance && routeDistanceMiles != null && (
        <RoutePerformanceSection
          performance={routePerformance}
          matchedRuns={matchedSummaries}
          currentRunId={workoutId}
          routeDistanceMiles={routeDistanceMiles}
        />
      )}

      {/* ── This Run's Impact (independent of route matching) ── */}
      {displayWorkout.isRunLike && (predictionImpact || ctlImpact) && (
        <RunImpactSection
          prediction={
            predictionImpact && activeRace
              ? {
                  impact: predictionImpact,
                  raceName: activeRace.name,
                  raceDateIso: activeRace.raceDate,
                }
              : null
          }
          ctl={ctlImpact}
        />
      )}

      {/* ── Route Map ───────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {routeLoading ? (
          <div className="h-64 sm:h-96 bg-surface animate-pulse" />
        ) : effectiveHasRoute && hasRoutePath ? (
          <>
            <RunMap
              points={routePoints}
              simplifiedPath={cachedMapPath ?? undefined}
            />
            {routeSyncing && (
              <div className="px-4 py-2 border-t border-border">
                <p className="text-xs text-textSecondary">
                  Route still syncing — showing the portion received so far.
                </p>
              </div>
            )}
          </>
        ) : effectiveHasRoute ? (
          <div className="h-64 sm:h-96 flex items-center justify-center">
            <p className="text-sm text-textSecondary">
              Route data not yet synced
            </p>
          </div>
        ) : (
          <div className="h-40 flex items-center justify-center">
            <p className="text-sm text-textSecondary">
              No GPS route available for this run
            </p>
          </div>
        )}
      </div>

      {/* ── Mile Splits ────────────────────────────────────── */}
      <MileSplitsTable
        splits={mileSplits}
        routeLoading={routeLoading}
        hasRoute={effectiveHasRoute}
        gapPerMile={gapPerMile}
      />

      {/* ── Pace & HR Charts ───────────────────────────────── */}
      <MileSplitCharts
        splits={mileSplits}
        hasRoute={effectiveHasRoute}
      />

      {/* ── Overlaid Analysis Chart (elevation + pace + GAP + HR) ─
          Renders from the persisted decimated cache while the route
          subcollection is still loading; switches to the raw points (with the
          GAP overlay) once they arrive. */}
      {effectiveHasRoute &&
        (routePoints.length > 1 || displayWorkout.overlayChartCache) && (
          <RunOverlayChart
            points={routePoints}
            perPointGap={runGap.perPointGap}
            cache={displayWorkout.overlayChartCache}
          />
        )}

      {/* ── Heart Rate Zone Breakdown ──────────────────────── */}
      {effectiveHasRoute &&
        (routePoints.length > 1 || displayWorkout.zoneBreakdown) && (
          <ZoneBreakdown
            points={routePoints}
            maxHR={resolvedMaxHR}
            thresholdPaceSecPerMile={userSettings?.thresholdPaceSecPerMile}
            cache={displayWorkout.zoneBreakdown}
          />
        )}
    </div>
  );
}
