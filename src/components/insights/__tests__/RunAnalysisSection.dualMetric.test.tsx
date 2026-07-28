import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunAnalysisWorkout } from "@/lib/runAnalysisTrend";

// Same ResponsiveContainer stand-in as the interaction suite: happy-dom measures
// the parent as 0×0, so without explicit dimensions the chart (and every axis,
// line and dot this file asserts on) renders nothing at all.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 600, height: 220 }),
  };
});

// The viewport hook is mocked rather than driven through window.matchMedia so a
// test can pin the breakpoint result directly; happy-dom's matchMedia has no way
// to simulate a resize.
const isDesktop = vi.fn(() => true);
vi.mock("@/hooks/useMediaQuery", () => ({
  useIsDesktop: () => isDesktop(),
  useMediaQuery: () => isDesktop(),
  DESKTOP_MEDIA_QUERY: "(min-width: 768px)",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { RunAnalysisSection } from "../RunAnalysisSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REST = 55;
const MAX = 190;

const PRIMARY_COLOR = "var(--color-chart-primary)";
const SECONDARY_COLOR = "var(--color-chart-secondary)";

beforeEach(() => {
  isDesktop.mockReturnValue(true);
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);

/** One run per week going back `count` weeks, each in the default [3,5] range. */
function weeklyRuns(count = 12, over: Partial<RunAnalysisWorkout> = {}): RunAnalysisWorkout[] {
  return Array.from({ length: count }, (_, i) => {
    const miles = 3 + (i % 5) * 0.25;
    return {
      workoutId: `w${i}`,
      date: daysAgo(i * 7 + 1).toISOString(),
      distanceMiles: miles,
      durationSeconds: Math.round(miles * 540),
      avgPaceSecPerMile: 540,
      avgHeartRate: 150,
      cadenceSPM: 170,
      activityType: "running",
      ...over,
    };
  });
}

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

function render(workouts: RunAnalysisWorkout[]) {
  act(() => {
    root.render(
      <RunAnalysisSection workouts={workouts} restingHr={REST} maxHr={MAX} />
    );
  });
}

function findButton(prefix: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").startsWith(prefix)
  ) as HTMLButtonElement | undefined;
}

function clickButton(prefix: string) {
  const btn = findButton(prefix);
  if (!btn) throw new Error(`button starting with "${prefix}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** aria-pressed state of a metric pill. */
function pressed(label: string): string | null {
  return findButton(label)?.getAttribute("aria-pressed") ?? null;
}

function yAxes(): Element[] {
  return Array.from(container.querySelectorAll(".recharts-yAxis"));
}

/**
 * Axis tick labels as {text, x}. Recharts v3 does NOT nest the tick <text>
 * inside its own .recharts-yAxis group (the nested tick <g>s render empty), so
 * ticks are read from the flat list and attributed to an axis by their VALUE
 * FORMAT and x position rather than by DOM ancestry.
 */
function tickLabels(): Array<{ text: string; x: number }> {
  return Array.from(
    container.querySelectorAll(".recharts-cartesian-axis-tick-value")
  ).map((t) => ({
    text: t.textContent ?? "",
    x: Number(t.getAttribute("x")),
  }));
}

/** Y-axis ticks only — numeric ("168") or M:SS ("8:30"); drops the x-axis's
 *  date labels ("May 11"). */
function yTicks(): Array<{ text: string; x: number }> {
  return tickLabels().filter((t) => /^[\d:]+$/.test(t.text));
}

/** Y ticks rendered in pace's M:SS format. */
function paceTicks(): Array<{ text: string; x: number }> {
  return yTicks().filter((t) => t.text.includes(":"));
}

/** Y ticks rendered as plain integers (cadence / HR / load / efficiency). */
function plainTicks(): Array<{ text: string; x: number }> {
  return yTicks().filter((t) => !t.text.includes(":"));
}

function lines(): Element[] {
  return Array.from(container.querySelectorAll(".recharts-line"));
}

function dots(): SVGCircleElement[] {
  return Array.from(container.querySelectorAll("circle"));
}

function clickDot(i: number) {
  const d = dots()[i];
  if (!d) throw new Error(`dot ${i} not found (have ${dots().length})`);
  act(() => {
    d.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function tableRows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("div.cursor-pointer")
  );
}

describe("RunAnalysisSection — metric multi-select toggle logic", () => {
  it("starts with exactly one metric (pace) selected", () => {
    render(weeklyRuns(12));
    expect(pressed("Pace")).toBe("true");
    expect(pressed("Cadence")).toBe("false");
    expect(pressed("Load")).toBe("false");
  });

  it("selecting a second metric adds it in click order", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(pressed("Pace")).toBe("true");
    expect(pressed("Cadence")).toBe("true");
  });

  it("selecting a THIRD metric while two are active is a no-op", () => {
    render(weeklyRuns(12));
    clickButton("Cadence"); // → [pace, cadence]
    clickButton("Load"); // capped — rejected
    expect(pressed("Load")).toBe("false");
    // The existing pair is untouched: no auto-swap of the oldest selection.
    expect(pressed("Pace")).toBe("true");
    expect(pressed("Cadence")).toBe("true");
  });

  it("deselecting down to one metric works", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    clickButton("Cadence"); // toggle back off
    expect(pressed("Cadence")).toBe("false");
    expect(pressed("Pace")).toBe("true");
  });

  it("deselecting the LAST remaining metric is a no-op", () => {
    render(weeklyRuns(12));
    clickButton("Pace"); // only selection — must be refused
    expect(pressed("Pace")).toBe("true");
    expect(container.textContent).toContain("Avg pace");
  });

  it("frees a slot after a deselect, so a new second metric can be added", () => {
    render(weeklyRuns(12));
    clickButton("Cadence"); // → [pace, cadence]
    clickButton("Cadence"); // → [pace]
    clickButton("Load"); // → [pace, load]
    expect(pressed("Load")).toBe("true");
    expect(pressed("Cadence")).toBe("false");
  });

  it("a rejected click does NOT clear an active bucket selection", () => {
    render(weeklyRuns(12));
    clickDot(0);
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);

    clickButton("Pace"); // refused (last remaining metric) → state untouched
    expect(tableRows()).toHaveLength(1);
    expect(findButton("Hide runs")).toBeDefined();
  });
});

describe("RunAnalysisSection — dual-metric data merge", () => {
  it("renders one dot per line per non-null bucket, aligned on the same buckets", () => {
    render(weeklyRuns(12));
    expect(dots()).toHaveLength(12); // single metric

    clickButton("Cadence");
    // Both metrics resolve in all 12 buckets → 12 primary + 12 secondary dots.
    expect(dots()).toHaveLength(24);
  });

  it("a bucket where only ONE metric resolves still renders that metric's dot", () => {
    const runs = weeklyRuns(12);
    runs[3].cadenceSPM = null; // pace still computable, cadence is not
    render(runs);
    clickButton("Cadence");
    // 12 pace dots + 11 cadence dots — the gap is per-line, not per-bucket.
    expect(dots()).toHaveLength(23);
  });

  it("shows one headline per selected metric, each in its own units", () => {
    render(weeklyRuns(12));
    clickButton("Heart rate");
    expect(container.textContent).toContain("Avg pace");
    expect(container.textContent).toContain("Avg HR");
    expect(container.textContent).toContain("bpm");
  });

  it("reports a single shared run count per bucket, not one per metric", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    clickDot(0);
    clickButton("Show runs");
    // runCount is metric-agnostic: one run in this bucket regardless of the two
    // metrics overlaid, so the drill-down shows exactly one row (not two).
    expect(tableRows()).toHaveLength(1);
  });
});

describe("RunAnalysisSection — dual axis rendering", () => {
  it("renders a single y-axis and a single line with one metric selected", () => {
    render(weeklyRuns(12));
    expect(yAxes()).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });

  it("renders a second y-axis and a second line with two metrics selected", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(yAxes()).toHaveLength(2);
    expect(lines()).toHaveLength(2);
  });

  it("orients the secondary axis on the right, leaving the primary on the left", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    // Pace (primary) ticks sit left of every cadence (secondary) tick.
    const maxPaceX = Math.max(...paceTicks().map((t) => t.x));
    const minCadenceX = Math.min(...plainTicks().map((t) => t.x));
    expect(paceTicks().length).toBeGreaterThan(0);
    expect(plainTicks().length).toBeGreaterThan(0);
    expect(maxPaceX).toBeLessThan(minCadenceX);
  });

  it("colors the two lines with the primary and secondary chart tokens", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    const strokes = lines().map((l) =>
      l.querySelector(".recharts-line-curve")?.getAttribute("stroke")
    );
    expect(strokes).toEqual([PRIMARY_COLOR, SECONDARY_COLOR]);
  });

  it("drops back to one axis and one line when the second metric is removed", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(yAxes()).toHaveLength(2);

    clickButton("Cadence");
    expect(yAxes()).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });

  it("formats each axis by its OWN metric, not by a shared setting", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    // Pace keeps its M:SS tickFormatter; cadence renders plain integers on the
    // same chart — proof the two axes are configured independently.
    expect(paceTicks().length).toBeGreaterThan(0);
    expect(plainTicks().length).toBeGreaterThan(0);
  });

  it("applies pace formatting to the RIGHT axis when pace is the second metric", () => {
    render(weeklyRuns(12));
    clickButton("Cadence"); // → [pace, cadence]
    clickButton("Pace"); // → [cadence]
    clickButton("Pace"); // → [cadence, pace] — pace now secondary
    // The axis config follows the METRIC, not the slot: pace still formats M:SS,
    // now on the right-hand side (higher x than the cadence ticks).
    const minPaceX = Math.min(...paceTicks().map((t) => t.x));
    const maxCadenceX = Math.max(...plainTicks().map((t) => t.x));
    expect(paceTicks().length).toBeGreaterThan(0);
    expect(minPaceX).toBeGreaterThan(maxCadenceX);
  });
});

describe("RunAnalysisSection — responsive secondary axis", () => {
  it("renders secondary axis tick labels at desktop width", () => {
    isDesktop.mockReturnValue(true);
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(plainTicks().length).toBeGreaterThan(0); // cadence labels present
  });

  it("hides secondary axis tick labels below the breakpoint", () => {
    isDesktop.mockReturnValue(false);
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(plainTicks()).toHaveLength(0);
  });

  it("keeps the PRIMARY axis ticks below the breakpoint", () => {
    isDesktop.mockReturnValue(false);
    render(weeklyRuns(12));
    clickButton("Cadence");
    // Only the second axis's labels are sacrificed for width.
    expect(paceTicks().length).toBeGreaterThan(0);
  });

  it("still plots the secondary LINE and its dots below the breakpoint", () => {
    isDesktop.mockReturnValue(false);
    render(weeklyRuns(12));
    clickButton("Cadence");
    // Collapsing the axis to width 0 stops Recharts painting the axis group,
    // but the scale still resolves — the series itself must be unaffected.
    expect(lines()).toHaveLength(2);
    expect(dots()).toHaveLength(24);
    const strokes = lines().map((l) =>
      l.querySelector(".recharts-line-curve")?.getAttribute("stroke")
    );
    expect(strokes).toEqual([PRIMARY_COLOR, SECONDARY_COLOR]);
  });

  it("still renders a single axis with one metric, at either width", () => {
    isDesktop.mockReturnValue(false);
    render(weeklyRuns(12));
    // Single-metric is unaffected by the breakpoint — no secondary axis exists
    // to hide, and the primary keeps its labels.
    expect(yAxes()).toHaveLength(1);
    expect(paceTicks().length).toBeGreaterThan(0);
  });
});

describe("RunAnalysisSection — dot click across two lines", () => {
  it("selects the bucket when a SECONDARY line dot is clicked", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    // Secondary dots follow the 12 primary ones in document order.
    clickDot(12);
    expect(findButton("Show runs")).toBeDefined();
    clickButton("Show runs");
    expect(tableRows()).toHaveLength(1);
  });

  it("resolves the SAME bucket from either line's dot at that x position", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");

    clickDot(3); // primary line, 4th bucket
    clickButton("Show runs");
    const fromPrimary = tableRows()[0].textContent ?? "";

    clickDot(12 + 3); // secondary line, same bucket
    const fromSecondary = tableRows()[0].textContent ?? "";
    expect(fromSecondary).toBe(fromPrimary);
  });

  it("rings the selected bucket's dot on BOTH lines", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    clickDot(2);
    const radii = dots().map((d) => d.getAttribute("r"));
    expect(radii[2]).toBe("7"); // primary
    expect(radii[12 + 2]).toBe("7"); // secondary, same bucket
    expect(radii.filter((r) => r === "7")).toHaveLength(2);
  });
});

describe("RunAnalysisSection — pill color coding", () => {
  it("paints the active single metric's pill with the primary line color", () => {
    render(weeklyRuns(12));
    expect(findButton("Pace")?.getAttribute("style")).toContain(PRIMARY_COLOR);
  });

  it("paints the second-selected pill with the secondary line color", () => {
    render(weeklyRuns(12));
    clickButton("Cadence");
    expect(findButton("Pace")?.getAttribute("style")).toContain(PRIMARY_COLOR);
    expect(findButton("Cadence")?.getAttribute("style")).toContain(
      SECONDARY_COLOR
    );
  });

  it("leaves inactive pills unstyled", () => {
    render(weeklyRuns(12));
    const load = findButton("Load");
    expect(load?.getAttribute("style")).toBeFalsy();
    expect(load?.className).toContain("bg-surface");
  });

  it("re-assigns colors by slot when the primary metric is removed", () => {
    render(weeklyRuns(12));
    clickButton("Cadence"); // pace=primary, cadence=secondary
    clickButton("Pace"); // → [cadence] — cadence is promoted to primary
    expect(findButton("Cadence")?.getAttribute("style")).toContain(
      PRIMARY_COLOR
    );
  });
});
