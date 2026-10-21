import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";

const h = vi.hoisted(() => ({ getDoc: vi.fn(), setDoc: vi.fn(), route: vi.fn(), hr: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: (...parts: unknown[]) => ({ id: parts.at(-1) }),
  getDoc: h.getDoc,
  setDoc: h.setDoc,
  collection: vi.fn(), getDocs: vi.fn(), onSnapshot: vi.fn(), query: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), startAfter: vi.fn(), writeBatch: vi.fn(),
}));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.route }));
vi.mock("@/services/hrStream", () => ({ fetchHRStream: h.hr }));
import { computeAndStoreTrainingLoad, enrichTrainingLoads } from "@/services/healthWorkouts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const metadata = (extra = {}) => ({ exists: () => true, data: () => ({ durationSeconds: 1800, avgHeartRate: 145, activityType: "running", ...extra }) });
const workouts = [{ workoutId: "synthetic-one", hasRoute: true }, { workoutId: "synthetic-two", hasRoute: true }] as HealthWorkout[];

beforeEach(() => {
  vi.resetAllMocks();
  h.getDoc.mockResolvedValue(metadata({ hasRoute: true }));
  h.setDoc.mockResolvedValue(undefined);
  h.route.mockResolvedValue([]);
  h.hr.mockResolvedValue([]);
});

describe("training-load consumer lifetime", () => {
  it("does not read metadata when already retired", async () => {
    await computeAndStoreTrainingLoad("synthetic-owner", "synthetic-one", null, { isCurrent: () => false });
    expect(h.getDoc).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it("does not acquire raw routes or the next workout after metadata retires", async () => {
    let current = true;
    const pending = deferred<ReturnType<typeof metadata>>();
    h.getDoc.mockReturnValueOnce(pending.promise);
    const task = enrichTrainingLoads("synthetic-owner", workouts, null, { isCurrent: () => current });
    current = false;
    pending.resolve(metadata({ hasRoute: true }));
    await task;
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.route).not.toHaveBeenCalled();
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it.each(["route", "HR stream"])("does not write or start the next workout after %s acquisition retires", async (source) => {
    let current = true;
    const pending = deferred<never[]>();
    h.getDoc.mockResolvedValue(metadata(source === "route" ? { hasRoute: true } : { hasHRStream: true }));
    (source === "route" ? h.route : h.hr).mockReturnValueOnce(pending.promise);
    const task = enrichTrainingLoads("synthetic-owner", workouts, null, { isCurrent: () => current });
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    pending.resolve([]);
    await task;
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.setDoc).not.toHaveBeenCalled();
    if (source === "route") expect(h.route.mock.calls[0][2].isCurrent()).toBe(false);
  });

  it("keeps an acknowledged first success while retirement prevents the next workout", async () => {
    let current = true;
    h.setDoc.mockImplementationOnce(async () => { current = false; });
    const result = await enrichTrainingLoads("synthetic-owner", workouts, null, { isCurrent: () => current });
    expect(h.getDoc).toHaveBeenCalledTimes(1);
    expect(h.setDoc).toHaveBeenCalledTimes(1);
    expect(result.map((entry) => entry.workoutId)).toEqual(["synthetic-one"]);
  });
});
