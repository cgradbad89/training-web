import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  measureClientPerformance,
  useClientPerformanceMark,
} from "@/hooks/useClientPerformanceMark";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("client performance instrumentation", () => {
  it("marks a ready milestone only once and measures from its start", async () => {
    const mark = vi.spyOn(window.performance, "mark");
    const measure = vi.spyOn(window.performance, "measure");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    window.performance.mark("training:test:start");
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness({ ready }: { ready: boolean }) {
      useClientPerformanceMark("training:test:ready", ready, {
        measureFrom: "training:test:start",
        measureName: "training:test:duration",
      });
      return null;
    }

    await act(async () => root.render(<Harness ready={false} />));
    await act(async () => root.render(<Harness ready />));
    await act(async () => root.render(<Harness ready />));

    expect(mark).toHaveBeenCalledWith("training:test:ready", undefined);
    expect(measure).toHaveBeenCalledWith(
      "training:test:duration",
      "training:test:start",
      "training:test:ready"
    );
    expect(info).toHaveBeenCalledWith(
      "[client-performance]",
      expect.objectContaining({ event: "measure" })
    );
    act(() => root.unmount());
  });

  it("returns null instead of disrupting the UI when a start mark is absent", () => {
    expect(
      measureClientPerformance(
        "training:missing:duration",
        "training:missing:start",
        "training:missing:end"
      )
    ).toBeNull();
  });
});
