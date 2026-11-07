import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutePoint } from "@/services/routes";

// Real recovery service + real calculations; only the Firestore boundary is synthetic. No Firebase project is contacted.
const h = vi.hoisted(() => ({ getDoc: vi.fn(), setDoc: vi.fn(), count: vi.fn(), runTransaction: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, ...parts: string[]) => parts.join("/"),
  doc: (_db: unknown, ...parts: string[]) => parts.join("/"),
  getDoc: h.getDoc, setDoc: h.setDoc, getCountFromServer: h.count,
  runTransaction: (...args: unknown[]) => h.runTransaction(...args),
  getDocs: vi.fn(), onSnapshot: vi.fn(), query: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn(), writeBatch: vi.fn(),
}));
vi.mock("@/utils/routeCache", () => ({ getRouteStartPoint: vi.fn() }));

import {
  checkBestEffortsRouteGrowth, computeAndStoreBestEfforts, hasAttemptedBestEfforts, resetBestEffortsRecoveryState,
} from "@/services/healthWorkouts";
import { assessBestEffortsCache, computeBestEfforts, withBestEffortsFreshness, type BestEffortsMap } from "@/utils/bestEfforts";

const EARTH_RADIUS_M = 3958.8 * 1609.344, MILE = 1609.344, START_MS = Date.UTC(2026, 10, 7, 14, 0, 0);
const point = (i: number, meters: number): RoutePoint => ({ index: i, lat: (meters / EARTH_RADIUS_M) * (180 / Math.PI), lng: 0, altitude: 0, speed: null, hr: null,
  timestamp: new Date(START_MS + i * 1000).toISOString() });
const steady = (miles: number, pace = 590): RoutePoint[] => { const speed = MILE / pace, n = Math.floor(miles * MILE / speed); return Array.from({ length: n + 1 }, (_, i) => point(i, i * speed)); };
const FACTS = { distanceMiles: 9.18, durationSeconds: 5413 };
const FULL = steady(9.18), TRUNCATED = FULL.slice(0, 400);
const stored = (points: RoutePoint[], complete = true): BestEffortsMap => withBestEffortsFreshness(computeBestEfforts(points), complete, points.length);
const snap = (bestEfforts?: unknown) => ({ exists: () => true, data: () => (bestEfforts === undefined ? {} : { bestEfforts }) });
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

beforeEach(() => {
  vi.clearAllMocks(); resetBestEffortsRecoveryState();
  h.getDoc.mockResolvedValue(snap()); h.setDoc.mockResolvedValue(undefined);
  // default: a transaction that reads through getDoc and writes through setDoc (single session, no contention)
  h.runTransaction.mockImplementation(async (_db: unknown, fn: (tx: unknown) => unknown) => {
    let pending = null as unknown[] | null;                                  // like Firestore: writes are applied at COMMIT and a failure rejects the transaction
    const out = await fn({ get: (ref: unknown) => h.getDoc(ref), set: (...args: unknown[]) => { pending = args; } });
    if (pending) await h.setDoc(...pending);
    return out;
  });
});

describe("recovery persists only the derived best-effort fields, once", () => {
  it("recovers the truncated all-null record: writes ONLY { bestEfforts } with merge, complete values and the route distance", async () => {
    h.getDoc.mockResolvedValue(snap(stored(TRUNCATED)));
    const result = await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS, existing: stored(TRUNCATED) });
    expect(h.setDoc).toHaveBeenCalledTimes(1);
    const [ref, payload, options] = h.setDoc.mock.calls[0];
    expect(ref).toBe("users/u1/healthWorkouts/w1"); expect(options).toEqual({ merge: true }); expect(Object.keys(payload)).toEqual(["bestEfforts"]);
    expect(payload.bestEfforts).toMatchObject({ computedFromRouteComplete: true, computedFromPointCount: FULL.length });
    expect(payload.bestEfforts["10k"]).not.toBeNull(); expect(payload.bestEfforts.computedFromRouteDistanceMeters).toBeGreaterThan(9 * MILE);
    expect(payload.bestEfforts.verificationAttempts).toBeUndefined();
    expect(result["5k"]).not.toBeNull();
    expect(assessBestEffortsCache(result, true, FACTS).state).toBe("valid_current");
  });
  it("is idempotent: recomputing an already valid, identical record performs no write", async () => {
    const valid = stored(FULL);
    h.getDoc.mockResolvedValue(snap({ ...valid, computedFromRouteDistanceMeters: undefined }));
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });
    const written = h.setDoc.mock.calls[0]?.[1].bestEfforts;
    h.setDoc.mockClear(); h.getDoc.mockResolvedValue(snap(written));
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });
    expect(h.setDoc).not.toHaveBeenCalled();
  });
});

