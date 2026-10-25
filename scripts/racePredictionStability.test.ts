// @vitest-environment node
import {it,expect} from "vitest";
import {writeFileSync} from "node:fs";
import {buildWorkoutResearchExperiments} from "./racePredictionStability";
it("reproduces legacy counterintuitive changes and documents seven conditional-model perturbations",()=>{
  const report=buildWorkoutResearchExperiments();
  expect(Math.round(report.legacy.ordinaryRun.deltaSeconds)).toBe(5);
  expect(report.legacy.futurePlan.agedRacePlusSyntheticPlanSeconds-report.legacy.futurePlan.beforeSeconds).toBeGreaterThan(600);
  const b=report.scenarios.map(s=>s.models[1].minutes);
  expect(b).toEqual([125,125,125,125,125,130,124,130]);
  expect(report.scenarios[4].recentMiles).toBeGreaterThan(report.scenarios[0].recentMiles);
  expect(report.scenarios[3].longestRecentMiles).toBe(10);
  expect(report.realAthleteAccuracy).toBeNull();
  if(process.env.WORKOUT_RESEARCH_SIMULATION_OUTPUT)writeFileSync(process.env.WORKOUT_RESEARCH_SIMULATION_OUTPUT,JSON.stringify(report,null,2)+"\n");
});
