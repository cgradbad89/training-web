import type { TargetHeartRate } from "@/types/plan";
import {
  evaluateHrTarget,
  formatHrActualLabel,
  formatHrTarget,
} from "@/utils/hrTarget";

interface HrTargetCardProps {
  target: TargetHeartRate;
  /** The run's whole-run average HR. */
  avgHr: number | null | undefined;
  /** Workout (tempo): label the figure as the whole-run average. */
  isWholeRunWorkout: boolean;
  /** Share of valid time above the literal cap; null hides the row. */
  timeAbove: { pct: number; capBpm: number } | null;
  /** Show a small skeleton while the hrStream read is in flight. */
  timeAboveLoading: boolean;
}

/**
 * "Heart rate vs target" card for Run detail. Status wording is the same as the
 * Plans chip (`formatHrActualLabel`) and is judged only by `evaluateHrTarget`
 * (2 bpm grace on the rounded whole-run average). The words — not the color —
 * carry the meaning. Time above the cap is the LITERAL cap, no grace.
 */
export function HrTargetCard({
  target,
  avgHr,
  isWholeRunWorkout,
  timeAbove,
  timeAboveLoading,
}: HrTargetCardProps) {
  const result = evaluateHrTarget(target, avgHr);
  const label = formatHrActualLabel(result);
  const abovePct = timeAbove ? Math.min(100, Math.max(0, Math.round(timeAbove.pct))) : 0;
  const underPct = 100 - abovePct;

  return (
    <div
      data-testid="hr-target-card"
      className="bg-card rounded-2xl border border-border p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-textPrimary">Heart rate vs target</h2>
        {label ? (
          <span
            data-testid="hr-target-status"
            data-hr-status={result.status}
            className={`text-xs px-2 py-0.5 rounded-full bg-surface border border-border whitespace-nowrap ${
              result.status === "on-target" ? "text-success" : "text-warning"
            }`}
          >
            {label}
          </span>
        ) : (
          <span data-testid="hr-target-status" className="text-xs text-textSecondary">
            No average heart rate recorded
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary uppercase tracking-wide">Target</span>
          <span className="text-lg font-semibold text-textPrimary tabular-nums">
            {formatHrTarget(target)}
            <span className="text-xs font-normal text-textSecondary ml-1">bpm</span>
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary uppercase tracking-wide">Your average</span>
          <span className="text-lg font-semibold text-textPrimary tabular-nums">
            {result.avgBpm != null ? result.avgBpm : "—"}
            {result.avgBpm != null && (
              <span className="text-xs font-normal text-textSecondary ml-1">bpm</span>
            )}
          </span>
        </div>
      </div>

      {isWholeRunWorkout && (
        <p className="mt-3 text-xs text-textSecondary">
          Whole-run average (incl. warm-up/cool-down)
        </p>
      )}

      {timeAboveLoading && !timeAbove && (
        <div
          data-testid="hr-time-above-skeleton"
          className="mt-4 h-5 rounded-lg bg-surface animate-pulse"
        />
      )}

      {timeAbove && (
        <div data-testid="hr-time-above" className="mt-4">
          <div
            role="img"
            aria-label={`${underPct}% of time under ${timeAbove.capBpm}, ${abovePct}% above`}
            className="flex h-2 rounded-full overflow-hidden bg-border"
          >
            <div data-testid="hr-time-under-bar" className="h-full bg-success" style={{ width: `${underPct}%` }} />
            <div data-testid="hr-time-above-bar" className="h-full bg-warning" style={{ width: `${abovePct}%` }} />
          </div>
          <p className="mt-2 text-xs text-textSecondary tabular-nums">
            {underPct}% of time under {timeAbove.capBpm} · {abovePct}% above
          </p>
        </div>
      )}
    </div>
  );
}