describe("never overwrite newer or more complete data with older or partial data", () => {
  it("keeps a complete current record when a recomputation comes from an incomplete route or fewer points", async () => {
    const good = stored(FULL);
    h.getDoc.mockResolvedValue(snap(good));
    expect(await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 1200), false, { facts: FACTS })).toMatchObject({ computedFromPointCount: FULL.length });
    resetBestEffortsRecoveryState();
    expect(await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 900), true, { facts: FACTS })).toMatchObject({ computedFromPointCount: FULL.length });
    expect(h.setDoc).not.toHaveBeenCalled();
  });
  it("does not mark an incomplete route complete: the flag written is exactly what the caller reports", async () => {
    await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 1200), false, { facts: FACTS });
    expect(h.setDoc.mock.calls[0][1].bestEfforts.computedFromRouteComplete).toBe(false);
  });
  it("replaces a partial-route record once the route is complete", async () => {
    h.getDoc.mockResolvedValue(snap(stored(FULL.slice(0, 1100), false)));
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });
    expect(h.setDoc.mock.calls[0][1].bestEfforts).toMatchObject({ computedFromRouteComplete: true, computedFromPointCount: FULL.length });
  });
});

describe("bounded retries: a sparse or gapped route does not trap the app", () => {
  it("advances the attempt counter only while the result still looks implausible, and stops at the bound", async () => {
    const gappedFacts = { distanceMiles: 6.5, durationSeconds: 3900 }, gapped = steady(2.5);
    let existing: BestEffortsMap | undefined = stored(gapped);
    let recomputes = 0;
    for (let i = 0; i < 6; i++) {
      if (!assessBestEffortsCache(existing, true, gappedFacts).recompute) break;
      h.getDoc.mockResolvedValue(snap(existing)); resetBestEffortsRecoveryState();
      await computeAndStoreBestEfforts("u1", "w1", gapped, true, { facts: gappedFacts, existing });
      recomputes++;
      existing = h.setDoc.mock.calls.at(-1)![1].bestEfforts;
    }
    expect(recomputes).toBe(2); expect(existing!.verificationAttempts).toBe(2);
    expect(assessBestEffortsCache(existing, true, gappedFacts)).toMatchObject({ state: "unavailable_confirmed", recompute: false });
  });
});

describe("no repeated work", () => {
  it("shares one calculation and one write between concurrent requests for the same user and workout", async () => {
    const gate = deferred<ReturnType<typeof snap>>();
    h.getDoc.mockReturnValue(gate.promise);
    const a = computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS }), b = computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });
    gate.resolve(snap());
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.getDoc).toHaveBeenCalledTimes(1); expect(h.setDoc).toHaveBeenCalledTimes(1); expect(ra).toBe(rb);
  });
  it("different users or workouts are independent", async () => {
    await Promise.all([computeAndStoreBestEfforts("u1", "w1", FULL, true), computeAndStoreBestEfforts("u2", "w1", FULL, true), computeAndStoreBestEfforts("u1", "w2", FULL, true)]);
    expect(h.setDoc).toHaveBeenCalledTimes(3);
    expect(h.setDoc.mock.calls.map(c => c[0]).sort()).toEqual(["users/u1/healthWorkouts/w1", "users/u1/healthWorkouts/w2", "users/u2/healthWorkouts/w1"]);
  });
  it("remembers a session attempt against the SAME stored record, so a revisit does not re-read the route, but a changed record re-qualifies", async () => {
    const existing = stored(TRUNCATED);
    expect(hasAttemptedBestEfforts("u1", "w1", existing)).toBe(false);
    h.getDoc.mockResolvedValue(snap(existing));
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS, existing });
    expect(hasAttemptedBestEfforts("u1", "w1", existing)).toBe(true);
    expect(hasAttemptedBestEfforts("u2", "w1", existing)).toBe(false);                            // another user is not covered
    expect(hasAttemptedBestEfforts("u1", "w1", stored(FULL.slice(0, 900)))).toBe(false);          // a different record is a new question
  });
  it("a failed write is reported to the caller and still counts as attempted (no hot retry loop in the session)", async () => {
    const existing = stored(TRUNCATED);
    h.getDoc.mockResolvedValue(snap(existing)); h.setDoc.mockRejectedValue(new Error("permission-denied"));
    await expect(computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS, existing })).rejects.toThrow("permission-denied");
    expect(hasAttemptedBestEfforts("u1", "w1", existing)).toBe(true);
    // the in-flight slot is released: a later explicit request is not wedged
    h.setDoc.mockResolvedValue(undefined);
    await expect(computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS, existing })).resolves.toBeDefined();
  });
  it("a failed read is reported and does not write", async () => {
    h.getDoc.mockRejectedValue(new Error("offline"));
    await expect(computeAndStoreBestEfforts("u1", "w1", FULL, true)).rejects.toThrow("offline");
    expect(h.setDoc).not.toHaveBeenCalled();
  });
});

