import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";

vi.mock("@/lib/firebase", () => ({ db: {} }));

const h = vi.hoisted(() => ({
  setDoc: vi.fn(),
  deleteSentinel: { kind: "delete-field" },
}));

vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  doc: (...args: unknown[]) => ({ id: args.at(-1) }),
  getDocs: vi.fn(),
  setDoc: h.setDoc,
  deleteDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteField: () => h.deleteSentinel,
  writeBatch: vi.fn(),
}));

import { associateRunWithRace, createRace, normalizeRaceDocument, saveRace, updateRace } from "@/services/races";
import type { Race } from "@/types/race";

beforeEach(() => {
  h.setDoc.mockReset().mockResolvedValue(undefined);
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

  it.each(["confirmationHistory", "performanceEvidence", "confirmationHistory.currentRevisionId"])("prevents generic writes to %s", async key => {
    await expect(updateRace("u1", "r1", { [key]: undefined })).rejects.toThrow("versioned confirmation");
    await expect(createRace("u1", { [key]: null } as unknown as Omit<Race, "id" | "createdAt">)).rejects.toThrow("versioned confirmation");
    await expect(saveRace("u1", { id: "r1", [key]: null } as unknown as Race)).rejects.toThrow("versioned confirmation");
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it("keeps legacy ordinary saves as merges so concurrent evidence is never replaced", async () => {
    await saveRace("u1", { id: "r1", name: "Changed name" } as Race);
    expect(h.setDoc.mock.calls[0][2]).toEqual({ merge: true });
  });

  it("retains invalid history presence rather than silently reverting to legacy evidence", () => {
    expect(normalizeRaceDocument("r1", { raceDate: "2026-09-20", createdAt: "2026-09-01", confirmationHistory: { schemaVersion: 99 } }).confirmationHistory).toBeNull();
  });
});
