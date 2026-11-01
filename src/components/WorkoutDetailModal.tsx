"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  Clock,
  Flame,
  Heart,
  Watch,
  Calendar,
  AlertTriangle,
  Pencil,
  Trash2,
} from "lucide-react";
import { isManualActivity, type HealthWorkout } from "@/types/healthWorkout";
import { ManualActivityModal } from "@/components/manualActivity/ManualActivityModal";
import { ManualSourceBadge } from "@/components/manualActivity/ManualSourceBadge";
import { useManualActivityActions } from "@/hooks/useManualActivityActions";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { formatDuration, formatMiles, formatPace } from "@/utils/pace";
import {
  excludeWorkout,
  restoreWorkout,
} from "@/services/workoutOverrides";
import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { resolveDisplayLoad } from "@/utils/trainingLoad";
import { fetchHRStream, type HRStreamSample } from "@/services/hrStream";
import dynamic from "next/dynamic";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";

// Lazy-load the Recharts HR chart (client-only) so opening the workout modal
// doesn't pull Recharts into the initial bundle of routes that render it.
const WorkoutHRChart = dynamic(() => import("@/components/WorkoutHRChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={300} />,
});

interface WorkoutDetailModalProps {
  workout: HealthWorkout;
  override: WorkoutOverride | null;
  userId: string;
  maxHr: number;
  restingHr: number;
  onClose: () => void;
  onExcludeChange: (workoutId: string, excluded: boolean) => void;
}

