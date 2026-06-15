"use client";

/**
 * PlanExportModal — pick a running plan + optional default time and download a
 * calendar (.ics) file. Generation is fully client-side and in-memory via
 * generateIcs (no Firestore, no network). Rest days are skipped; runs with a
 * stored scheduledTime keep it, others use the default time or export all-day.
 */

import { useEffect, useState } from "react";
import { type RunningPlan } from "@/types/plan";
import { generateIcs } from "@/utils/icsExport";

export interface PlanExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Pre-filtered to running plans by the caller (isRunningPlan). */
  runningPlans: RunningPlan[];
  /** Pre-select this plan id (e.g. the currently selected plan). */
  initialPlanId?: string;
}

/** Filesystem-safe slug for the download filename. */
function sanitizeFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "running";
}

export function PlanExportModal({
  open,
  onClose,
  runningPlans,
  initialPlanId,
}: PlanExportModalProps) {
  // All hooks run before any early return (React error #310).
  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    initialPlanId ?? runningPlans[0]?.id ?? ""
  );
  const [defaultTime, setDefaultTime] = useState<string>("");

  // Re-sync the picker when the modal (re)opens or the caller's selection changes.
  useEffect(() => {
    if (!open) return;
    setSelectedPlanId(initialPlanId ?? runningPlans[0]?.id ?? "");
  }, [open, initialPlanId, runningPlans]);

  if (!open) return null;

  const selectedPlan =
    runningPlans.find((p) => p.id === selectedPlanId) ?? runningPlans[0] ?? null;

  function handleExport() {
    if (!selectedPlan) return;
    const ics = generateIcs({
      plan: selectedPlan,
      defaultTime: defaultTime || undefined,
    });
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(selectedPlan.name)}-plan.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card rounded-2xl shadow-xl border border-border w-full max-w-sm p-5">
        <h3 className="font-bold text-textPrimary text-sm mb-4">
          Export plan to calendar
        </h3>

        {/* Plan picker */}
        <label className="block text-xs font-semibold text-textSecondary mb-1.5">
          Plan
        </label>
        <select
          value={selectedPlanId}
          onChange={(e) => setSelectedPlanId(e.target.value)}
          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {runningPlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.status === "active" ? " (Active)" : ""}
            </option>
          ))}
        </select>

        {/* Default time */}
        <label className="block text-xs font-semibold text-textSecondary mb-1.5">
          Default time for runs without a set time (optional)
        </label>
        <input
          type="time"
          value={defaultTime}
          onChange={(e) => setDefaultTime(e.target.value)}
          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-2 focus:outline-none focus:ring-2 focus:ring-primary"
        />

        <p className="text-xs text-textSecondary mb-4">
          Runs with a time set in the plan keep that time. Rest days are skipped.
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-border text-sm text-textSecondary hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={!selectedPlan}
            className="px-4 py-2 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            Export .ics
          </button>
        </div>
      </div>
    </div>
  );
}
