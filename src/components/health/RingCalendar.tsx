"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  ActivityRings,
  RING_COLORS,
  RING_LABELS,
  RING_UNITS,
  fmtRingNumber,
  type RingDatum,
} from "@/components/ActivityRings";
import {
  RING_METRICS,
  dailyRingProgress,
  eachDate,
  periodRingProgress,
  resolveGoalForDate,
  shiftDate,
  toIsoDate,
} from "@/lib/ringMath";
import { weekStart } from "@/utils/dates";
import type { HealthMetric } from "@/services/healthMetrics";
import type { HealthGoalDoc, RingMetric } from "@/types/healthGoal";

type CalendarView = "week" | "month" | "ytd";

const VIEW_OPTIONS: { value: CalendarView; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "ytd", label: "YTD" },
];

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface RingCalendarProps {
  /** healthMetrics docs keyed by their "YYYY-MM-DD" date. */
  metricsByDate: Map<string, HealthMetric>;
  goals: HealthGoalDoc[];
  /**
   * Fired whenever the visible date range changes (view switch / month nav)
   * so the parent can fetch+cache just that range.
   */
  onVisibleRangeChange?: (startDate: string, endDate: string) => void;
  /** Ring tap inside the day detail panel — routes to the Trends tab. */
  onMetricClick?: (metric: RingMetric) => void;
}

/** Daily rings (with value labels) for one calendar day. */
function ringsForDate(
  date: string,
  metricsByDate: Map<string, HealthMetric>,
  goals: HealthGoalDoc[],
  todayIso: string
): RingDatum[] {
  const doc = date <= todayIso ? metricsByDate.get(date) : undefined;
  return RING_METRICS.map((metric) => {
    const value = doc?.[metric] as number | undefined;
    const goal = resolveGoalForDate(goals, metric, date);
    return {
      metric,
      label: RING_LABELS[metric],
      progress: dailyRingProgress(value, goal),
      color: RING_COLORS[metric],
      valueLabel: `${fmtRingNumber(metric, value != null && value > 0 ? value : 0)} / ${fmtRingNumber(metric, goal)}${RING_UNITS[metric]}`,
    };
  });
}

/** "Mon, Jun 8" header for the day detail panel. */
function formatDayTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Calendar of mini activity rings: current week by default, with Month
 * (grid + ←/→ navigation) and YTD (12-row month summary) views. Tapping a
 * day expands a detail panel with full rings + numbers vs goals.
 */
