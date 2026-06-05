import { describe, expect, it } from "vitest";
import {
  derivePlanStatus,
  isActiveFromStatus,
  groupPlansByStatus,
  type PlanStatus,
} from "@/types/plan";

describe("derivePlanStatus", () => {
  it("returns an explicit status when present (active)", () => {
    expect(derivePlanStatus({ status: "active", isActive: false })).toBe("active");
  });

  it("returns an explicit status when present (completed)", () => {
    // Explicit status wins even when the isActive mirror disagrees.
    expect(derivePlanStatus({ status: "completed", isActive: true })).toBe(
      "completed"
    );
  });

  it("returns an explicit status when present (draft)", () => {
    expect(derivePlanStatus({ status: "draft", isActive: true })).toBe("draft");
  });

  it("falls back to isActive:true → active for legacy docs", () => {
    expect(derivePlanStatus({ isActive: true })).toBe("active");
  });

  it("falls back to isActive:false → draft for legacy docs", () => {
    expect(derivePlanStatus({ isActive: false })).toBe("draft");
  });

  it("treats absent status AND absent isActive as draft", () => {
    expect(derivePlanStatus({})).toBe("draft");
  });

  it("never returns completed from a legacy isActive flag", () => {
    // No combination of the legacy mirror alone can produce "completed".
    expect(derivePlanStatus({ isActive: true })).not.toBe("completed");
    expect(derivePlanStatus({ isActive: false })).not.toBe("completed");
  });

  it("ignores an unrecognized status string and falls back to the mirror", () => {
    expect(derivePlanStatus({ status: "bogus", isActive: true })).toBe("active");
    expect(derivePlanStatus({ status: "bogus", isActive: false })).toBe("draft");
  });
});

describe("isActiveFromStatus", () => {
  it("maps active → true", () => {
    expect(isActiveFromStatus("active")).toBe(true);
  });

  it("maps completed → false", () => {
    expect(isActiveFromStatus("completed")).toBe(false);
  });

  it("maps draft → false", () => {
    expect(isActiveFromStatus("draft")).toBe(false);
  });

  it("round-trips with derivePlanStatus for the active case", () => {
    const status: PlanStatus = derivePlanStatus({ isActive: true });
    expect(isActiveFromStatus(status)).toBe(true);
  });
});

describe("groupPlansByStatus", () => {
  const p = (id: string, status: PlanStatus) => ({ id, status });

  it("partitions into the three buckets", () => {
    const groups = groupPlansByStatus([
      p("a", "active"),
      p("d", "draft"),
      p("c", "completed"),
    ]);
    expect(groups.active.map((x) => x.id)).toEqual(["a"]);
    expect(groups.draft.map((x) => x.id)).toEqual(["d"]);
    expect(groups.completed.map((x) => x.id)).toEqual(["c"]);
  });

  it("returns empty buckets for an empty input", () => {
    expect(groupPlansByStatus([])).toEqual({
      active: [],
      draft: [],
      completed: [],
    });
  });

  it("preserves input order within each bucket", () => {
    const groups = groupPlansByStatus([
      p("d1", "draft"),
      p("d2", "draft"),
      p("c1", "completed"),
      p("d3", "draft"),
    ]);
    expect(groups.draft.map((x) => x.id)).toEqual(["d1", "d2", "d3"]);
    expect(groups.completed.map((x) => x.id)).toEqual(["c1"]);
    expect(groups.active).toEqual([]);
  });

  it("handles a mix where some buckets are empty", () => {
    const groups = groupPlansByStatus([p("c1", "completed"), p("c2", "completed")]);
    expect(groups.active).toEqual([]);
    expect(groups.draft).toEqual([]);
    expect(groups.completed.map((x) => x.id)).toEqual(["c1", "c2"]);
  });
});
