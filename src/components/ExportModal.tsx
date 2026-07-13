"use client";

import React, { useState, useEffect } from "react";
import { X, Download, AlertCircle } from "lucide-react";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  type TimeRange,
  filterByTimeRange,
  generateWorkoutsCsv,
  generateRunsCsv,
  downloadCsv,
} from "@/utils/exportCsv";
import { fetchSplitsForRuns } from "@/services/bulkExport";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: "runs" | "workouts";
  data: HealthWorkout[];
  uid: string | null;
  maxHr: number;
  restingHr: number;
}

const OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "30_days", label: "Last 30 Days" },
  { value: "90_days", label: "Last 90 Days" },
  { value: "6_months", label: "Last 6 Months" },
  { value: "ytd", label: "Year to Date" },
  { value: "all_time", label: "All Time" },
];

export function ExportModal({
  isOpen,
  onClose,
  type,
  data,
  uid,
  maxHr,
  restingHr,
}: ExportModalProps) {
  const [selectedRange, setSelectedRange] = useState<TimeRange>("30_days");
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalToProcess, setTotalToProcess] = useState(0);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
      // Reset state when closed
      setSelectedRange("30_days");
      setIsExporting(false);
      setProgress(0);
      setTotalToProcess(0);
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleExport = async () => {
    setIsExporting(true);
    setProgress(0);
    setTotalToProcess(0);

    try {
      const filteredData = filterByTimeRange(data, selectedRange);

      if (type === "workouts") {
        const csv = generateWorkoutsCsv(filteredData, maxHr, restingHr);
        downloadCsv(`workouts_export_${selectedRange}.csv`, csv);
      } else {
        if (!uid) throw new Error("User not authenticated");

        // Fetch splits for runs
        const splitsMap = await fetchSplitsForRuns(
          filteredData,
          uid,
          (completed, total) => {
            setProgress(completed);
            setTotalToProcess(total);
          }
        );

        const csv = generateRunsCsv(filteredData, splitsMap, maxHr, restingHr);
        downloadCsv(`runs_export_${selectedRange}.csv`, csv);
      }
      onClose();
    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to export data. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={!isExporting ? onClose : undefined}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-textPrimary">
            Export {type === "runs" ? "Runs" : "Workouts"}
          </h2>
          {!isExporting && (
            <button
              onClick={onClose}
              className="p-1.5 text-textSecondary hover:bg-surface rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mb-6 space-y-3">
          <p className="text-sm text-textSecondary">
            Select a time frame to export your data as a CSV file.
          </p>
          <div className="space-y-2">
            {OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                  selectedRange === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-surface"
                } ${isExporting ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <input
                  type="radio"
                  name="timeRange"
                  value={opt.value}
                  checked={selectedRange === opt.value}
                  onChange={() => setSelectedRange(opt.value)}
                  disabled={isExporting}
                  className="w-4 h-4 text-primary bg-surface border-border focus:ring-primary focus:ring-2"
                />
                <span className="text-sm font-medium text-textPrimary">
                  {opt.label}
                </span>
              </label>
            ))}
          </div>

          {type === "runs" && selectedRange === "all_time" && (
            <div className="flex items-start gap-2 mt-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-xs text-amber-800 dark:text-amber-200">
                Exporting all time runs may take a moment to fetch pace and heart rate splits.
              </p>
            </div>
          )}
        </div>

        {isExporting && type === "runs" && totalToProcess > 0 && (
          <div className="mb-6 space-y-2">
            <div className="flex justify-between text-xs text-textSecondary font-medium">
              <span>Fetching run details...</span>
              <span>
                {progress} / {totalToProcess}
              </span>
            </div>
            <div className="h-2 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{
                  width: `${(progress / totalToProcess) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        <button
          onClick={handleExport}
          disabled={isExporting}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isExporting ? (
            <span className="flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Generating...
            </span>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Export CSV
            </>
          )}
        </button>
      </div>
    </div>
  );
}
