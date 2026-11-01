import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  workouts: [] as HealthWorkout[],
  historyComplete: true,
  fetchRange: vi.fn(),
}));
vi.mock("@/hooks/useManualActivityActions", () => ({
  useManualActivityActions: () => ({ create: h.create, update: h.update, remove: vi.fn() }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "owner" } }) }));
vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({ workouts: h.workouts, workoutsHistoryComplete: h.historyComplete }),
}));
vi.mock("@/services/healthWorkouts", () => ({ fetchHealthWorkoutsInRange: h.fetchRange }));

import { ManualActivityModal, type ManualActivityModalMode } from "../ManualActivityModal";

let root: Root;
let container: HTMLDivElement;
const onClose = vi.fn();
const onSaved = vi.fn();

function savedWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "manual_x", entrySource: "manual", name: "Run", activityType: "running", displayType: "Run",
    startDate: new Date(2026, 9, 10, 7, 30), endDate: new Date(2026, 9, 10, 8, 0), durationSeconds: 1800,
    sourceName: "Manual Entry", isRunLike: true, hasRoute: false, syncedAt: new Date(), calories: 0,
    avgHeartRate: null, distanceMiles: 3, distanceMeters: 4828, avgPaceSecPerMile: 600, avgSpeedMPS: 2.7,
    hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...overrides,
  };
}

async function render(mode: ManualActivityModalMode) {
  await act(async () => {
    root.render(<ManualActivityModal mode={mode} onClose={onClose} onSaved={onSaved} />);
  });
}

function setValue(selector: string, value: string) {
  const element = container.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

const byLabel = (label: string) => {
  const match = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label));
  return match ? `[id="${match.getAttribute("for")}"]` : "";
};

