import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "fs";
import path from "path";
import { RunStatusIcon } from "@/components/RunStatusIcon";
import { type RunEntryStatus } from "@/utils/planMatching";
import { type RunningPlan } from "@/types/plan";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Icon unification regression.
 *
 * Three separate implementations used to render the same four-state
 * `RunEntryStatus`: RunStatusIcon (the documented source of truth), the
 * dashboard's inline `StatusIcon` (a literal duplicate), and
 * RunningPlanDetail's own set — whose "partial" drew a bare `Check`, visually
 * indistinguishable from "met" at 16px. Both duplicates now route through
 * RunStatusIcon; these tests keep them from diverging again.
 */

const STATUSES: RunEntryStatus[] = ["met", "partial", "missed", "upcoming"];

/** Exact lucide class token per status — `lucide-circle` is a PREFIX of the
 *  others, so these must be matched as whole class tokens, never substrings. */
const EXPECTED_ICON: Record<RunEntryStatus, string> = {
  met: "lucide-circle-check",
  partial: "lucide-circle-minus",
  missed: "lucide-circle-x",
  upcoming: "lucide-circle",
};

const EXPECTED_COLOR: Record<RunEntryStatus, string> = {
  met: "text-success",
  partial: "text-warning",
  missed: "text-danger",
  upcoming: "text-textSecondary",
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
  vi.restoreAllMocks();
});

function svgClasses(el: Element): string[] {
  return Array.from(el.classList);
}

describe("RunStatusIcon — canonical four-state rendering", () => {
  for (const status of STATUSES) {
    it(`renders ${EXPECTED_ICON[status]} + ${EXPECTED_COLOR[status]} for "${status}"`, () => {
      act(() => root.render(<RunStatusIcon status={status} />));
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      const classes = svgClasses(svg!);
      expect(classes).toContain(EXPECTED_ICON[status]);
      expect(classes).toContain(EXPECTED_COLOR[status]);
    });
  }

  it('"partial" is a minus circle, NOT any kind of checkmark', () => {
    act(() => root.render(<RunStatusIcon status="partial" />));
    const classes = svgClasses(container.querySelector("svg")!);
    expect(classes).toContain("lucide-circle-minus");
    // Neither the bare `Check` nor the `CheckCircle`/`CheckCircle2` family.
    expect(classes.some((c) => c.includes("check"))).toBe(false);
  });

  it('"met" and "partial" render visibly different icons', () => {
    act(() => root.render(<RunStatusIcon status="met" />));
    const met = container.querySelector("svg")!.getAttribute("class");
    act(() => root.render(<RunStatusIcon status="partial" />));
    const partial = container.querySelector("svg")!.getAttribute("class");
    expect(met).not.toEqual(partial);
  });

  it("honours an explicit size (the call sites' 16px footprint)", () => {
    act(() => root.render(<RunStatusIcon status="met" size={16} />));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
  });
});

// ─── Call site 1: RunningPlanDetail (rendered) ────────────────────────────────

vi.mock("@/components/PlanCompletionSummary", () => ({
  PlanCompletionSummary: () => null,
}));

function mkPlan(): RunningPlan {
  // One week, four run entries — one per status. Statuses are driven by
  // statusForRunEntry, which we stub below so each row is deterministic.
  return {
    id: "p1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-06-01",
    status: "active",
    isActive: true,
    weeks: [
      {
        weekNumber: 1,
        entries: STATUSES.map((s, i) => ({
          id: `e-${s}`,
          weekIndex: 0,
          weekday: i + 1,
          dayOfWeek: i,
          runType: "outdoor",
          distanceMiles: 3 + i,
          description: `entry-${s}`,
        })),
      },
    ],
  } as unknown as RunningPlan;
}

describe("RunningPlanDetail routes its entry rows through RunStatusIcon", () => {
  it("renders the shared icon for all four statuses (and no bare checkmark for partial)", async () => {
    // Stub the matcher so each entry lands on a known status, keyed by its id.
    vi.doMock("@/utils/planMatching", async (orig) => {
      const actual = await (orig() as Promise<Record<string, unknown>>);
      return {
        ...actual,
        matchPlanToActual: () => new Map(),
        statusForRunEntry: (_p: unknown, e: { id: string }) =>
          e.id.replace("e-", "") as RunEntryStatus,
      };
    });
    vi.resetModules();
    const { RunningPlanDetail } = await import("@/components/RunningPlanDetail");

    await act(async () => {
      root.render(
        <RunningPlanDetail
          plan={mkPlan()}
          activities={[]}
          onUpdate={() => {}}
          onDelete={() => {}}
          onSetActive={() => {}}
          onComplete={() => {}}
          onReopen={() => {}}
          onCopyPlan={() => {}}
          onExport={() => {}}
        />
      );
    });

    const html = container.innerHTML;
    // Every status's canonical icon is present …
    for (const status of STATUSES) {
      expect(html).toContain(EXPECTED_ICON[status]);
    }
    // … and the "partial" row specifically carries the minus circle.
    const partialIcon = container.querySelector("svg.lucide-circle-minus");
    expect(partialIcon).not.toBeNull();
    expect(svgClasses(partialIcon!)).toContain("text-warning");

    // The pre-fix "partial" icon was a bare `Check` (class `lucide-check`,
    // no enclosing circle). It must not appear on any entry row.
    const bareChecks = Array.from(container.querySelectorAll("svg")).filter((s) =>
      s.classList.contains("lucide-check")
    );
    expect(bareChecks).toHaveLength(0);

    vi.doUnmock("@/utils/planMatching");
  });
});

// ─── Call site 2: dashboard PlanProgressCard (structural) ─────────────────────

/**
 * The dashboard's plan card lives inside the auth-guarded page component, which
 * can't be mounted here without stubbing Firestore, auth, and the ring stack.
 * These assertions instead pin the source: the inline duplicate is gone and the
 * row renders the shared component. See the session report — this call site is
 * verified structurally, not by render.
 */
describe("dashboard PlanProgressCard routes through RunStatusIcon", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../app/(app)/dashboard/page.tsx"),
    "utf8"
  );

  it("imports the shared RunStatusIcon", () => {
    expect(src).toContain('import { RunStatusIcon } from "@/components/RunStatusIcon"');
  });

  it("renders <RunStatusIcon> in the planned-run row", () => {
    expect(src).toContain("<RunStatusIcon status={status} />");
  });

  it("no longer defines its own StatusIcon component", () => {
    expect(src).not.toMatch(/function\s+StatusIcon\s*\(/);
    expect(src).not.toContain("<StatusIcon ");
  });

  it("no longer maps the four run statuses to icons inline", () => {
    // The duplicate's giveaway pair — a warning-tinted MinusCircle and a
    // danger-tinted XCircle sitting in this file rather than in RunStatusIcon.
    expect(src).not.toMatch(/<MinusCircle[^>]*text-warning/);
    expect(src).not.toMatch(/<XCircle[^>]*text-danger/);
  });
});
