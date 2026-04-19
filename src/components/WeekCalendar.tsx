"use client";

import React, { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";
import {
  buildCalendarEvents,
  type CalendarEvent,
} from "@/utils/planCalendar";
import { weekStart as getWeekStart } from "@/utils/dates";

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

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ─── Event Pill ───────────────────────────────────────────────────────────────

export function EventPill({
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

// ─── Week Calendar ────────────────────────────────────────────────────────────

interface WeekCalendarProps {
  plans: (RunningPlan | WorkoutPlan)[];
  actualRuns: HealthWorkout[];
  /** Optional override for which week to show. Defaults to the current week's Monday. */
  weekStart?: Date;
  /**
   * Optional click handler. When omitted, defaults to the same routing
   * behavior CalendarView uses: workout events route to the workout detail
   * page, running events route to /plans.
   */
  onEventClick?: (event: CalendarEvent) => void;
}

/**
 * Standalone week-view calendar grid. Renders 7 columns (Mon–Sun) of the
 * given `weekStart` Monday, with planned-session pills derived from
 * `plans` + `actualRuns` via buildCalendarEvents.
 *
 * No prev/next/toggle controls — those are owned by the parent (CalendarView
 * provides them; the dashboard renders the calendar fixed to the current week).
 */
export function WeekCalendar({
  plans,
  actualRuns,
  weekStart,
  onEventClick,
}: WeekCalendarProps) {
  const router = useRouter();

  const monday = useMemo(
    () => weekStart ?? getWeekStart(new Date()),
    [weekStart]
  );

  const events = useMemo(
    () => buildCalendarEvents(plans, actualRuns),
    [plans, actualRuns]
  );

  const today = todayMidnight();
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(monday, i)),
    [monday]
  );

  function handleClick(event: CalendarEvent) {
    if (onEventClick) {
      onEventClick(event);
      return;
    }
    if (event.planType === "workout") {
      router.push(
        `/workout/${event.planId}/${event.weekIndex}/${event.weekday}/${event.sessionIndex}`
      );
    } else {
      router.push("/plans");
    }
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px] grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {/* Header row */}
        {days.map((day, i) => {
          const isToday = isSameDay(day, today);
          return (
            <div
              key={`h-${i}`}
              className={`p-2 text-center bg-card ${isToday ? "bg-primary/5" : ""}`}
            >
              <div className="text-xs font-semibold text-textSecondary">
                {DAY_HEADERS[i]}
              </div>
              <div
                className={`text-sm font-bold mt-0.5 ${isToday ? "text-primary" : "text-textPrimary"}`}
              >
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
              key={`b-${i}`}
              className={`p-2 bg-card min-h-[100px] flex flex-col gap-1 ${isToday ? "bg-primary/5" : ""}`}
            >
              {dayEvents.map((ev, j) => (
                <EventPill
                  key={j}
                  event={ev}
                  onClick={() => handleClick(ev)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