export function WorkoutDetailModal({
  workout: workoutProp,
  override,
  userId,
  maxHr,
  restingHr,
  onClose,
  onExcludeChange,
}: WorkoutDetailModalProps) {
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const isExcluded = override?.isExcluded === true;
  // Callers hold a snapshot of the selected workout; show an edit straight away.
  const [editedWorkout, setEditedWorkout] = useState<HealthWorkout | null>(null);
  const workout =
    editedWorkout?.workoutId === workoutProp.workoutId ? editedWorkout : workoutProp;
  const isManual = isManualActivity(workout);
  const { remove: removeManualActivity } = useManualActivityActions();
  const [isEditingManual, setIsEditingManual] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Per-sample HR stream for non-route workouts (hrStream subcollection).
  // Only fetched when the workout actually has a stream — avoids a wasted
  // Firestore read on the ~290 streamless workouts. The chart self-hides when
  // fewer than 2 points are available, so no extra empty-state is needed here.
  const [hrSamples, setHrSamples] = useState<HRStreamSample[]>([]);
  const [, setHrLoading] = useState(false);

  useEffect(() => {
    if (workout.hasHRStream !== true) {
      setHrSamples([]);
      return;
    }
    let alive = true;
    setHrLoading(true);
    fetchHRStream(userId, workout.workoutId)
      .then((samples) => {
        if (alive) setHrSamples(samples);
      })
      .catch((e) => {
        console.error("Failed to load HR stream", e);
        if (alive) setHrSamples([]);
      })
      .finally(() => {
        if (alive) setHrLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [userId, workout.workoutId, workout.hasHRStream]);

  async function handleExclude() {
    setSaving(true);
    try {
      await excludeWorkout(userId, workout.workoutId);
      onExcludeChange(workout.workoutId, true);
      onClose();
    } catch (e) {
      console.error("Failed to exclude workout", e);
    } finally {
      setSaving(false);
      setShowConfirm(false);
    }
  }

  async function handleRestore() {
    setSaving(true);
    try {
      await restoreWorkout(userId, workout.workoutId);
      onExcludeChange(workout.workoutId, false);
      onClose();
    } catch (e) {
      console.error("Failed to restore workout", e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteManual() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await removeManualActivity(workout.workoutId);
      onClose();
    } catch (e) {
      setDeleteError(
        e instanceof Error ? e.message : "This activity couldn't be deleted."
      );
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  }

  const startDate = new Date(workout.startDate);
  const endDate = new Date(workout.endDate);

  const dateLabel = startDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel =
    startDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }) +
    " \u2013 " +
    endDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 lg:items-center lg:p-4"
      onClick={onClose}
    >
      {/* Slide-up drawer on mobile, centered modal on desktop. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workout-detail-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl lg:max-h-[90vh] lg:max-w-md lg:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between p-5 border-b border-border bg-card z-10">
          <div>
            <h2
              id="workout-detail-title"
              className="text-base font-semibold text-textPrimary"
            >
              {isManual
                ? resolveActivityTitle({
                    customTitle: workout.customTitle,
                    activityType: workout.displayType,
                    rawActivityType: workout.isRunLike ? undefined : workout.activityType,
                    distanceMiles: workout.distanceMiles,
                  })
                : workout.displayType}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <ManualSourceBadge workout={workout} />
              {isExcluded && (
                <span className="text-xs bg-danger/10 text-danger px-2 py-0.5 rounded-full">
                  Excluded
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close workout details"
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          {/* Stats grid */}
          <div className="p-5 grid grid-cols-2 gap-4">
            {/* Date & Time */}
            <div className="col-span-2 bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Calendar size={14} className="text-textSecondary" />
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Date
                </span>
              </div>
              <p className="text-sm font-medium text-textPrimary">
                {dateLabel}
              </p>
              <p className="text-xs text-textSecondary mt-0.5">{timeLabel}</p>
            </div>

            {/* Duration */}
            <div className="bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock size={14} className="text-textSecondary" />
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Duration
                </span>
              </div>
              <p className="text-xl font-bold text-textPrimary">
                {formatDuration(workout.durationSeconds)}
              </p>
            </div>

            {/* Calories */}
            <div className="bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Flame size={14} className="text-textSecondary" />
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Calories
                </span>
              </div>
              <p className="text-xl font-bold text-textPrimary">
                {workout.calories
                  ? Math.round(workout.calories) + " kcal"
                  : "\u2014"}
              </p>
            </div>

            {/* Avg HR */}
            <div className="bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Heart size={14} className="text-textSecondary" />
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Avg HR
                </span>
              </div>
              <p className="text-xl font-bold text-textPrimary">
                {workout.avgHeartRate
                  ? Math.round(workout.avgHeartRate) + " bpm"
                  : "\u2014"}
              </p>
            </div>

            {/* Training Load */}
            <div className="bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Training Load
                </span>
              </div>
              <TrainingLoadBadge
                score={resolveDisplayLoad(workout, maxHr, restingHr)}
                avgHeartRate={workout.avgHeartRate}
                activityType={workout.activityType}
                maxHr={maxHr}
                restingHr={restingHr}
                durationSeconds={workout.durationSeconds}
                trainingLoadMethod={workout.trainingLoadMethod}
                size="large"
              />
            </div>

            {/* Source */}
            <div className="bg-surface rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Watch size={14} className="text-textSecondary" />
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Source
                </span>
              </div>
              <p className="text-sm font-medium text-textPrimary">
                {workout.sourceName || "Apple Watch"}
              </p>
              <p className="text-xs text-textSecondary mt-0.5 truncate">
                {workout.activityType.replace(/_/g, " ")}
              </p>
            </div>
          </div>

          {isManual && workout.distanceMiles > 0 && (
            <div className="px-5 pb-4">
              <p className="text-sm text-textSecondary">
                {formatMiles(workout.distanceMiles)} mi
                {workout.avgPaceSecPerMile
                  ? ` · ${formatPace(workout.avgPaceSecPerMile)} /mi`
                  : ""}
              </p>
            </div>
          )}

          {workout.notes && (
            <div className="px-5 pb-4">
              <p className="mb-1 text-xs text-textSecondary uppercase tracking-widest font-semibold">
                Notes
              </p>
              <p className="whitespace-pre-wrap text-sm text-textPrimary">
                {workout.notes}
              </p>
            </div>
          )}

          {/* Full-workout HR line (non-route workouts with an hrStream).
              Self-hides when fewer than 2 samples are available. */}
          {hrSamples.length > 0 && (
            <div className="px-5 pb-4">
              <WorkoutHRChart samples={hrSamples} />
            </div>
          )}

          {/* Edit / Delete — manually entered activities only */}
          {isManual && (
            <div className="px-5 pb-3">
              {deleteError && (
                <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {deleteError}
                </p>
              )}
              {showDeleteConfirm ? (
                <div className="bg-danger/5 border border-danger/20 rounded-xl p-4">
                  <div className="flex items-start gap-2 mb-3">
                    <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
                    <p className="text-sm text-textPrimary">
                      Permanently delete this activity? This can&apos;t be undone.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowDeleteConfirm(false)}
                      disabled={deleting}
                      className="flex-1 py-2 rounded-lg border border-border text-sm text-textSecondary hover:bg-surface transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDeleteManual}
                      disabled={deleting}
                      className="flex-1 py-2 rounded-lg bg-danger text-white text-sm font-medium hover:bg-danger/90 disabled:opacity-50 transition-colors"
                    >
                      {deleting ? "Deleting\u2026" : "Delete"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setIsEditingManual(true)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-border text-sm font-medium text-textPrimary hover:bg-surface transition-colors"
                  >
                    <Pencil size={14} /> Edit
                  </button>
                  <button
                    onClick={() => { setDeleteError(null); setShowDeleteConfirm(true); }}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-danger text-danger text-sm font-medium hover:bg-danger/5 transition-colors"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Exclude / Restore section */}
          <div className="px-5">
            {!isExcluded ? (
              <>
                {!showConfirm ? (
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="w-full py-2.5 rounded-xl border border-danger text-danger text-sm font-medium hover:bg-danger/5 transition-colors"
                  >
                    Exclude Workout
                  </button>
                ) : (
                  <div className="bg-danger/5 border border-danger/20 rounded-xl p-4">
                    <div className="flex items-start gap-2 mb-3">
                      <AlertTriangle
                        size={16}
                        className="text-danger mt-0.5 shrink-0"
                      />
                      <p className="text-sm text-textPrimary">
                        Exclude this workout? It will be hidden from your
                        history. You can restore it anytime.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowConfirm(false)}
                        className="flex-1 py-2 rounded-lg border border-border text-sm text-textSecondary hover:bg-surface transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleExclude}
                        disabled={saving}
                        className="flex-1 py-2 rounded-lg bg-danger text-white text-sm font-medium hover:bg-danger/90 disabled:opacity-50 transition-colors"
                      >
                        {saving ? "Excluding\u2026" : "Exclude"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button
                onClick={handleRestore}
                disabled={saving}
                className="w-full py-2.5 rounded-xl border border-primary text-primary text-sm font-medium hover:bg-primary/5 disabled:opacity-50 transition-colors"
              >
                {saving ? "Restoring\u2026" : "Restore Workout"}
              </button>
            )}
          </div>
        </div>
      </div>
      {isEditingManual && (
        // Stops the backdrop click-to-close above from also closing this modal.
        <div onClick={(event) => event.stopPropagation()}>
          <ManualActivityModal
            mode={{ type: "edit", workout }}
            onClose={() => setIsEditingManual(false)}
            onSaved={(saved) => {
              setEditedWorkout(saved);
              setIsEditingManual(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