export function RingCalendar({
  metricsByDate,
  goals,
  onVisibleRangeChange,
  onMetricClick,
}: RingCalendarProps) {
  const todayIso = toIsoDate(new Date());
  const [view, setView] = useState<CalendarView>("week");
  // First-of-month anchoring the Month view.
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const currentYear = Number(todayIso.slice(0, 4));
  const currentMonthIdx = Number(todayIso.slice(5, 7)) - 1;

  // Visible range per view — drives the parent's range-scoped fetch.
  const visibleRange = useMemo(() => {
    if (view === "week") {
      const ws = weekStart(new Date());
      return { start: toIsoDate(ws), end: shiftDate(toIsoDate(ws), 6) };
    }
    if (view === "month") {
      const y = monthAnchor.getFullYear();
      const m = monthAnchor.getMonth();
      return {
        start: toIsoDate(new Date(y, m, 1)),
        end: toIsoDate(new Date(y, m + 1, 0)),
      };
    }
    return { start: `${currentYear}-01-01`, end: todayIso };
  }, [view, monthAnchor, todayIso, currentYear]);

  useEffect(() => {
    onVisibleRangeChange?.(visibleRange.start, visibleRange.end);
  }, [visibleRange, onVisibleRangeChange]);

  const toggleDay = (date: string) =>
    setSelectedDay((prev) => (prev === date ? null : date));

  // ── Week view: one row of 7 mini rings, Mon–Sun ─────────────────────────
  const weekDays = useMemo(
    () => eachDate(visibleRange.start, shiftDate(visibleRange.start, 6)),
    [visibleRange.start]
  );

  // ── Month view: grid with leading blanks ────────────────────────────────
  const monthGrid = useMemo(() => {
    if (view !== "month") return { blanks: 0, days: [] as string[] };
    const y = monthAnchor.getFullYear();
    const m = monthAnchor.getMonth();
    const first = new Date(y, m, 1);
    const blanks = (first.getDay() + 6) % 7; // Monday-start offset
    return {
      blanks,
      days: eachDate(toIsoDate(first), toIsoDate(new Date(y, m + 1, 0))),
    };
  }, [view, monthAnchor]);

  const monthIsCurrent =
    monthAnchor.getFullYear() === currentYear &&
    monthAnchor.getMonth() === currentMonthIdx;

  // ── YTD view: one summary row per month (Jan → current) ────────────────
  // Implementation choice: 12-row mini summary (one period-ring set per
  // month) rather than vertically stacked month grids — simpler and reads
  // as a true year overview. Tapping a row jumps to that month's grid.
  const ytdMonths = useMemo(() => {
    if (view !== "ytd") return [];
    return Array.from({ length: currentMonthIdx + 1 }, (_, monthIdx) => {
      const start = toIsoDate(new Date(currentYear, monthIdx, 1));
      const endOfMonth = toIsoDate(new Date(currentYear, monthIdx + 1, 0));
      const end = endOfMonth > todayIso ? todayIso : endOfMonth; // to-date
      const rings: RingDatum[] = RING_METRICS.map((metric) => {
        const days = eachDate(start, end).map((date) => ({
          date,
          value: (metricsByDate.get(date)?.[metric] as number | undefined) ?? null,
        }));
        const progress = periodRingProgress(days, goals, metric, start, end);
        return {
          metric,
          label: RING_LABELS[metric],
          progress,
          color: RING_COLORS[metric],
          valueLabel: `${Math.round(progress * 100)}%`,
        };
      });
      return { monthIdx, rings };
    });
  }, [view, currentYear, currentMonthIdx, todayIso, metricsByDate, goals]);

  const selectedDayRings = selectedDay
    ? ringsForDate(selectedDay, metricsByDate, goals, todayIso)
    : null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5 mb-8">
      {/* View toggle + (month nav) */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
        <div className="inline-flex items-center gap-1 bg-surface rounded-lg p-0.5">
          {VIEW_OPTIONS.map((o) => {
            const active = o.value === view;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setView(o.value)}
                aria-pressed={active}
                className={`text-xs px-3 h-7 rounded-lg font-semibold transition-colors ${
                  active
                    ? "bg-primary text-white"
                    : "text-textSecondary hover:text-textPrimary"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>

        {view === "month" && (
          <div className="flex items-center gap-1 text-sm text-textSecondary">
            <button
              type="button"
              onClick={() =>
                setMonthAnchor(
                  (d) => new Date(d.getFullYear(), d.getMonth() - 1, 1)
                )
              }
              aria-label="Previous month"
              className="p-1 rounded hover:bg-surface hover:text-textPrimary transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="min-w-[130px] text-center font-medium text-textPrimary">
              {MONTH_NAMES[monthAnchor.getMonth()]} {monthAnchor.getFullYear()}
            </span>
            <button
              type="button"
              onClick={() =>
                setMonthAnchor(
                  (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1)
                )
              }
              aria-label="Next month"
              className="p-1 rounded hover:bg-surface hover:text-textPrimary transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {!monthIsCurrent && (
              <button
                type="button"
                onClick={() =>
                  setMonthAnchor(new Date(currentYear, currentMonthIdx, 1))
                }
                className="ml-1 text-xs px-2 h-6 rounded-md bg-surface text-textSecondary hover:text-textPrimary transition-colors"
              >
                Today
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Week view ──────────────────────────────────────────────── */}
      {view === "week" && (
        <div className="grid grid-cols-7 gap-1">
          {weekDays.map((date, i) => (
            <DayCell
              key={date}
              date={date}
              topLabel={WEEKDAY_HEADERS[i]}
              dayNumber={Number(date.slice(8, 10))}
              isToday={date === todayIso}
              selected={selectedDay === date}
              rings={ringsForDate(date, metricsByDate, goals, todayIso)}
              size={44}
              onSelect={() => toggleDay(date)}
            />
          ))}
        </div>
      )}

      {/* ── Month view ─────────────────────────────────────────────── */}
      {view === "month" && (
        <>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {WEEKDAY_HEADERS.map((d) => (
              <span
                key={d}
                className="text-[10px] text-textSecondary text-center font-semibold uppercase"
              >
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: monthGrid.blanks }, (_, i) => (
              <span key={`blank-${i}`} aria-hidden />
            ))}
            {monthGrid.days.map((date) => (
              <DayCell
                key={date}
                date={date}
                dayNumber={Number(date.slice(8, 10))}
                isToday={date === todayIso}
                selected={selectedDay === date}
                rings={ringsForDate(date, metricsByDate, goals, todayIso)}
                size={36}
                onSelect={() => toggleDay(date)}
              />
            ))}
          </div>
        </>
      )}

      {/* ── YTD view ───────────────────────────────────────────────── */}
      {view === "ytd" && (
        <div className="flex flex-col">
          {ytdMonths.map(({ monthIdx, rings }) => (
            <button
              key={monthIdx}
              type="button"
              onClick={() => {
                setView("month");
                setMonthAnchor(new Date(currentYear, monthIdx, 1));
              }}
              className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-xl hover:bg-surface transition-colors"
            >
              <span className="text-sm text-textPrimary w-24 text-left">
                {MONTH_NAMES[monthIdx]}
              </span>
              <ActivityRings rings={rings} size={36} />
              <span className="flex-1 flex items-center justify-end gap-3">
                {rings.map((r) => (
                  <span
                    key={r.metric}
                    className="text-[10px] tabular-nums w-9 text-right"
                    style={{ color: r.color }}
                  >
                    {r.valueLabel}
                  </span>
                ))}
              </span>
            </button>
          ))}
          <p className="text-[10px] text-textSecondary mt-2">
            Month completion = total logged ÷ total goal across the month
            (current month to-date). Tap a month to open its grid.
          </p>
        </div>
      )}

      {/* ── Day detail panel ───────────────────────────────────────── */}
      {selectedDay && selectedDayRings && view !== "ytd" && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-textPrimary">
              {formatDayTitle(selectedDay)}
            </p>
            <button
              type="button"
              onClick={() => setSelectedDay(null)}
              className="text-xs text-textSecondary hover:text-textPrimary transition-colors"
            >
              Close
            </button>
          </div>
          <ActivityRings
            rings={selectedDayRings}
            size={160}
            showLegend
            onRingClick={onMetricClick}
          />
        </div>
      )}
    </div>
  );
}

interface DayCellProps {
  date: string;
  topLabel?: string;
  dayNumber: number;
  isToday: boolean;
  selected: boolean;
  rings: RingDatum[];
  size: number;
  onSelect: () => void;
}

function DayCell({
  topLabel,
  dayNumber,
  isToday,
  selected,
  rings,
  size,
  onSelect,
}: DayCellProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col items-center gap-0.5 py-1.5 px-0.5 rounded-xl transition-colors ${
        selected ? "bg-surface ring-2 ring-primary" : "hover:bg-surface"
      }`}
    >
      {topLabel && (
        <span className="text-[10px] text-textSecondary font-semibold uppercase">
          {topLabel}
        </span>
      )}
      <ActivityRings rings={rings} size={size} />
      <span
        className={`text-[10px] tabular-nums ${
          isToday
            ? "font-bold text-primary"
            : "text-textSecondary"
        }`}
      >
        {dayNumber}
      </span>
    </button>
  );
}
