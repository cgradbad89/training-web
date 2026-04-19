"use client";

import React from "react";
import { addWeeks, formatWeekRange, weekStart as toWeekStart } from "@/utils";

interface WeekNavigatorProps {
  weekStart: Date;
  onChange: (newStart: Date) => void;
  /** Prevent navigating past today's week. Default true for back-compat. */
  disableFuture?: boolean;
  /**
   * When true, render a small "Today" pill between the arrows that resets
   * the navigator to the current week. The pill auto-hides on the current
   * week. Default false for back-compat.
   */
  showTodayReset?: boolean;
}

export function WeekNavigator({
  weekStart,
  onChange,
  disableFuture = true,
  showTodayReset = false,
}: WeekNavigatorProps) {
  const todayWeekStart = toWeekStart(new Date());
  const isCurrentWeek = weekStart.getTime() === todayWeekStart.getTime();
  const isCurrentOrFuture = weekStart.getTime() >= todayWeekStart.getTime();

  function prev() {
    onChange(addWeeks(weekStart, -1));
  }

  function next() {
    if (disableFuture && isCurrentOrFuture) return;
    onChange(addWeeks(weekStart, 1));
  }

  function resetToToday() {
    onChange(todayWeekStart);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={prev}
        aria-label="Previous week"
        className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary transition-colors"
      >
        ←
      </button>
      <span className="text-sm font-medium text-textPrimary min-w-[140px] text-center">
        {formatWeekRange(weekStart)}
      </span>
      {showTodayReset && !isCurrentWeek && (
        <button
          onClick={resetToToday}
          className="text-xs font-semibold px-2 py-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          title="Jump to current week"
        >
          Today
        </button>
      )}
      <button
        onClick={next}
        aria-label="Next week"
        disabled={disableFuture && isCurrentOrFuture}
        className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        →
      </button>
    </div>
  );
}
