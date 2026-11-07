import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCurrentHalfRunImpact, type CurrentHalfRunImpact } from "@/utils/currentHalfRunImpact";
import type { CtlImpact, RunImpact } from "@/utils/runImpact";
import type { CurrentImpactCard } from "@/hooks/useCurrentHalfRunImpact";
import {
  ANCHOR_RUN_ID, exclusionOverride, fixtureWithCurrentRuns, improvingNine, minimumThree, subsecondSlower, thresholdSix,
} from "@/utils/__tests__/fixtures/currentImpactFixture";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";
import { RunImpactSection } from "../RunImpactSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const ready = (impact: CurrentHalfRunImpact, notice: string | null = null): CurrentImpactCard => ({ state: "ready", impact, notice });
const ctl: CtlImpact = { withCtl: 12, withoutCtl: 10, delta: 2 };
const legacy = { impact: { affectsProjection: true, withRunSeconds: 7800, withoutRunSeconds: 7830, deltaSeconds: -30 } as RunImpact, raceName: "Legacy Half", raceDateIso: "2027-03-20" };
function render(currentEstimate: CurrentImpactCard | null, extra: Partial<React.ComponentProps<typeof RunImpactSection>> = {}) {
  act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={currentEstimate} {...extra} />));
  return container.textContent ?? "";
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const impactFor = (input: ReturnType<typeof improvingNine>, runId: string) => computeCurrentHalfRunImpact({ ...input, runId });

describe("current-estimate impact tile — comparison states", () => {
  it("1. improvement: without → with, signed ▼ difference, and the model-influence disclosure", () => {
    const text = render(ready(impactFor(improvingNine(), "cur-3-1")));
    expect(text).toContain("This Run’s Impact"); expect(text).toContain("Current half-marathon estimate");
    expect(q("impact-without")).toBe("~2:11"); expect(q("impact-with")).toBe("~2:11");
    expect(q("impact-delta")).toBe("▼ 18 s"); expect(q("impact-state")).toBe("Faster by 18 s");
    expect(text).toContain("Shows how this run changes the current model estimate, not a measured fitness gain.");
    expect(text).not.toMatch(/fitness gained|you gained|improved your fitness/i);
    expect(container.querySelector('[data-testid="impact-delta"]')!.className).toContain("text-success");
  });

  it("2. worsening is shown, never suppressed, in the caution color", () => {
    render(ready(impactFor(thresholdSix(), "cur-2-0")));
    expect(q("impact-delta")).toBe("▲ 10 s"); expect(q("impact-state")).toBe("Slower by 10 s");
    expect(container.querySelector('[data-testid="impact-delta"]')!.className).toContain("text-warning");
  });

  it("3a. a positive sub-second difference is qualified, never a false exact zero", () => {
    render(ready(impactFor(subsecondSlower(), "current-3-1")));
    expect(q("impact-delta")).toBe("▲ 0.9 s"); expect(q("impact-state")).toBe("Slower by 0.9 s (negligible)");
  });

  it("3b. an exactly unchanged estimate says so", () => {
    render(ready(impactFor(currentFixture(), "base-0-0")));
    expect(q("impact-delta")).toBe("None"); expect(q("impact-state")).toBe("No change in the model estimate");
  });

  it("4. unsupported counterfactual keeps the current estimate and explains why", () => {
    const text = render(ready(impactFor(minimumThree(), "cur-5-0")));
    expect(q("impact-with")).toBe("~2:11"); expect(q("impact-state")).toBe("Comparison not supported");
    expect(text).toContain("At least three completed training runs");
  });

  it("9. a historical run with no model influence reports its age instead of an artificial effect", () => {
    const text = render(ready(impactFor(improvingNine(), "base-0-0")));
    expect(q("impact-state")).toBe("No change in the model estimate");
    expect(text).toMatch(/It is \d+ days old and may fall outside the training windows/);
  });
});

describe("current-estimate impact tile — unavailable and non-evidence states", () => {
  it("5. insufficient evidence", () => {
    const text = render(ready(impactFor(fixtureWithCurrentRuns([]), "base-0-0")));
    expect(q("impact-state")).toBe("Insufficient evidence"); expect(text).toContain("At least three completed training runs");
    expect(text).toContain("Only this estimate is unavailable");
  });
  it("6a. expired race anchor", () => {
    const text = render(ready(impactFor({ ...improvingNine(), asOf: "2027-03-20T16:00:00.000Z" }, "cur-3-1")));
    expect(q("impact-state")).toBe("Race anchor expired"); expect(text).toContain("180 days");
  });
  it("6b. missing race anchor", () => {
    render(ready(impactFor({ ...improvingNine(), overrides: exclusionOverride(ANCHOR_RUN_ID) }, "cur-3-1")));
    expect(q("impact-state")).toBe("No usable race anchor");
  });
  it("7. no race context", () => {
    render(ready(impactFor({ ...improvingNine(), races: [] }, "cur-3-1")));
    expect(q("impact-state")).toBe("No race result to anchor an estimate");
  });
  it("8a. an excluded run is explained, not compared", () => {
    const text = render(ready(impactFor({ ...improvingNine(), overrides: exclusionOverride("cur-3-1") }, "cur-3-1")));
    expect(q("impact-state")).toBe("Not a training input to the estimate"); expect(text).toContain("excluded in your overrides");
    expect(q("impact-delta")).toBeNull();
  });
  it("8b. the qualifying race's own run is held fixed", () => {
    const text = render(ready(impactFor(improvingNine(), ANCHOR_RUN_ID)));
    expect(text).toContain("recorded result for the race the estimate is anchored to"); expect(text).toContain("held fixed");
  });
  it("10a. loading", () => {
    render({ state: "loading" });
    expect(container.querySelector('[role="status"]')!.textContent).toContain("Calculating");
  });
  it("10b. recoverable error is local to the tile", () => {
    render({ state: "error", message: "workouts could not be loaded. Reload to retry." }, { ctl });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("could not be loaded");
    expect(container.textContent).toContain("Fitness (CTL)");
  });
  it("shows the stale-data notice when a refresh failed", () => {
    render(ready(impactFor(improvingNine(), "cur-3-1"), "Showing previously loaded workouts. A refresh failed, so this may be out of date."));
    expect(container.textContent).toContain("A refresh failed");
  });
});

describe("independence from CTL and from the legacy prediction", () => {
  it("renders CTL unchanged beside any estimate state", () => {
    for (const card of [ready(impactFor(improvingNine(), "cur-3-1")), { state: "loading" } as CurrentImpactCard,
      ready(impactFor({ ...improvingNine(), races: [] }, "cur-3-1"))]) {
      render(card, { ctl });
      expect(container.textContent).toContain("Fitness (CTL)");
      expect(container.textContent).toContain("10.0"); expect(container.textContent).toContain("12.0"); expect(container.textContent).toContain("▲ 2.0");
      expect(container.textContent).toContain("42-day load contribution from this run");
    }
  });
  it("shows CTL alone when no current-estimate card is supplied", () => {
    expect(render(null, { ctl })).toContain("Fitness (CTL)");
  });
  it("renders nothing when there is nothing to show", () => expect(render(null)).toBe(""));
  it("never renders the legacy Riegel prediction tile when the current estimate owns the slot", () => {
    const text = render({ state: "loading" }, { prediction: legacy, predictionUnavailableReason: "legacy reason" });
    expect(text).not.toContain("Legacy Half"); expect(text).not.toContain("legacy reason"); expect(text).not.toContain("Prediction recomputed");
  });
});
