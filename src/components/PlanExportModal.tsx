"use client";

import { useEffect, useState, useMemo } from "react";
import { type Plan, isRunningPlan, isWorkoutPlan } from "@/types/plan";
import { generateIcs } from "@/utils/icsExport";
import { generateRunningPlanCsv, generateWorkoutPlanCsv } from "@/utils/planExportCsv";

export interface PlanExportModalProps {
  open: boolean;
  onClose: () => void;
  allPlans: Plan[];
  initialPlanId?: string;
}

function sanitizeFilename(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "plan";
}

export function PlanExportModal({
  open,
  onClose,
  allPlans,
  initialPlanId,
}: PlanExportModalProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    initialPlanId ?? allPlans[0]?.id ?? ""
  );
  
  const selectedPlan = useMemo(
    () => allPlans.find((p) => p.id === selectedPlanId) ?? allPlans[0] ?? null,
    [allPlans, selectedPlanId]
  );
  
  const isWorkout = selectedPlan ? isWorkoutPlan(selectedPlan) : false;

  const [exportFormat, setExportFormat] = useState<"csv" | "calendar">("csv");
  const [defaultTime, setDefaultTime] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    const planId = initialPlanId ?? allPlans[0]?.id ?? "";
    setSelectedPlanId(planId);
    
    // Auto-select CSV if the initial plan is a workout
    const plan = allPlans.find((p) => p.id === planId) ?? allPlans[0] ?? null;
    if (plan && isWorkoutPlan(plan)) {
      setExportFormat("csv");
    } else {
      setExportFormat("calendar");
    }
  }, [open, initialPlanId, allPlans]);

  useEffect(() => {
    // If the user switches to a workout plan, force the format to CSV
    if (isWorkout && exportFormat === "calendar") {
      setExportFormat("csv");
    }
  }, [isWorkout, exportFormat]);

  if (!open) return null;

  function handleExport() {
    if (!selectedPlan) return;

    if (exportFormat === "calendar") {
      if (!isRunningPlan(selectedPlan)) return; // Guard and type narrow
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
    } else {
      let csv = "";
      if (isRunningPlan(selectedPlan)) {
        csv = generateRunningPlanCsv(selectedPlan);
      } else if (isWorkoutPlan(selectedPlan)) {
        csv = generateWorkoutPlanCsv(selectedPlan);
      } else {
        // legacy pilates
        alert("Exporting legacy pilates plans to CSV is not supported.");
        return;
      }
      
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sanitizeFilename(selectedPlan.name)}-plan.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

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
          Export Plan
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
          {allPlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.status === "active" ? " (Active)" : ""}
              {isWorkoutPlan(p) ? " (Workout)" : " (Running)"}
            </option>
          ))}
        </select>

        {/* Format picker */}
        <label className="block text-xs font-semibold text-textSecondary mb-1.5">
          Format
        </label>
        <select
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as "csv" | "calendar")}
          className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-card text-textPrimary mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="csv">CSV (.csv)</option>
          <option value="calendar" disabled={isWorkout}>
            Calendar iOS (.ics) {isWorkout ? "- Placeholder" : ""}
          </option>
        </select>

        {/* Default time (only for calendar export) */}
        {exportFormat === "calendar" && (
          <>
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
          </>
        )}

        {exportFormat === "csv" && (
          <p className="text-xs text-textSecondary mb-4">
            Exports a detailed spreadsheet containing all your planned workouts and exercises.
          </p>
        )}

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
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
