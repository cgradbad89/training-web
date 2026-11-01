import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("@/hooks/useManualActivityActions", () => ({
  useManualActivityActions: () => ({ create: vi.fn(), update: vi.fn(), remove: h.remove }),
}));
vi.mock("@/services/workoutOverrides", () => ({ excludeWorkout: vi.fn(), restoreWorkout: vi.fn() }));
vi.mock("@/services/hrStream", () => ({ fetchHRStream: vi.fn().mockResolvedValue([]) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/manualActivity/ManualActivityModal", () => ({
  ManualActivityModal: ({ mode }: { mode: { type: string } }) => <div data-testid="manual-editor">{mode.type}</div>,
}));

import { WorkoutDetailModal } from "@/components/WorkoutDetailModal";

function workout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "HK-1", name: "Workout", activityType: "yoga", displayType: "Workout",
    startDate: new Date(2026, 9, 10, 7, 30), endDate: new Date(2026, 9, 10, 8, 0), durationSeconds: 1800,
    sourceName: "Apple Watch", isRunLike: false, hasRoute: false, syncedAt: new Date(), calories: 0,
    avgHeartRate: null, distanceMiles: 0, distanceMeters: null, avgPaceSecPerMile: null, avgSpeedMPS: null,
    hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...overrides,
  };
}
const manual = () => workout({ workoutId: "manual_y", entrySource: "manual", sourceName: "Manual Entry", displayType: "Yoga", customTitle: "Sunrise flow", notes: "Felt loose" });

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();

async function render(w: HealthWorkout) {
  await act(async () => {
    root.render(
      <WorkoutDetailModal workout={w} override={null} userId="owner" maxHr={185} restingHr={60}
        onClose={onClose} onExcludeChange={vi.fn()} />
    );
  });
}
const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

beforeEach(() => {
  h.remove.mockReset().mockResolvedValue(undefined);
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("WorkoutDetailModal for manual activities", () => {
  it("offers no Edit, Delete or Manual label on an Apple Health workout", async () => {
    await render(workout());
    expect(buttonNamed("Edit")).toBeUndefined();
    expect(buttonNamed("Delete")).toBeUndefined();
    expect(container.textContent).not.toContain("Manual");
    expect(buttonNamed("Exclude Workout")).toBeTruthy();
  });

  it("shows the label, title, notes and actions on a manual workout", async () => {
    await render(manual());
    expect(container.textContent).toContain("Manual");
    expect(container.textContent).toContain("Sunrise flow");
    expect(container.textContent).toContain("Felt loose");
    expect(buttonNamed("Edit")).toBeTruthy();
    expect(buttonNamed("Delete")).toBeTruthy();
  });

  it("opens the shared form in edit mode", async () => {
    await render(manual());
    await act(async () => { buttonNamed("Edit")!.click(); });
    expect(container.querySelector('[data-testid="manual-editor"]')?.textContent).toBe("edit");
  });

  it("requires explicit confirmation before deleting", async () => {
    await render(manual());
    await act(async () => { buttonNamed("Delete")!.click(); });
    expect(h.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("can't be undone");
    await act(async () => { buttonNamed("Delete")!.click(); });
    expect(h.remove).toHaveBeenCalledWith("manual_y");
    expect(onClose).toHaveBeenCalled();
  });

  it("can back out of deleting", async () => {
    await render(manual());
    await act(async () => { buttonNamed("Delete")!.click(); });
    await act(async () => { buttonNamed("Cancel")!.click(); });
    expect(h.remove).not.toHaveBeenCalled();
    expect(buttonNamed("Edit")).toBeTruthy();
  });

  it("keeps the modal open and explains a blocked delete", async () => {
    h.remove.mockRejectedValue(new Error('This activity is linked to the race "City Half".'));
    await render(manual());
    await act(async () => { buttonNamed("Delete")!.click(); });
    await act(async () => { buttonNamed("Delete")!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("City Half");
    expect(onClose).not.toHaveBeenCalled();
  });
});
