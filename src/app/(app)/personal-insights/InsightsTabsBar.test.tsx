import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InsightsTabsBar, type InsightsTab } from "./InsightsTabsBar";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

describe("InsightsTabsBar", () => {
  it("renders all 3 tabs with the correct labels in order", () => {
    act(() => {
      root.render(<InsightsTabsBar value="fitness" onChange={() => {}} />);
    });
    const labels = buttons().map((b) => b.textContent);
    expect(labels).toEqual(["Fitness & Load", "Race Readiness", "Workout Trends"]);
  });

  it("calls onChange with the correct value when a tab is clicked", () => {
    const onChange = vi.fn<(tab: InsightsTab) => void>();
    act(() => {
      root.render(<InsightsTabsBar value="fitness" onChange={onChange} />);
    });
    // Click "Race Readiness" (performance) and "Workout Trends" (workouts).
    act(() => {
      buttons()[1].click();
    });
    expect(onChange).toHaveBeenLastCalledWith("performance");
    act(() => {
      buttons()[2].click();
    });
    expect(onChange).toHaveBeenLastCalledWith("workouts");
  });

  it("marks the active tab via aria-pressed based on the value prop", () => {
    act(() => {
      root.render(<InsightsTabsBar value="workouts" onChange={() => {}} />);
    });
    const pressed = buttons().map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "false", "true"]);
  });
});
