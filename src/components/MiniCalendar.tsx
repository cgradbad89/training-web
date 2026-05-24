"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { weekStart as getWeekStart } from "@/utils/dates";

/** Local-date "YYYY-MM-DD" key. Using local fields (not toISOString) so a
 *  late-evening activity doesn't roll forward a day in TZs west of UTC. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Mon-anchored week key matching what runs/workouts pages already use for
 *  grouping. Exported so callers can produce stable refs the calendar can
 *  scroll into view. */
export function weekKeyForDate(date: Date): string {
  const d = getWeekStart(date);
  return toLocalIsoDate(d);
}

interface MiniCalendarProps {
  year: number;
  /** Map keyed by toLocalIsoDate(date) → numeric value to display on that
   *  day. Use the exported `toLocalIsoDateForCalendar` helper to build it
   *  so callers and the calendar agree on TZ handling. */
  valuesByDate: Record<string, number>;
  /** Inline display under the day number when a value exists. */
  formatValue: (v: number) => string;
  /** Native title-attribute tooltip on the day cell. */
  formatTooltip: (v: number) => string;
  /** Called with the Mon-anchored week key for the clicked day. */
  onDayClick: (wKey: string) => void;
  /** When set, the calendar forces this month and disables chevron nav. */
  lockedMonth?: number | null;
}

/** Build the values map a caller passes to MiniCalendar. Each entry is the
 *  per-day reduction (sum, count, etc.) of whatever the caller wants to
 *  surface. */
export const toLocalIsoDateForCalendar = toLocalIsoDate;

export function MiniCalendar({
  year,
  valuesByDate,
  formatValue,
  formatTooltip,
  onDayClick,
  lockedMonth,
}: MiniCalendarProps) {
  const today = new Date();
  const isLocked = lockedMonth !== null && lockedMonth !== undefined;
  const [month, setMonth] = useState<number>(() => {
    if (isLocked) return lockedMonth as number;
    return today.getFullYear() === year ? today.getMonth() : 11;
  });

  useEffect(() => {
    if (isLocked) {
      setMonth(lockedMonth as number);
    } else {
      setMonth(today.getFullYear() === year ? today.getMonth() : 11);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, lockedMonth]);

  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const monthLabel = firstDay.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const canGoPrev = !isLocked && month !== 0;
  const canGoNext = !isLocked && month !== 11;

  function prevMonth() {
    if (isLocked || month === 0) return;
    setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (isLocked || month === 11) return;
    setMonth((m) => m + 1);
  }

  // Lift the day-of-week header so we render it once.
  const dayLabels = useMemo(() => ["M", "T", "W", "T", "F", "S", "S"], []);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={prevMonth}
          disabled={!canGoPrev}
          aria-label="Previous month"
          className="p-1 rounded-md hover:bg-surface text-textSecondary disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-semibold text-textSecondary">{monthLabel}</span>
        <button
          onClick={nextMonth}
          disabled={!canGoNext}
          aria-label="Next month"
          className="p-1 rounded-md hover:bg-surface text-textSecondary disabled:opacity-30 transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {dayLabels.map((d, i) => (
          <div
            key={i}
            className="text-center text-[10px] font-semibold text-textSecondary py-0.5"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: totalCells }).map((_, i) => {
          const dayNum = i - startOffset + 1;
          const isThisMonth = dayNum >= 1 && dayNum <= daysInMonth;

          if (!isThisMonth) {
            return <div key={i} className="h-7" />;
          }

          const cellDate = new Date(year, month, dayNum);
          const isoDate = toLocalIsoDate(cellDate);
          const value = valuesByDate[isoDate];
          const hasActivity = !!value;
          const isToday =
            cellDate.getFullYear() === today.getFullYear() &&
            cellDate.getMonth() === today.getMonth() &&
            cellDate.getDate() === today.getDate();

          const wk = weekKeyForDate(cellDate);

          return (
            <button
              key={i}
              onClick={() => hasActivity && onDayClick(wk)}
              disabled={!hasActivity}
              className={`flex flex-col items-center justify-center h-7 rounded-full transition-colors
                ${hasActivity ? "cursor-pointer" : "cursor-default"}
              `}
              title={hasActivity ? formatTooltip(value) : undefined}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium transition-colors
                  ${
                    hasActivity
                      ? "bg-primary text-white"
                      : "border border-border text-textSecondary"
                  }
                  ${isToday ? "ring-2 ring-primary ring-offset-1" : ""}
                `}
              >
                {dayNum}
              </div>
              {hasActivity && (
                <span className="text-[9px] text-textSecondary leading-none mt-0.5">
                  {formatValue(value)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
