"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import {
  collection,
  getDocs,
  orderBy,
  query,
} from "firebase/firestore";

import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/useAuth";
import { type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { computeMileSplits, type MileSplit } from "@/utils/mileSplits";
import { formatPace, formatDuration } from "@/utils/pace";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunActivityModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Planned session data — always present. */
  plannedEntry: PlannedRunEntry;
  /** Actual matched run, if any. Absent/null ⇒ the session is still upcoming. */
  matchedRun?: HealthWorkout | null;
  /** Calendar date of this planned session. */
  sessionDate: Date;
}

// ─── Label helpers ──────────────────────────────────────────────────────────

const WORKOUT_TYPE_LABELS: Record<string, string> = {
  easy: "Easy Run",
  tempo: "Tempo Run",
  long: "Long Run",
  race: "Race",
  rest: "Rest Day",
  cross: "Cross Training",
};

const RUN_TYPE_LABELS: Record<string, string> = {
  outdoor: "Outdoor Run",
  treadmill: "Treadmill Run",
  otf: "OTF Run",
  longRun: "Long Run",
  rest: "Rest Day",
};

/** Human run-type label for the header (e.g. "Easy Run", "Long Run"). */
function runTypeLabel(entry: PlannedRunEntry): string {
  if (entry.workoutType && WORKOUT_TYPE_LABELS[entry.workoutType]) {
    return WORKOUT_TYPE_LABELS[entry.workoutType];
  }
  if (entry.runType && RUN_TYPE_LABELS[entry.runType]) {
    return RUN_TYPE_LABELS[entry.runType];
  }
  return "Run";
}

