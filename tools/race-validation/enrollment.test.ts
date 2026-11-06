// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dueCheckpoints } from "./checkpoint";
import { HORIZONS, checkpointKey } from "./evidence";
import { checkpointDates, enrollmentReference, isHalfMarathon, raceIneligibility, resolveEnrollments, type RaceMeta } from "./enrollment";
import { captureObjectName, pilotTarget } from "./scheduled-capture";

const pinned = pilotTarget("synthetic", "march-race");
const half = (id: string, raceDate: string | null, extra: Partial<RaceMeta> = {}): RaceMeta =>
  ({ id, raceDate, raceDistance: "halfMarathon", isActive: true, ...extra });
const plan = (discovered: RaceMeta[] | null, now: string, extra: Partial<Parameters<typeof resolveEnrollments>[0]> = {}) =>
  resolveEnrollments({ pinned, subject: "synthetic", timeZone: "America/New_York", now, autoEnabled: true, discovered, ...extra });

describe("race eligibility", () => {
  it("accepts only an active, valid, future half marathon with a stable identity", () => {
    const today = "2027-04-10";
    expect(raceIneligibility(half("a", "2027-09-04"), today)).toBeNull();
    expect(raceIneligibility(half("a", "2027-09-04", { isActive: false }), today)).toBe("not_active");
    expect(raceIneligibility(half("a", "2027-09-04", { isActive: undefined }), today)).toBe("not_active");
    expect(raceIneligibility(half("a", "2027-09-04", { raceDistance: "10K" }), today)).toBe("not_half_marathon");
    expect(raceIneligibility(half("a", "2027-09-04", { raceDistance: "marathon" }), today)).toBe("not_half_marathon");
    expect(raceIneligibility(half("a", null), today)).toBe("invalid_date");
    expect(raceIneligibility(half("a", "2027-02-30"), today)).toBe("invalid_date");
    expect(raceIneligibility(half("a", "09/04/2027"), today)).toBe("invalid_date");
    expect(raceIneligibility(half("", "2027-09-04"), today)).toBe("invalid_identity");
    expect(raceIneligibility(half("a/b", "2027-09-04"), today)).toBe("invalid_identity");
    // The 1-day checkpoint is the last: it is still eligible on that day and not after.
    expect(raceIneligibility(half("a", "2027-04-11"), "2027-04-10")).toBeNull();
    expect(raceIneligibility(half("a", "2027-04-11"), "2027-04-11")).toBe("past_final_checkpoint");
    expect(raceIneligibility(half("a", "2027-03-20"), "2027-04-10")).toBe("past_final_checkpoint");
  });

  it("recognizes half-marathon distances without widening to other events", () => {
    expect(isHalfMarathon({ raceDistance: "halfMarathon" })).toBe(true);
    expect(isHalfMarathon({ raceDistance: "custom", customDistanceMiles: 13.1 })).toBe(true);
    expect(isHalfMarathon({ raceDistance: "custom", customDistanceMiles: 13.4 })).toBe(false);
    expect(isHalfMarathon({ raceDistance: "custom", customDistanceMiles: Number.NaN })).toBe(false);
    expect(isHalfMarathon({ raceDistance: "custom" })).toBe(false);
    expect(isHalfMarathon({ raceDistance: "5K" })).toBe(false);
  });

  it("judges the final checkpoint by the owner-local day across the DST boundary", () => {
    // New York is UTC-4 in September: 03:30Z is still September 2 locally, 04:30Z is September 3.
    const race = [half("a", "2027-09-03")];
    expect(plan(race, "2027-09-03T03:30:00.000Z").targets.map(t => t.raceId)).toEqual(["march-race", "a"]);
    expect(plan(race, "2027-09-03T04:30:00.000Z").targets.map(t => t.raceId)).toEqual(["march-race"]);
  });
});

