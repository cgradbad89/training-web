import { describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_CAPS, loadAcceptanceSources, parseAcceptanceOverride, parseAcceptancePlan, parseAcceptanceRace,
  parseAcceptanceWorkout, classifyNumericField, scopeAcceptanceSources, type AcceptanceCollection, type AcceptanceReader, type ParentRead, type ParentRecord } from "./loader";
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
    const context = parseAcceptanceWorkout(workout("context",{routeClusterId:"supplied-loop",weather:{tempF:61,fetchedAt:"2026-10-18T15:00:00Z"}}));
    expect(context.routeClusterId).toBe("supplied-loop");
    expect(context.weather?.tempF).toBe(61);
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

const diagnosedIds = ["8A6341A4-D510-4E2B-906B-C0692248FE1F", "CA25BADB-53CA-424F-8062-EA0C871E49D9"];
const scopeOptions = { asOfs: [new Date("2026-10-23T16:00:00Z"), new Date("2026-10-23T03:59:59.999Z")], timeZone: "America/New_York" };
function distanceless(id = diagnosedIds[0], fields: Record<string, unknown> = {}): ParentRecord {
  const result = workout(id, { source: "healthkit", sourceName: "Fixture watch", activityType: "running", durationSeconds: 300,
    startDate: "2020-01-01T12:00:00Z", endDate: "2020-01-01T12:05:00Z", syncedAt: "2021-01-01T12:00:00Z", ...fields });
  delete result.data.distanceMiles;
  delete result.data.distanceMeters;
  return result;
}
async function scopeFixture(invalid = diagnosedIds.map(id => distanceless(id)), extra: Partial<Record<AcceptanceCollection, ParentRecord[]>> = {}) {
  return loadAcceptanceSources(reader({ healthWorkouts: [workout(), ...invalid], ...extra }), uid);
}

