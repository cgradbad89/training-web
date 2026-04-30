"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeft, Pencil, RotateCcw } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { MileSplitsTable } from "@/components/MileSplitsTable";
import { MileSplitCharts } from "@/components/MileSplitCharts";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatBlock } from "@/components/ui/StatBlock";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { EfficiencyTooltip } from "@/components/ui/EfficiencyTooltip";
import { useAuth } from "@/hooks/useAuth";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { fetchHealthWorkout } from "@/services/healthWorkouts";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { fetchShoes, fetchManualShoeAssignmentsMap } from "@/services/shoes";
import {
  fetchOverride,
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
  efficiencyDisplayScore,
  efficiencyTierLevel,
  distanceBucket,
  driftLevel,
} from "@/utils/metrics";
import { computeMileSplits, type MileSplit } from "@/utils/mileSplits";
import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const RunMap = dynamic(() => import("@/components/RunMap"), { ssr: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEffBadgeLevel(
  workout: HealthWorkout
): "good" | "ok" | "low" | "neutral" {
  const hasHR =
    workout.avgHeartRate !== null && (workout.avgSpeedMPS ?? 0) > 0;
  if (!hasHR || !workout.avgHeartRate) return "neutral";
  try {
    const displayScore = efficiencyDisplayScore(
      workout.avgSpeedMPS ?? 0,
      workout.avgHeartRate
    );
    if (!isFinite(displayScore) || displayScore <= 0 || displayScore > 10)
      return "neutral";
    return efficiencyTierLevel(displayScore, workout.distanceMiles);
  } catch {
    return "neutral";
  }
}

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
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(true);

  // Edit panel state
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formDistance, setFormDistance] = useState("");
  const [formDuration, setFormDuration] = useState("");
  const [formRunType, setFormRunType] = useState("");

  // Exclude state
  const [excluding, setExcluding] = useState(false);
  const [showExcludeConfirm, setShowExcludeConfirm] = useState(false);

  // Unsaved-changes warning for the edit form
  const editFormDirty = isEditing && (formDistance !== "" || formDuration !== "" || formRunType !== "");
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

  useEffect(() => {
    if (!uid || !workoutId) return;
    setLoading(true);

    Promise.all([
      fetchHealthWorkout(uid, workoutId),
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
      fetchOverride(uid, workoutId),
    ])
      .then(([w, s, a, o]) => {
        setWorkout(w);
        setShoes(s);
        setAssignments(a);
        setOverride(o);

        if (w?.hasRoute) {
          fetchRoutePoints(uid, workoutId)
            .then(setRoutePoints)
            .catch(console.error)
            .finally(() => setRouteLoading(false));

          // Fetch per-mile HR from iOS-synced subcollection
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
        } else {
          setRouteLoading(false);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid, workoutId]);

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
  const isExcluded = override?.isExcluded === true;
  const hasOverrides =
    override != null &&
    (override.distanceMilesOverride != null ||
      override.durationSecondsOverride != null ||
      override.runTypeOverride != null);

  // Shoe assignment
  const assignedShoeId = assignments[workout.workoutId] ?? null;
  const assignedShoe = shoes.find((s) => s.id === assignedShoeId) ?? null;
  const shoeName = assignedShoe
    ? assignedShoe.name ||
      `${assignedShoe.brand} ${assignedShoe.model}`.trim()
    : null;

  // Date formatting
  const startDate = new Date(displayWorkout.startDate);
  const dateDisplay = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const fullDateDisplay = startDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeDisplay = startDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  // Efficiency \u2014 use the same normalized 1\u201310 display score as the runs list
  // and dashboard. computeEfficiencyDisplay returned the raw 14\u201320 score, which
  // always failed the >10 sanity cap and rendered blank for every valid run.
  const effHasHR =
    displayWorkout.avgHeartRate !== null &&
    displayWorkout.avgHeartRate !== undefined &&
    displayWorkout.avgHeartRate > 0 &&
    (displayWorkout.avgSpeedMPS ?? 0) > 0;
  const effDisplay = (() => {
    if (!effHasHR || displayWorkout.avgHeartRate == null) return null;
    const score = efficiencyDisplayScore(
      displayWorkout.avgSpeedMPS ?? 0,
      displayWorkout.avgHeartRate
    );
    if (!isFinite(score) || score <= 0 || score > 10) return null;
    return score;
  })();
  const effBadgeLevel = getEffBadgeLevel(displayWorkout);
  const effStr = effDisplay != null ? effDisplay.toFixed(1) : "\u2014";

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
              Efficiency
            </span>
            <EfficiencyTooltip distanceMiles={displayWorkout.distanceMiles}>
              <MetricBadge
                label="Eff"
                value={effStr}
                level={effStr === "\u2014" ? "neutral" : effBadgeLevel}
              />
            </EfficiencyTooltip>
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mt-5 pt-5 border-t border-border">
          <StatBlock
            label="Elevation Gain"
            value={
              displayWorkout.elevationGainM != null
                ? Math.round(displayWorkout.elevationGainM).toString()
                : "\u2014"
            }
            unit={displayWorkout.elevationGainM != null ? "m" : undefined}
          />
          <StatBlock
            label="Date & Time"
            value={fullDateDisplay}
            sublabel={timeDisplay}
          />
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

      {/* ── Route Map ───────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {displayWorkout.hasRoute ? (
          routeLoading ? (
            <div className="h-64 sm:h-96 bg-surface animate-pulse" />
          ) : routePoints.length > 0 ? (
            <RunMap points={routePoints} />
          ) : (
            <div className="h-64 sm:h-96 flex items-center justify-center">
              <p className="text-sm text-textSecondary">
                Route data not yet synced
              </p>
            </div>
          )
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
        hasRoute={displayWorkout.hasRoute}
      />

      {/* ── Pace & HR Charts ───────────────────────────────── */}
      <MileSplitCharts
        splits={mileSplits}
        hasRoute={displayWorkout.hasRoute}
      />
    </div>
  );
}