/** Planned pace string ("MM:SS/mi"), preferring the seconds field. */
function plannedPaceLabel(entry: PlannedRunEntry): string | null {
  if (
    entry.targetPaceSecondsPerMile != null &&
    entry.targetPaceSecondsPerMile > 0
  ) {
    return `${formatPace(entry.targetPaceSecondsPerMile)}/mi`;
  }
  if (entry.paceTarget && entry.paceTarget.trim() !== "") {
    return `${entry.paceTarget}/mi`;
  }
  return null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** One label/value row inside the Planned / Actual comparison blocks. */
function StatRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-textSecondary">{label}</span>
      <span className="text-sm font-semibold text-textPrimary tabular-nums">
        {value}
      </span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RunActivityModal({
  isOpen,
  onClose,
  plannedEntry,
  matchedRun,
  sessionDate,
}: RunActivityModalProps): React.JSX.Element | null {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  // ── Mile-splits state (route points + per-mile HR subcollection) ──────────
  // Pace is GPS-derived (same path as the run detail page); per-mile HR comes
  // from the iOS-synced mileSplits subcollection. Both are fetched lazily, only
  // while the modal is open AND a matched run exists.
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [perMileHR, setPerMileHR] = useState<Record<number, number>>({});
  const [splitsLoading, setSplitsLoading] = useState(false);

  // All hooks run before the early return below (Rules of Hooks). Null guards
  // live inside each callback.
  const mileSplits = useMemo<MileSplit[]>(() => {
    if (routePoints.length < 2 || !matchedRun) return [];
    const computed = computeMileSplits(
      routePoints,
      matchedRun.avgHeartRate,
      matchedRun.distanceMiles
    );
    return computed.map((split) => ({
      ...split,
      avgBpm: perMileHR[split.mile] ?? undefined,
    }));
  }, [routePoints, perMileHR, matchedRun]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Fetch route points + per-mile HR on open — mirrors runs/[id]/page.tsx.
  useEffect(() => {
    if (!isOpen || !uid || !matchedRun) {
      setRoutePoints([]);
      setPerMileHR({});
      setSplitsLoading(false);
      return;
    }
    let cancelled = false;
    const workoutId = matchedRun.workoutId;
    setSplitsLoading(true);
    setRoutePoints([]);
    setPerMileHR({});

    fetchRoutePoints(uid, workoutId)
      .then((points) => {
        if (cancelled) return;
        setRoutePoints(points);

        // Per-mile HR from the iOS-synced mileSplits subcollection. Same path
        // and guards (avgBpm && sampleCount >= 2) the run detail page uses.
        if (points.length >= 2) {
          return getDocs(
            query(
              collection(
                db,
                `users/${uid}/healthWorkouts/${workoutId}/mileSplits`
              ),
              orderBy("mile", "asc")
            )
          ).then((snap) => {
            if (cancelled) return;
            const hrMap: Record<number, number> = {};
            snap.docs.forEach((doc) => {
              const data = doc.data();
              if (data.avgBpm && data.sampleCount >= 2) {
                hrMap[data.mile as number] = data.avgBpm as number;
              }
            });
            setPerMileHR(hrMap);
          });
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setSplitsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, uid, matchedRun]);

  if (!isOpen) return null;

  const typeLabel = runTypeLabel(plannedEntry);
  const dateLabel = sessionDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const plannedPace = plannedPaceLabel(plannedEntry);
  const notes = plannedEntry.notes ?? plannedEntry.description ?? null;
  const hasMatch = matchedRun != null;
  // The mile-splits table fills its HR column only when per-mile HR exists;
  // pace is always present once we have splits.
  const hasSplitHR = mileSplits.some((s) => s.avgBpm != null);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 lg:items-center lg:p-4"
      onClick={onClose}
    >
      {/* Slide-up drawer on mobile, centered card on desktop (max-width 480px). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-activity-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl lg:max-h-[90vh] lg:w-[480px] lg:max-w-[480px] lg:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between gap-3 p-5 border-b border-border bg-card">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2
                id="run-activity-title"
                className="text-base font-semibold text-textPrimary"
              >
                {typeLabel}
              </h2>
              {hasMatch ? (
                <span className="text-[10px] bg-success/15 text-success px-2 py-0.5 rounded-full font-semibold">
                  Completed
                </span>
              ) : (
                <span className="text-[10px] bg-surface text-textSecondary border border-border px-2 py-0.5 rounded-full font-semibold">
                  Upcoming
                </span>
              )}
            </div>
            <p className="text-xs text-textSecondary mt-0.5">{dateLabel}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close run details"
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 flex flex-col gap-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          {/* Planned vs Actual — side by side on desktop when matched. */}
          <div
            className={`grid grid-cols-1 gap-3 ${
              hasMatch ? "sm:grid-cols-2" : ""
            }`}
          >
            {/* Planned (always shown) */}
            <div className="bg-surface rounded-xl p-4 flex flex-col gap-2">
              <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                Planned
              </span>
              <StatRow
                label="Distance"
                value={`${plannedEntry.distanceMiles.toFixed(1)} mi`}
              />
              <StatRow label="Pace" value={plannedPace ?? "—"} />
            </div>

            {/* Actual (only when matched) */}
            {matchedRun && (
              <div className="bg-surface rounded-xl p-4 flex flex-col gap-2">
                <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                  Actual
                </span>
                <StatRow
                  label="Distance"
                  value={
                    matchedRun.distanceMiles > 0
                      ? `${matchedRun.distanceMiles.toFixed(2)} mi`
                      : "—"
                  }
                />
                <StatRow
                  label="Pace"
                  value={
                    matchedRun.avgPaceSecPerMile
                      ? `${formatPace(matchedRun.avgPaceSecPerMile)}/mi`
                      : "—"
                  }
                />
                <StatRow
                  label="Avg HR"
                  value={
                    matchedRun.avgHeartRate
                      ? `${Math.round(matchedRun.avgHeartRate)} bpm`
                      : "—"
                  }
                />
                <StatRow
                  label="Duration"
                  value={formatDuration(matchedRun.durationSeconds)}
                />
              </div>
            )}
          </div>

          {/* Planned notes (if any) */}
          {notes && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                Notes
              </span>
              <p className="text-sm text-textPrimary">{notes}</p>
            </div>
          )}

          {/* Mile splits — only meaningful for a matched, routed run. */}
          {matchedRun && splitsLoading && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                Mile Splits
              </span>
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-7 bg-surface rounded-lg animate-pulse"
                  />
                ))}
              </div>
            </div>
          )}

          {matchedRun && !splitsLoading && mileSplits.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-textSecondary uppercase tracking-widest font-semibold">
                Mile Splits
              </span>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-textSecondary uppercase tracking-wide border-b border-border">
                      <th className="text-left py-2 pr-4 font-medium">Mile</th>
                      <th className="text-right py-2 px-4 font-medium">Pace</th>
                      {hasSplitHR && (
                        <th className="text-right py-2 pl-4 font-medium">HR</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {mileSplits.map((split) => (
                      <tr
                        key={split.mile}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="py-2 pr-4 text-textPrimary font-medium">
                          {split.isPartial
                            ? `Mile ${split.mile} (${split.segmentMiles.toFixed(
                                1
                              )} mi)`
                            : `Mile ${split.mile}`}
                        </td>
                        <td className="py-2 px-4 text-right text-textPrimary tabular-nums">
                          {formatPace(split.paceSecPerMile)}/mi
                        </td>
                        {hasSplitHR && (
                          <td className="py-2 pl-4 text-right text-textPrimary tabular-nums">
                            {split.avgBpm ? (
                              `${Math.round(split.avgBpm)} bpm`
                            ) : (
                              <span className="text-textSecondary">—</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between gap-3 p-5 border-t border-border bg-card">
          {matchedRun ? (
            <Link
              href={`/runs/${matchedRun.workoutId}`}
              className="text-sm font-medium text-primary hover:underline"
            >
              View Full Run →
            </Link>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-textSecondary border border-border rounded-lg hover:bg-surface transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
