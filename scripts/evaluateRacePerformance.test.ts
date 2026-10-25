import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOfflineRaceEvaluation } from "./evaluateRacePerformance";
import { confirmedRaceFixture } from "../src/utils/__tests__/fixtures/raceConfirmationFixture";

it("consumes exported confirmation receipt timestamps without manufacturing historical eligibility", () => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-race-evaluation-"));
  try {
    const fixture = confirmedRaceFixture();
    const inputPath = join(directory, "synthetic-input.json");
    const outputPath = join(directory, "report.json");
    const receipt = { _seconds: Date.parse(fixture.revision.availableAt!) / 1000, _nanoseconds: 0 };
    const history = fixture.race.confirmationHistory!;
    const race = { ...fixture.race, confirmationHistory: { ...history,
      revisions: { [fixture.revision.revisionId]: { ...fixture.revision, availableAt: receipt } } } };
    const input = { asOf: "2026-10-25T16:00:00.000Z", timeZone: "America/New_York", halfMarathonRaces: [{ id: race.id, doc: race }],
      healthWorkouts: [{ id: fixture.workout.workoutId, doc: fixture.workout }], workoutOverrides: [] };
    writeFileSync(inputPath, JSON.stringify(input));
    const result = runOfflineRaceEvaluation(inputPath, outputPath);
    expect(result.source).toMatchObject({ confirmationHistoryCount: 1, childCollectionsUsed: [] });
    expect(result.report).toMatchObject({ eligibleOutcomeCount: 1, untrustedChronologyRaceCount: 1, researchOnly: true });
    expect(result.report.cases[0]).toMatchObject({ targetAvailableAt: fixture.revision.availableAt,
      targetConfirmationRevisionId: fixture.revision.revisionId, predictedSeconds: null });
    expect(JSON.parse(readFileSync(outputPath, "utf8")).report).toEqual(result.report);
    writeFileSync(inputPath, JSON.stringify({ ...input, asOf: "2026-10-23T16:00:00.000Z" }));
    expect(runOfflineRaceEvaluation(inputPath, outputPath).report.eligibleOutcomeCount).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(!process.env.RACE_EVALUATION_INPUT)("evaluates a supplied offline race fixture without network or database access", () => {
  const output = process.env.RACE_EVALUATION_OUTPUT;
  if (!output) throw new TypeError("Set RACE_EVALUATION_OUTPUT to the desired local JSON report path");
  const result = runOfflineRaceEvaluation(process.env.RACE_EVALUATION_INPUT!, output);
  expect(result.source.childCollectionsUsed).toEqual([]);
  expect(result.report.researchOnly).toBe(true);
});
