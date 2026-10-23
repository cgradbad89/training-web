import { describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_CAPS, loadAcceptanceSources, parseAcceptanceOverride, parseAcceptancePlan, parseAcceptanceRace,
  parseAcceptanceWorkout, type AcceptanceCollection, type AcceptanceReader, type ParentRead, type ParentRecord } from "./loader";
import { buildRaceTrainingContext } from "../../src/utils/raceTrainingContext";
import { evaluateRacePerformance } from "../../src/utils/racePerformance";

const uid = "owner-uid";
const dates = { startDate: "2026-10-18T13:00:00Z", endDate: "2026-10-18T14:00:00Z", syncedAt: "2026-10-18T14:05:00Z" };
function workout(id = "w1", fields: Record<string, unknown> = {}): ParentRecord {
  return { id, data: { ...dates, workoutId: id, displayType: "Run", isRunLike: true, durationSeconds: 3600, distanceMiles: 6, ...fields } };
}
function race(fields: Record<string, unknown> = {}): ParentRecord {
  return { id: "r1", data: { name: "September Half", raceDate: "2026-09-20", raceDistance: "halfMarathon", result: "2:11:11", isActive: false, ...fields } };
}
function read(records: ParentRecord[], cap: number, capped = false): ParentRead {
  return { records, cap, capped, fromServer: true, readStartedAt: "2026-10-23T10:00:00Z", readCompletedAt: "2026-10-23T10:00:01Z" };
}
function reader(data: Partial<Record<AcceptanceCollection, ParentRecord[]>> = {}): AcceptanceReader {
  return {
    collection: vi.fn(async (name: AcceptanceCollection, cap: number) => read(data[name] ?? [], cap)),
    plan: vi.fn(async () => read([], 1)),
    workout: vi.fn(async () => read([], 1)),
  };
}
const planData = { name: "Target plan", status: "active", isActive: false, startDate: "2026-09-14", weeks: [] };

