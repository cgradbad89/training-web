import { expect, it } from "vitest";
import { runOfflineRaceEvaluation } from "./evaluateRacePerformance";

it.skipIf(!process.env.RACE_EVALUATION_INPUT)("evaluates a supplied offline race fixture without network or database access", () => {
  const output = process.env.RACE_EVALUATION_OUTPUT;
  if (!output) throw new TypeError("Set RACE_EVALUATION_OUTPUT to the desired local JSON report path");
  const result = runOfflineRaceEvaluation(process.env.RACE_EVALUATION_INPUT!, output);
  expect(result.source.childCollectionsUsed).toEqual([]);
  expect(result.report.researchOnly).toBe(true);
});
