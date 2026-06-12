"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeft, Pencil, RotateCcw } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { MileSplitsTable } from "@/components/MileSplitsTable";
import { MileSplitCharts } from "@/components/MileSplitCharts";
import { RunOverlayChart } from "@/components/RunOverlayChart";
import { ZoneBreakdown } from "@/components/ZoneBreakdown";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatBlock } from "@/components/ui/StatBlock";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { WeatherTile } from "@/components/runs/WeatherTile";
import { RoutePerformanceSection } from "@/components/runs/RoutePerformanceSection";
import { RunImpactSection } from "@/components/runs/RunImpactSection";
import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import {
  computeAndStoreBestEfforts,
  fetchHealthWorkout,
  fetchHealthWorkouts,
  saveWeatherForWorkout,
} from "@/services/healthWorkouts";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
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
  clusterRoutesGeographic,
  findClusterForRun,
  type RouteCluster,
} from "@/utils/routeClustering";
import {
  computeRoutePerformance,
  toMatchedRunSummaries,
} from "@/utils/routePerformance";
import {
  computePredictionImpact,
  computeCtlImpact,
} from "@/utils/runImpact";
import { parseLocalDate } from "@/utils/dates";
import { type Race, RACE_DISTANCE_MILES } from "@/types/race";
import { type UserSettings } from "@/types/userSettings";
import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { fetchWeatherForRun } from "@/lib/weather";

