import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Skeleton } from "@/components/ui/Skeleton";

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

describe("Skeleton", () => {
  it("renders without crashing", () => {
    act(() => {
      root.render(<Skeleton />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-busy")).toBe("true");
  });

  it("applies the pulse + surface classes", () => {
    act(() => {
      root.render(<Skeleton />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.className).toContain("animate-pulse");
    expect(status?.className).toContain("bg-surface");
  });

  it("accepts a className prop and applies it alongside the base classes", () => {
    act(() => {
      root.render(<Skeleton className="w-24 h-4 rounded" />);
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.className).toContain("w-24");
    expect(status?.className).toContain("h-4");
    expect(status?.className).toContain("rounded");
    expect(status?.className).toContain("animate-pulse");
  });
});
