import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type PlannedRunEntry } from "@/types/plan";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Phase 4 regression: a partial-quality match used to show the label
 * "Incomplete", which directly contradicted the entry being counted as
 * completed everywhere else (isPlanEntryCompleted treats "partial" as
 * completed). The badge now reads "Partial" instead.
 */

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

vi.mock("@/lib/firebase", () => ({ db: {} }));

vi.mock("@/utils/routeCache", () => ({
  getRoutePoints: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/utils/mileSplitsCache", () => ({
  getMileSplits: vi.fn().mockResolvedValue([]),
}));

import { RunActivityModal } from "@/components/runs/RunActivityModal";

function plannedEntry(): PlannedRunEntry {
  return {
    id: "e1",
    weekIndex: 0,
    weekday: 1,
    dayOfWeek: 0,
    distanceMiles: 5,
    runType: "outdoor",
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("RunActivityModal — status badge label", () => {
  it("shows 'Partial' (not the old contradictory 'Incomplete') for a partial-quality match", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <RunActivityModal
          isOpen={true}
          onClose={() => {}}
          plannedEntry={plannedEntry()}
          matchedRun={null}
          status="partial"
          sessionDate={new Date("2026-01-19T12:00:00Z")}
        />
      );
    });
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).not.toContain("Incomplete");
  });

  it("leaves the 'met' and 'missed' labels unchanged ('Completed' / 'Missed')", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <RunActivityModal
          isOpen={true}
          onClose={() => {}}
          plannedEntry={plannedEntry()}
          matchedRun={null}
          status="met"
          sessionDate={new Date("2026-01-19T12:00:00Z")}
        />
      );
    });
    expect(container.textContent).toContain("Completed");

    await act(async () => {
      root.render(
        <RunActivityModal
          isOpen={true}
          onClose={() => {}}
          plannedEntry={plannedEntry()}
          matchedRun={null}
          status="missed"
          sessionDate={new Date("2026-01-19T12:00:00Z")}
        />
      );
    });
    expect(container.textContent).toContain("Missed");
  });
});
