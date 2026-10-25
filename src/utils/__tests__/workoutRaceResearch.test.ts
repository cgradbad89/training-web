import { describe,expect,it } from "vitest";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { estimateWorkoutRaceResearch as estimate,researchRaceCutoff } from "../workoutRaceResearch";
import { evaluateWorkoutResearchArchives,explainWorkoutRemoval } from "../workoutRaceResearchEvaluation";
import { researchRace,researchRun,workoutResearchFixture } from "./fixtures/workoutRaceResearchFixture";

const override=(id:string,fields:Partial<WorkoutOverride>={}):WorkoutOverride=>({workoutId:id,userId:"synthetic",isExcluded:false,excludedAt:null,excludedReason:null,
  distanceMilesOverride:null,durationSecondsOverride:null,runTypeOverride:null,updatedAt:"2026-10-24T12:00:00Z",...fields});
describe("conditional workout-aware half-marathon research",()=>{
  it("uses a race anchor and observed comparable workouts once, with minute rounding and explicit assumptions",()=>{
    const result=estimate(workoutResearchFixture());
    expect(result.models.map(m=>m.finishMinutes)).toEqual([130,125,null]);
    expect(result.pairs).toHaveLength(6);
    expect(result.models[1].adjustmentMinutes).toBe(-5);
    expect(result.models[1].assumptions.join(" ")).toMatch(/Unvalidated/);
    expect(result.future.finishMinutes).toBeNull();expect(result.validated).toBe(false);
    expect(result).not.toHaveProperty("currentCapability");
    expect(result.contributions.filter(c=>c.role==="conditional_numeric")).toHaveLength(1);
  });
  it("requires explicit scenario selection and withholds unsupported coefficients",()=>{
    const input=workoutResearchFixture();input.allowSummaryPaceTransfer=false;
    const result=estimate(input);
    expect(result.models[1]).toMatchObject({finishMinutes:130,status:"comparator_only",adjustmentMinutes:0});
    expect(result.models[2].reason).toContain("calibration");
  });
  it.each(["Easy Run","Long Run","Tempo","Intervals","Race Pace","Recovery","Unplanned","Treadmill Run"])("counts completed %s parents without requiring GPS/HR/recorded pace",type=>{
    const input=workoutResearchFixture();input.workouts=[researchRun("typed","2026-10-21",600,{displayType:type,avgHeartRate:null,avgPaceSecPerMile:null,weather:null,routeClusterId:undefined})];
    const result=estimate(input);expect(result.modelingRuns).toHaveLength(1);expect(result.training.recentFourWeeks.miles).toBe(5);
    expect(result.history.missing).toMatchObject({heartRate:1,recordedPace:1,route:1,weather:1});
  });
  it("applies canonical distance/duration/type/exclusion and rejects late overrides",()=>{
    const input=workoutResearchFixture();input.overrides={"after-0":override("after-0",{distanceMilesOverride:6}),"after-1":override("after-1",{isExcluded:true}),"after-2":override("after-2",{updatedAt:"2027-01-01T00:00:00Z"})};
    const result=estimate(input);
    expect(result.history.runs.find(r=>r.workout.workoutId==="after-0")?.workout.distanceMiles).toBe(6);
    expect(result.history.runs.some(r=>r.workout.workoutId==="after-1")).toBe(false);
    expect(result.history.exclusions.map(e=>e.reason)).toEqual(expect.arrayContaining(["canonical_owner_exclusion","override_identity_or_availability_unresolved"]));
  });
  it("collapses repeated IDs/activities and rejects conflicting versions before overrides",()=>{
    const input=workoutResearchFixture();const w=input.workouts[1];input.workouts=[...input.workouts,w,{...w,workoutId:"duplicate-id"}];
    expect(estimate(input).history.runs).toHaveLength(13);
    input.workouts=[...input.workouts,{...w,durationSeconds:w.durationSeconds+60}];
    expect(estimate(input).history.exclusions.some(e=>e.reason==="conflicting_parent_versions")).toBe(true);
  });
  it.each([undefined,null,0,NaN])("does not turn missing/invalid distance %s into zero",distance=>{
    const input=workoutResearchFixture();input.workouts=[researchRun("bad","2026-10-21",600,{distanceMiles:distance as number})];
    expect(estimate(input).history.runs).toHaveLength(0);
    expect(estimate(input).history.exclusions[0].reason).toContain("distance_or_duration");
  });
  it.each(["hr","duration","route","terrain","weather","late-weather","indoor","intensity"])("withholds pace transfer for incomparable %s",reason=>{
    const input=workoutResearchFixture();input.workouts=input.workouts.map(w=>{
      if(!w.workoutId.startsWith("after"))return w;
      if(reason==="hr")return {...w,avgHeartRate:160};
      if(reason==="duration")return {...w,durationSeconds:5000};
      if(reason==="route")return {...w,routeClusterId:undefined};
      if(reason==="terrain")return {...w,elevationGainM:800};
      if(reason==="weather")return {...w,weather:null};
      if(reason==="late-weather")return {...w,weather:{...w.weather!,fetchedAt:"2027-01-01T00:00:00Z"}};
      return {...w,displayType:reason==="indoor"?"Treadmill Run":"Intervals"};
    });
    const result=estimate(input);expect(result.models[1].finishMinutes).toBe(130);expect(result.models[1].status).toBe("comparator_only");
  });
  it("reports endurance/consistency changes without arbitrary time credits",()=>{
    const input=workoutResearchFixture();input.workouts=[...input.workouts,researchRun("long","2026-10-24",650,{distanceMiles:10,durationSeconds:6500})];
    const result=estimate(input);expect(result.training.longestRecentRun?.miles).toBe(10);expect(result.training.longRuns.recentCount).toBe(1);
    expect(result.models[1].finishMinutes).toBe(125);
    expect(result.training.consistency.weeksWithRuns).toBeGreaterThan(0);
  });
  it("does not move a rounded estimate after one ordinary 9:29/mile run lacking matched effort evidence",()=>{
    const input=workoutResearchFixture();input.workouts=[...input.workouts,researchRun("ordinary","2026-10-24",569,{avgHeartRate:null})];
    expect(estimate(input).models[1].finishMinutes).toBe(125);
    const difference=explainWorkoutRemoval(input,["ordinary"]);
    expect(difference.models[1].effectMinutes).toBe(0);expect(difference.features.sessions).toBe(1);
  });
  it("permits explainable slower results instead of forcing monotonic improvement",()=>{
    const input=workoutResearchFixture();input.workouts=input.workouts.map(w=>w.workoutId.startsWith("after")?researchRun(w.workoutId,w.startDate.toISOString().slice(0,10),624):w);
    expect(estimate(input).models[1].finishMinutes).toBe(135);
  });
  it("explains several missing weeks / time advancement without invented decay",()=>{
    const input=workoutResearchFixture();input.asOf="2026-12-15T16:00:00Z";
    const result=estimate(input);expect(result.models[1].finishMinutes).toBe(130);expect(result.daysSinceLatestRun).toBe(54);
    expect(result.models[1].reason).toContain("matched pairs");
    input.asOf="2027-04-01T16:00:00Z";expect(estimate(input).models[1].reason).toContain("older");
  });
  it("uses a new confirmed race as a new anchor, without compounding prior training adjustment",()=>{
    const input=workoutResearchFixture();const added=researchRace("new-half","2026-10-23",7440,true);
    input.races=[...input.races,added.race];input.workouts=[...input.workouts,added.workout];
    const result=estimate(input);expect(result.anchor?.raceId).toBe("new-half");expect(result.models[0].finishMinutes).toBe(124);expect(result.models[1].finishMinutes).toBe(124);
  });
  it("accepts September timing only as provisional, rejects April clock disagreement",()=>{
    const input=workoutResearchFixture();const april=researchRace("provided-April-unverified","2026-04-26",8130);april.workout.endDate=new Date(april.workout.startDate.getTime()+8759*1000);
    const september=researchRace("provided-September-unverified","2026-09-20",7871);
    input.races=[april.race,september.race];input.workouts=[...input.workouts,april.workout,september.workout];
    const result=estimate(input);expect(result.anchor?.status).toBe("recorded_unverified");expect(result.models[0].finishMinutes).toBe(131);
    expect(result.raceEvidence.find(e=>e.raceId===april.race.id)?.timingAgreement).toBe("discrepant");
    input.races=[april.race];expect(estimate(input).models[0].finishMinutes).toBeNull();
  });
  it("never falls back to provisional evidence when invalid confirmation history exists",()=>{
    const input=workoutResearchFixture();const {race,workout}=researchRace("invalid-history","2026-09-20",7871);race.confirmationHistory=null;
    input.races=[race];input.workouts=[workout];expect(estimate(input).anchor).toBeNull();
  });
  it("withholds numeric retrospective replay and incomplete collection inputs",()=>{
    const input=workoutResearchFixture();input.asOf="2026-10-10T16:00:00Z";
    expect(estimate(input).models.every(m=>m.finishMinutes===null)).toBe(true);
    input.asOf=input.capturedAt;input.complete.overrides=false;
    expect(estimate(input).models.every(m=>m.finishMinutes===null)).toBe(true);
  });
  it("never includes future workouts, late syncs or records beyond capture",()=>{
    const input=workoutResearchFixture();input.workouts=[...input.workouts,researchRun("future","2027-01-01"),researchRun("late","2026-10-24",600,{syncedAt:new Date("2027-01-01")})];
    expect(estimate(input).history.runs).toHaveLength(13);
    input.asOf="2027-02-01T00:00:00Z";expect(estimate(input).history.runs).toHaveLength(13);
  });
  it("bounds weather availability by capture even when advancing the as-of date",()=>{
    const input=workoutResearchFixture();input.asOf="2026-10-26T16:00:00Z";
    input.workouts=input.workouts.map(w=>w.workoutId.startsWith("after")?{...w,weather:{...w.weather!,fetchedAt:"2026-10-26T12:00:00Z"}}:w);
    const result=estimate(input);expect(result.pairs).toHaveLength(0);expect(result.history.missing.weather).toBe(6);
  });
  it("reports actual race age when time advances past the snapshot",()=>{
    const input=workoutResearchFixture();input.asOf="2027-04-01T16:00:00Z";
    expect(estimate(input).anchor).toMatchObject({ageDays:214,stale:true});
  });
  it.each([480,720])("abstains instead of clipping an extreme matched ratio at pace %s",pace=>{
    const input=workoutResearchFixture();input.workouts=input.workouts.map(w=>w.workoutId.startsWith("after")?researchRun(w.workoutId,w.startDate.toISOString().slice(0,10),pace,{distanceMiles:3000/pace,durationSeconds:3000,endDate:new Date(w.startDate.getTime()+3000000)}):w);
    expect(estimate(input).models[1].reason).toContain("spread/magnitude");
  });
  it.each([["2026-03-09","America/New_York","2026-03-09T03:59:59.999Z"],["2026-11-02","America/New_York","2026-11-02T04:59:59.999Z"],["2026-10-26","Asia/Kathmandu","2026-10-25T18:14:59.999Z"]])("uses the instant before local race date %s in %s",(date,zone,cutoff)=>{
    expect(researchRaceCutoff(date,zone)).toBe(cutoff);
  });
  it("is deterministic under input permutation and does not mutate observations",()=>{
    const input=workoutResearchFixture();const before=JSON.stringify(input);const a=estimate(input);
    expect(estimate({...input,workouts:[...input.workouts].reverse()})).toEqual(a);expect(JSON.stringify(input)).toBe(before);
  });
});

