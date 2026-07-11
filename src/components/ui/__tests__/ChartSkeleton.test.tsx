import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";

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

describe("ChartSkeleton", () => {
  it("renders without crashing", () => {
    act(() => {
      root.render(<ChartSkeleton />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-busy")).toBe("true");
  });

  it("defaults to ~300px height when no height prop is given", () => {
    act(() => {
      root.render(<ChartSkeleton />);
    });
    const status = container.querySelector('[role="status"]') as HTMLElement;
    expect(status.style.height).toBe("300px");
  });

  it("accepts a height prop and applies it", () => {
    act(() => {
      root.render(<ChartSkeleton height={48} />);
    });
    const status = container.querySelector('[role="status"]') as HTMLElement;
    expect(status.style.height).toBe("48px");
  });

  it("renders a ghost bar silhouette", () => {
    act(() => {
      root.render(<ChartSkeleton height={220} />);
    });
    const bars = container.querySelectorAll('[role="status"] > div > div');
    expect(bars.length).toBeGreaterThan(0);
  });
});
