"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";
import { buildCalendarEvents, type CalendarEvent } from "@/utils/planCalendar";
import { weekStart } from "@/utils/dates";

// ─── Color helpers ────────────────────────────────────────────────────────────

const CATEGORY_PILL: Record<WorkoutCategory, string> = {
  strength:     "bg-blue-600 text-white",
  orangetheory: "bg-orange-500 text-white",
  cycling:      "bg-green-600 text-white",
  pilates:      "bg-purple-500 text-white",
  yoga:         "bg-teal-500 text-white",
  hiit:         "bg-red-500 text-white",
};

function eventPillClass(event: CalendarEvent): string {
  if (event.planType === "running") return "bg-blue-100 text-blue-800";
  if (event.category && event.category in CATEGORY_PILL) {
    return CATEGORY_PILL[event.category];
  }
  return "bg-gray-100 text-gray-600";
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getMonthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function weekPeriodLabel(monday: Date): string {
  const sunday = addDays(monday, 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${monday.toLocaleDateString("en-US", opts)} – ${sunday.toLocaleDateString("en-US", opts)}`;
}

function monthPeriodLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── Event Pill ───────────────────────────────────────────────────────────────

function EventPill({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-xs cursor-pointer truncate leading-tight ${eventPillClass(event)} ${event.completed ? "opacity-60" : ""}`}
    >
      {event.completed && "✓ "}
      {event.label}
      {event.distanceMiles != null && ` · ${event.distanceMiles.toFixed(1)} mi`}
    </div>
  );
}

// ─── Week Grid ────────────────────────────────────────────────────────────────

function WeekGrid({
  events,
  monday,
  onEventClick,
}: {
  events: CalendarEvent[];
  monday: Date;
  onEventClick: (e: CalendarEvent) => void;
}) {
  const today = todayMidnight();
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px] grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {/* Header row */}
        {days.map((day, i) => {
          const isToday = isSameDay(day, today);
          return (
            <div key={i} className={`p-2 text-center bg-card ${isToday ? "bg-primary/5" : ""}`}>
              <div className="text-xs font-semibold text-textSecondary">{DAY_HEADERS[i]}</div>
              <div className={`text-sm font-bold mt-0.5 ${isToday ? "text-primary" : "text-textPrimary"}`}>
                {day.getDate()}
              </div>
            </div>
          );
        })}
        {/* Body row */}
        {days.map((day, i) => {
          const dayEvents = events.filter((e) => isSameDay(e.date, day));
          const isToday = isSameDay(day, today);
          return (
            <div
              key={i}
              className={`p-2 bg-card min-h-[100px] flex flex-col gap-1 ${isToday ? "bg-primary/5" : ""}`}
            >
              {dayEvents.map((ev, j) => (
                <EventPill key={j} event={ev} onClick={() => onEventClick(ev)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Month Grid ───────────────────────────────────────────────────────────────

function MonthGrid({
  events,
  monthStart,
  onEventClick,
}: {
  events: CalendarEvent[];
  monthStart: Date;
  onEventClick: (e: CalendarEvent) => void;
}) {
  const today = todayMidnight();
  const gridStart = weekStart(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  return (
    <div className="overflow-y-auto flex-1">
      <div className="grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {/* Day name headers */}
        {DAY_HEADERS.map((h) => (
          <div key={h} className="p-2 text-center bg-card">
            <span className="text-xs font-semibold text-textSecondary">{h}</span>
          </div>
        ))}
        {/* Date cells */}
        {cells.map((day, i) => {
          const inMonth = day.getMonth() === monthStart.getMonth();
          const isToday = isSameDay(day, today);
          const dayEvents = events.filter((e) => isSameDay(e.date, day));
          const shown = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - 3;
          return (
            <div key={i} className={`p-1.5 bg-card min-h-[72px] ${isToday ? "bg-primary/5" : ""}`}>
              <div
                className={`text-xs font-semibold mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                  isToday
                    ? "bg-primary text-white"
                    : inMonth
                    ? "text-textPrimary"
                    : "text-textSecondary/30"
                }`}
              >
                {day.getDate()}
              </div>
              <div className="flex flex-col gap-0.5">
                {shown.map((ev, j) => (
                  <EventPill key={j} event={ev} onClick={() => onEventClick(ev)} />
                ))}
                {overflow > 0 && (
                  <span className="text-[10px] text-textSecondary pl-1">+{overflow} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface CalendarViewProps {
  plans: (RunningPlan | WorkoutPlan)[];
  actualRuns?: HealthWorkout[];
  onRunningEventClick?: (planId: string, weekIndex: number) => void;
}

export function CalendarView({ plans, actualRuns = [], onRunningEventClick }: CalendarViewProps) {
  const router = useRouter();

  const [calView, setCalView] = useState<"week" | "month">("week");
  const [currentMonday, setCurrentMonday] = useState<Date>(() => weekStart(new Date()));
  const [currentMonthStart, setCurrentMonthStart] = useState<Date>(() =>
    getMonthStart(new Date())
  );

  const events = useMemo(() => buildCalendarEvents(plans, actualRuns), [plans, actualRuns]);

  const hasActivePlans = plans.some((p) => p.isActive);

  const periodLabel =
    calView === "week"
      ? weekPeriodLabel(currentMonday)
      : monthPeriodLabel(currentMonthStart);

  function handlePrev() {
    if (calView === "week") {
      setCurrentMonday((d) => addDays(d, -7));
    } else {
      setCurrentMonthStart((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
    }
  }

  function handleNext() {
    if (calView === "week") {
      setCurrentMonday((d) => addDays(d, 7));
    } else {
      setCurrentMonthStart((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));
    }
  }

  function handleEventClick(event: CalendarEvent) {
    if (event.planType === "workout") {
      router.push(`/workout/${event.planId}/${event.weekIndex}/${event.weekday}`);
    } else if (onRunningEventClick) {
      onRunningEventClick(event.planId, event.weekIndex);
    } else {
      router.push("/plans");
    }
  }

  if (!hasActivePlans) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-textSecondary text-center max-w-sm">
          No active plans. Activate a running or workout plan to see your schedule.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden p-4 gap-4">
      {/* Controls bar */}
      <div className="flex justify-between items-center shrink-0">
        <div className="flex gap-2">
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setCalView(v)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${
                calView === v
                  ? "bg-primary text-white"
                  : "text-textSecondary hover:text-textPrimary"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrev}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-textPrimary min-w-[160px] text-center">
            {periodLabel}
          </span>
          <button
            onClick={handleNext}
            className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {calView === "week" ? (
        <WeekGrid events={events} monday={currentMonday} onEventClick={handleEventClick} />
      ) : (
        <MonthGrid
          events={events}
          monthStart={currentMonthStart}
          onEventClick={handleEventClick}
        />
      )}
    </div>
  );
}
