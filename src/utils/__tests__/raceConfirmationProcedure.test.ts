/**
 * Dry-run validation of the owner confirmation procedure (docs/race-confirmation-procedure-2026.md) for the two 2026 half marathons.
 * It drives the REAL builders (`buildRaceConfirmationInput`, `buildRaceConfirmationRevision`) on synthetic workouts shaped like the two races
 * and then evaluates the shipped estimator. It never touches Firestore and contains no owner records or identifiers.
 */
import { describe, expect, it } from "vitest";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RaceConfirmationDraft } from "@/types/raceConfirmation";
import { buildRaceConfirmationInput, buildRaceConfirmationRevision } from "@/utils/raceConfirmation";
import { cadenceRuns } from "@/utils/__tests__/fixtures/policyStudyFixture";
import { confirmedRaceFixture } from "@/utils/__tests__/fixtures/raceConfirmationFixture";
import { estimateHybridHalfMarathonV11 } from "@/utils/performance/hybridPerformanceV11";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";

const TZ = "America/New_York";
const REQUEST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** An UNCONFIRMED race record exactly as it exists before the owner confirms it (no confirmation history). */
function unconfirmed(id: string, date: string, moving: number, elapsed?: number) {
  const f = confirmedRaceFixture({ id, date, seconds: moving, elapsed });
  const race: Race = { ...f.race }; delete race.confirmationHistory;
  const workout: HealthWorkout = { ...f.workout, avgHeartRate: 168, hasRoute: true };
  return { race, workout };
}
const draft = (o: Partial<RaceConfirmationDraft> & Pick<RaceConfirmationDraft, "raceDate" | "finishSeconds">): RaceConfirmationDraft => ({
  officialEventName: "Synthetic official event", distanceMeters: 21_097.5, timeBasis: "chip", status: "owner_confirmed", effort: "hard",
  conditions: "Owner description: effort felt moderately hard, not a maximal attempt (subjective, not a measurement). Mild, flat.",
  source: "Owner attestation of the official finish time", ...o });
function confirm(race: Race, workout: HealthWorkout, d: RaceConfirmationDraft, availableAt: string): Race {
  const input = buildRaceConfirmationInput({ race, workout, override: null, timeZone: TZ, draft: d, requestId: REQUEST });
  const revision = buildRaceConfirmationRevision(input, null, availableAt);
  return { ...race, confirmationHistory: { schemaVersion: 1, chronology: "client_document_untrusted", currentRevisionId: revision.revisionId, revisions: { [revision.revisionId]: revision } } };
}
const world = (races: { race: Race; workout: HealthWorkout }[], asOfDate: string) => ({ races: races.map(r => r.race), overrides: {}, timeZone: TZ, asOf: `${asOfDate}T17:00:00.000Z`,
  workouts: [...cadenceRuns({ start: "2025-08-04", end: "2026-11-07", gaps: [2, 2, 3], miles: [5, 6, 5, 8] }), ...races.map(r => r.workout)] });

