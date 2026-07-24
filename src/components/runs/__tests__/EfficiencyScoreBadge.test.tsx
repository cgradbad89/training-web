import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EfficiencyScoreBadge,
  getScoreBand,
} from "../EfficiencyScoreBadge";
import type { EfficiencyScoreResult } from "@/utils/efficiencyScore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── getScoreBand ──────────────────────────────────────────────────────────

describe("getScoreBand", () => {
  it("returns 'high' at and above 65", () => {
    expect(getScoreBand(65)).toBe("high");
    expect(getScoreBand(100)).toBe("high");
  });

  it("returns 'mid' between 35 (inclusive) and 65 (exclusive)", () => {
    expect(getScoreBand(35)).toBe("mid");
    expect(getScoreBand(64.9)).toBe("mid");
    expect(getScoreBand(50)).toBe("mid");
  });

  it("returns 'low' below 35", () => {
    expect(getScoreBand(34.9)).toBe("low");
    expect(getScoreBand(0)).toBe("low");
  });
});

// ─── Component rendering ───────────────────────────────────────────────────

function scored(over: Partial<EfficiencyScoreResult> = {}): EfficiencyScoreResult {
  return {
    score: 70,
    percentDeltaVsBaseline: 0.09,
    cadenceDeltaVsBaseline: null,
    hrrPct: 71,
    usedRegression: false,
    status: "scored",
    ...over,
  };
}

const building: EfficiencyScoreResult = {
  score: null,
  percentDeltaVsBaseline: null,
  cadenceDeltaVsBaseline: null,
  hrrPct: null,
  usedRegression: false,
  status: "building_baseline",
};

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

/** Trigger the JS-state hover tooltip (React onMouseEnter ← native mouseover). */
function hover(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

describe("EfficiencyScoreBadge", () => {
  it("renders the building-baseline state with muted styling", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={building} baselineRunCount={3} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    expect(pill.textContent).toContain("Building baseline");
    expect(pill.className).toContain("text-textSecondary");
    expect(pill.className).not.toContain("text-success");
  });

  it("shows a plain run-count building message (no 'similar-effort' wording)", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={building} baselineRunCount={3} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    hover(pill);
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("Not enough runs yet");
    expect(tooltip.textContent).toContain("3 of 5");
    expect(tooltip.textContent).not.toContain("similar-effort");
  });

  it("renders a high-band score in success color", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ score: 80 })} baselineRunCount={6} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    expect(pill.textContent).toContain("80");
    expect(pill.className).toContain("text-success");
  });

  it("renders a mid-band score in warning color", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ score: 50 })} baselineRunCount={6} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    expect(pill.className).toContain("text-warning");
  });

  it("renders a low-band score in danger color", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ score: 20 })} baselineRunCount={6} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    expect(pill.className).toContain("text-danger");
  });

  it("shows the run's HRR effort line in the tooltip", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ hrrPct: 74 })} baselineRunCount={6} />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    hover(pill);
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("74% HRR");
  });

  it("appends '(effort-adjusted)' only when usedRegression is true", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ usedRegression: true })} baselineRunCount={6} />
      );
    });
    let tooltip = container.querySelector('[role="tooltip"]');
    hover(container.querySelector('[aria-label="Efficiency score"]')!);
    tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip!.textContent).toContain("(effort-adjusted)");

    act(() => {
      root.render(
        <EfficiencyScoreBadge result={scored({ usedRegression: false })} baselineRunCount={6} />
      );
    });
    hover(container.querySelector('[aria-label="Efficiency score"]')!);
    tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip!.textContent).not.toContain("(effort-adjusted)");
  });

  it("shows the cadence line in the tooltip when a cadence delta is present", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge
          result={scored({ score: 70, cadenceDeltaVsBaseline: 0.03 })}
          baselineRunCount={6}
        />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    hover(pill);
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip).not.toBeNull();
    expect(tooltip.textContent).toContain("Cadence");
    expect(tooltip.textContent).toContain("+3%");
  });

  it("omits the cadence line in the tooltip when the cadence delta is null", () => {
    act(() => {
      root.render(
        <EfficiencyScoreBadge
          result={scored({ score: 70, cadenceDeltaVsBaseline: null })}
          baselineRunCount={6}
        />
      );
    });
    const pill = container.querySelector('[aria-label="Efficiency score"]')!;
    hover(pill);
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).not.toContain("Cadence");
  });
});