describe("narrow acceptance scope for the two diagnosed distance-less parents", () => {
  it.each([
    [{}, "absent"], [{ value: null }, "null"], [{ value: "3.1" }, "nonnumeric"], [{ value: undefined }, "nonnumeric"],
    [{ value: NaN }, "nonfinite"], [{ value: Infinity }, "nonfinite"], [{ value: 3.1 }, "finite"],
  ] as const)("distinguishes numeric field presence and validity before JSON serialization: %j", (data, expected) => {
    expect(classifyNumericField(data, "value")).toBe(expected);
  });
  it("retains raw rejected parents and exact absent-field diagnostics without changing the invalid source status", async () => {
    const raw = diagnosedIds.map(id => distanceless(id));
    const result = await scopeFixture(raw);
    expect(result.sourcesReady).toBe(false);
    expect(result.invalidWorkouts.map(item => item.record)).toEqual(raw);
    expect(result.invalidWorkouts[0].record).toBe(raw[0]);
    expect(result.invalidWorkouts[0].numericFields).toEqual({ durationSeconds: "finite", distanceMiles: "absent", distanceMeters: "absent" });
    const scoped = scopeAcceptanceSources(result, scopeOptions);
    expect(scoped.sourcesReady).toBe(true);
    expect(scoped.invalidWorkouts).toBe(result.invalidWorkouts);
    expect(scoped.diagnostics.find(item => item.source === "healthWorkouts")?.status).toBe("invalid");
    expect(scoped.reportingScope).toMatchObject({ accepted: true, fullHistoryComplete: false });
    expect(scoped.reportingScope?.excludedWorkouts.map(item => item.id)).toEqual(diagnosedIds);
    expect(scoped.workouts).toHaveLength(1);
    expect(Object.hasOwn(raw[0].data, "distanceMiles")).toBe(false);
    expect(buildRaceTrainingContext({ ...scoped, asOf: scopeOptions.asOfs[0], timeZone: scopeOptions.timeZone }).recentFourWeeks.miles).toBe(6);
  });
  it("declares both current and saved reporting periods and protects the earliest prior-window boundary", async () => {
    const scoped = scopeAcceptanceSources(await scopeFixture(), scopeOptions);
    expect(scoped.reportingScope?.periods).toMatchObject([
      { localDate: "2026-10-23", chartStart: "2026-08-31", recentStart: "2026-09-26", priorStart: "2026-08-29", priorEnd: "2026-09-25", consistencyEnd: "2026-10-18" },
      { localDate: "2026-10-22", chartStart: "2026-08-31", recentStart: "2026-09-25", priorStart: "2026-08-28", priorEnd: "2026-09-24", consistencyEnd: "2026-10-18" },
    ]);
    const before = await scopeFixture([distanceless(diagnosedIds[0], { startDate: "2026-08-27T12:00:00Z", endDate: "2026-08-27T12:05:00Z" })]);
    expect(scopeAcceptanceSources(before, scopeOptions).sourcesReady).toBe(true);
    const boundary = await scopeFixture([distanceless(diagnosedIds[0], { startDate: "2026-08-28T12:00:00Z", endDate: "2026-08-28T12:05:00Z" })]);
    expect(scopeAcceptanceSources(boundary, scopeOptions).sourcesReady).toBe(false);
  });
  it("recomputes for changed reporting clocks instead of reusing an earlier acceptance grant", async () => {
    const result = scopeAcceptanceSources(await scopeFixture(), scopeOptions);
    expect(result.sourcesReady).toBe(true);
    const earlierClock = { asOfs: [new Date("2020-01-02T12:00:00Z")], timeZone: scopeOptions.timeZone };
    const rescope = scopeAcceptanceSources(result, earlierClock);
    expect(rescope.sourcesReady).toBe(false);
    expect(rescope.reportingScope?.blockers.join(" ")).toContain("unproven");
  });
  it("keeps unknown identities, non-distance parser errors, mismatched workout IDs and invalid dates blocked", async () => {
    expect(scopeAcceptanceSources(await scopeFixture([distanceless("unknown")]), scopeOptions).sourcesReady).toBe(false);
    const result = await scopeFixture();
    result.invalidWorkouts[0].error = "A different schema defect";
    expect(scopeAcceptanceSources(result, scopeOptions).sourcesReady).toBe(false);
    for (const fields of [{ workoutId: "wrong" }, { startDate: "invalid" }, { endDate: null }, { syncedAt: undefined }, { durationSeconds: NaN }]) {
      expect(scopeAcceptanceSources(await scopeFixture([distanceless(diagnosedIds[0], fields)]), scopeOptions).sourcesReady).toBe(false);
    }
  });
  it.each([null, "unknown", NaN])("does not widen the absent-field exception when distance is null, nonnumeric or nonfinite: %j", async distance => {
    const invalid = distanceless();
    invalid.data.distanceMiles = distance;
    expect(scopeAcceptanceSources(await scopeFixture([invalid]), scopeOptions).sourcesReady).toBe(false);
  });
  it("requires separate review when a rejected parent has an alternative meters summary", async () => {
    const invalid = distanceless();
    invalid.data.distanceMeters = 5000;
    expect(scopeAcceptanceSources(await scopeFixture([invalid]), scopeOptions).sourcesReady).toBe(false);
  });
  it("blocks an existing override or a race/plan reference, including legacy links and metadata references", async () => {
    const overridden = await scopeFixture(undefined, { workoutOverrides: [{ id: diagnosedIds[0], data: {
      workoutId: diagnosedIds[0], userId: uid, isExcluded: true, updatedAt: "2021-01-01T12:00:00Z",
    } }] });
    expect(scopeAcceptanceSources(overridden, scopeOptions).sourcesReady).toBe(false);
    const linked = await scopeFixture(undefined, { halfMarathonRaces: [race({ linkedStravaActivityId: diagnosedIds[0] })] });
    expect(scopeAcceptanceSources(linked, scopeOptions).sourcesReady).toBe(false);
    const referenced = await scopeFixture(undefined, { activePlans: [{ id: "p", data: { ...planData, notes: diagnosedIds[1] } }] });
    expect(scopeAcceptanceSources(referenced, scopeOptions).sourcesReady).toBe(false);
  });
  it("checks all selectable plans and protects canonical one-day matching before the earliest due entry", async () => {
    const plan = { ...planData, startDate: "2020-01-02", weeks: [{ weekNumber: 1, entries: [{ id: "e", weekIndex: 0, weekday: 1, distanceMiles: 3 }] }] };
    const oldPlan = await scopeFixture(undefined, { activePlans: [{ id: "p", data: plan }] });
    const blocked = scopeAcceptanceSources(oldPlan, scopeOptions);
    expect(blocked.reportingScope?.earliestPlanMatchingDate).toBe("2020-01-01");
    expect(blocked.sourcesReady).toBe(false);
    expect(blocked.reportingScope?.blockers.join(" ")).toContain("historical matching displacement");
    const safePlan = await scopeFixture(undefined, { activePlans: [{ id: "p", data: { ...plan, startDate: "2020-01-03" } }] });
    expect(scopeAcceptanceSources(safePlan, scopeOptions).sourcesReady).toBe(true);
  });
  it("checks an older completed linked plan even when a newer active plan is safe", async () => {
    const source = reader({ healthWorkouts: [workout(), distanceless()],
      halfMarathonRaces: [race({ linkedPlanId: "completed" })], activePlans: [{ id: "active", data: planData }] });
    source.plan = vi.fn(async id => read([{ id, data: { ...planData, status: "completed", startDate: "2020-01-01",
      weeks: [{ weekNumber: 1, entries: [{ id: "e", weekIndex: 0, weekday: 1, distanceMiles: 3 }] }] } }], 1));
    expect(scopeAcceptanceSources(await loadAcceptanceSources(source, uid), scopeOptions).sourcesReady).toBe(false);
  });
  it("withholds scope when a required source, linked plan, capped read or server provenance is unproven", async () => {
    const result = await scopeFixture();
    for (const source of ["halfMarathonRaces", "workoutOverrides", "activePlans"]) {
      const missing = { ...result, diagnostics: result.diagnostics.filter(item => item.source !== source) };
      expect(scopeAcceptanceSources(missing, scopeOptions).sourcesReady).toBe(false);
    }
    const capped = { ...result, diagnostics: result.diagnostics.map(item => item.source === "healthWorkouts" ? { ...item, readCapped: true } : item) };
    expect(scopeAcceptanceSources(capped, scopeOptions).sourcesReady).toBe(false);
    const cache = { ...result, diagnostics: result.diagnostics.map(item => ({ ...item, fromServer: false })) };
    expect(scopeAcceptanceSources(cache, scopeOptions).sourcesReady).toBe(false);
    const missingPlan = await scopeFixture(undefined, { halfMarathonRaces: [race({ linkedPlanId: "absent" })] });
    expect(scopeAcceptanceSources(missingPlan, scopeOptions).sourcesReady).toBe(false);
  });
  it("cannot change consistency's null-versus-zero guard by silently discarding the only possible running history", async () => {
    const onlyUnknown = await loadAcceptanceSources(reader({ healthWorkouts: [distanceless()] }), uid);
    expect(scopeAcceptanceSources(onlyUnknown, scopeOptions).sourcesReady).toBe(false);
    expect(scopeAcceptanceSources(await scopeFixture(), { ...scopeOptions, asOfs: [] }).sourcesReady).toBe(false);
    expect(scopeAcceptanceSources(await scopeFixture(), { ...scopeOptions, timeZone: "invalid" }).sourcesReady).toBe(false);
  });
});
