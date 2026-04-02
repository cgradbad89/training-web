"use client";

import React, { useState } from "react";
import { X, RotateCcw, Calendar, Clock, Heart } from "lucide-react";
import { type HealthWorkout } from "@/types/healthWorkout";
import { restoreWorkout } from "@/services/workoutOverrides";
import { formatDuration } from "@/utils/pace";

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface ExcludedItemsModalProps {
  isOpen: boolean;
  onClose: () => void;
  excludedItems: HealthWorkout[];
  userId: string;
  onRestored: (workoutId: string) => void;
}

export function ExcludedItemsModal({
  isOpen,
  onClose,
  excludedItems,
  userId,
  onRestored,
}: ExcludedItemsModalProps) {
  const [restoringId, setRestoringId] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleRestore(workoutId: string) {
    setRestoringId(workoutId);
    try {
      await restoreWorkout(userId, workoutId);
      onRestored(workoutId);
    } catch (err) {
      console.error("Failed to restore workout:", err);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-card rounded-2xl border border-border shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-border">
            <div>
              <h2 className="text-lg font-bold text-textPrimary">
                Excluded Items
              </h2>
              <p className="text-xs text-textSecondary mt-0.5">
                {excludedItems.length === 0
                  ? "No excluded items"
                  : `${excludedItems.length} excluded \u2014 tap Restore to add back`}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-surface text-textSecondary"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1 p-3 space-y-2">
            {excludedItems.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-textSecondary text-sm">
                  No excluded items yet.
                </p>
                <p className="text-textSecondary text-xs mt-1">
                  Use the Exclude button on any run or workout to hide it from
                  your history.
                </p>
              </div>
            ) : (
              excludedItems.map((item) => (
                <div
                  key={item.workoutId}
                  className="flex items-center gap-3 bg-surface rounded-xl border border-border p-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-textPrimary truncate">
                      {item.displayType}
                    </p>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="flex items-center gap-1 text-xs text-textSecondary">
                        <Calendar className="w-3 h-3" />
                        {formatDate(item.startDate)}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-textSecondary">
                        <Clock className="w-3 h-3" />
                        {formatDuration(item.durationSeconds)}
                      </span>
                      {item.avgHeartRate && (
                        <span className="flex items-center gap-1 text-xs text-textSecondary">
                          <Heart className="w-3 h-3" />
                          {Math.round(item.avgHeartRate)} bpm
                        </span>
                      )}
                      {item.distanceMiles > 0 && (
                        <span className="text-xs text-textSecondary">
                          {item.distanceMiles.toFixed(2)} mi
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleRestore(item.workoutId)}
                    disabled={restoringId === item.workoutId}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {restoringId === item.workoutId
                      ? "Restoring..."
                      : "Restore"}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
