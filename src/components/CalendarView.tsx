"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { isRunningPlan, type RunningPlan, type WorkoutPlan, type PlannedRunEntry } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RunEntryStatus } from "@/utils/planMatching";
import { buildCalendarEvents, type CalendarEvent } from "@/utils/planCalendar";
import { weekStart, toLocalIsoDate } from "@/utils/dates";
import { WeekCalendar, EventPill, calendarEventKey } from "@/components/WeekCalendar";
import { RunActivityModal } from "@/components/runs/RunActivityModal";
import { WorkoutDetailModal } from "@/components/WorkoutDetailModal";
import { CalendarDayDetailModal } from "@/components/CalendarDayDetailModal";

function addDays(date: Date, n: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function MonthGrid({
  events, month, onEventClick, onMore,
}: {
  events: CalendarEvent[];
  month: Date;
  onEventClick: (event: CalendarEvent) => void;
  onMore: (date: Date, events: CalendarEvent[]) => void;
}) {
  const todayKey = toLocalIsoDate(new Date());
  const first = weekStart(month);
  const cells = Array.from({ length: 42 }, (_, index) => addDays(first, index));
  return (
    <div className="overflow-y-auto flex-1">
      <div className="grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {DAY_HEADERS.map((header) => (
          <div key={header} className="p-2 text-center bg-card">
            <span className="text-xs font-semibold text-textSecondary">{header}</span>
          </div>
        ))}
        {cells.map((day) => {
          const key = toLocalIsoDate(day);
          const inMonth = day.getMonth() === month.getMonth();
          const isToday = key === todayKey;
          const dayEvents = events.filter((event) => toLocalIsoDate(event.date) === key);
          const overflow = dayEvents.length - 3;
          return (
            <div key={key} className={`p-1.5 bg-card min-h-[72px] ${isToday ? "bg-primary/5" : ""}`}>
              <div className={`text-xs font-semibold mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                isToday ? "bg-primary text-white" : inMonth ? "text-textPrimary" : "text-textSecondary/30"
              }`}>{day.getDate()}</div>
              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((event) => (
                  <EventPill key={calendarEventKey(event)} event={event} onClick={() => onEventClick(event)} />
                ))}
                {overflow > 0 && (
                  <button type="button" className="text-[10px] text-textSecondary pl-1 text-left hover:text-textPrimary"
                    onClick={() => onMore(day, dayEvents)}>
                    +{overflow} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface CalendarViewProps {
  plans: (RunningPlan | WorkoutPlan)[];
  actualWorkouts?: HealthWorkout[];
  userId: string | null;
  overrides: Record<string, WorkoutOverride>;
  maxHr: number;
  restingHr: number;
  onWorkoutExcludeChange: (workoutId: string, excluded: boolean) => void;
}

export function CalendarView({
  plans, actualWorkouts = [], userId, overrides, maxHr, restingHr, onWorkoutExcludeChange,
}: CalendarViewProps) {
  const router = useRouter();
  const [calView, setCalView] = useState<"week" | "month">("week");
  const [currentMonday, setCurrentMonday] = useState(() => weekStart(new Date()));
  const [currentMonth, setCurrentMonth] = useState(() => monthStart(new Date()));
  const [dayDetail, setDayDetail] = useState<{ date: Date; events: CalendarEvent[] } | null>(null);
  const [selectedWorkout, setSelectedWorkout] = useState<HealthWorkout | null>(null);
  const [selectedSession, setSelectedSession] = useState<{
    entry: PlannedRunEntry; matchedRun: HealthWorkout | null;
    status: RunEntryStatus; date: Date;
  } | null>(null);

  // The Plans page supplies already-effective workouts. Keep one shared event array.
  const events = useMemo(
    () => buildCalendarEvents(plans, actualWorkouts, undefined, { includeActualOnly: true }),
    [plans, actualWorkouts]
  );
  const periodLabel = calView === "week"
    ? `${currentMonday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${addDays(currentMonday, 6).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  function handleEventClick(event: CalendarEvent) {
    if (event.kind === "actual-run") {
      router.push(`/runs/${event.activity.workoutId}`);
      return;
    }
    if (event.kind === "actual-workout") {
      setSelectedWorkout(event.activity);
      return;
    }
    if (event.kind === "planned-workout") {
      router.push(`/workout/${event.planId}/${event.weekIndex}/${event.weekday}/${event.sessionIndex}`);
      return;
    }
    const plan = plans.find((candidate) => candidate.id === event.planId);
    if (!plan || !isRunningPlan(plan)) return;
    const entry = plan.weeks.flatMap((week) => week.entries).find((candidate) => candidate.id === event.entryId);
    if (entry) setSelectedSession({
      entry, matchedRun: event.activity, status: event.status, date: event.date,
    });
  }

  return (
    <>
      <div className="flex flex-col flex-1 overflow-hidden p-4 gap-4">
        <div className="flex justify-between items-center shrink-0">
          <div className="flex gap-2">
            {(["week", "month"] as const).map((view) => (
              <button key={view} type="button" onClick={() => setCalView(view)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors capitalize ${
                  calView === view ? "bg-primary text-white" : "text-textSecondary hover:text-textPrimary"
                }`}>{view}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Previous calendar period" onClick={() => {
              if (calView === "week") setCurrentMonday((date) => addDays(date, -7));
              else setCurrentMonth((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1));
            }} className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-textPrimary min-w-[160px] text-center">{periodLabel}</span>
            <button type="button" aria-label="Next calendar period" onClick={() => {
              if (calView === "week") setCurrentMonday((date) => addDays(date, 7));
              else setCurrentMonth((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1));
            }} className="p-1.5 rounded-lg hover:bg-surface text-textSecondary hover:text-textPrimary">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        {calView === "week" ? (
          <WeekCalendar plans={plans} actualRuns={actualWorkouts} prebuiltEvents={events}
            weekStart={currentMonday} onEventClick={handleEventClick} />
        ) : (
          <MonthGrid events={events} month={currentMonth} onEventClick={handleEventClick}
            onMore={(date, dayEvents) => setDayDetail({ date, events: dayEvents })} />
        )}
      </div>
      {dayDetail && <CalendarDayDetailModal date={dayDetail.date} events={dayDetail.events}
        onClose={() => setDayDetail(null)} onEventClick={handleEventClick} />}
      {selectedSession && <RunActivityModal isOpen onClose={() => setSelectedSession(null)}
        plannedEntry={selectedSession.entry} matchedRun={selectedSession.matchedRun}
        status={selectedSession.status} sessionDate={selectedSession.date} />}
      {selectedWorkout && userId && <WorkoutDetailModal workout={selectedWorkout}
        override={overrides[selectedWorkout.workoutId] ?? null} userId={userId}
        maxHr={maxHr} restingHr={restingHr} onClose={() => setSelectedWorkout(null)}
        onExcludeChange={(workoutId, excluded) => {
          onWorkoutExcludeChange(workoutId, excluded);
          setSelectedWorkout(null);
        }} />}
    </>
  );
}
