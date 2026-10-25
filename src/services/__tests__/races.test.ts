import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";

vi.mock("@/lib/firebase", () => ({ db: {} }));

const h = vi.hoisted(() => ({
  setDoc: vi.fn(),
  records: new Map<string, Record<string, unknown>>(),
  updateDoc: vi.fn(), deleteDoc: vi.fn(),
  deleteSentinel: { kind: "delete-field" },
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: (...args: unknown[]) => ({ id: args.at(-1) }),
  getDocs: vi.fn(),
  setDoc: h.setDoc,
  deleteDoc: h.deleteDoc,
  updateDoc: h.updateDoc,
  deleteField: () => h.deleteSentinel,
  writeBatch: vi.fn(),
}));

import { associateRunWithRace, createRace, deleteRace, disassociateRunFromRace, normalizeRaceDocument, saveRace, updateRace } from "@/services/races";
import type { Race } from "@/types/race";

beforeEach(() => {
  h.records.clear();
  const apply = (reference: { id: string }, writes: Record<string, unknown>, merge = true) => {
    const next = merge ? { ...h.records.get(reference.id) } : {};
    for (const [key, value] of Object.entries(writes)) {
      if (value === h.deleteSentinel) delete next[key];
      else next[key] = value;
    }
    h.records.set(reference.id, next);
  };
  h.setDoc.mockReset().mockImplementation(async (reference, writes, options) => apply(reference, writes, options?.merge === true));
  h.updateDoc.mockReset().mockImplementation(async (reference, writes) => apply(reference, writes));
  h.deleteDoc.mockReset().mockImplementation(async reference => { h.records.delete(reference.id); });
});

describe("race persistence continuity", () => {
  it("stores an associated workout's local calendar date, not its UTC date", async () => {
    const run = {
      workoutId: "w1",
      startDate: new Date(2026, 7, 29, 23, 30),
      distanceMiles: 13.1,
      durationSeconds: 7200,
      avgPaceSecPerMile: 550,
    } as HealthWorkout;

    await associateRunWithRace("u1", "r1", run);

    expect(h.setDoc.mock.calls[0][1]).toMatchObject({
      actualRunId: "w1",
      actualRunDate: "2026-08-29",
    });
  });

  it("deletes explicitly cleared optional race links on merge updates", async () => {
    await updateRace("u1", "r1", { linkedPlanId: undefined });
    expect(h.setDoc.mock.calls[0][1]).toEqual({
      linkedPlanId: h.deleteSentinel,
    });
  });

  it.each(["confirmationHistory", "performanceEvidence", "confirmationHistory.currentRevisionId", "performanceEvidence.knownAt"])("prevents generic writes to %s", async key => {
    await expect(updateRace("u1", "r1", { [key]: undefined })).rejects.toThrow("versioned confirmation");
    await expect(createRace("u1", { [key]: null } as unknown as Omit<Race, "id" | "createdAt">)).rejects.toThrow("versioned confirmation");
    await expect(saveRace("u1", { id: "r1", [key]: null } as unknown as Race)).rejects.toThrow("versioned confirmation");
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it("full-saves ordinary fields without stale optional values or erasing a concurrent confirmation", async () => {
    const caller = { id: "r1", name: "Changed name", raceDate: "2026-09-20", raceDistance: "halfMarathon", isActive: false, createdAt: "2026-01-01" } as Race;
    // The caller's snapshot predates another tab's explicit confirmation.
    const confirmationHistory = { currentRevisionId: "new", revisions: { old: { source: "original" }, new: { source: "correction" } } };
    const performanceEvidence = { original: "legacy evidence" };
    h.records.set("r1", { ...caller, customDistanceMiles: 14, location: "Old", targetPaceSecondsPerMile: 600,
      linkedStravaActivityId: "s1", result: "2:00:00", notes: "Old", linkedPlanId: "p1",
      actualRunId: "w1", actualRunDate: "2026-09-20", actualRunDistanceMiles: 14,
      actualRunDurationSeconds: 7200, actualRunAvgPace: 600, confirmationHistory, performanceEvidence });
    await saveRace("u1", caller);
    expect(h.records.get("r1")).toEqual({ ...caller, confirmationHistory, performanceEvidence });
  });

  it("creates through legacy full-save and can explicitly clear optional fields on its next save", async () => {
    const race = { id: "r1", name: "New Race", raceDate: "2026-09-20", raceDistance: "halfMarathon", isActive: false, createdAt: "2026-01-01", linkedPlanId: "p1" } as Race;
    await saveRace("u1", race);
    expect(h.records.get("r1")).toEqual(race);
    await saveRace("u1", { ...race, linkedPlanId: undefined });
    expect(h.records.get("r1")).not.toHaveProperty("linkedPlanId");
  });

  it("preserves evidence through ordinary create/edit/link/unlink, and deletes the whole race only on explicit deletion", async () => {
    const race = { name: "New Race", raceDate: "2026-09-20", raceDistance: "halfMarathon", isActive: false } as const;
    const id = await createRace("u1", race);
    expect(h.records.get(id)).toMatchObject({ ...race, id });
    const confirmationHistory = { schemaVersion: 99 }; // Even invalid evidence must survive.
    h.records.get(id)!.confirmationHistory = confirmationHistory;
    await updateRace("u1", id, { name: "Edited", linkedPlanId: "p1" });
    await updateRace("u1", id, { linkedPlanId: undefined });
    await associateRunWithRace("u1", id, { workoutId: "w1", startDate: new Date(2026, 8, 20), distanceMiles: 13.1, durationSeconds: 7200 } as HealthWorkout);
    expect(h.records.get(id)).toMatchObject({ actualRunId: "w1", confirmationHistory });
    await disassociateRunFromRace("u1", id);
    expect(h.records.get(id)).toMatchObject({ name: "Edited", confirmationHistory });
    expect(h.records.get(id)).not.toHaveProperty("actualRunId");
    expect(h.records.get(id)).not.toHaveProperty("linkedPlanId");
    await deleteRace("u1", id);
    expect(h.records.has(id)).toBe(false);
  });

  it("retains invalid history presence rather than silently reverting to legacy evidence", () => {
    expect(normalizeRaceDocument("r1", { raceDate: "2026-09-20", createdAt: "2026-09-01", confirmationHistory: { schemaVersion: 99 } }).confirmationHistory).toBeNull();
  });
});