describe("September-shaped race: moving time = elapsed time", () => {
  const sep = unconfirmed("sep", "2026-09-20", 7871);
  it("a hard-effort confirmation passes the app's own validation and becomes labelled demonstrated performance", () => {
    const race = confirm(sep.race, sep.workout, draft({ raceDate: "2026-09-20", finishSeconds: 7871 }), "2026-11-09T15:00:00.000Z");
    const e = estimateHybridHalfMarathonV11(world([{ race, workout: sep.workout }], "2026-11-10"));
    expect(e.demonstrated.basis).toBe("demonstrated_performance_only");
    expect(e).toMatchObject({ status: "provisional", confidence: "low" });
    expect(e.seconds!).toBeGreaterThanOrEqual(7871 - 1); expect(e.seconds!).toBeLessThan(7871 * 1.01);
    expect(estimateRaceDayForecast(world([{ race, workout: sep.workout }], "2026-11-10"), { raceDate: "2026-12-20", plan: null, hybrid: e }).withheldCause).toBe("demonstrated_performance_only");
  });
  it("`hard` and `nonmaximal` give identical estimates; `unknown` is accepted by the form but contributes nothing", () => {
    const at = (effort: RaceConfirmationDraft["effort"]) => estimateHybridHalfMarathonV11(world([{ race: confirm(sep.race, sep.workout, draft({ raceDate: "2026-09-20", finishSeconds: 7871, effort }), "2026-11-09T15:00:00.000Z"), workout: sep.workout }], "2026-11-10"));
    expect(at("hard")).toEqual(at("nonmaximal"));
    expect(at("unknown").status).toBe("unavailable");
  });
  it("the procedure's guard rails: a wrong finish time, an owner-confirmation with only a URL, and a duplicate are all refused", () => {
    expect(() => buildRaceConfirmationInput({ race: sep.race, workout: sep.workout, override: null, timeZone: TZ, requestId: REQUEST,
      draft: draft({ raceDate: "2026-09-20", finishSeconds: 7871 + 600 }) })).toThrow(/timing/i);
    expect(() => buildRaceConfirmationInput({ race: sep.race, workout: sep.workout, override: null, timeZone: TZ, requestId: REQUEST,
      draft: draft({ raceDate: "2026-09-20", finishSeconds: 7871, source: "https://results.example.test/x" }) })).toThrow(/attestation text/i);
    const once = confirm(sep.race, sep.workout, draft({ raceDate: "2026-09-20", finishSeconds: 7871 }), "2026-11-09T15:00:00.000Z");
    expect(() => buildRaceConfirmationRevision(buildRaceConfirmationInput({ race: once, workout: sep.workout, override: null, timeZone: TZ, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      draft: draft({ raceDate: "2026-09-20", finishSeconds: 7871, correctionReason: "dup" }) }), once.confirmationHistory!, "2026-11-09T16:00:00.000Z")).toThrow(/already confirmed/);
  });
});

describe("April-shaped race: moving 8,130 s but a recording that began ~10:29 before the start (elapsed 8,759 s)", () => {
  const apr = unconfirmed("apr", "2026-04-26", 8130, 8759);
  const timing = "The recording began about 10 minutes 29 seconds before the timed start (route paused, standing heart rate); the watch moving time is the official time.";
  it("is refused without the timing explanation (the shorter time is never assumed official) and accepted with it", () => {
    expect(() => confirm(apr.race, apr.workout, draft({ raceDate: "2026-04-26", finishSeconds: 8130 }), "2026-11-09T15:00:00.000Z")).toThrow(/timing explanation/i);
    expect(() => confirm(apr.race, apr.workout, draft({ raceDate: "2026-04-26", finishSeconds: 8130, timingReconciliation: timing }), "2026-11-09T15:00:00.000Z")).not.toThrow();
  });
  it("entered in November it is a labelled historical record only: 196 days old, so it carries no weight in the current estimate", () => {
    const race = confirm(apr.race, apr.workout, draft({ raceDate: "2026-04-26", finishSeconds: 8130, timingReconciliation: timing }), "2026-11-09T15:00:00.000Z");
    const e = estimateHybridHalfMarathonV11(world([{ race, workout: apr.workout }], "2026-11-10"));
    expect(e.status).toBe("unavailable");
    expect(e.demonstrated).toMatchObject({ eligibleRaces: 1, usedRaces: 0 });
  });
  it("both races together: September carries the number, April is expired history", () => {
    const sep = unconfirmed("sep", "2026-09-20", 7871);
    const a = confirm(apr.race, apr.workout, draft({ raceDate: "2026-04-26", finishSeconds: 8130, timingReconciliation: timing }), "2026-11-09T15:00:00.000Z");
    const s = confirm(sep.race, sep.workout, draft({ raceDate: "2026-09-20", finishSeconds: 7871 }), "2026-11-09T15:05:00.000Z");
    const e = estimateHybridHalfMarathonV11(world([{ race: a, workout: apr.workout }, { race: s, workout: sep.workout }], "2026-11-10"));
    expect(e.demonstrated).toMatchObject({ basis: "demonstrated_performance_only", eligibleRaces: 2, usedRaces: 1 });
  });
});
