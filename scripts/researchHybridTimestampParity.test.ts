// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Timestamp as AdminTimestamp } from "firebase-admin/firestore";
import { Timestamp as BrowserTimestamp } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import { loadFromCache, stamp, workoutFrom } from "./researchHybrid";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { evaluateRacePerformance } from "@/utils/racePerformance";
import { treatConfirmedRacesAsMaximal } from "@/utils/performance/confirmedRaceAssumption";
import { selectRaceConfirmationEvidence } from "@/utils/raceConfirmationEvidence";
import { confirmedRaceFixture } from "@/utils/__tests__/fixtures/raceConfirmationFixture";

const seconds = Date.parse("2026-09-20T12:00:00Z") / 1000;
const nanosCases = [0, 1, 499_999, 500_000, 999_999, 1_000_000, 1_000_001, 999_499_999, 999_500_000, 999_999_999];

describe("research Admin/browser timestamp parity (offline)", () => {
  it.each(nanosCases)("matches browser Date conversion at %i nanoseconds, including manual updatedAt", nanos => {
    const raw = { startDate: new AdminTimestamp(seconds, nanos), endDate: new AdminTimestamp(seconds + 7871, nanos),
      syncedAt: new AdminTimestamp(seconds + 8000, nanos), updatedAt: new AdminTimestamp(seconds + 9000, nanos) };
    const browser = Object.fromEntries(Object.entries(raw).map(([key, t]) => [key, new BrowserTimestamp(t.seconds, t.nanoseconds)]));
    for (const entrySource of [undefined, "manual"]) {
      const actual = workoutFrom("synthetic", { ...raw, entrySource });
      const expected = workoutModelSummary("synthetic", { ...browser, entrySource });
      expect(actual.startDate).toEqual(expected.startDate);
      expect(actual.endDate).toEqual(expected.endDate);
      expect(actual.syncedAt).toEqual(expected.syncedAt);
      expect(actual.startDate.getTime()).toBe(new Date(seconds * 1000 + nanos / 1e6).getTime());
    }
  });

  it.each([
    { date: "2026-04-26", finish: 8130, effort: "nonmaximal" as const, note: "Owner attestation: approximately 80% effort." },
    { date: "2026-09-20", finish: 7871, effort: "hard" as const, note: "Owner attestation: approximately 90% effort." },
  ])("preserves the $date confirmation and effort notes through Admin loading and a cache round trip", ({ date, finish, effort, note }) => {
    const f = confirmedRaceFixture({ id: `synthetic-${date}`, date, seconds: finish, availableAt: `${date}T23:00:00.000Z` });
    const nanos = 500_000; // Admin toDate rounds this up; the browser truncates it.
    const timestamp = (d: Date) => new AdminTimestamp(d.getTime() / 1000, nanos);
    const rawWorkout = { ...f.workout, startDate: timestamp(f.workout.startDate), endDate: timestamp(f.workout.endDate), syncedAt: timestamp(f.workout.syncedAt) };
    f.revision.details.effort = effort;
    f.revision.details.conditions = note;
    const receiptSeconds = Date.parse(f.revision.availableAt!) / 1000;
    const rawRace = { ...f.race, confirmationHistory: { ...f.race.confirmationHistory!, revisions: {
      [f.revision.revisionId]: { ...f.revision, availableAt: new AdminTimestamp(receiptSeconds, nanos) },
    } } };
    const race = normalizeRaceDocument(f.race.id, rawRace);
    const workout = workoutFrom(f.workout.workoutId, rawWorkout);
    const asOf = new Date(Date.parse(`${date}T23:00:00Z`) + 86_400_000).toISOString();
    const evaluate = (r = race, w = workout) => evaluateRacePerformance({ races: [r], workouts: [w], asOf, timeZone: "America/New_York" });
    expect(evaluate().evidence[0]).toMatchObject({ finishSeconds: finish, effort, timingAgreement: "consistent", status: "verified" });
    expect(evaluateRacePerformance({ races: treatConfirmedRacesAsMaximal([race]), workouts: [workout], asOf, timeZone: "America/New_York" }).latestBenchmark?.eligibleForEquivalence).toBe(true);
    expect(race.confirmationHistory!.revisions[f.revision.revisionId].details.effort).toBe(effort);
    expect(selectRaceConfirmationEvidence(race, asOf, "America/New_York").confirmation?.conditions).toBe(note);
    // Receipt availability rounds UP, preventing a confirmation from appearing early.
    expect(selectRaceConfirmationEvidence(race, new Date(receiptSeconds * 1000).toISOString(), "America/New_York").revision).toBeNull();
    expect(selectRaceConfirmationEvidence(race, new Date(receiptSeconds * 1000 + 1).toISOString(), "America/New_York").revision).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "hybrid-timestamp-parity-"));
    try {
      const path = join(dir, "synthetic.json");
      writeFileSync(path, JSON.stringify({ workouts: [{ id: workout.workoutId, ...stamp(rawWorkout) as object }],
        races: [{ id: race.id, ...stamp(rawRace) as object }], overrides: [], plans: [], vo2: [], streams: {} }));
      const cached = loadFromCache(path);
      expect(cached.workouts[0]).toEqual(workout);
      expect(cached.races[0]).toEqual(race);
      expect(evaluate(cached.races[0], cached.workouts[0])).toEqual(evaluate());
      // Older private captures remain readable.
      writeFileSync(path, JSON.stringify({ workouts: [{ id: "legacy", startDate: { __ts: f.workout.startDate.toISOString() } }], races: [], overrides: [], plans: [], vo2: [], streams: {} }));
      expect(loadFromCache(path).workouts[0].startDate).toEqual(f.workout.startDate);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
