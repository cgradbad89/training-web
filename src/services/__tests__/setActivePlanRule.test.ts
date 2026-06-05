import { describe, expect, it } from "vitest";
import { nextStatusForSibling, planCompletionPatch } from "@/services/plans";
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

describe("planCompletionPatch", () => {
  it("complete → completed/inactive with the passed ISO timestamp", () => {
    expect(planCompletionPatch("complete", "2026-06-05T12:00:00.000Z")).toEqual({
      status: "completed",
      isActive: false,
      completedAt: "2026-06-05T12:00:00.000Z",
    });
  });

  it("reopen → draft/inactive and clears completedAt (undefined)", () => {
    const patch = planCompletionPatch("reopen", "2026-06-05T12:00:00.000Z");
    expect(patch.status).toBe("draft");
    expect(patch.isActive).toBe(false);
    expect(patch.completedAt).toBeUndefined();
  });

  it("complete always clears the active mirror (isActive false)", () => {
    expect(planCompletionPatch("complete").isActive).toBe(false);
  });

  it("status and isActive never disagree", () => {
    for (const action of ["complete", "reopen"] as const) {
      const patch = planCompletionPatch(action);
      // neither completion state is "active", so the mirror is always false
      expect(patch.isActive).toBe(patch.status === "active");
      expect(patch.isActive).toBe(false);
    }
  });

  it("is self-only — merging the patch leaves sibling plans referentially unchanged", () => {
    const target = { id: "p1", status: "active" as PlanStatus, isActive: true };
    const siblingA = { id: "p2", status: "draft" as PlanStatus, isActive: false };
    const siblingB = {
      id: "p3",
      status: "completed" as PlanStatus,
      isActive: false,
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    const plans = [target, siblingA, siblingB];

    const merged = plans.map((p) =>
      p.id === "p1" ? { ...p, ...planCompletionPatch("complete", "2026-06-05T12:00:00.000Z") } : p
    );

    // Target transitioned…
    expect(merged[0]).toMatchObject({ status: "completed", isActive: false });
    // …and the patch touched no sibling (same object references preserved).
    expect(merged[1]).toBe(siblingA);
    expect(merged[2]).toBe(siblingB);
    expect(merged[2].completedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reopening a plan with no prior completedAt is a clean no-op clear", () => {
    const plan = { id: "p1", status: "completed" as PlanStatus, isActive: false };
    const merged = { ...plan, ...planCompletionPatch("reopen") };
    expect(merged.status).toBe("draft");
    expect("completedAt" in merged && merged.completedAt).toBeFalsy();
  });
});
