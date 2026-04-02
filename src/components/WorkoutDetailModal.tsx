"use client";

import React, { useState } from "react";
import {
  X,
  Clock,
  Flame,
  Heart,
  Watch,
  Calendar,
  AlertTriangle,
} from "lucide-react";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { formatDuration } from "@/utils/pace";
import {
  excludeWorkout,
  restoreWorkout,
} from "@/services/workoutOverrides";

interface WorkoutDetailModalProps {
  workout: HealthWorkout;
  override: WorkoutOverride | null;
  userId: string;
  onClose: () => void;
  onExcludeChange: (workoutId: string, excluded: boolean) => void;
}

export function WorkoutDetailModal({
  workout,
  override,
  userId,
  onClose,
  onExcludeChange,
}: WorkoutDetailModalProps) {
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const isExcluded = override?.isExcluded === true;

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
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Slide-up drawer / centered modal */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-2xl shadow-xl max-h-[90vh] overflow-y-auto lg:inset-0 lg:flex lg:items-center lg:justify-center lg:bg-transparent lg:shadow-none">
        <div className="lg:bg-card lg:rounded-2xl lg:shadow-xl lg:w-full lg:max-w-md lg:max-h-[90vh] lg:overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-card z-10">
            <div>
              <h2 className="text-base font-semibold text-textPrimary">
                {workout.displayType}
              </h2>
              {isExcluded && (
                <span className="text-xs bg-danger/10 text-danger px-2 py-0.5 rounded-full">
                  Excluded
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors"
            >
              <X size={18} />
            </button>
          </div>

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

          {/* Exclude / Restore section */}
          <div className="px-5 pb-5">
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
    </>
  );
}
