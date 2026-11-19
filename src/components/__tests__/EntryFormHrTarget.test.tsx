import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunningPlanDetail } from "@/components/RunningPlanDetail";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/PlanCompletionSummary", () => ({
  PlanCompletionSummary: () => null,
}));

function planWith(entry: Partial<PlannedRunEntry>): RunningPlan {
  return {
    id: "run-plan",
    name: "Run Plan",
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
            distanceMiles: 6,
            runType: "outdoor",
            workoutType: "tempo",
            targetPaceSecondsPerMile: 550,
            paceTarget: "9:10",
            description: "Tempo",
            ...entry,
          },
        ],
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

let container: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(plan: RunningPlan, onUpdate = vi.fn(async (p: RunningPlan) => void p)) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <RunningPlanDetail
        plan={plan}
        activities={[]}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onSetActive={vi.fn()}
        onCopyPlan={vi.fn(async () => {})}
        onExport={vi.fn()}
      />
    );
  });
  await flush();
  return onUpdate;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

async function setInput(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openEntryEditor() {
  await click(buttonWithText("Edit"));
  const editEntry = container.querySelector<HTMLButtonElement>('button[title="Edit entry"]');
  expect(editEntry).toBeTruthy();
  await click(editEntry!);
}

function hrInputs() {
  const min = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((i) =>
    i.labels?.[0]?.textContent?.includes("HR min")
  );
  const max = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find((i) =>
    i.labels?.[0]?.textContent?.includes("HR max")
  );
  expect(min).toBeTruthy();
  expect(max).toBeTruthy();
  return { min: min!, max: max! };
}

async function saveAndFinish(onUpdate: ReturnType<typeof vi.fn>) {
  await click(buttonWithText("Apply Entry"));
  await click(buttonWithText("Done"));
  expect(onUpdate).toHaveBeenCalledTimes(1);
  return (onUpdate.mock.calls[0][0] as RunningPlan).weeks[0].entries[0];
}

beforeEach(() => {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => window.setTimeout(cb, 0);
  }
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("EntryForm HR min / HR max inputs", () => {
  it("renders two labelled number inputs", async () => {
    await mount(planWith({}));
    await openEntryEditor();
    const { min, max } = hrInputs();
    expect(min.type).toBe("number");
    expect(max.type).toBe("number");
    expect(min.value).toBe("");
    expect(max.value).toBe("");
  });

  it("prefills a cap from the legacy targetHeartRate", async () => {
    await mount(planWith({ targetHeartRate: 135 }));
    await openEntryEditor();
    const { min, max } = hrInputs();
    expect(min.value).toBe("");
    expect(max.value).toBe("135");
  });

  it("prefills a range from targetHr", async () => {
    await mount(planWith({ targetHr: { minBpm: 146, maxBpm: 155 } }));
    await openEntryEditor();
    const { min, max } = hrInputs();
    expect(min.value).toBe("146");
    expect(max.value).toBe("155");
  });

  it("saves a range with targetHr set and the legacy cap null", async () => {
    const onUpdate = await mount(planWith({ targetHeartRate: 135 }));
    await openEntryEditor();
    const { min, max } = hrInputs();
    await setInput(min, "146");
    await setInput(max, "155");
    const saved = await saveAndFinish(onUpdate);
    expect(saved.targetHr).toEqual({ minBpm: 146, maxBpm: 155 });
    expect(saved.targetHeartRate).toBeNull();
    // Fields the form does not show survive the edit.
    expect(saved.workoutType).toBe("tempo");
    expect(saved.targetPaceSecondsPerMile).toBe(550);
  });

  it("saves a max-only cap and dual-writes the legacy field", async () => {
    const onUpdate = await mount(planWith({}));
    await openEntryEditor();
    const { max } = hrInputs();
    await setInput(max, "135");
    const saved = await saveAndFinish(onUpdate);
    expect(saved.targetHr).toEqual({ minBpm: null, maxBpm: 135 });
    expect(saved.targetHeartRate).toBe(135);
  });

  it("saves null when both inputs are cleared", async () => {
    const onUpdate = await mount(planWith({ targetHr: { minBpm: null, maxBpm: 135 }, targetHeartRate: 135 }));
    await openEntryEditor();
    const { min, max } = hrInputs();
    await setInput(min, "");
    await setInput(max, "");
    const saved = await saveAndFinish(onUpdate);
    expect(saved.targetHr).toBeNull();
    expect(saved.targetHeartRate).toBeNull();
  });

  it("shows an inline error and blocks save when min exceeds max", async () => {
    const onUpdate = await mount(planWith({}));
    await openEntryEditor();
    const { min, max } = hrInputs();
    await setInput(min, "160");
    await setInput(max, "150");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("min can't exceed max");
    expect(buttonWithText("Apply Entry").disabled).toBe(true);
    await click(buttonWithText("Apply Entry"));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("shows an error for an out-of-range value and clears it when fixed", async () => {
    await mount(planWith({}));
    await openEntryEditor();
    const { max } = hrInputs();
    await setInput(max, "300");
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(max.getAttribute("aria-invalid")).toBe("true");
    await setInput(max, "150");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(buttonWithText("Apply Entry").disabled).toBe(false);
  });
});
