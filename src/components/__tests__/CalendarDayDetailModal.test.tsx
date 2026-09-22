import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarDayDetailModal } from "@/components/CalendarDayDetailModal";
import type { CalendarEvent } from "@/utils/planCalendar";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/runs/RunActivityModal", () => ({ RunActivityModal: () => null }));
const date = new Date(2026, 8, 21, 9);
const events: CalendarEvent[] = Array.from({ length: 4 }, (_, index) => ({
  kind: "actual-workout" as const, date, label: `Workout ${index + 1}`,
  activity: { workoutId: `w${index + 1}`, startDate: date, isRunLike: false } as HealthWorkout,
}));
let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let onEventClick: ReturnType<typeof vi.fn>;
function mount() {
  onClose = vi.fn(); onEventClick = vi.fn();
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CalendarDayDetailModal date={date} events={events}
    onClose={onClose} onEventClick={onEventClick} />));
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("CalendarDayDetailModal", () => {
  it("shows the local date and all events in supplied order", () => {
    mount();
    expect(container.textContent).toContain("Monday, September 21, 2026");
    expect(container.querySelectorAll("[role=dialog] button")).toHaveLength(5);
    expect(container.textContent?.indexOf("Workout 1")).toBeLessThan(container.textContent!.indexOf("Workout 4"));
  });
  it("closes before delegating an event click", () => {
    mount();
    act(() => (container.querySelectorAll("[role=dialog] button")[1] as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEventClick).toHaveBeenCalledWith(events[0]);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onEventClick.mock.invocationCallOrder[0]);
  });
  it("closes from the backdrop, close button, and Escape", () => {
    mount();
    act(() => {
      (container.firstChild as HTMLElement).click();
      (container.querySelector('[aria-label="Close day details"]') as HTMLButtonElement).click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
