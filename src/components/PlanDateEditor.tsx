"use client";

/**
 * Shared in-place start/end date editor for the plan detail headers
 * (RunningPlanDetail + CrossTrainingPlanDetail). Keeps the two headers' UX
 * identical and routes ALL date math through the pure planDateEdit helpers.
 *
 * Model (see PRD §5 item 22): a plan stores only `startDate` + `weeks[]`; total
 * weeks = `weeks.length` and end date is DERIVED. So:
 *   - START date is a SLIDE handle: change it → slideStartDate (Monday-snapped);
 *     the whole plan shifts, weeks.length unchanged, end moves with it. (For a
 *     workout plan slideStartDate also clears stored completion.)
 *   - END date is a LENGTH handle: change it → resizeToEndDate; start fixed,
 *     weeks recomputed. Lengthen appends empty weeks; shorten drops trailing
 *     weeks — gated behind a confirm dialog when any dropped week holds entries.
 *   - The week count shown is DERIVED (weeksForSpan), never directly edited.
 *
 * Persistence is delegated to `onApply` (the header's existing onUpdate path);
 * this component performs no Firestore writes itself.
 */

import { useEffect, useState } from "react";
import { type Plan } from "@/types/plan";
import {
  snapToMonday,
  derivePlanEndDate,
  weeksForSpan,
  slideStartDate,
  resizeToEndDate,
  droppedWeeksWithEntries,
  raceAlignment,
} from "@/utils/planDateEdit";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface PlanDateEditorProps {
  plan: Plan;
  /** Persist the recomputed plan (header wires this to its onUpdate/persist). */
  onApply: (updated: Plan) => void | Promise<void>;
  /**
   * Optional linked race date (ISO "YYYY-MM-DD"). When supplied AND the plan now
   * ends after it, a non-blocking informational note is shown. The Plans page
   * does not currently load races, so this is omitted today (graceful degrade).
   */
  linkedRaceDate?: string;
}

const inputClass =
  "text-sm border border-border rounded-lg px-2 py-1.5 bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary";

export function PlanDateEditor({
  plan,
  onApply,
  linkedRaceDate,
}: PlanDateEditorProps) {
  // Local mirrors of the two pickers. Initialized from the plan and resynced
  // whenever the persisted plan's dates/length change (e.g. after an apply).
  const [startInput, setStartInput] = useState(plan.startDate);
  const [endInput, setEndInput] = useState(() => derivePlanEndDate(plan));

  // Pending shorten awaiting confirmation: the target end ISO + dropped summary.
  const [pendingShorten, setPendingShorten] = useState<{
    endIso: string;
    dropped: { weekNumber: number; entryCount: number }[];
  } | null>(null);

  // The race-alignment note is tied to the EDIT ACTION: it only appears once a
  // start/end edit has been applied this session (so merely opening the editor
  // on a pre-existing mismatch shows nothing). Set true whenever an edit
  // actually persists.
  const [touched, setTouched] = useState(false);

  const derivedEnd = derivePlanEndDate(plan);

  // Resync mirrors to the persisted plan (hooks always run — before any return).
  useEffect(() => {
    setStartInput(plan.startDate);
    setEndInput(derivedEnd);
  }, [plan.startDate, derivedEnd]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleStartChange(value: string) {
    if (!value) return;
    const snapped = snapToMonday(value);
    setStartInput(snapped);
    // Slide keeps weeks.length, so it can never drop entries — apply directly.
    setTouched(true);
    void onApply(slideStartDate(plan, snapped));
  }

  function handleEndChange(value: string) {
    if (!value) return;
    setEndInput(value);
    const newWeeks = weeksForSpan(plan.startDate, value);
    if (newWeeks < plan.weeks.length) {
      const dropped = droppedWeeksWithEntries(plan, newWeeks);
      if (dropped.length > 0) {
        // Defer touched until the user confirms the destructive shorten.
        setPendingShorten({ endIso: value, dropped });
        return;
      }
    }
    // Lengthen, equal, or shorten with no entries lost — apply directly.
    setTouched(true);
    void onApply(resizeToEndDate(plan, value));
  }

  function confirmShorten() {
    if (!pendingShorten) return;
    setTouched(true);
    void onApply(resizeToEndDate(plan, pendingShorten.endIso));
    setPendingShorten(null);
  }

  function cancelShorten() {
    // Revert the end picker to the plan's current derived end.
    setEndInput(derivedEnd);
    setPendingShorten(null);
  }

  // ── Derived display ───────────────────────────────────────────────────────

  const previewWeeks = weeksForSpan(startInput, endInput);
  const droppedWeekCount = pendingShorten?.dropped.length ?? 0;

  // Race-alignment note: only after an edit (touched), and only when the
  // resulting plan no longer aligns with the linked race. Both directions.
  const alignment = raceAlignment(plan, linkedRaceDate);
  const raceDateLabel = linkedRaceDate
    ? new Date(linkedRaceDate + "T00:00:00").toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : "";
  const weeksBeforeRace =
    linkedRaceDate && alignment === "before"
      ? weeksForSpan(derivePlanEndDate(plan), linkedRaceDate)
      : 0;
  const raceNote =
    touched && alignment === "after"
      ? `Heads up: this plan now ends after your race on ${raceDateLabel}.`
      : touched && alignment === "before"
        ? `Heads up: this plan now ends ${weeksBeforeRace} week${
            weeksBeforeRace === 1 ? "" : "s"
          } before your race on ${raceDateLabel}.`
        : null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-textSecondary">Start date</span>
          <input
            type="date"
            value={startInput}
            onChange={(e) => handleStartChange(e.target.value)}
            className={inputClass}
            aria-label="Plan start date"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-textSecondary">End date</span>
          <input
            type="date"
            value={endInput}
            min={startInput}
            onChange={(e) => handleEndChange(e.target.value)}
            className={inputClass}
            aria-label="Plan end date"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-textSecondary">Length</span>
          <span className="text-sm font-semibold text-textPrimary tabular-nums py-1.5">
            {previewWeeks} {previewWeeks === 1 ? "week" : "weeks"}
          </span>
        </div>
      </div>

      <p className="text-xs text-textSecondary">
        Weeks start Monday — the start date snaps to its Monday. Changing the end
        date adds or removes trailing weeks.
      </p>

      {raceNote && <p className="text-xs text-warning">{raceNote}</p>}

      <ConfirmDialog
        isOpen={pendingShorten != null}
        title="Remove weeks with planned sessions?"
        message={`Shortening this plan removes ${droppedWeekCount} trailing week${
          droppedWeekCount === 1 ? "" : "s"
        } that still contain planned sessions. This can't be undone.`}
        confirmLabel="Remove weeks"
        confirmVariant="danger"
        onConfirm={confirmShorten}
        onCancel={cancelShorten}
      />
    </div>
  );
}
