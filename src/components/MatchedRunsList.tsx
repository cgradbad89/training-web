"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { type MatchedRunSummary } from "@/utils/routePerformance";
import { formatPace } from "@/utils/pace";
import { parseLocalDate } from "@/utils/dates";
import { computeLoadIntensity } from "@/utils/loadScale";

export interface MatchedRunsListProps {
  /** Caller controls order (both current entry points pass newest first). */
  runs: MatchedRunSummary[];
  /** Highlighted row + "This run" sub-label. */
  currentRunId?: string;
  onClose: () => void;
  /** e.g. "Matched runs · 9.0 mi route" */
  title: string;
  /**
   * "overlay" (default): right-side flyout panel on desktop, bottom sheet
   * below lg — with backdrop / ✕ / Escape close.
   * "inline": just the titled list, for embedding inside another surface
   * (the Routes trend drawer) — no backdrop, no close affordances.
   */
  variant?: "overlay" | "inline";
}

function formatListDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Rows({
  runs,
  currentRunId,
  onNavigate,
}: {
  runs: MatchedRunSummary[];
  currentRunId?: string;
  onNavigate: (runId: string) => void;
}) {
  // Single shared load scale: cap = highest load among these matched runs (all
  // runs). 0 when none have a load → intensity skipped (chips render as before).
  const runLoadCap = Math.max(0, ...runs.map((r) => r.load ?? 0));
  return (
    <div className="flex flex-col">
      {/* Column header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-2 pb-2 border-b border-border">
        {["Date", "Pace", "Dist", "Load"].map((h) => (
          <span
            key={h}
            className="text-[10px] font-semibold text-textSecondary uppercase tracking-wide last:text-center"
          >
            {h}
          </span>
        ))}
      </div>

      {runs.map((r) => {
        const isCurrent = currentRunId != null && r.runId === currentRunId;
        return (
          <button
            key={r.runId}
            onClick={() => onNavigate(r.runId)}
            className={`grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center px-2 py-2.5 text-left border-b border-border last:border-b-0 transition-colors hover:bg-surface ${
              isCurrent ? "bg-primary/5" : ""
            }`}
          >
            <span className="flex flex-col min-w-0">
              <span
                className={`text-sm truncate ${
                  isCurrent
                    ? "font-semibold text-primary"
                    : "text-textPrimary"
                }`}
              >
                {formatListDate(r.date)}
              </span>
              {isCurrent && (
                <span className="text-[10px] font-semibold text-primary uppercase tracking-wide">
                  This run
                </span>
              )}
            </span>
            <span className="text-sm text-textPrimary tabular-nums">
              {formatPace(r.paceSeconds)} /mi
            </span>
            <span className="text-sm text-textSecondary tabular-nums">
              {r.distanceMiles.toFixed(1)} mi
            </span>
            {/* Load chip — renders "—" itself when load is null. Single
                shared scale via runLoadCap (skipped when no loads). */}
            <TrainingLoadBadge
              score={r.load}
              avgHeartRate={undefined}
              intensity={
                runLoadCap > 0
                  ? computeLoadIntensity(r.load, runLoadCap)
                  : undefined
              }
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shared matched-runs list with two entry points: the Run Detail "View all N
 * matched runs" flyout and the Routes-page trend drawer (inline). Rows
 * navigate to the run's detail page.
 */
export function MatchedRunsList({
  runs,
  currentRunId,
  onClose,
  title,
  variant = "overlay",
}: MatchedRunsListProps) {
  const router = useRouter();
  const isOverlay = variant === "overlay";

  // Escape closes (overlay only) — listener always registered, no-ops inline,
  // so hooks stay unconditional.
  useEffect(() => {
    if (!isOverlay) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOverlay, onClose]);

  // Lock body scroll behind the overlay.
  useEffect(() => {
    if (!isOverlay) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOverlay]);

  function handleNavigate(runId: string) {
    if (isOverlay) onClose();
    router.push(`/runs/${runId}`);
  }

  if (!isOverlay) {
    return (
      <div>
        <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-2">
          {title}
        </h3>
        <Rows
          runs={runs}
          currentRunId={currentRunId}
          onNavigate={handleNavigate}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Bottom sheet (< lg) / right flyout panel (≥ lg) */}
      <div
        role="dialog"
        aria-label={title}
        className="absolute inset-x-0 bottom-0 h-[70vh] rounded-t-2xl border-t border-border bg-card shadow-xl flex flex-col lg:inset-x-auto lg:right-0 lg:top-0 lg:bottom-0 lg:h-auto lg:w-[400px] lg:rounded-none lg:border-t-0 lg:border-l"
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b border-border shrink-0">
          <h3 className="text-sm font-bold text-textPrimary truncate">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface transition-colors text-textSecondary shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <Rows
            runs={runs}
            currentRunId={currentRunId}
            onNavigate={handleNavigate}
          />
        </div>
      </div>
    </div>
  );
}