const RunMap = dynamic(() => import("@/components/RunMap"), { ssr: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  const [userSettings, setUserSettings] = useState<UserSettings | null>();
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(true);

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
  const [clusters, setClusters] = useState<RouteCluster[] | null>(null);

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
      if (routePoints.length < 2 || !displayWorkoutForSplits) return [];
      const computed = computeMileSplits(routePoints, displayWorkoutForSplits.avgHeartRate);
      // Merge in per-mile HR from iOS-synced subcollection
      return computed.map((split) => ({
        ...split,
        avgBpm: perMileHR[split.mile] ?? undefined,
      }));
    },
    [routePoints, displayWorkoutForSplits, perMileHR]
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

  // NET elevation (ft) for the elevation KPI's secondary line. Sourced from the
  // GAP computation so Total (cumulative ascent) and Net stay consistent.
  // Negative = net descent. Hidden when unavailable (no NaN).
  const netRiseFt =
    runGap.netRiseM != null ? Math.round(runGap.netRiseM * 3.28084) : null;
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
    setLoading(true);

    Promise.all([
      fetchHealthWorkout(uid, workoutId),
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
      fetchOverride(uid, workoutId),
      fetchUserSettings(uid),
    ])
      .then(([w, s, a, o, settings]) => {
        setWorkout(w);
        setShoes(s);
        setAssignments(a);
        setOverride(o);
        setUserSettings(settings);

        // Always attempt the route read, regardless of the parent `hasRoute`
        // flag. The iOS headless sync can write a populated `route`
        // subcollection but leave `hasRoute: false` if a short background wake
        // is suspended before the trailing flag write. Trusting the flag alone
        // would suppress map/splits/HR for runs whose data actually exists, so
        // route availability is derived from the DATA: a read of >= 2 points
        // means "routed" for all downstream rendering. A genuinely route-less
        // workout (Pilates/strength) reads 0 points and is unchanged.
        fetchRoutePoints(uid, workoutId)
          .then((points) => {
            setRoutePoints(points);

            // Weather backfill: a run with GPS but no stored weather yet gets
            // its start-point/time conditions fetched from Open-Meteo and
            // persisted. Already-stored weather is reused (no fetch). Failures
            // are swallowed — the tile simply doesn't render.
            if (w && w.weather == null && points.length > 0) {
              fetchWeatherForRun(points[0].lat, points[0].lng, w.startDate)
                .then((weather) => {
                  if (!weather) return;
                  setWorkout((current) =>
                    current ? { ...current, weather } : current
                  );
                  saveWeatherForWorkout(uid, workoutId, weather).catch(
                    console.error
                  );
                })
                .catch(console.error);
            }

            if (isRoutePresent(points.length)) {
              // Natural new-run hook: the detail page already reads route
              // points for maps/splits/GAP, so computing missing best efforts
              // here avoids adding heavy route reads to the runs list hot path.
              if (w && w.bestEfforts === undefined) {
                computeAndStoreBestEfforts(uid, workoutId, points)
                  .then((bestEfforts) => {
                    setWorkout((current) =>
                      current ? { ...current, bestEfforts } : current
                    );
                  })
                  .catch(console.error);
              }

              // Fetch per-mile HR from the iOS-synced mileSplits subcollection.
              // Gated on the SAME data signal (>= 2 route points) so it runs for
              // a falsely-flagged run and is skipped for genuinely route-less
              // workouts.
              getDocs(
                query(
                  collection(db, `users/${uid}/healthWorkouts/${workoutId}/mileSplits`),
                  orderBy("mile", "asc")
                )
              )
                .then((snap) => {
                  const hrMap: Record<number, number> = {};
                  snap.docs.forEach((doc) => {
                    const data = doc.data();
                    if (data.avgBpm && data.sampleCount >= 2) {
                      hrMap[data.mile as number] = data.avgBpm as number;
                    }
                  });
                  setPerMileHR(hrMap);
                })
                .catch(console.error);
            }
          })
          .catch(console.error)
          .finally(() => setRouteLoading(false));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid, workoutId]);

  // ── Route Performance + Run Impact data (deferred, non-blocking) ──────────
  // Same data path the Routes / insights pages already use: one all-workouts
  // query + overrides + races. No new collections, fields, or rules.
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    Promise.all([
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchAllOverrides(uid),
      fetchRaces(uid),
    ])
      .then(([all, overrides, fetchedRaces]) => {
        if (cancelled) return;
        setAllWorkoutsRaw(all);
        setAllOverrides(overrides);
        setRaces(fetchedRaces);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid]);

  // Cluster input — EXACTLY the Routes page's filter (isRunLike && hasRoute on
  // raw docs), so the run detail's "matched runs" agree with the Routes page.
  const clusterInput = useMemo(
    () =>
      allWorkoutsRaw
        ? allWorkoutsRaw.filter((w) => w.isRunLike && w.hasRoute)
        : null,
    [allWorkoutsRaw]
  );

  useEffect(() => {
    if (!uid || !clusterInput || clusterInput.length === 0) return;
    let cancelled = false;
    clusterRoutesGeographic(clusterInput, uid)
      .then((result) => {
        if (!cancelled) setClusters(result);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [uid, clusterInput]);

  // Insights run set — overrides applied, excluded filtered (the same shaping
  // Personal/Plan Insights use), so the prediction here matches those pages.
  const workoutsForInsights = useMemo(() => {
    if (!allWorkoutsRaw || !allOverrides) return null;
    return allWorkoutsRaw
      .map((w) => applyOverride(w, allOverrides[w.workoutId] ?? null))
      .filter((w) => !allOverrides[w.workoutId]?.isExcluded);
  }, [allWorkoutsRaw, allOverrides]);

  const currentCluster = useMemo(
    () => (clusters ? findClusterForRun(clusters, workoutId) : null),
    [clusters, workoutId]
  );

  const matchedSummaries = useMemo(
    () =>
      currentCluster
        ? toMatchedRunSummaries(
            currentCluster.allRuns,
            resolvedMaxHR,
            resolvedRestingHR
          )
        : [],
    [currentCluster, resolvedMaxHR, resolvedRestingHR]
  );

  const routePerformance = useMemo(
    () => computeRoutePerformance(workoutId, matchedSummaries),
    [workoutId, matchedSummaries]
  );

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
  const predictionImpact = useMemo(() => {
    if (!workoutsForInsights || !activeRace || !raceDistanceMiles) return null;
    const cutoff = parseLocalDate(activeRace.raceDate);
    cutoff.setHours(23, 59, 59, 999);
    const predictionRuns = workoutsForInsights.filter(
      (w) => w.isRunLike && w.startDate <= cutoff
    );
    return computePredictionImpact(predictionRuns, workoutId, {
      raceDistanceMiles,
      races: raceInputs,
    });
  }, [
    workoutsForInsights,
    activeRace,
    raceDistanceMiles,
    raceInputs,
    workoutId,
  ]);

  const ctlImpact = useMemo(() => {
    if (!workoutsForInsights || workoutsForInsights.length === 0) return null;
    return computeCtlImpact(
      workoutsForInsights,
      workoutId,
      resolvedMaxHR,
      resolvedRestingHR
    );
  }, [workoutsForInsights, workoutId, resolvedMaxHR, resolvedRestingHR]);

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
  // Derive route availability from the DATA, not just the parent flag. The iOS
  // headless sync can leave `hasRoute: false` on a doc that nonetheless has a
  // populated `route` subcollection; once we've read >= 2 points, render the
  // run as routed regardless of the flag. (< 2 points → unchanged no-route UI.)
  const effectiveHasRoute = deriveEffectiveHasRoute(
    displayWorkout.hasRoute,
    routePoints.length
  );
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
    <div className="max-w-4xl mx-auto p-4 lg:p-6 flex flex-col gap-6">
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
            {displayWorkout.displayType} &middot; {dateDisplay}
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
            // Dead-band/flat runs show the actual pace labelled "flat" \u2014 "\u2014"
            // is reserved for runs with no route/elevation data at all.
            const gapDisplay = selectGapDisplay(runGap);
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
            <span className="text-xs text-textSecondary uppercase tracking-wide">
              HR Drift
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
          {displayWorkout.weather && (
            <WeatherTile weather={displayWorkout.weather} />
          )}
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
      {routePerformance && currentCluster && (
        <RoutePerformanceSection
          performance={routePerformance}
          matchedRuns={matchedSummaries}
          currentRunId={workoutId}
          routeDistanceMiles={currentCluster.distanceMiles}
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
        ) : effectiveHasRoute && routePoints.length > 0 ? (
          <>
            <RunMap points={routePoints} />
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
        gapPerMile={runGap.perMileGapSecPerMile}
      />

      {/* ── Pace & HR Charts ───────────────────────────────── */}
      <MileSplitCharts
        splits={mileSplits}
        hasRoute={effectiveHasRoute}
      />

      {/* ── Overlaid Analysis Chart (elevation + pace + GAP + HR) ─ */}
      {effectiveHasRoute && routePoints.length > 1 && (
        <RunOverlayChart points={routePoints} perPointGap={runGap.perPointGap} />
      )}

      {/* ── Heart Rate Zone Breakdown ──────────────────────── */}
      {effectiveHasRoute && routePoints.length > 1 && (
        <ZoneBreakdown
          points={routePoints}
          maxHR={resolvedMaxHR}
          thresholdPaceSecPerMile={userSettings?.thresholdPaceSecPerMile}
        />
      )}
    </div>
  );
}
