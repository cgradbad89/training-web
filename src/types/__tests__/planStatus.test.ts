import { describe, expect, it } from "vitest";
import {
  derivePlanStatus,
  isActiveFromStatus,
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
