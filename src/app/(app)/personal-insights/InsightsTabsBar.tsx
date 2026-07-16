"use client";

import React from "react";

export type InsightsTab = "fitness" | "performance" | "workouts";

const INSIGHTS_TABS: ReadonlyArray<{ value: InsightsTab; label: string }> = [
  { value: "fitness", label: "Fitness & Load" },
  { value: "performance", label: "Race Readiness" },
  { value: "workouts", label: "Workout Trends" },
];

interface InsightsTabsBarProps {
  value: InsightsTab;
  onChange: (tab: InsightsTab) => void;
}

/** Segmented pill-group for the Personal Insights tabs. Mirrors the
 *  HealthTabsBar treatment (same surface pill container + tokens). */
export function InsightsTabsBar({ value, onChange }: InsightsTabsBarProps) {
  return (
    <div className="inline-flex items-center gap-1 bg-surface rounded-xl p-1">
      {INSIGHTS_TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            aria-pressed={active}
            className={`text-sm px-4 h-8 rounded-lg font-semibold transition-colors ${
              active
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