async function fillValidRun() {
  await act(async () => {
    setValue(byLabel("Date"), "2026-10-10");
    setValue(byLabel("Start time"), "07:30");
    setValue('[aria-label="minutes"]', "30");
    setValue(byLabel("Distance"), "3");
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

beforeEach(() => {
  h.create.mockReset().mockResolvedValue(savedWorkout());
  h.update.mockReset().mockResolvedValue({ workout: savedWorkout(), plans: [] });
  h.fetchRange.mockReset().mockResolvedValue([]);
  h.workouts = [];
  h.historyComplete = true;
  onClose.mockReset();
  onSaved.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ManualActivityModal", () => {
  it("opens as an accessible dialog with the requested default and focus on it", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(byLabel("Activity type"))).toBe(document.activeElement);
    expect((document.activeElement as HTMLSelectElement).value).toBe("outdoor_run");
    expect(container.textContent).toContain("Add Activity");
  });

  it("defaults to a workout where asked", async () => {
    await render({ type: "create", defaultKind: "other" });
    expect((container.querySelector(byLabel("Activity type")) as HTMLSelectElement).value).toBe("other");
  });

  it("uses a responsive drawer-to-dialog layout", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    const className = container.querySelector('[role="dialog"]')!.className;
    expect(className).toContain("w-full");
    expect(className).toContain("rounded-t-2xl");
    expect(className).toContain("lg:max-w-lg");
    expect(className).toContain("max-h-[calc(100dvh-1rem)]");
  });

  it("offers every requested activity type", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    const options = [...container.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual([
      "Outdoor Run", "Treadmill Run", "Walking", "Cycling", "Strength Training",
      "HIIT / Orangetheory", "Pilates", "Yoga", "Other Workout",
    ]);
  });

  it("shows inline, linked validation errors and saves nothing", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    await submit();
    const durationField = container.querySelector('[aria-label="minutes"]')!;
    const errorId = durationField.getAttribute("aria-describedby")!;
    expect(durationField.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector(`[id="${errorId}"]`)?.textContent).toMatch(/duration/i);
    expect(container.textContent).toMatch(/Enter a distance/);
    expect(h.create).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows distance only for kinds that use it and marks it optional when it is", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    expect(byLabel("Distance")).not.toBe("");
    await act(async () => { setValue(byLabel("Activity type"), "yoga"); });
    expect(byLabel("Distance")).toBe("");
    await act(async () => { setValue(byLabel("Activity type"), "cycling"); });
    expect(container.textContent).toContain("Distance (miles) (optional)");
  });

  it("calculates pace live and doesn't ask for it", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    expect(container.textContent).toContain("Pace: 10:00 /mi");
    expect(byLabel("Pace")).toBe("");
  });

  it("saves a valid form and reports the saved record", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    expect(h.create).toHaveBeenCalledOnce();
    const [input, id] = h.create.mock.calls[0];
    expect(input).toMatchObject({ kind: "outdoor_run", durationSeconds: 1800, distanceMiles: 3, localDate: "2026-10-10", localTime: "07:30" });
    expect(id).toMatch(/^manual_/);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("disables saving and ignores a double submit while a save is pending", async () => {
    let resolve!: (w: HealthWorkout) => void;
    h.create.mockReturnValue(new Promise((res) => { resolve = res; }));
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    expect(container.textContent).toContain("Saving…");
    const saveButton = buttonNamed("Saving…")!;
    expect(saveButton.disabled).toBe(true);
    expect(buttonNamed("Cancel")!.disabled).toBe(true);
    await submit();
    expect(h.create).toHaveBeenCalledOnce();
    await act(async () => { resolve(savedWorkout()); });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("keeps the form and shows the error on failure, and retries with the same ID", async () => {
    h.create.mockRejectedValueOnce(new Error("Couldn't save this activity. Nothing was saved."));
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    expect(onSaved).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Nothing was saved/);
    expect((container.querySelector(byLabel("Distance")) as HTMLInputElement).value).toBe("3");
    await submit();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[1][1]).toBe(h.create.mock.calls[0][1]);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("warns about a possible duplicate, explains why, and writes nothing yet", async () => {
    h.workouts = [savedWorkout({ workoutId: "HK-1", entrySource: undefined, sourceName: "Apple Watch", startDate: new Date(2026, 9, 10, 7, 35) })];
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    expect(h.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain("may already be recorded");
    expect(container.textContent).toContain("Apple Watch");
    expect(container.textContent).toContain("5 min apart");
    expect(buttonNamed("Save Anyway")).toBeTruthy();
    expect(buttonNamed("Cancel")).toBeTruthy();
  });

  it("Save Anyway writes the new record only", async () => {
    h.workouts = [savedWorkout({ workoutId: "HK-1", entrySource: undefined, startDate: new Date(2026, 9, 10, 7, 35) })];
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    await act(async () => { buttonNamed("Save Anyway")!.click(); });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.update).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("Cancel from the duplicate warning writes nothing", async () => {
    h.workouts = [savedWorkout({ workoutId: "HK-1", entrySource: undefined, startDate: new Date(2026, 9, 10, 7, 35) })];
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    await act(async () => { buttonNamed("Cancel")!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("changing a field dismisses a stale duplicate warning", async () => {
    h.workouts = [savedWorkout({ workoutId: "HK-1", entrySource: undefined, startDate: new Date(2026, 9, 10, 7, 35) })];
    await render({ type: "create", defaultKind: "outdoor_run" });
    await fillValidRun();
    await submit();
    await act(async () => { setValue(byLabel("Distance"), "9"); });
    expect(buttonNamed("Save Anyway")).toBeUndefined();
  });

  it("checks a targeted window, not all history, for a date older than loaded data", async () => {
    h.historyComplete = false;
    h.workouts = [savedWorkout({ workoutId: "HK-recent", startDate: new Date(2026, 9, 12), durationSeconds: 60 })];
    await render({ type: "create", defaultKind: "outdoor_run" });
    await act(async () => {
      setValue(byLabel("Date"), "2024-03-05");
      setValue(byLabel("Start time"), "07:30");
      setValue('[aria-label="minutes"]', "30");
      setValue(byLabel("Distance"), "3");
    });
    await submit();
    expect(h.fetchRange).toHaveBeenCalledOnce();
    const [, from, to] = h.fetchRange.mock.calls[0];
    expect((to as Date).getTime() - (from as Date).getTime()).toBeLessThanOrEqual(4 * 86400000);
  });

  it("still saves if the targeted duplicate read fails", async () => {
    h.historyComplete = false;
    h.fetchRange.mockRejectedValue(new Error("offline"));
    h.workouts = [savedWorkout({ workoutId: "HK-recent", startDate: new Date(2026, 9, 12) })];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await render({ type: "create", defaultKind: "outdoor_run" });
    await act(async () => {
      setValue(byLabel("Date"), "2024-03-05");
      setValue(byLabel("Start time"), "07:30");
      setValue('[aria-label="minutes"]', "30");
      setValue(byLabel("Distance"), "3");
    });
    await submit();
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("preloads an existing record for editing and updates it without a duplicate check", async () => {
    const workout = savedWorkout({ avgHeartRate: 150, calories: 300, customTitle: "Loop", notes: "Windy" });
    h.workouts = [workout];
    await render({ type: "edit", workout });
    expect(container.textContent).toContain("Edit Activity");
    expect((container.querySelector(byLabel("Date")) as HTMLInputElement).value).toBe("2026-10-10");
    expect((container.querySelector(byLabel("Start time")) as HTMLInputElement).value).toBe("07:30");
    expect((container.querySelector('[aria-label="minutes"]') as HTMLInputElement).value).toBe("30");
    expect((container.querySelector(byLabel("Average HR")) as HTMLInputElement).value).toBe("150");
    expect((container.querySelector(byLabel("Title")) as HTMLInputElement).value).toBe("Loop");
    expect((container.querySelector(byLabel("Notes")) as HTMLTextAreaElement).value).toBe("Windy");
    await act(async () => { setValue(byLabel("Distance"), "3.5"); });
    await submit();
    expect(h.update).toHaveBeenCalledWith("manual_x", expect.objectContaining({ distanceMiles: 3.5 }));
    expect(h.create).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("closes on Escape, but not while saving", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockReset();
    h.create.mockReturnValue(new Promise(() => {}));
    await fillValidRun();
    await submit();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("doesn't steal focus when a parent re-renders with a new close handler", async () => {
    await render({ type: "create", defaultKind: "outdoor_run" });
    const notes = container.querySelector(byLabel("Notes")) as HTMLTextAreaElement;
    await act(async () => { notes.focus(); });
    await act(async () => {
      root.render(<ManualActivityModal mode={{ type: "create", defaultKind: "outdoor_run" }} onClose={() => {}} onSaved={onSaved} />);
    });
    expect(document.activeElement).toBe(notes);
  });
});
