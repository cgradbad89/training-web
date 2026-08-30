import { describe, expect, it, vi } from "vitest";
import {
  recomputeIsRequired,
  saveSettingsWithRecompute,
  type SettingsRecomputeStatus,
} from "@/utils/settingsRecompute";
import { TrainingLoadRecomputeError } from "@/services/healthWorkouts";

const stats = { processed: 3, streamed: 1, fallback: 2, skipped: 0 };

function harness(
  completedAnchors = { maxHeartRate: 185, restingHeartRate: 60 },
  status: SettingsRecomputeStatus = { state: "idle" }
) {
  return {
    uid: "u1",
    settings: {},
    anchors: { ...completedAnchors },
    completedAnchors,
    recomputeStatus: status,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    refreshSettings: vi.fn().mockResolvedValue(undefined),
    recompute: vi.fn().mockResolvedValue(stats),
    refreshWorkouts: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Settings HR-anchor recompute state machine", () => {
  it.each([
    ["max HR", { maxHeartRate: 190, restingHeartRate: 60 }],
    ["resting HR", { maxHeartRate: 185, restingHeartRate: 55 }],
    ["both anchors", { maxHeartRate: 190, restingHeartRate: 55 }],
  ])("recomputes once when %s changes", async (_label, anchors) => {
    const input = harness();
    input.anchors = anchors;

    const result = await saveSettingsWithRecompute(input);

    expect(input.recompute).toHaveBeenCalledTimes(1);
    expect(result.recomputeStatus).toEqual({ state: "idle" });
    expect(result.completedAnchors).toEqual(anchors);
  });

  it("does not recompute for an unrelated settings change", async () => {
    const input = harness();
    input.settings = { displayName: "Updated" };

    await saveSettingsWithRecompute(input);

    expect(input.recompute).not.toHaveBeenCalled();
    expect(input.refreshWorkouts).not.toHaveBeenCalled();
  });

  it.each([
    ["first workout", 0],
    ["after successful writes", 2],
  ])("keeps recomputation required after failure on %s", async (_label, processed) => {
    const input = harness();
    input.anchors = { maxHeartRate: 190, restingHeartRate: 60 };
    input.recompute.mockRejectedValue(
      new TrainingLoadRecomputeError("failed-id", {
        processed,
        streamed: 0,
        fallback: processed,
        skipped: 0,
      })
    );

    const result = await saveSettingsWithRecompute(input);

    expect(result.completedAnchors).toEqual(input.completedAnchors);
    expect(result.recomputeStatus).toEqual({
      state: "failed",
      anchors: input.anchors,
      processed,
      failedWorkoutId: "failed-id",
    });
    expect(input.refreshWorkouts).not.toHaveBeenCalled();
  });

  it("retries unchanged saved anchors and clears failed state after success", async () => {
    const anchors = { maxHeartRate: 190, restingHeartRate: 55 };
    const input = harness(
      { maxHeartRate: 185, restingHeartRate: 60 },
      { state: "failed", anchors, processed: 1 }
    );
    input.anchors = anchors;

    expect(recomputeIsRequired(input.completedAnchors, anchors, input.recomputeStatus)).toBe(true);
    const result = await saveSettingsWithRecompute(input);

    expect(input.recompute).toHaveBeenCalledWith("u1", input.settings);
    expect(result.recomputeStatus).toEqual({ state: "idle" });
    expect(result.completedAnchors).toEqual(anchors);
  });

  it("refreshes shared settings after every successful save", async () => {
    const input = harness();
    await saveSettingsWithRecompute(input);
    expect(input.refreshSettings).toHaveBeenCalledTimes(1);
  });

  it("refreshes shared workouts only after successful recomputation", async () => {
    const input = harness();
    input.anchors = { maxHeartRate: 190, restingHeartRate: 60 };
    await saveSettingsWithRecompute(input);
    expect(input.refreshWorkouts).toHaveBeenCalledTimes(1);
  });

  it("does not falsely refresh workouts after a failed recomputation", async () => {
    const input = harness();
    input.anchors = { maxHeartRate: 190, restingHeartRate: 60 };
    input.recompute.mockRejectedValue(new Error("failed"));
    await saveSettingsWithRecompute(input);
    expect(input.refreshWorkouts).not.toHaveBeenCalled();
  });
});
