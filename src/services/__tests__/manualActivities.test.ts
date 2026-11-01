import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory Firestore: transactions apply writes only if the callback succeeds. */
const h = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  user: null as { uid: string; email: string; emailVerified: boolean } | null,
  races: [] as Record<string, unknown>[],
  plans: [] as Record<string, unknown>[],
  commits: 0,
  failNextCommit: null as { code: string } | null,
  loseAcknowledgement: false,
  statsUpdates: [] as string[],
  DELETE: Symbol("deleteField"),
}));

function applyMerge(path: string, data: Record<string, unknown>, merge: boolean) {
  const base = merge ? { ...(h.records.get(path) ?? {}) } : {};
  for (const [key, value] of Object.entries(data)) {
    if (value === h.DELETE) delete base[key];
    else base[key] = value;
  }
  h.records.set(path, base);
}

vi.mock("@/lib/firebase", () => ({ db: {}, auth: { get currentUser() { return h.user; } } }));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...parts: string[]) => ({ path: parts.join("/") }),
  collection: (_db: unknown, ...parts: string[]) => ({ path: parts.join("/") }),
  deleteField: () => h.DELETE,
  Timestamp: { fromDate: (date: Date) => ({ toDate: () => date }) },
  getDoc: async (ref: { path: string }) => ({
    exists: () => h.records.has(ref.path), id: ref.path.split("/").pop(), data: () => h.records.get(ref.path),
  }),
  getDocs: async (ref: { path: string }) => ({
    docs: [...h.records.keys()]
      .filter((path) => path.startsWith(`${ref.path}/`))
      .map((path) => ({ id: path.split("/").pop() })),
  }),
  updateDoc: async (ref: { path: string }) => {
    if (!h.records.has(ref.path)) throw Object.assign(new Error("missing"), { code: "not-found" });
    h.statsUpdates.push(ref.path);
  },
  runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const pending: (() => void)[] = [];
    const tx = {
      get: async (ref: { path: string }) => ({
        exists: () => h.records.has(ref.path), id: ref.path.split("/").pop(), data: () => h.records.get(ref.path),
      }),
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) =>
        pending.push(() => applyMerge(ref.path, data, options?.merge === true)),
      delete: (ref: { path: string }) => pending.push(() => h.records.delete(ref.path)),
    };
    const result = await fn(tx);
    if (h.failNextCommit) {
      const failure = Object.assign(new Error("commit failed"), h.failNextCommit);
      h.failNextCommit = null;
      throw failure;
    }
    pending.forEach((apply) => apply());
    h.commits += 1;
    if (h.loseAcknowledgement) {
      h.loseAcknowledgement = false;
      throw Object.assign(new Error("connection lost"), { code: "unavailable" });
    }
    return result;
  },
}));
vi.mock("@/services/plans", () => ({ fetchPlans: async () => h.plans }));
vi.mock("@/services/races", () => ({ fetchRaces: async () => h.races }));
vi.mock("@/services/healthWorkouts", async () => {
  const { toDate } = await vi.importActual<typeof import("@/utils/dates")>("@/utils/dates");
  return {
    docToHealthWorkout: (id: string, data: Record<string, unknown>) => ({
      ...data, workoutId: id, startDate: toDate(data.startDate), endDate: toDate(data.endDate),
    }),
  };
});

import {
  createManualActivity,
  deleteManualActivity,
  releasePlansMatchedTo,
  updateManualActivity,
} from "@/services/manualActivities";
import { type ManualActivityInput } from "@/utils/manualActivity";
import { type Plan } from "@/types/plan";

const UID = "owner";
const ID = "manual_11111111-1111-4111-8111-111111111111";
const WORKOUT_PATH = `users/${UID}/healthWorkouts/${ID}`;
const HK_ID = "A1B2C3D4-0000-4000-8000-000000000000";
const HK_PATH = `users/${UID}/healthWorkouts/${HK_ID}`;

