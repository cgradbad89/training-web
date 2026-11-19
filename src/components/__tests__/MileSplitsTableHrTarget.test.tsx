import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MileSplitsTable } from "@/components/MileSplitsTable";
import type { MileSplit } from "@/utils/mileSplits";
import type { TargetHeartRate } from "@/types/plan";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const CAP: TargetHeartRate = { minBpm: null, maxBpm: 135 };

function split(mile: number, avgBpm?: number): MileSplit {
  return { mile, segmentMiles: 1, paceSecPerMile: 600, isPartial: false, avgBpm };
}

// 130 under, 135 at cap, 137 within grace, 138 over, 150 over, none.
const SPLITS = [split(1, 130), split(2, 135), split(3, 137), split(4, 138), split(5, 150), split(6)];

let container: HTMLDivElement;
let root: Root;

function render(hrTarget?: TargetHeartRate | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <MileSplitsTable
        splits={SPLITS}
        routeLoading={false}
        hasRoute
        {...(hrTarget === undefined ? {} : { hrTarget })}
      />
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("MileSplitsTable hrTarget flag", () => {
  it("renders identically with no hrTarget, null, or a target nobody exceeds", () => {
    render();
    const baseline = container.innerHTML;
    act(() => root.unmount());
    container.remove();

    render(null);
    expect(container.innerHTML).toBe(baseline);
    act(() => root.unmount());
    container.remove();

    render({ minBpm: null, maxBpm: 200 });
    expect(container.innerHTML).toBe(baseline);
    expect(baseline).not.toContain("▲");
    expect(baseline).not.toContain("over target");
  });

  it("with no target the HR cells are the plain 'N bpm' text", () => {
    render();
    const cells = Array.from(container.querySelectorAll("tbody tr")).map(
      (tr) => tr.querySelectorAll("td")[3].textContent
    );
    expect(cells).toEqual(["130 bpm", "135 bpm", "137 bpm", "138 bpm", "150 bpm", "—"]);
  });

  it("with a cap target flags only miles over the cap beyond grace", () => {
    render(CAP);
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const flagged = rows.map((tr) => tr.querySelectorAll("td")[3].querySelector(".text-warning") != null);
    expect(flagged).toEqual([false, false, false, true, true, false]);
  });

  it("a flagged cell shows ▲, the bpm in warning text and an accessible label", () => {
    render(CAP);
    const cell = container.querySelectorAll("tbody tr")[3].querySelectorAll("td")[3];
    expect(cell.textContent).toContain("▲");
    expect(cell.textContent).toContain("138 bpm");
    expect(cell.textContent).toContain("(over target)");
    expect(cell.querySelector(".text-warning")?.getAttribute("title")).toBe("Over target");
    expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toContain("▲");
    expect(cell.querySelector(".sr-only")?.textContent).toContain("over target");
  });

  it("leaves the other columns untouched when flagging", () => {
    render();
    const before = Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).slice(0, 3).map((td) => td.textContent)
    );
    act(() => root.unmount());
    container.remove();
    render(CAP);
    const after = Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).slice(0, 3).map((td) => td.textContent)
    );
    expect(after).toEqual(before);
  });

  it("does not flag against a range target's max within grace, but does above it", () => {
    render({ minBpm: 146, maxBpm: 155 });
    expect(container.querySelectorAll(".text-warning").length).toBe(0);
  });

  it("never flags a floor-only target", () => {
    render({ minBpm: 140, maxBpm: null });
    expect(container.querySelectorAll(".text-warning").length).toBe(0);
  });
});