describe("enrollment resolution", () => {
  it("keeps only the pinned race, with zero discovery inputs used, when automatic enrollment is off", () => {
    const result = plan([half("sept", "2027-09-04")], "2027-04-10T17:00:00.000Z", { autoEnabled: false });
    expect(result.targets).toEqual([pinned]);
    expect(result.notes).toEqual(["auto_disabled"]);
  });

  it("recognizes the saved active September 2027 half marathon and derives its four dates from the stored date", () => {
    const result = plan([half("sept", "2027-09-04")], "2027-04-10T17:00:00.000Z");
    expect(result.targets.map(t => t.raceId)).toEqual(["march-race", "sept"]);
    expect(result.notes).toEqual([]);
    const septTarget = result.targets[1];
    expect(septTarget).toMatchObject({ subject: "synthetic", raceDate: "2027-09-04", timeZone: "America/New_York" });
    expect(checkpointDates(septTarget, HORIZONS).map(d => d.checkpointDate)).toEqual(["2027-08-07", "2027-08-21", "2027-08-28", "2027-09-03"]);
  });

  it("never lets any discovery outcome remove the pinned March race", () => {
    for (const discovered of [null, [], [half("x", "2027-09-04"), half("y", "2027-10-02")], [half("march-race", "2027-03-21")], [half("a", null)]]) {
      for (const now of ["2027-01-05T17:00:00.000Z", "2027-03-19T17:00:00.000Z", "2027-05-01T17:00:00.000Z"]) {
        expect(plan(discovered, now).targets[0]).toEqual(pinned);
      }
    }
    expect(plan(null, "2027-02-20T17:00:00.000Z")).toMatchObject({ targets: [pinned], notes: ["discovery_failed"] });
    expect(plan([], "2027-02-20T17:00:00.000Z", { overflow: true, discovered: [] }).notes).toEqual(["discovery_overflow"]);
  });

  it("does not enroll inactive, unsupported, malformed or finished races, or invent an enrollment", () => {
    const result = plan([
      half("old", "2027-03-20", { isActive: false }), half("ten", "2027-09-04", { raceDistance: "10K" }),
      half("bad", null), half("done", "2027-01-30"),
    ], "2027-04-10T17:00:00.000Z");
    expect(result.targets).toEqual([pinned]);
    expect(result.notes).toEqual(["none_eligible"]);
    expect(result.counts.ineligible).toEqual({ not_active: 1, not_half_marathon: 1, invalid_date: 1, past_final_checkpoint: 1 });
  });

  it("treats two eligible active races as a conflict and enrolls neither", () => {
    const result = plan([half("sept", "2027-09-04"), half("oct", "2027-10-09")], "2027-04-10T17:00:00.000Z");
    expect(result.targets).toEqual([pinned]);
    expect(result.notes).toEqual(["conflict"]);
    expect(result.counts.eligible).toBe(2);
  });

  it("does not double-enroll the pinned race id, even when its stored date was edited", () => {
    expect(plan([half("march-race", "2027-03-20")], "2027-02-20T17:00:00.000Z").targets).toEqual([pinned]);
    expect(plan([half("march-race", "2027-03-27")], "2027-02-20T17:00:00.000Z").targets).toEqual([pinned]);
  });

  it("allows the pinned race and one new active race to overlap without conflict", () => {
    const result = plan([half("march-race", "2027-03-20"), half("sept", "2027-09-04")], "2027-03-01T17:00:00.000Z");
    expect(result.targets.map(t => t.raceId)).toEqual(["march-race", "sept"]);
    expect(result.notes).toEqual([]);
  });

  it("exposes only an opaque reference", () => {
    const ref = enrollmentReference(pinned);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).not.toContain("march-race");
  });
});

describe("scheduling and custody", () => {
  const sept = plan([half("sept", "2027-09-04")], "2027-04-10T17:00:00.000Z").targets[1];

  it("preserves the March identity and object names exactly as before enrollment generalization", () => {
    const resolved = plan([half("sept", "2027-09-04")], "2027-04-10T17:00:00.000Z").targets[0];
    for (const horizon of HORIZONS) {
      expect(captureObjectName(checkpointKey(resolved, horizon))).toBe(captureObjectName(checkpointKey(pilotTarget("synthetic", "march-race"), horizon)));
    }
    // Pinned to literals so a refactor cannot silently move March's evidence (computed independently of the code under test).
    expect(HORIZONS.map(horizon => captureObjectName(checkpointKey(resolved, horizon)))).toEqual(["half-marathon/v1/838fb1b56ff69d2cc9ab7e34f28f7835576f19ac6fada08daee7e42ce927b730.json", "half-marathon/v1/5efe86b6e3f905611a7c47cd6f71a1b9b8a2c05c9bc663ef989e522afdccfd4c.json", "half-marathon/v1/535d7b467f5daf041270254b0dc7c974fa9bcaf9e9244121b2be66199a8b3f4b.json", "half-marathon/v1/dc504e03e3583b15be4d41ea03db4545c6ed83de6e6abc8c910725d5d62ac2a4.json"]);
    expect(dueCheckpoints([resolved], "2027-02-20T17:00:00.000Z")).toHaveLength(1);
  });

  it("gives every race, horizon and date a distinct object name so evidence never collides", () => {
    const names = new Set<string>();
    for (const target of [pinned, sept, { ...sept, raceDate: "2027-09-11" }]) {
      for (const horizon of HORIZONS) names.add(captureObjectName(checkpointKey(target, horizon)));
    }
    expect(names.size).toBe(12);
  });

  it("never backdates: a race first seen late has no earlier checkpoints due", () => {
    // Sept 4 race first tracked on Aug 25: the Aug 7 and Aug 21 slots are gone and are never produced.
    expect(dueCheckpoints([sept], "2027-08-25T17:00:00.000Z")).toEqual([]);
    expect(dueCheckpoints([sept], "2027-08-28T17:00:00.000Z").map(d => d.horizon)).toEqual([7]);
    expect(dueCheckpoints([sept], "2027-09-03T17:00:00.000Z").map(d => d.horizon)).toEqual([1]);
  });

  it("keeps simultaneous checkpoints of different races distinct", () => {
    // A race on 2027-03-27 has its 14-day checkpoint on the same day as March's 7-day checkpoint.
    const overlapping = { ...sept, raceId: "overlap", raceDate: "2027-03-27" };
    const due = dueCheckpoints([pinned, overlapping], "2027-03-13T17:00:00.000Z");
    expect(due.map(d => `${d.target.raceId}:${d.horizon}`).sort()).toEqual(["march-race:7", "overlap:14"]);
    expect(new Set(due.map(d => captureObjectName(d.key))).size).toBe(2);
  });

  it("makes a corrected race date a new target and leaves the old evidence keys untouched", () => {
    const moved = { ...sept, raceDate: "2027-09-11" };
    for (const horizon of HORIZONS) expect(checkpointKey(moved, horizon)).not.toBe(checkpointKey(sept, horizon));
    expect(checkpointKey(sept, 28)).toBe(JSON.stringify([JSON.stringify(["synthetic", "sept", "2027-09-04", "America/New_York"]), 28]));
  });
});