const input = (overrides: Partial<ManualActivityInput> = {}): ManualActivityInput => ({
  kind: "outdoor_run", localDate: "2026-01-10", localTime: "07:30", durationSeconds: 1800,
  distanceMiles: 3, avgHeartRate: 150, calories: 400, title: "Loop", notes: "Windy", ...overrides,
});
const plan = (overrides: Record<string, unknown> = {}) => ({
  id: "plan-1", name: "Plan", planType: "workout", status: "active", isActive: true, startDate: "2026-01-05",
  weeks: [{ weekNumber: 1, entries: [
    { id: "e1", type: "workout", completed: true, completedAt: "2026-01-10T12:30:00.000Z", matchedWorkoutId: ID },
    { id: "e2", type: "workout", completed: true, completedAt: "2026-01-11T12:30:00.000Z" },
  ] }],
  createdAt: "x", updatedAt: "x", ...overrides,
});

beforeEach(() => {
  h.records.clear();
  h.user = { uid: UID, email: "folstromjohn@gmail.com", emailVerified: true };
  h.races = []; h.plans = []; h.commits = 0; h.failNextCommit = null;
  h.loseAcknowledgement = false; h.statsUpdates = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("createManualActivity", () => {
  it("writes the Firestore document at the shared path with matching workoutId", async () => {
    const saved = await createManualActivity(UID, input(), ID);
    const doc = h.records.get(WORKOUT_PATH)!;
    expect(doc).toMatchObject({
      workoutId: ID, entrySource: "manual", sourceName: "Manual Entry", isRunLike: true,
      hasRoute: false, hasHRStream: false, distanceMiles: 3, avgPaceSecPerMile: 600,
    });
    expect(doc).not.toHaveProperty("syncedAt");
    expect(doc).toHaveProperty("createdAt");
    expect(doc).toHaveProperty("updatedAt");
    expect(saved.workoutId).toBe(ID);
  });

  it("reuses the same ID on retry after a lost acknowledgement, without a second write", async () => {
    h.loseAcknowledgement = true;
    await expect(createManualActivity(UID, input(), ID)).rejects.toThrow(/offline/);
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
    const commits = h.commits;
    const firstDoc = h.records.get(WORKOUT_PATH);

    const retried = await createManualActivity(UID, input({ notes: "changed" }), ID);
    expect(retried.workoutId).toBe(ID);
    expect(h.records.get(WORKOUT_PATH)).toBe(firstDoc);
    expect(h.records.size).toBe(1);
    expect(h.commits).toBe(commits + 1); // read-only transaction, no document change
  });

  it("recovers after a failed write: nothing stored, failure surfaced, retry succeeds", async () => {
    h.failNextCommit = { code: "permission-denied" };
    await expect(createManualActivity(UID, input(), ID)).rejects.toThrow(/permission/);
    expect(h.records.has(WORKOUT_PATH)).toBe(false);
    await expect(createManualActivity(UID, input(), ID)).resolves.toMatchObject({ workoutId: ID });
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });

  it.each([
    ["signed out", () => { h.user = null; }],
    ["another user", () => { h.user = { uid: "someone-else", email: "folstromjohn@gmail.com", emailVerified: true }; }],
    ["an unverified email", () => { h.user = { uid: UID, email: "folstromjohn@gmail.com", emailVerified: false }; }],
    ["a different email", () => { h.user = { uid: UID, email: "stranger@example.test", emailVerified: true }; }],
  ])("refuses %s before any write", async (_name, arrange) => {
    arrange();
    await expect(createManualActivity(UID, input(), ID)).rejects.toMatchObject({ code: "unauthorized" });
    expect(h.records.size).toBe(0);
  });

  it("validates at the service boundary, not only in the form", async () => {
    await expect(createManualActivity(UID, input({ durationSeconds: -1 }), ID))
      .rejects.toMatchObject({ code: "invalid" });
    expect(h.records.size).toBe(0);
  });

  it("refuses an ID outside the manual namespace", async () => {
    await expect(createManualActivity(UID, input(), HK_ID)).rejects.toMatchObject({ code: "not_manual" });
  });

  it("never overwrites an existing unmarked record at the requested ID", async () => {
    h.records.set(WORKOUT_PATH, { workoutId: ID, activityType: "running" });
    await expect(createManualActivity(UID, input(), ID)).rejects.toMatchObject({ code: "not_manual" });
    expect(h.records.get(WORKOUT_PATH)).toEqual({ workoutId: ID, activityType: "running" });
  });

  it("marks the stats cache stale for backdated changes when it exists", async () => {
    h.records.set(`users/${UID}/insights/aggregatedStats`, {});
    await createManualActivity(UID, input(), ID);
    await vi.waitFor(() => expect(h.statsUpdates).toHaveLength(1));
  });

  it("a missing or unwritable stats cache never fails a successful save", async () => {
    await expect(createManualActivity(UID, input(), ID)).resolves.toBeTruthy();
  });
});

describe("updateManualActivity", () => {
  beforeEach(async () => { await createManualActivity(UID, input(), ID); });

  it("refuses to edit an Apple Health record even with a manual-looking ID", async () => {
    const original = { workoutId: ID, activityType: "running", durationSeconds: 100 };
    h.records.set(WORKOUT_PATH, original);
    await expect(updateManualActivity(UID, ID, input())).rejects.toMatchObject({ code: "not_manual" });
    expect(h.records.get(WORKOUT_PATH)).toEqual(original);
  });

  it("refuses to edit an Apple Health ID outright", async () => {
    h.records.set(HK_PATH, { workoutId: HK_ID, activityType: "running" });
    await expect(updateManualActivity(UID, HK_ID, input())).rejects.toMatchObject({ code: "not_manual" });
    expect(h.records.get(HK_PATH)).toEqual({ workoutId: HK_ID, activityType: "running" });
  });

  it("reports a record that no longer exists rather than recreating it", async () => {
    h.records.delete(WORKOUT_PATH);
    await expect(updateManualActivity(UID, ID, input())).rejects.toMatchObject({ code: "not_found" });
    expect(h.records.has(WORKOUT_PATH)).toBe(false);
  });

  it("refuses a non-owner", async () => {
    h.user = null;
    await expect(updateManualActivity(UID, ID, input())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("preserves unrelated fields, including ones iOS added", async () => {
    h.records.set(WORKOUT_PATH, { ...h.records.get(WORKOUT_PATH), hrBackfillFirstAttemptAt: "kept" });
    await updateManualActivity(UID, ID, input({ title: "Renamed" }));
    expect(h.records.get(WORKOUT_PATH)).toMatchObject({
      hrBackfillFirstAttemptAt: "kept", customTitle: "Renamed", workoutId: ID,
    });
  });

  it.each([
    ["duration", { durationSeconds: 2000 }],
    ["distance", { distanceMiles: 3.5 }],
    ["type", { kind: "treadmill_run" as const }],
    ["average HR", { avgHeartRate: 140 }],
    ["removing average HR", { avgHeartRate: null }],
  ])("clears the stored load and PR badges when %s changes", async (_name, change) => {
    h.records.set(WORKOUT_PATH, {
      ...h.records.get(WORKOUT_PATH), trainingLoadV2: 90, trainingLoadMethod: "avg-hr-fallback",
      trainingLoadBasisComplete: true, prBadges: ["5K PR"],
    });
    const { workout } = await updateManualActivity(UID, ID, input(change));
    for (const field of ["trainingLoadV2", "trainingLoadMethod", "trainingLoadBasisComplete", "prBadges"]) {
      expect(h.records.get(WORKOUT_PATH)).not.toHaveProperty(field);
      expect(workout).not.toHaveProperty(field);
    }
  });

  it("keeps the stored load when only the title or notes change", async () => {
    h.records.set(WORKOUT_PATH, { ...h.records.get(WORKOUT_PATH), trainingLoadV2: 90 });
    await updateManualActivity(UID, ID, input({ title: "New", notes: "New" }));
    expect(h.records.get(WORKOUT_PATH)).toMatchObject({ trainingLoadV2: 90 });
  });

  it("removes optional values the owner blanked instead of merging them back", async () => {
    await updateManualActivity(UID, ID, input({ calories: null, title: null, notes: null, kind: "walking", distanceMiles: null }));
    const doc = h.records.get(WORKOUT_PATH)!;
    for (const field of ["calories", "customTitle", "notes", "distanceMiles", "distanceMeters", "avgPaceSecPerMile", "avgSpeedMPS"]) {
      expect(doc).not.toHaveProperty(field);
    }
    expect(doc.isRunLike).toBe(false);
  });

  it("removes a field override that would hide the edit", async () => {
    const path = `users/${UID}/workoutOverrides/${ID}`;
    h.records.set(path, { workoutId: ID, isExcluded: false, distanceMilesOverride: 9, durationSecondsOverride: null, runTypeOverride: null });
    const result = await updateManualActivity(UID, ID, input());
    expect(h.records.has(path)).toBe(false);
    expect(result.override).toBeNull();
  });

  it("keeps the exclusion when clearing field overrides", async () => {
    const path = `users/${UID}/workoutOverrides/${ID}`;
    h.records.set(path, { workoutId: ID, isExcluded: true, distanceMilesOverride: 9, durationSecondsOverride: null, runTypeOverride: null });
    const result = await updateManualActivity(UID, ID, input());
    expect(h.records.get(path)).toMatchObject({ isExcluded: true, distanceMilesOverride: null });
    expect(result.override).toMatchObject({ isExcluded: true, distanceMilesOverride: null });
  });

  it("releases a matched plan session when the date moves", async () => {
    h.plans = [plan()];
    const result = await updateManualActivity(UID, ID, input({ localDate: "2026-01-12" }));
    expect(result.plans).toHaveLength(1);
    const stored = h.records.get(`users/${UID}/plans/plan-1`) as ReturnType<typeof plan>;
    const entries = stored.weeks[0].entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({ completed: false });
    expect(entries[0]).not.toHaveProperty("matchedWorkoutId");
    expect(entries[1]).toMatchObject({ completed: true });
  });

  it("leaves a matched session alone when only the time of day changes", async () => {
    h.plans = [plan()];
    const result = await updateManualActivity(UID, ID, input({ localTime: "18:00" }));
    expect(result.plans).toEqual([]);
  });

  it("blocks measurement changes on a race-linked run, but allows notes", async () => {
    h.races = [{ id: "r1", name: "City Half", actualRunId: ID }];
    await expect(updateManualActivity(UID, ID, input({ distanceMiles: 4 })))
      .rejects.toMatchObject({ code: "linked_race", message: expect.stringContaining("City Half") });
    await expect(updateManualActivity(UID, ID, input({ notes: "Great day" }))).resolves.toBeTruthy();
  });

  it("surfaces a failed write and changes nothing", async () => {
    const before = h.records.get(WORKOUT_PATH);
    h.failNextCommit = { code: "unavailable" };
    await expect(updateManualActivity(UID, ID, input({ distanceMiles: 4 }))).rejects.toThrow(/Nothing was saved/);
    expect(h.records.get(WORKOUT_PATH)).toBe(before);
  });
});

describe("deleteManualActivity", () => {
  beforeEach(async () => { await createManualActivity(UID, input(), ID); });

  it("deletes the record", async () => {
    await deleteManualActivity(UID, ID);
    expect(h.records.has(WORKOUT_PATH)).toBe(false);
  });

  it("refuses to delete an Apple Health ID", async () => {
    h.records.set(HK_PATH, { workoutId: HK_ID, activityType: "running" });
    await expect(deleteManualActivity(UID, HK_ID)).rejects.toMatchObject({ code: "not_manual" });
    expect(h.records.has(HK_PATH)).toBe(true);
  });

  it("refuses to delete an unmarked record, whatever its ID looks like", async () => {
    h.records.set(WORKOUT_PATH, { workoutId: ID, activityType: "running" });
    await expect(deleteManualActivity(UID, ID)).rejects.toMatchObject({ code: "not_manual" });
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });

  it("refuses a non-owner", async () => {
    h.user = { uid: UID, email: "folstromjohn@gmail.com", emailVerified: false };
    await expect(deleteManualActivity(UID, ID)).rejects.toMatchObject({ code: "unauthorized" });
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });

  it("cleans the shoe assignment, override and dismissed pairs in the same commit", async () => {
    const shoePath = `users/${UID}/shoeAssignments/manual`;
    const overridePath = `users/${UID}/workoutOverrides/${ID}`;
    const dismissedPath = `users/${UID}/dismissedDuplicates/${HK_ID}_${ID}`;
    const otherDismissed = `users/${UID}/dismissedDuplicates/other_pair`;
    h.records.set(shoePath, { [ID]: "shoe-1", "other-run": "shoe-2" });
    h.records.set(overridePath, { workoutId: ID, isExcluded: true });
    h.records.set(dismissedPath, {});
    h.records.set(otherDismissed, {});
    const commits = h.commits;

    const result = await deleteManualActivity(UID, ID);

    expect(h.commits).toBe(commits + 1);
    expect(h.records.get(shoePath)).toEqual({ "other-run": "shoe-2" });
    expect(h.records.has(overridePath)).toBe(false);
    expect(h.records.has(dismissedPath)).toBe(false);
    expect(h.records.has(otherDismissed)).toBe(true);
    expect(result.overrideRemoved).toBe(true);
  });

  it("releases a plan session completed by this activity, not a manual completion", async () => {
    h.plans = [plan()];
    const result = await deleteManualActivity(UID, ID);
    expect(result.plans).toHaveLength(1);
    const stored = h.records.get(`users/${UID}/plans/plan-1`) as ReturnType<typeof plan>;
    const [matched, manual] = stored.weeks[0].entries as Record<string, unknown>[];
    expect(matched.completed).toBe(false);
    expect(matched).not.toHaveProperty("completedAt");
    expect(manual.completed).toBe(true);
  });

  it("blocks deletion of a race-linked activity with an actionable message", async () => {
    h.races = [{ id: "r1", name: "City Half", actualRunId: ID }];
    await expect(deleteManualActivity(UID, ID))
      .rejects.toMatchObject({ code: "linked_race", message: expect.stringContaining("Unlink") });
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });

  it("blocks deletion of an activity cited by race confirmation history", async () => {
    h.races = [{ id: "r1", name: "City Half", confirmationHistory: { revisions: { a: { details: { linkedWorkoutId: ID } } } } }];
    await expect(deleteManualActivity(UID, ID)).rejects.toMatchObject({ code: "linked_race" });
  });

  it("blocks deletion when saved performance evidence cites the activity", async () => {
    h.records.set(`users/${UID}/performanceFeatures/${ID}`, { workoutId: ID });
    await expect(deleteManualActivity(UID, ID)).rejects.toMatchObject({ code: "linked_performance" });
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });

  it("treats an already-deleted record as success on retry", async () => {
    h.loseAcknowledgement = true;
    await expect(deleteManualActivity(UID, ID)).rejects.toThrow(/offline/);
    expect(h.records.has(WORKOUT_PATH)).toBe(false);
    await expect(deleteManualActivity(UID, ID)).resolves.toEqual({ overrideRemoved: false, plans: [] });
  });

  it("surfaces a failed delete and keeps the record", async () => {
    h.failNextCommit = { code: "permission-denied" };
    await expect(deleteManualActivity(UID, ID)).rejects.toThrow(/permission/);
    expect(h.records.has(WORKOUT_PATH)).toBe(true);
  });
});

describe("releasePlansMatchedTo", () => {
  it("ignores running plans and unrelated matches", () => {
    const running = { id: "run", planType: "running", weeks: [] } as unknown as Plan;
    const other = plan({ id: "other" }) as unknown as Plan;
    expect(releasePlansMatchedTo([running, other], "manual_unrelated")).toEqual([]);
  });
});
