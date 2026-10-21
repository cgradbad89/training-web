import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthWorkout, type TrainingLoadFields } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  enrichTrainingLoads: vi.fn(),
  pathname: "/runs",
  epoch: 1,
}));

vi.mock("@/services/healthWorkouts", () => ({
  enrichTrainingLoads: h.enrichTrainingLoads,
}));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("@/utils/routeCache", () => ({ getRouteCacheEpoch: () => h.epoch }));

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
  uid = "u1",
  owningPathname = "/runs",
}: {
  workouts: HealthWorkout[];
  patch: (workoutId: string, fields: TrainingLoadFields) => void;
  uid?: string | null;
  owningPathname?: "/runs" | "/workouts";
}) {
  useEnrichTrainingLoads(uid, workouts, null, patch, owningPathname);
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
  h.pathname = "/runs";
  h.epoch = 1;
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

  it.each(["unmount", "pathname", "auth epoch", "uid"])("retires pending publication and service ownership at %s", async (retirement) => {
    const patch = vi.fn();
    let resolve!: (value: unknown[]) => void;
    h.enrichTrainingLoads.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render([workout()], patch);
    const options = h.enrichTrainingLoads.mock.calls[0][3] as { isCurrent?: () => boolean } | undefined;

    await act(async () => {
      if (retirement === "unmount") root.unmount();
      else if (retirement === "auth epoch") h.epoch++;
      else {
        if (retirement === "pathname") h.pathname = "/personal-insights";
        root.render(<Probe workouts={[workout()]} patch={patch} uid={retirement === "uid" ? null : "u1"} />);
      }
    });
    expect(options?.isCurrent?.()).toBe(false);
    await act(async () => {
      resolve([{ workoutId: "w1", trainingLoadV2: 97, trainingLoadMethod: "streamed", trainingLoadBasisComplete: true }]);
      await Promise.resolve();
    });
    expect(patch).not.toHaveBeenCalled();
    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(1);
    if (retirement === "unmount") root = createRoot(container);
  });

  it("reconsiders a new HR basis that arrived during the current pass", async () => {
    const patch = vi.fn();
    let resolve!: (value: unknown[]) => void;
    h.enrichTrainingLoads
      .mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue([]);
    await render([workout()], patch);
    await render([workout({ hasHRStream: true })], patch);
    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(2);
    expect(h.enrichTrainingLoads.mock.calls[1][1]).toEqual([expect.objectContaining({ hasHRStream: true })]);
  });

  it.each([["/runs", "/workouts"], ["/workouts", "/runs"]] as const)("retains %s ownership when navigating to %s", async (owningPathname, nextPathname) => {
    const patch = vi.fn();
    let resolve!: (value: unknown[]) => void;
    h.enrichTrainingLoads.mockReturnValue(new Promise((done) => { resolve = done; }));
    h.pathname = owningPathname;
    await act(async () => root.render(<Probe workouts={[workout()]} patch={patch} owningPathname={owningPathname} />));
    const oldIsCurrent = h.enrichTrainingLoads.mock.calls[0][3].isCurrent;
    h.pathname = nextPathname;
    await act(async () => root.render(<Probe workouts={[workout()]} patch={patch} owningPathname={owningPathname} />));
    expect(oldIsCurrent()).toBe(false);
    await act(async () => { resolve([]); await Promise.resolve(); });
    expect(h.enrichTrainingLoads).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
  });
});