describe("chronological research comparison",()=>{
  it("compares A/B/C on a frozen synthetic pre-race snapshot, excluding the outcome",()=>{
    const input=workoutResearchFixture();const outcome=researchRace("held-out","2026-10-26",7500,true);
    const outcomes={...input,races:[...input.races,outcome.race],workouts:[...input.workouts,outcome.workout],asOf:"2026-10-27T16:00:00Z",capturedAt:"2026-10-27T16:00:00Z"};
    const report=evaluateWorkoutResearchArchives([{label:"pre-race",input}],outcomes);
    const rows=report.cases.filter(c=>c.outcomeId==="held-out");
    expect(rows.map(r=>r.predictedMinutes)).toEqual([130,125,null]);expect(rows[1].errorMinutes).toBe(0);
    expect(report.kind).toBe("simulated_chronological_evaluation");expect(report.realAccuracy).toBeNull();
    expect(rows.every(r=>r.capturedAt!<r.cutoff)).toBe(true);
  });
  it("does not use a post-race snapshot or fabricate real historical accuracy",()=>{
    const input=workoutResearchFixture();const post={...input,capturedAt:"2026-11-01T00:00:00Z"};
    expect(evaluateWorkoutResearchArchives([{label:"too-late",input:post}],input).cases.every(c=>c.predictedMinutes===null)).toBe(true);
    input.source="owner_parent_export";
    const real=evaluateWorkoutResearchArchives([{label:"writable",input}],input);expect(real.realAccuracy).toBeNull();expect(real.independentlyVerifiedRealComparisonCount).toBe(0);
  });
});
