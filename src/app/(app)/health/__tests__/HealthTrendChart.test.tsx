import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HealthTrendChart } from "@/app/(app)/health/HealthTrendChart";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Recharts' ResponsiveContainer relies on ResizeObserver, which happy-dom does
// not implement — stub it so the chart render path can be smoke-tested.
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

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
  vi.restoreAllMocks();
});

describe("HealthTrendChart", () => {
  it("renders the 'Not enough data' state with fewer than 2 valid points", () => {
    act(() => {
      root.render(
        <HealthTrendChart
          data={[{ date: "2026-01-01", value: 170 }]}
          label="Weight"
          color="var(--color-chart-primary)"
        />,
      );
    });
    expect(container.textContent).toContain("Not enough data");
  });

  it("renders a line chart given minimal valid props without throwing", () => {
    expect(() => {
      act(() => {
        root.render(
          <HealthTrendChart
            data={[
              { date: "2026-01-01", value: 170 },
              { date: "2026-01-02", value: 171 },
              { date: "2026-01-03", value: 169 },
            ]}
            label="Weight"
            color="var(--color-chart-primary)"
          />,
        );
      });
    }).not.toThrow();
    expect(container.querySelector(".recharts-responsive-container")).not.toBeNull();
  });

  it("renders a bar chart variant without throwing", () => {
    expect(() => {
      act(() => {
        root.render(
          <HealthTrendChart
            type="bar"
            data={[
              { date: "2026-01-01", value: 8000 },
              { date: "2026-01-02", value: 9000 },
            ]}
            label="Steps"
            color="var(--color-chart-success)"
          />,
        );
      });
    }).not.toThrow();
  });
});
