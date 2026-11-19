import type { TargetHeartRate } from "@/types/plan";
import {
  evaluateHrTarget,
  formatHrActualLabel,
  formatHrTarget,
} from "@/utils/hrTarget";

interface HrTargetChipsProps {
  /** The entry's resolved HR target (`resolveHrTarget`), or null for none. */
  target: TargetHeartRate | null;
  /** The matched run's whole-run average HR. */
  avgHr: number | null | undefined;
  /** True when the entry has a full OR partial match. */
  matched: boolean;
}

const CHIP =
  "text-xs px-2 py-0.5 rounded-full bg-surface border border-border whitespace-nowrap";

/**
 * Target chip ("Target ≤ 135" / "Target 146–155") plus, for a matched run with
 * an average HR, an actual chip ("Avg 138 · over by 3"). Renders as flex
 * children (a fragment) so the entry row's wrapping container lays them out.
 * Status is judged only by `evaluateHrTarget` — no thresholds here — and the
 * words, not the color, carry the meaning.
 */
export function HrTargetChips({ target, avgHr, matched }: HrTargetChipsProps) {
  if (!target) return null;

  const result = matched ? evaluateHrTarget(target, avgHr) : null;
  const label = result ? formatHrActualLabel(result) : null;

  return (
    <>
      <span data-hr-chip="target" className={`${CHIP} text-textSecondary`}>
        Target {formatHrTarget(target)}
      </span>
      {result && label && (
        <span
          data-hr-chip="actual"
          data-hr-status={result.status}
          className={`${CHIP} ${
            result.status === "on-target" ? "text-success" : "text-warning"
          }`}
        >
          {label}
        </span>
      )}
    </>
  );
}
