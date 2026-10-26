/** Explicit offline acceptance, reusing the existing parent-only projection.
 * Never queries Firebase, writes owner records, or commits private reports. */
import fs from "node:fs";
import { expect, it } from "vitest";
import { normalizeWorkoutResearchExport } from "../src/utils/workoutResearchInput";
import { estimateCurrentHalfMarathon } from "../src/utils/experimentalCurrentPerformance";

it.skipIf(!process.env.CURRENT_HALF_INPUT)("evaluates a supplied offline parent capture without additional reads", () => {
  const input = normalizeWorkoutResearchExport(JSON.parse(fs.readFileSync(process.env.CURRENT_HALF_INPUT!, "utf8")));
  expect(Object.values(input.complete).every(Boolean)).toBe(true);
  const result = estimateCurrentHalfMarathon(input);
  expect(result.validated).toBe(false);
  expect(result.finishMinutes).not.toBeNull();
  const report = { source: "Existing read-only parent capture; not refreshed live data", capturedAt: input.capturedAt,
    eligibleRuns: result.eligibleRuns, anchor: result.anchor, baselineSeconds: result.baselineSeconds,
    finishMinutes: result.finishMinutes, paceSecondsPerMile: result.paceSecondsPerMile,
    adjustmentSeconds: result.adjustmentSeconds, adjustmentMethod: result.adjustmentMethod,
    baselineTraining: result.baselineTraining, currentTraining: result.currentTraining,
    recentFourWeeks: result.training.recentFourWeeks, priorFourWeeks: result.training.priorFourWeeks,
    sinceAnchor: result.sinceAnchor, contributions: result.contributions, gaps: result.gaps, reason: result.reason };
  if (process.env.CURRENT_HALF_OUTPUT) fs.writeFileSync(process.env.CURRENT_HALF_OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ eligibleRuns: report.eligibleRuns, anchor: report.anchor?.name,
    baselineSeconds: report.baselineSeconds, finishMinutes: report.finishMinutes, adjustmentSeconds: report.adjustmentSeconds,
    adjustmentMethod: report.adjustmentMethod, baselineTraining: report.baselineTraining, currentTraining: report.currentTraining,
    recentFourWeeks: report.recentFourWeeks, priorFourWeeks: report.priorFourWeeks, contributions: report.contributions, reason: report.reason }, null, 2));
});
