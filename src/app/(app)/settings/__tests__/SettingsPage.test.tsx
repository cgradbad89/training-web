import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  saveUserSettings: vi.fn(),
  recomputeAllTrainingLoad: vi.fn(),
  refreshSettings: vi.fn(),
  refreshWorkouts: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { uid: "u1", email: "owner@example.com", displayName: "Owner" },
  }),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    userSettings: { maxHeartRate: 185, restingHeartRate: 60 },
    workouts: [],
    races: [],
    settingsLoading: false,
    workoutsLoading: false,
    racesLoading: false,
    refreshSettings: h.refreshSettings,
    refreshWorkouts: h.refreshWorkouts,
  }),
}));

vi.mock("@/services/userSettings", () => ({
  saveUserSettings: h.saveUserSettings,
  saveUserSettingsSuggestions: vi.fn(),
  gatherRecentRunHr: vi.fn(),
}));

vi.mock("@/services/healthWorkouts", () => ({
  recomputeAllTrainingLoad: h.recomputeAllTrainingLoad,
}));

import SettingsPage from "../page";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  h.saveUserSettings.mockReset().mockResolvedValue(undefined);
  h.recomputeAllTrainingLoad.mockReset();
  h.refreshSettings.mockReset().mockResolvedValue(undefined);
  h.refreshWorkouts.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<SettingsPage />);
  });
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SettingsPage recompute concurrency", () => {
  it("does not start overlapping recomputations on repeated Save actions", async () => {
    let finish!: (value: {
      processed: number;
      streamed: number;
      fallback: number;
      skipped: number;
    }) => void;
    h.recomputeAllTrainingLoad.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );

    const input = container.querySelector<HTMLInputElement>("#max-heart-rate")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    act(() => {
      setter.call(input, "190");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save Settings")
    )!;

    act(() => {
      save.click();
      save.click();
    });
    await flush();

    expect(h.saveUserSettings).toHaveBeenCalledTimes(1);
    expect(h.recomputeAllTrainingLoad).toHaveBeenCalledTimes(1);

    finish({ processed: 2, streamed: 1, fallback: 1, skipped: 0 });
    await flush();
    expect(h.refreshSettings).toHaveBeenCalledTimes(1);
    expect(h.refreshWorkouts).toHaveBeenCalledTimes(1);
  });
});
