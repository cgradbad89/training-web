"use client";

import React, { useEffect } from "react";
import { X } from "lucide-react";
import type { CalendarEvent } from "@/utils/planCalendar";
import { EventPill, calendarEventKey } from "@/components/WeekCalendar";

export interface CalendarDayDetailModalProps {
  date: Date;
  events: CalendarEvent[];
  onClose: () => void;
  onEventClick: (event: CalendarEvent) => void;
}

export function CalendarDayDetailModal({
  date, events, onClose, onEventClick,
}: CalendarDayDetailModalProps): React.ReactElement {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/40 lg:items-center lg:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="calendar-day-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl lg:max-h-[90vh] lg:max-w-md lg:rounded-2xl"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-5">
          <h2 id="calendar-day-title" className="text-base font-semibold text-textPrimary">
            {date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close day details"
            className="p-1.5 rounded-lg text-textSecondary hover:bg-surface"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] flex flex-col gap-2">
          {events.map((event) => (
            <EventPill key={calendarEventKey(event)} event={event} onClick={() => {
              onClose();
              onEventClick(event);
            }} />
          ))}
        </div>
      </div>
    </div>
  );
}
