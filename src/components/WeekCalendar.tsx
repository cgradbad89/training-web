"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Dumbbell, Footprints } from "lucide-react";
import type { RunningPlan, WorkoutPlan, WorkoutCategory, PlannedRunEntry } from "@/types/plan";
import { isRunningPlan } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { buildCalendarEvents, type CalendarEvent } from "@/utils/planCalendar";
import { weekStart as getWeekStart, toLocalIsoDate } from "@/utils/dates";
import type { RunEntryStatus } from "@/utils/planMatching";
import { RunActivityModal } from "@/components/runs/RunActivityModal";
import { RunStatusIcon } from "@/components/RunStatusIcon";

const CATEGORY_PILL: Record<WorkoutCategory, string> = {
  strength: "bg-blue-600 text-white", orangetheory: "bg-orange-500 text-white",
  cycling: "bg-green-600 text-white", pilates: "bg-purple-500 text-white",
  yoga: "bg-teal-500 text-white", hiit: "bg-red-500 text-white",
};

export function calendarEventKey(event: CalendarEvent): string {
  return event.kind === "actual-run" || event.kind === "actual-workout"
    ? `${event.kind}-${event.activity.workoutId}`
    : `${event.kind}-${event.planId}-${event.entryId}`;
}

function eventPillClass(event: CalendarEvent): string {
  if (event.kind === "actual-run" || event.kind === "actual-workout") {
    return "bg-surface text-textPrimary border border-border";
  }
  if (event.kind === "planned-running") return "bg-blue-100 text-blue-800";
  return event.category ? CATEGORY_PILL[event.category] : "bg-gray-100 text-gray-600";
}

function addDays(date: Date, n: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function EventPill({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const actual = event.kind === "actual-run" || event.kind === "actual-workout";
  const time = actual ? event.activity.startDate.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  }) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded px-1.5 py-0.5 text-xs truncate leading-tight flex items-center gap-1 ${eventPillClass(event)} ${event.kind === "planned-workout" && event.completed ? "opacity-60" : ""}`}
    >
      {event.kind === "planned-running" && <RunStatusIcon status={event.status} size={12} />}
      {event.kind === "planned-workout" && event.completed && "✓ "}
      {event.kind === "actual-run" && <Footprints aria-label="Actual run" size={12} className="shrink-0" />}
      {event.kind === "actual-workout" && <Dumbbell aria-label="Actual workout" size={12} className="shrink-0" />}
      <span className="truncate">
        {actual && `${time} · `}{event.label}
        {event.kind === "planned-running" && event.distanceMiles != null && ` · ${event.distanceMiles.toFixed(1)} mi`}
      </span>
    </button>
  );
}

interface WeekCalendarProps {
  plans: (RunningPlan | WorkoutPlan)[];
  actualRuns: HealthWorkout[];
  overrides?: Record<string, WorkoutOverride>;
  prebuiltEvents?: CalendarEvent[];
  weekStart?: Date;
  onEventClick?: (event: CalendarEvent) => void;
}

/** Standalone dashboard use stays planned-only unless prebuiltEvents is supplied. */
export function WeekCalendar({
  plans, actualRuns, overrides, prebuiltEvents, weekStart, onEventClick,
}: WeekCalendarProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<{
    entry: PlannedRunEntry; activity: HealthWorkout | null;
    status: RunEntryStatus; date: Date;
  } | null>(null);
  const monday = useMemo(() => weekStart ?? getWeekStart(new Date()), [weekStart]);
  const builtEvents = useMemo(
    () => prebuiltEvents ?? buildCalendarEvents(plans, actualRuns, overrides),
    [prebuiltEvents, plans, actualRuns, overrides]
  );
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const todayKey = toLocalIsoDate(new Date());

  function handleClick(event: CalendarEvent) {
    if (onEventClick) return onEventClick(event);
    if (event.kind === "planned-workout") {
      router.push(`/workout/${event.planId}/${event.weekIndex}/${event.weekday}/${event.sessionIndex}`);
      return;
    }
    if (event.kind === "actual-run") {
      router.push(`/runs/${event.activity.workoutId}`);
      return;
    }
    if (event.kind === "actual-workout") return;
    const plan = plans.find((candidate) => candidate.id === event.planId);
    if (!plan || !isRunningPlan(plan)) return;
    const entry = plan.weeks.flatMap((week) => week.entries).find((candidate) => candidate.id === event.entryId);
    if (entry) setSelected({ entry, activity: event.activity, status: event.status, date: event.date });
  }

  return (
    <>
      <div className="overflow-x-auto">
        <div className="min-w-[560px] grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
          {days.map((day, i) => {
            const isToday = toLocalIsoDate(day) === todayKey;
            return (
              <div key={`h-${toLocalIsoDate(day)}`} className={`p-2 text-center bg-card ${isToday ? "bg-primary/5" : ""}`}>
                <div className="text-xs font-semibold text-textSecondary">{DAY_HEADERS[i]}</div>
                <div className={`text-sm font-bold mt-0.5 ${isToday ? "text-primary" : "text-textPrimary"}`}>{day.getDate()}</div>
              </div>
            );
          })}
          {days.map((day) => {
            const dayKey = toLocalIsoDate(day);
            const isToday = dayKey === todayKey;
            return (
              <div key={`b-${dayKey}`} className={`p-2 bg-card min-h-[100px] flex flex-col gap-1 ${isToday ? "bg-primary/5" : ""}`}>
                {builtEvents.filter((event) => toLocalIsoDate(event.date) === dayKey).map((event) => (
                  <EventPill key={calendarEventKey(event)} event={event} onClick={() => handleClick(event)} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <RunActivityModal isOpen onClose={() => setSelected(null)} plannedEntry={selected.entry}
          matchedRun={selected.activity} status={selected.status} sessionDate={selected.date} />
      )}
    </>
  );
}
