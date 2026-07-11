import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlanPaceChart } from "@/components/charts/PlanPaceChart";
import { FitnessCurveChart } from "@/app/(app)/personal-insights/FitnessCurveChart";
import { Vo2TrendChart } from "@/app/(app)/personal-insights/Vo2TrendChart";
import { PaceTrendChart } from "@/app/(app)/personal-insights/PaceTrendChart";
import { SleepByDowChart } from "@/app/(app)/health/SleepByDowChart";
import { HourlyHRChart } from "@/app/(app)/health/HourlyHRChart";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Recharts' ResponsiveContainer relies on ResizeObserver (absent in happy-dom).
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
});

/** Render `el` into the test root and assert it doesn't throw. */
function expectRenders(el: React.ReactElement) {
  expect(() => {
    act(() => {
      root.render(el);
    });
  }).not.toThrow();
}

describe("extracted chart components render with minimal valid props", () => {
  it("PlanPaceChart returns null when no week has a pace", () => {
    act(() => {
      root.render(
        <PlanPaceChart data={[{ label: "W1", pace: null }]} />,
      );
    });
    expect(container.textContent).toBe("");
  });

  it("PlanPaceChart renders given a pace point", () => {
    expectRenders(
      <PlanPaceChart
        data={[
          { label: "W1", pace: 540 },
          { label: "W2", pace: 530 },
        ]}
      />,
    );
    expect(container.textContent).toContain("Weekly Avg Pace");
  });

  it("FitnessCurveChart renders", () => {
    expectRenders(
      <FitnessCurveChart
        data={[
          { date: "2026-01-01", ctl: 40, atl: 45, tsb: -5 },
          { date: "2026-01-08", ctl: 42, atl: 44, tsb: -2 },
        ]}
      />,
    );
  });

  it("Vo2TrendChart renders", () => {
    expectRenders(
      <Vo2TrendChart
        data={[
          { date: "Jan 1", value: 44.1 },
          { date: "Jan 8", value: 44.6 },
        ]}
      />,
    );
  });

  it("PaceTrendChart renders", () => {
    expectRenders(
      <PaceTrendChart
        data={[
          { label: "W1", short: 480, medium: 540, long: 600 },
          { label: "W2", short: 470, medium: null, long: 590 },
        ]}
      />,
    );
  });

  it("SleepByDowChart renders with per-bar fills", () => {
    expectRenders(
      <SleepByDowChart
        data={[
          { day: "Mon", avg: 7.2, fill: "var(--color-success)" },
          { day: "Tue", avg: 6.8, fill: "var(--color-warning)" },
        ]}
        domain={[6, 8]}
      />,
    );
  });

  it("HourlyHRChart renders", () => {
    expectRenders(
      <HourlyHRChart
        data={[
          { label: "12 AM", bpm: 58 },
          { label: "1 AM", bpm: 56 },
        ]}
        domain={[50, 70]}
      />,
    );
  });
});
