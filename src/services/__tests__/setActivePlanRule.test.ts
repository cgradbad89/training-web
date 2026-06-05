import { describe, expect, it } from "vitest";
import { nextStatusForSibling } from "@/services/plans";
import { type PlanStatus } from "@/types/plan";

// Tests the pure per-plan decision behind setActivePlan's batch write. The
// Firestore batch itself isn't unit-testable, so the decision rule is extracted
// into nextStatusForSibling and verified here.

const plan = (id: string, status: PlanStatus) => ({ id, status });

describe("nextStatusForSibling", () => {
  it("activates the target plan (status active + isActive true)", () => {
    expect(nextStatusForSibling(plan("p1", "draft"), "p1")).toEqual({
      status: "active",
      isActive: true,
    });
  });

  it("demotes a same-type active sibling to draft", () => {
    expect(nextStatusForSibling(plan("p2", "active"), "p1")).toEqual({
      status: "draft",
      isActive: false,
    });
  });

  it("demotes a same-type draft sibling to draft (idempotent)", () => {
    expect(nextStatusForSibling(plan("p2", "draft"), "p1")).toEqual({
      status: "draft",
      isActive: false,
    });
  });

  it("leaves a completed sibling UNCHANGED (returns null — no write)", () => {
    expect(nextStatusForSibling(plan("p2", "completed"), "p1")).toBeNull();
  });

  it("activates a target even when it is currently completed", () => {
    // The target id always wins, regardless of its prior status.
    expect(nextStatusForSibling(plan("p1", "completed"), "p1")).toEqual({
      status: "active",
      isActive: true,
    });
  });

  it("never produces a record whose status and isActive disagree", () => {
    for (const status of ["active", "draft", "completed"] as PlanStatus[]) {
      const asTarget = nextStatusForSibling(plan("p1", status), "p1");
      expect(asTarget).toEqual({ status: "active", isActive: true });

      const asSibling = nextStatusForSibling(plan("p2", status), "p1");
      if (asSibling) {
        expect(asSibling.isActive).toBe(asSibling.status === "active");
      }
    }
  });
});
