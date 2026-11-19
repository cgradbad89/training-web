import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HrTargetCard } from "@/components/runs/HrTargetCard";
import type { TargetHeartRate } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const CAP: TargetHeartRate = { minBpm: null, maxBpm: 135 };
const RANGE: TargetHeartRate = { minBpm: 146, maxBpm: 155 };

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<React.ComponentProps<typeof HrTargetCard>>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <HrTargetCard
        target={CAP}
        avgHr={133}
        isWholeRunWorkout={false}
        timeAbove={null}
        timeAboveLoading={false}
        {...props}
      />
    );
  });
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("HrTargetCard", () => {
  it("cap on target: title, target and average figures, success badge", () => {
    render({ avgHr: 133 });
    expect(container.textContent).toContain("Heart rate vs target");
    expect(container.textContent).toContain("≤ 135");
    expect(container.textContent).toContain("133");
    expect(q("hr-target-status")?.textContent).toBe("Avg 133 · on target");
    expect(q("hr-target-status")?.className).toContain("text-success");
  });

  it("cap over: warning badge with the over wording", () => {
    render({ avgHr: 141 });
    expect(q("hr-target-status")?.textContent).toBe("Avg 141 · over by 6");
    expect(q("hr-target-status")?.className).toContain("text-warning");
    expect(q("hr-target-status")?.className).not.toContain("text-success");
  });

  it("within grace shows +2 and stays on target", () => {
    render({ avgHr: 137 });
    expect(q("hr-target-status")?.textContent).toBe("Avg 137 · on target (+2)");
    expect(q("hr-target-status")?.className).toContain("text-success");
  });

  it("range with the whole-run label", () => {
    render({ target: RANGE, avgHr: 150, isWholeRunWorkout: true });
    expect(container.textContent).toContain("146–155");
    expect(container.textContent).toContain("Whole-run average (incl. warm-up/cool-down)");
    expect(q("hr-target-status")?.textContent).toBe("Avg 150 · on target");
  });

  it("does not show the whole-run label for non-workouts", () => {
    render({ isWholeRunWorkout: false });
    expect(container.textContent).not.toContain("Whole-run average");
  });

  it("range under shows the under wording", () => {
    render({ target: RANGE, avgHr: 143, isWholeRunWorkout: true });
    expect(q("hr-target-status")?.textContent).toBe("Avg 143 · under by 3");
    expect(q("hr-target-status")?.className).toContain("text-warning");
  });

  it("timeAbove null → no bar and no skeleton", () => {
    render({ timeAbove: null, timeAboveLoading: false });
    expect(q("hr-time-above")).toBeNull();
    expect(q("hr-time-above-skeleton")).toBeNull();
  });

  it("loading → skeleton and no bar", () => {
    render({ timeAbove: null, timeAboveLoading: true });
    expect(q("hr-time-above-skeleton")).toBeTruthy();
    expect(q("hr-time-above")).toBeNull();
  });

  it("shows the split bar and the literal-cap wording", () => {
    render({ avgHr: 140, timeAbove: { pct: 38.2, capBpm: 135 } });
    expect(q("hr-time-above")?.textContent).toBe("62% of time under 135 · 38% above");
    expect(q("hr-time-under-bar")?.style.width).toBe("62%");
    expect(q("hr-time-above-bar")?.style.width).toBe("38%");
    expect(q("hr-time-above-skeleton")).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "62% of time under 135, 38% above"
    );
  });

  it("shows 100% / 0% edges without NaN", () => {
    render({ timeAbove: { pct: 0, capBpm: 135 } });
    expect(q("hr-time-above")?.textContent).toBe("100% of time under 135 · 0% above");
  });

  it("with no average HR shows a plain message and a dash", () => {
    render({ avgHr: null });
    expect(q("hr-target-status")?.textContent).toBe("No average heart rate recorded");
    expect(container.textContent).toContain("—");
  });
});