describe("cancellation and user switching", () => {
  it("a retired session before any I/O does nothing and is not remembered as attempted", async () => {
    const existing = stored(TRUNCATED);
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { isCurrent: () => false, facts: FACTS, existing });
    expect(h.getDoc).not.toHaveBeenCalled(); expect(h.setDoc).not.toHaveBeenCalled(); expect(hasAttemptedBestEfforts("u1", "w1", existing)).toBe(false);
  });
  it("a session that retires while the read is in flight writes nothing", async () => {
    let live = true;
    const gate = deferred<ReturnType<typeof snap>>(); h.getDoc.mockReturnValue(gate.promise);
    const pending = computeAndStoreBestEfforts("u1", "w1", FULL, true, { isCurrent: () => live, facts: FACTS });
    live = false; gate.resolve(snap());
    await pending;
    expect(h.setDoc).not.toHaveBeenCalled();
  });
});

// ── Late route completion: a route that grows across sessions, with the workout's routeComplete flag never changing ──
describe("late route completion", () => {
  const facts = { distanceMiles: 9.18, durationSeconds: 5413 };
  const route = (n: number) => FULL.slice(0, n);
  const lastWritten = () => h.setDoc.mock.calls.at(-1)![1].bestEfforts as BestEffortsMap;

  /** One Run Detail visit in a NEW session: recover if the policy (or independent growth evidence) says so. */
  async function visit(existing: BestEffortsMap, routeNow: number, pointsInFirestore: number) {
    resetBestEffortsRecoveryState();                                            // a new browser session
    h.getDoc.mockResolvedValue(snap(existing)); h.count.mockResolvedValue({ data: () => ({ count: pointsInFirestore }) });
    const assessment = assessBestEffortsCache(existing, true, facts);
    const grew = assessment.state === "unavailable_confirmed" ? await checkBestEffortsRouteGrowth("u1", "w1", existing) : false;
    if (!assessment.recompute && !grew) return { existing, recomputed: false, grew };
    await computeAndStoreBestEfforts("u1", "w1", route(routeNow), true, { facts, existing, routeGrew: grew });
    return { existing: lastWritten(), recomputed: true, grew };
  }

  it("400 → 1,000 → 5,411 points: bounded retries exhaust on the partial route, then independent growth evidence recovers it", async () => {
    let record: BestEffortsMap = stored(route(400));
    // two sessions while the route sits at 1,000 points (a stalled upload): both retries are spent
    for (let i = 0; i < 2; i++) { const v = await visit(record, 1000, 1000); expect(v.recomputed).toBe(true); record = v.existing; }
    expect(record.verificationAttempts).toBe(2);
    expect(assessBestEffortsCache(record, true, facts).state).toBe("unavailable_confirmed");
    // a third session, route STILL 1,000 points: nothing happens (bounded) — one cheap count, no route read, no write
    h.setDoc.mockClear();
    const still = await visit(record, 1000, 1000);
    expect(still).toMatchObject({ recomputed: false, grew: false }); expect(h.setDoc).not.toHaveBeenCalled();
    // the upload finishes (5,411 points) with the routeComplete flag unchanged: independent evidence reopens the record
    const grown = await visit(record, 5411, 5411);
    expect(grown).toMatchObject({ recomputed: true, grew: true });
    expect(lastWritten()).toMatchObject({ computedFromPointCount: 5411 }); expect(lastWritten()["10k"]).not.toBeNull();
    expect(lastWritten().verificationAttempts).toBeUndefined();
    expect(assessBestEffortsCache(lastWritten(), true, facts).state).toBe("valid_current");
  });

  it("a genuinely sparse route stays bounded: the same count never reopens the record", async () => {
    const sparse = steady(2.5), sparseFacts = { distanceMiles: 6.5, durationSeconds: 3900 };
    let record: BestEffortsMap = stored(sparse);
    for (let i = 0; i < 2; i++) {
      resetBestEffortsRecoveryState(); h.getDoc.mockResolvedValue(snap(record));
      await computeAndStoreBestEfforts("u1", "w1", sparse, true, { facts: sparseFacts, existing: record });
      record = h.setDoc.mock.calls.at(-1)![1].bestEfforts;
    }
    expect(assessBestEffortsCache(record, true, sparseFacts).state).toBe("unavailable_confirmed");
    h.count.mockResolvedValue({ data: () => ({ count: sparse.length }) });
    expect(await checkBestEffortsRouteGrowth("u1", "w1", record)).toBe(false);
  });

  it("the growth check is one aggregate count, memoized per record, failure-safe and user-scoped", async () => {
    const record = stored(route(1000));
    h.count.mockResolvedValue({ data: () => ({ count: 5411 }) });
    expect(await checkBestEffortsRouteGrowth("u1", "w1", record)).toBe(true);
    expect(await checkBestEffortsRouteGrowth("u1", "w1", record)).toBe(true);
    expect(h.count).toHaveBeenCalledTimes(1);
    expect(await checkBestEffortsRouteGrowth("u2", "w1", record)).toBe(true); expect(h.count).toHaveBeenCalledTimes(2);
    resetBestEffortsRecoveryState(); h.count.mockRejectedValue(new Error("offline"));
    expect(await checkBestEffortsRouteGrowth("u1", "w1", record)).toBe(false);
    expect(await checkBestEffortsRouteGrowth("u1", "w1", undefined)).toBe(false);
    expect(await checkBestEffortsRouteGrowth("u1", "w1", record, { isCurrent: () => false })).toBe(false);
  });
});

