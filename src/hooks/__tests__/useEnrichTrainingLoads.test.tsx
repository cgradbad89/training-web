import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthWorkout, type TrainingLoadFields } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  enrichTrainingLoads: vi.fn(),
}));

vi.mock("@/services/healthWorkouts", () => ({
  enrichTrainingLoads: h.enrichTrainingLoads,
}));

import { useEnrichTrainingLoads } from "@/hooks/useEnrichTrainingLoads";

function workout(partial: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "w1",
    durationSeconds: 1800,
    avgHeartRate: 145,
    activityType: "running",
    hasRoute: false,
    hasHRStream: false,
    ...partial,
  } as HealthWorkout;
}

function Probe({
  workouts,
  patch,
}: {
  workouts: HealthWorkout[];
  patch: (workoutId: string, fields: TrainingLoadFields) => void;
}) {
  useEnrichTrainingLoads("u1", workouts, null, patch);
  return null;
}

let container: HTMLDivElement;
let root: Root;

async function render(
  workouts: HealthWorkout[],
  patch: (workoutId: string, fields: TrainingLoadFields) => void
) {
  await act(async () => {
    root.render(<Probe workouts={workouts} patch={patch} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  h.enrichTrainingLoads.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useEnrichTrainingLoads local AppData publication", () => {
  it("patches a successful 95→97 store and does not repeat on its own output", async () => {
    const patch = vi.fn();
    h.enrichTrainingLoads.mockResolvedValue([
      {
        workoutId: "w1",
        trainingLoadV2: 97,
        trainingLoadMethod: "streamed",
        trainingLoadBasisComplete: true,
      },
    ]);

    await render([workout({ trainingLoadV2: 95, trainingLoadMethod: "avg-hr-fallback", hasRoute: true })], patch);

    expect(patch).toHaveBeenCalledWith("w1", {
      trainingLoadV2: 97,
      trainingLoadMethod: "streamed",
      trainingLoadBasisComplete: true,
    });
    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(1);

    await render(
      [
        workout({
          trainingLoadV2: 97,
          trainingLoadMethod: "streamed",
          trainingLoadBasisComplete: true,
          hasRoute: true,
        }),
      ],
      patch
    );

    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(1);
  });

  it("does not patch when enrichment rejects", async () => {
    const patch = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    h.enrichTrainingLoads.mockRejectedValue(new Error("write failed"));

    await render([workout()], patch);

    expect(patch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[useEnrichTrainingLoads] enrich failed",
      expect.any(Error)
    );
  });

  it("publishes an avg-HR→streamed basis upgrade", async () => {
    const patch = vi.fn();
    h.enrichTrainingLoads.mockResolvedValue([
      {
        workoutId: "w1",
        trainingLoadV2: 97,
        trainingLoadMethod: "streamed",
        trainingLoadBasisComplete: true,
      },
    ]);

    await render(
      [
        workout({
          trainingLoadV2: 95,
          trainingLoadMethod: "avg-hr-fallback",
          hasHRStream: true,
        }),
      ],
      patch
    );

    expect(patch).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({
        trainingLoadV2: 97,
        trainingLoadMethod: "streamed",
      })
    );
  });
});
