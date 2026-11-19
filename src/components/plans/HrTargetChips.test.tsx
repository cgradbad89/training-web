import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HrTargetChips } from "@/components/plans/HrTargetChips";
import type { TargetHeartRate } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const CAP: TargetHeartRate = { minBpm: null, maxBpm: 135 };
const RANGE: TargetHeartRate = { minBpm: 146, maxBpm: 155 };

let container: HTMLDivElement;
let root: Root;

function render(props: React.ComponentProps<typeof HrTargetChips>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<HrTargetChips {...props} />);
  });
}

const targetChip = () => container.querySelector<HTMLElement>('[data-hr-chip="target"]');
const actualChip = () => container.querySelector<HTMLElement>('[data-hr-chip="actual"]');

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("HrTargetChips", () => {
  it("renders nothing without a target", () => {
    render({ target: null, avgHr: 140, matched: true });
    expect(container.innerHTML).toBe("");
  });

  it("shows only the target chip when unmatched", () => {
    render({ target: CAP, avgHr: 140, matched: false });
    expect(targetChip()?.textContent).toBe("Target ≤ 135");
    expect(actualChip()).toBeNull();
  });

  it("shows only the target chip when matched with no avg HR", () => {
    render({ target: RANGE, avgHr: null, matched: true });
    expect(targetChip()?.textContent).toBe("Target 146–155");
    expect(actualChip()).toBeNull();
  });

  it("on target: success text and the on-target label", () => {
    render({ target: CAP, avgHr: 133, matched: true });
    expect(actualChip()?.textContent).toBe("Avg 133 · on target");
    expect(actualChip()?.className).toContain("text-success");
    expect(actualChip()?.dataset.hrStatus).toBe("on-target");
  });

  it("on target within grace shows the +delta", () => {
    render({ target: CAP, avgHr: 137, matched: true });
    expect(actualChip()?.textContent).toBe("Avg 137 · on target (+2)");
    expect(actualChip()?.className).toContain("text-success");
  });

  it("over: warning text and the over label", () => {
    render({ target: CAP, avgHr: 138, matched: true });
    expect(actualChip()?.textContent).toBe("Avg 138 · over by 3");
    expect(actualChip()?.className).toContain("text-warning");
    expect(actualChip()?.className).not.toContain("text-success");
  });

  it("under-range: warning text and the under label", () => {
    render({ target: RANGE, avgHr: 143, matched: true });
    expect(actualChip()?.textContent).toBe("Avg 143 · under by 3");
    expect(actualChip()?.className).toContain("text-warning");
  });

  it("chips carry the surface/border styling and wrap-safe classes", () => {
    render({ target: CAP, avgHr: 138, matched: true });
    for (const chip of [targetChip(), actualChip()]) {
      expect(chip?.className).toContain("bg-surface");
      expect(chip?.className).toContain("border-border");
      expect(chip?.className).toContain("whitespace-nowrap");
    }
  });
});