describe("isolated acceptance source conversion", () => {
  it("normalizes canonical dates, legacy plan status, and the authoritative document IDs", () => {
    const result = parseAcceptanceWorkout(workout());
    expect(result.startDate.toISOString()).toBe("2026-10-18T13:00:00.000Z");
    expect(result.durationSeconds).toBe(3600);
    expect(result.hasRoute).toBe(false);
    expect(parseAcceptanceRace(race()).createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(parseAcceptancePlan({ id: "p1", data: planData })).toMatchObject({ id: "p1", status: "active", isActive: true, planType: "running" });
    expect(parseAcceptancePlan({ id: "legacy", data: { ...planData, status: undefined, isActive: true } })).toMatchObject({ status: "active" });
    expect(parseAcceptancePlan({ id: "strength", data: { planType: "workout" } })).toBeNull();
  });
  it("does not turn missing running distance, invalid timestamps, or conflicting IDs into plausible zeros", () => {
    expect(() => parseAcceptanceWorkout(workout("w1", { distanceMiles: undefined }))).toThrow("unavailable values cannot become zero");
    expect(() => parseAcceptanceWorkout(workout("w1", { startDate: "invalid" }))).toThrow("startDate");
    expect(() => parseAcceptanceWorkout(workout("w1", { syncedAt: undefined }))).toThrow("syncedAt");
    expect(() => parseAcceptanceWorkout(workout("w1", { workoutId: "wrong" }))).toThrow("conflicts");
    expect(() => parseAcceptanceRace(race({ raceDate: undefined }))).toThrow("raceDate");
  });
  it("preserves override exclusions/corrections but rejects cross-owner and malformed records", () => {
    const data = { userId: uid, workoutId: "w1", isExcluded: true, distanceMilesOverride: 5, durationSecondsOverride: null, updatedAt: "2026-10-18T16:00:00Z" };
    expect(parseAcceptanceOverride({ id: "w1", data }, uid)).toMatchObject(data);
    expect(() => parseAcceptanceOverride({ id: "w1", data: { ...data, userId: "other" } }, uid)).toThrow("conflicts");
    expect(() => parseAcceptanceOverride({ id: "w1", data: { ...data, durationSecondsOverride: "ten" } }, uid)).toThrow("Invalid");
    expect(() => parseAcceptanceOverride({ id: "w1", data: { ...data, updatedAt: null } }, uid)).toThrow("missing/invalid");
  });
  it("rejects malformed running-plan structures rather than letting matching crash", () => {
    expect(() => parseAcceptancePlan({ id: "p", data: { ...planData, weeks: [{ entries: [null] }] } })).toThrow("Malformed");
    expect(() => parseAcceptancePlan({ id: "p", data: { ...planData, weeks: [{ entries: [{ id: "e", weekday: 1, distanceMiles: 3 }] }] } })).toThrow("Malformed");
  });
});

describe("bounded server source loading", () => {
  it("reads only the four allowed owner parent scopes and reports server provenance and date coverage", async () => {
    const source = reader({ healthWorkouts: [workout()], halfMarathonRaces: [race()] });
    const result = await loadAcceptanceSources(source, uid);
    expect(source.collection).toHaveBeenCalledTimes(4);
    for (const name of ["healthWorkouts", "halfMarathonRaces", "workoutOverrides", "activePlans"] as const) {
      expect(source.collection).toHaveBeenCalledWith(name, ACCEPTANCE_CAPS[name]);
    }
    expect(source.plan).not.toHaveBeenCalled();
    expect(source.workout).not.toHaveBeenCalled();
    expect(result.sourcesReady).toBe(true);
    expect(result.diagnostics.every(item => item.fromServer && item.status === "complete")).toBe(true);
    expect(result.diagnostics.find(item => item.source === "healthWorkouts")?.coverage).toMatchObject({ oldestStartDate: "2026-10-18T13:00:00.000Z", newestStartDate: "2026-10-18T13:00:00.000Z" });
  });
  it("withholds panel acceptance on read caps, unavailable sources, and malformed parent documents", async () => {
    const source = reader();
    source.collection = vi.fn(async (name, cap) => {
      if (name === "healthWorkouts") return read([workout()], cap, true);
      if (name === "halfMarathonRaces") throw new Error("permission-denied");
      if (name === "workoutOverrides") return read([{ id: "w1", data: {} }], cap);
      return read([], cap);
    });
    const result = await loadAcceptanceSources(source, uid);
    expect(result.sourcesReady).toBe(false);
    expect(result.diagnostics.find(item => item.source === "healthWorkouts")?.status).toBe("truncated");
    expect(result.diagnostics.find(item => item.source === "halfMarathonRaces")).toMatchObject({ status: "error", fromServer: false, messages: ["permission-denied"] });
    expect(result.diagnostics.find(item => item.source === "workoutOverrides")?.status).toBe("invalid");
  });
  it("rejects false server provenance and invalid source bounds", async () => {
    const source = reader();
    source.collection = vi.fn(async (_name, cap) => ({ ...read([], cap + 1), fromServer: false } as unknown as ParentRead));
    expect((await loadAcceptanceSources(source, uid)).sourcesReady).toBe(false);
    await expect(loadAcceptanceSources(source, "other/owner")).rejects.toThrow("UID");
  });
  it("fetches only missing linked parent workouts and linked plans once, retaining exact race timing", async () => {
    const source = reader({ healthWorkouts: [workout()], halfMarathonRaces: [race({ actualRunId: "old-race", linkedPlanId: "linked" })] });
    source.workout = vi.fn(async id => read([workout(id, { ...dates, startDate: "2026-09-20T12:00:00Z", endDate: "2026-09-20T14:11:11Z", durationSeconds: 7871, distanceMiles: 13.2 })], 1));
    source.plan = vi.fn(async id => read([{ id, data: planData }], 1));
    const result = await loadAcceptanceSources(source, uid);
    expect(source.workout).toHaveBeenCalledExactlyOnceWith("old-race");
    expect(source.plan).toHaveBeenCalledExactlyOnceWith("linked");
    expect(result.workouts).toHaveLength(2);
    expect(result.plans[0].id).toBe("linked");
    expect(result.races[0].result).toBe("2:11:11");
    expect(result.sourcesReady).toBe(true);
  });
  it("distinguishes confirmed-absent linked parents from an unsuccessful source read", async () => {
    const source = reader({ halfMarathonRaces: [race({ actualRunId: "absent", linkedPlanId: "missing" })] });
    const result = await loadAcceptanceSources(source, uid);
    expect(result.diagnostics.find(item => item.source === "linkedWorkout:absent")).toMatchObject({ status: "complete", count: 0, fromServer: true });
    expect(result.diagnostics.find(item => item.source === "linkedPlan:missing")?.messages.join(" ")).toContain("confirmed absent");
    expect(result.sourcesReady).toBe(true);
  });
  it("rejects malicious linked IDs before calling the reader and limits linked plan fanout", async () => {
    const source = reader({ halfMarathonRaces: [race({ actualRunId: "w/route", linkedPlanId: "p/private" })] });
    const result = await loadAcceptanceSources(source, uid);
    expect(source.workout).not.toHaveBeenCalled();
    expect(source.plan).not.toHaveBeenCalled();
    expect(result.sourcesReady).toBe(false);
    const many = reader({ halfMarathonRaces: Array.from({ length: 21 }, (_, i) => ({ ...race({ linkedPlanId: `p${i}` }), id: `r${i}` })) });
    const tooMany = await loadAcceptanceSources(many, uid);
    expect(many.plan).not.toHaveBeenCalled();
    expect(tooMany.diagnostics.find(item => item.source === "linkedPlans")?.status).toBe("truncated");
  });
  it("passes untouched parent summaries and corrections to actual Phase 3A calculations", async () => {
    const source = reader({ healthWorkouts: [workout()], halfMarathonRaces: [race()], workoutOverrides: [{ id: "w1", data: {
      workoutId: "w1", userId: uid, isExcluded: false, distanceMilesOverride: 5, durationSecondsOverride: null, updatedAt: "2026-10-18T15:00:00Z",
    } }] });
    const result = await loadAcceptanceSources(source, uid);
    const asOf = new Date("2026-10-23T12:00:00Z");
    const training = buildRaceTrainingContext({ ...result, asOf, timeZone: "America/New_York" });
    expect(training.recentFourWeeks.miles).toBe(5);
    expect(result.workouts[0].distanceMiles).toBe(6);
    const evidence = evaluateRacePerformance({ ...result, asOf: asOf.toISOString(), timeZone: "America/New_York" });
    expect(evidence.currentCapability.estimatedSeconds).toBeNull();
    expect(evidence.raceDayForecast.estimatedSeconds).toBeNull();
    expect(evidence.evidence[0].status).not.toBe("verified");
  });
});