// ── Concurrent sessions: read-decide-write is atomic ──────────────────────────────────────────────────────────────
describe("two sessions recovering the same workout", () => {
  /** In-memory document with optimistic concurrency, like Firestore transactions: a commit fails and the callback re-runs if the doc changed. */
  function contendedStore(initial: BestEffortsMap) {
    let value: BestEffortsMap | undefined = initial, version = 0, retries = 0, writes = 0;
    const tx = (hook?: () => void) => async (_db: unknown, fn: (t: unknown) => Promise<unknown>) => {
      for (;;) {
        const readVersion = version; const pending: unknown[] = [];
        const result = await fn({ get: async () => { const v = value; hook?.(); return snap(v); }, set: (_r: unknown, data: { bestEfforts: BestEffortsMap }) => { pending.push(data.bestEfforts); } });
        if (version !== readVersion) { retries++; continue; }                         // someone else committed first → retry on fresh data
        if (pending.length) { value = pending[0] as BestEffortsMap; version++; writes++; }
        return result;
      }
    };
    return { tx, current: () => value, stats: () => ({ retries, writes }), commitOther: (v: BestEffortsMap) => { value = v; version++; writes++; } };
  }

  it("a stale partial recovery cannot overwrite a newer, more complete record committed by another device between its read and write", async () => {
    const complete = stored(FULL);
    const store = contendedStore(stored(TRUNCATED));
    let injected = false;
    // device B (stale cached partial route of 900 points) reads the OLD record; device A then commits the complete one
    h.runTransaction.mockImplementation(store.tx(() => { if (!injected) { injected = true; store.commitOther(complete); } }));
    const result = await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 900), true, { facts: FACTS, existing: stored(TRUNCATED) });
    expect(store.stats().retries).toBe(1);                                          // B detected the conflict and re-ran against A's record
    expect(store.current()).toMatchObject({ computedFromPointCount: FULL.length });  // A's record survives
    expect(result).toMatchObject({ computedFromPointCount: FULL.length });
  });

  it("the better result wins in either order, and two identical recoveries write once", async () => {
    const store = contendedStore(stored(TRUNCATED));
    h.runTransaction.mockImplementation(store.tx());
    await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 1500), true, { facts: FACTS });
    resetBestEffortsRecoveryState();
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });
    expect(store.current()).toMatchObject({ computedFromPointCount: FULL.length });
    resetBestEffortsRecoveryState();
    await computeAndStoreBestEfforts("u1", "w1", FULL.slice(0, 1500), true, { facts: FACTS });     // an older, smaller result arriving late
    expect(store.current()).toMatchObject({ computedFromPointCount: FULL.length });
    const writesBefore = store.stats().writes;
    resetBestEffortsRecoveryState();
    await computeAndStoreBestEfforts("u1", "w1", FULL, true, { facts: FACTS });                    // identical to what is stored
    expect(store.stats().writes).toBe(writesBefore);
  });
});
