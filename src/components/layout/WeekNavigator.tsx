"use client";

import React from "react";
import { addWeeks, formatWeekRange } from "@/utils";

interface WeekNavigatorProps {
  weekStart: Date;
  onChange: (newStart: Date) => void;
  /** Prevent navigating past today's week */
  disableFuture?: boolean;
}

export function WeekNavigator({
  weekStart,
  onChange,
  disableFuture = true,
}: WeekNavigatorProps) {
  const now = new Date();
  const currentWeekMs = (() => {
    const d = new Date(now);
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  const isCurrentOrFuture = weekStart.getTime() >= currentWeekMs;

  function prev() {
    onChange(addWeeks(weekStart, -1));
  }

  function next() {
    if (disableFuture && isCurrentOrFuture) return;
    onChange(addWeeks(weekStart, 1));
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={prev}
        aria-label="Previous week"
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors"
      >
        ←
      </button>
      <span className="text-sm font-medium text-gray-700 min-w-[140px] text-center">
        {formatWeekRange(weekStart)}
      </span>
      <button
        onClick={next}
        aria-label="Next week"
        disabled={disableFuture && isCurrentOrFuture}
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        →
      </button>
    </div>
  );
}
