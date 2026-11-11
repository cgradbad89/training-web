import { beforeEach, describe, expect, it, vi } from "vitest";
import { zonedWeekFor } from "@/lib/hubWeek";

/**
 * A recording fake of the Admin Firestore surface the reader may touch. Any
 * write-shaped method (set/update/delete/create/batch/runTransaction/
 * bulkWriter) throws, so the test also proves the adapter is read-only.
 */
const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = {
    workoutDocs: [] as { id: string; data: Record<string, unknown> }[],
    planDocs: [] as { id: string; data: Record<string, unknown> }[],
    overrideDocs: {} as Record<string, Record<string, unknown>>,
    failWith: null as unknown,
    workoutWhere: [] as unknown[][],
    uidPaths: [] as string[],
    getAllIds: [] as string[],
  };
  const forbidden = (name: string) => () => {
    throw new Error(`write-shaped call: ${name}`);
  };
  const writeGuards = Object.fromEntries(
    ["set", "update", "delete", "create", "batch", "runTransaction", "bulkWriter"].map((n) => [n, forbidden(n)])
  );
  function snapshot(docs: { id: string; data: Record<string, unknown> }[]) {
    return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
  }
  function query(kind: "workouts" | "plans") {
    const q: Record<string, unknown> = {
      ...writeGuards,
      where: (...args: unknown[]) => { calls.push(`${kind}.where`); if (kind === "workouts") state.workoutWhere.push(args); return q; },
      orderBy: () => { calls.push(`${kind}.orderBy`); return q; },
      select: () => { calls.push(`${kind}.select`); return q; },
      limit: () => { calls.push(`${kind}.limit`); return q; },
      get: async () => {
        calls.push(`${kind}.get`);
        if (state.failWith) throw state.failWith;
        return snapshot(kind === "workouts" ? state.workoutDocs : state.planDocs);
      },
    };
    return q;
  }
  const db = {
    ...writeGuards,
    collection: (name: string) => {
      calls.push(`db.collection(${name})`);
      return {
        doc: (uid: string) => {
          state.uidPaths.push(uid);
          return {
            ...writeGuards,
            collection: (sub: string) => {
              if (sub === "healthWorkouts") return query("workouts");
              if (sub === "plans") return query("plans");
              return { doc: (id: string) => ({ __override: id }) };
            },
          };
        },
      };
    },
    getAll: async (...refs: { __override: string }[]) => {
      calls.push("db.getAll");
      state.getAllIds = refs.map((r) => r.__override);
      return refs.map((r) => ({
        id: r.__override,
        exists: r.__override in state.overrideDocs,
        data: () => state.overrideDocs[r.__override],
      }));
    },
  };
  return { calls, state, db };
});

vi.mock("@/lib/firebaseAdmin", () => ({ getFirestore: () => h.db }));

import { HUB_WORKOUT_LIMIT, HubReadError, readHubWeek } from "@/lib/hubAdminReader";

const week = zonedWeekFor(new Date("2026-11-11T17:00:00.000Z"));

function workoutDoc(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      workoutId: id,
      startDate: new Date("2026-11-10T15:00:00.000Z"),
      endDate: new Date("2026-11-10T15:30:00.000Z"),
      durationSeconds: 1800,
      isRunLike: true,
      distanceMiles: 3,
      displayType: "Run",
      activityType: "running",
      ...extra,
    },
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.state.workoutDocs = [];
  h.state.planDocs = [];
  h.state.overrideDocs = {};
  h.state.failWith = null;
  h.state.workoutWhere = [];
  h.state.uidPaths = [];
  h.state.getAllIds = [];
});

describe("readHubWeek", () => {
  it("reads only the verified uid's week window, overrides by id, and every plan — read calls only", async () => {
    h.state.workoutDocs = [workoutDoc("w1"), workoutDoc("w2", { isRunLike: false, displayType: "Strength" })];
    h.state.planDocs = [
      { id: "p1", data: { planType: "running", startDate: "2026-11-02", weeks: [], isActive: true } },
      { id: "p2", data: { planType: "workout", startDate: "2026-11-02", weeks: [], status: "active" } },
    ];
    h.state.overrideDocs = { w2: { workoutId: "w2", isExcluded: true } };

    const read = await readHubWeek("the-uid", week);

    expect(h.state.uidPaths).toEqual(["the-uid"]);
    expect(h.state.workoutWhere).toEqual([
      ["startDate", ">=", week.startInstant],
      ["startDate", "<", week.endExclusiveInstant],
    ]);
    expect(h.state.getAllIds.sort()).toEqual(["w1", "w2"]);
    expect(read.counts).toEqual({ workouts: 2, overrides: 1, plans: 2 });
    expect(read.workouts.map((w) => w.workoutId).sort()).toEqual(["w1", "w2"]);
    expect(Object.keys(read.overrides)).toEqual(["w2"]);
    // Legacy plan (no status, isActive true) is normalized exactly like fetchPlans.
    expect(read.plans.map((p) => [p.id, p.status])).toEqual([["p1", "active"], ["p2", "active"]]);
    expect(read.stagesMs.workouts).toBeGreaterThanOrEqual(0);
    // Only read-shaped calls were made (write methods throw in the fake).
    expect(h.calls.every((c) => /collection|where|orderBy|select|limit|get|getAll/.test(c))).toBe(true);
  });

  it("skips the override read when the week has no workouts", async () => {
    const read = await readHubWeek("u", week);
    expect(read.counts).toEqual({ workouts: 0, overrides: 0, plans: 0 });
    expect(h.calls).not.toContain("db.getAll");
  });

  it("maps permission-denied (gRPC 7 and string codes) to reason 'permission'", async () => {
    for (const code of [7, "permission-denied"]) {
      h.state.failWith = Object.assign(new Error("7 PERMISSION_DENIED: missing or insufficient permissions"), { code });
      await expect(readHubWeek("u", week)).rejects.toMatchObject({ name: "HubReadError", reason: "permission" });
    }
  });

  it("maps every other failure to reason 'upstream' without keeping the message", async () => {
    h.state.failWith = Object.assign(new Error("14 UNAVAILABLE users/the-uid/healthWorkouts"), { code: 14 });
    const error = await readHubWeek("u", week).catch((e) => e);
    expect(error).toBeInstanceOf(HubReadError);
    expect(error.reason).toBe("upstream");
    expect(error.message).toBe("upstream");
  });

  it("refuses to silently truncate: an over-limit week is 'upstream'", async () => {
    h.state.workoutDocs = Array.from({ length: HUB_WORKOUT_LIMIT + 1 }, (_, i) => workoutDoc(`w${i}`));
    await expect(readHubWeek("u", week)).rejects.toMatchObject({ reason: "upstream" });
  });
});
