import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CrossTrainingPlanDetail } from "@/components/CrossTrainingPlanDetail";
import { RunningPlanDetail } from "@/components/RunningPlanDetail";
import { type RunningPlan, type WorkoutPlan } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/PlanCompletionSummary", () => ({
  PlanCompletionSummary: () => null,
}));

const runningPlan: RunningPlan = {
  id: "run-plan",
  name: "Original Run Plan",
  planType: "running",
  startDate: "2026-09-07",
  status: "draft",
  isActive: false,
  weeks: [
    {
      weekNumber: 1,
      entries: [
        {
          id: "run-1",
          weekIndex: 0,
          weekday: 1,
          dayOfWeek: 0,
          distanceMiles: 3,
          runType: "outdoor",
          description: "Easy run",
        },
      ],
    },
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const workoutPlan: WorkoutPlan = {
  id: "workout-plan",
  name: "Original Workout Plan",
  planType: "workout",
  startDate: "2026-09-07",
  status: "draft",
  isActive: false,
  weeks: [
    {
      weekNumber: 1,
      entries: [
        {
          id: "session-1",
          weekIndex: 0,
          weekday: 1,
          dayOfWeek: 0,
          type: "workout",
          category: "strength",
          label: "Upper Body",
          exercises: [],
        },
      ],
    },
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  await flush();
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

async function setInput(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setTextarea(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  }
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("plan draft edit sessions", () => {
  it("keeps a running plan editable across multiple changes and saves once on Done", async () => {
    const onUpdate = vi.fn(async (updated: RunningPlan) => {
      void updated;
    });
    await mount(
      <RunningPlanDetail
        plan={runningPlan}
        activities={[]}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        onExport={vi.fn()}
      />
    );

    await click(buttonWithText("Edit"));
    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Plan name"]'
    );
    expect(name).toBeTruthy();
    await setInput(name!, "Run Plan Revised");

    const editEntry = container.querySelector<HTMLButtonElement>(
      'button[title="Edit entry"]'
    );
    expect(editEntry).toBeTruthy();
    await click(editEntry!);
    const description = container.querySelector<HTMLInputElement>(
      'input[placeholder="e.g. Easy effort with strides"]'
    );
    expect(description).toBeTruthy();
    await setInput(description!, "Easy run with strides");
    await click(buttonWithText("Apply Entry"));

    expect(buttonWithText("Done")).toBeTruthy();
    expect(container.textContent).toContain("Unsaved changes");
    expect(onUpdate).not.toHaveBeenCalled();

    await click(buttonWithText("Done"));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const saved = onUpdate.mock.calls[0][0];
    expect(saved.name).toBe("Run Plan Revised");
    expect(saved.weeks[0].entries[0].description).toBe(
      "Easy run with strides"
    );
    expect(buttonWithText("Edit")).toBeTruthy();
  });

  it("keeps a workout plan editable across multiple changes and saves once on Done", async () => {
    const onUpdate = vi.fn(async (updated: WorkoutPlan) => {
      void updated;
    });
    await mount(
      <CrossTrainingPlanDetail
        plan={workoutPlan}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        saving={false}
        onExport={vi.fn()}
      />
    );

    await click(buttonWithText("Edit"));
    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Plan name"]'
    );
    expect(name).toBeTruthy();
    await setInput(name!, "Workout Plan Revised");

    const editEntry = container.querySelector<HTMLButtonElement>(
      'button[title="Edit"]'
    );
    expect(editEntry).toBeTruthy();
    await click(editEntry!);
    const label = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Label"]'
    );
    expect(label).toBeTruthy();
    await setTextarea(label!, "Upper Body Revised");
    await click(buttonWithText("Apply Session"));

    expect(buttonWithText("Done")).toBeTruthy();
    expect(container.textContent).toContain("Unsaved changes");
    expect(onUpdate).not.toHaveBeenCalled();

    await click(buttonWithText("Done"));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const saved = onUpdate.mock.calls[0][0];
    expect(saved.name).toBe("Workout Plan Revised");
    expect(saved.weeks[0].entries[0].label).toBe("Upper Body Revised");
    expect(buttonWithText("Edit")).toBeTruthy();
  });

  it("stages plan completion in the same running-plan draft", async () => {
    const onUpdate = vi.fn(async (updated: RunningPlan) => {
      void updated;
    });
    await mount(
      <RunningPlanDetail
        plan={runningPlan}
        activities={[]}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        onExport={vi.fn()}
      />
    );

    await click(buttonWithText("Edit"));
    await click(buttonWithText("Complete Plan"));
    await click(buttonWithText("Mark Completed"));

    expect(buttonWithText("Done")).toBeTruthy();
    expect(container.textContent).toContain("Unsaved changes");
    expect(onUpdate).not.toHaveBeenCalled();

    await click(buttonWithText("Done"));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ status: "completed", isActive: false })
    );
  });

  it("keeps the draft and edit controls available when Done cannot save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUpdate = vi.fn(async (updated: RunningPlan) => {
      void updated;
      throw new Error("write failed");
    });
    await mount(
      <RunningPlanDetail
        plan={runningPlan}
        activities={[]}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        onExport={vi.fn()}
      />
    );

    await click(buttonWithText("Edit"));
    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Plan name"]'
    );
    await setInput(name!, "Unsaved Run Plan");
    await click(buttonWithText("Done"));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(buttonWithText("Done")).toBeTruthy();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Plan name"]')
        ?.value
    ).toBe("Unsaved Run Plan");
    expect(container.textContent).toContain("Your draft is still here");
  });
});
