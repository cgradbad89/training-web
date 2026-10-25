// @vitest-environment node
import {describe,it,expect} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {normalizeWorkoutResearchExport} from "../src/utils/workoutResearchInput";
import {estimateWorkoutRaceResearch} from "../src/utils/workoutRaceResearch";
import {runOfflineWorkoutResearch} from "./evaluateWorkoutRaceResearch";
import {workoutResearchFixture} from "../src/utils/__tests__/fixtures/workoutRaceResearchFixture";

describe("offline parent-only research runner",()=>{
  it("preserves missing collection disclosure and never reads archive children",()=>{
    const directory=mkdtempSync(path.join(tmpdir(),"workout-research-"));
    try{
      const fixture=workoutResearchFixture();const input=path.join(directory,"input.json"),output=path.join(directory,"output.json");
      writeFileSync(input,JSON.stringify({exportedAt:fixture.capturedAt,healthWorkouts:fixture.workouts.map(w=>({id:w.workoutId,doc:w,route:{mustNotUse:true},hrStream:{mustNotUse:true}}))}));
      const report=runOfflineWorkoutResearch(input,output);
      expect(report.source.complete).toEqual({workouts:true,races:false,overrides:false});
      expect(report.source.childCollectionsUsed).toEqual([]);expect(report.summary.models.every(m=>m.finishMinutes===null)).toBe(true);
      expect(readFileSync(output,"utf8")).not.toContain("mustNotUse");
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it("preserves scoped invalid parents as exclusions and rejects an invalid timezone",()=>{
    const fixture=workoutResearchFixture();
    const raw={...fixture,reportingScope:{limitations:["Bounded supplied history, not lifetime completeness."]},invalidWorkouts:[{record:{id:"invalid-historic",data:{...fixture.workouts[1],workoutId:"invalid-historic",distanceMiles:undefined,distanceMeters:undefined}}}]};
    const normalized=normalizeWorkoutResearchExport(JSON.parse(JSON.stringify(raw)));
    expect(estimateWorkoutRaceResearch(normalized).history.exclusions).toContainEqual({workoutId:"invalid-historic",reason:"missing_or_invalid_distance_or_duration"});
    expect(normalized.sourceNotes).toContain("Bounded supplied history, not lifetime completeness.");
    expect(()=>normalizeWorkoutResearchExport({...raw,timeZone:"invalid/timezone"})).toThrow("IANA");
    expect(normalizeWorkoutResearchExport({...raw,overrides:null}).complete.overrides).toBe(false);
  });
  it("normalizes raw race timestamps and fails closed on conflicting workout identity",()=>{
    const fixture=workoutResearchFixture();const race=fixture.races[0];
    const normalized=normalizeWorkoutResearchExport({exportedAt:fixture.capturedAt,healthWorkouts:fixture.workouts.map(w=>({id:w.workoutId,doc:w})),halfMarathonRaces:[{id:race.id,doc:{...race,raceDate:{seconds:Date.parse(race.raceDate)/1000},createdAt:{seconds:Date.parse(race.createdAt)/1000}}}],workoutOverrides:[]});
    expect(normalized.races[0]).toMatchObject({raceDate:race.raceDate,createdAt:new Date(race.createdAt).toISOString()});
    expect(estimateWorkoutRaceResearch(normalized).models[0].finishMinutes).toBe(130);
    expect(()=>normalizeWorkoutResearchExport({...fixture,workouts:[{id:"other-id",doc:fixture.workouts[0]}]})).toThrow("identities conflict");
  });
  it.skipIf(!process.env.WORKOUT_RESEARCH_INPUT)("evaluates an explicitly supplied offline archive",()=>{
    expect(process.env.WORKOUT_RESEARCH_OUTPUT).toBeTruthy();
    const report=runOfflineWorkoutResearch(process.env.WORKOUT_RESEARCH_INPUT!,process.env.WORKOUT_RESEARCH_OUTPUT!);
    expect(report.source.databaseWrites).toBe(0);
  });
});
