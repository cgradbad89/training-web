/** Reproducible invented-data experiments, never owner accuracy evidence. */
import {fitRiegel,predictSeconds,type EffortPoint} from "../src/utils/riegelFit";
import {estimateWorkoutRaceResearch} from "../src/utils/workoutRaceResearch";
import {evaluateWorkoutResearchArchives} from "../src/utils/workoutRaceResearchEvaluation";
import {researchRace,researchRun,workoutResearchFixture} from "../src/utils/__tests__/fixtures/workoutRaceResearchFixture";

export function buildWorkoutResearchExperiments(){
  const points:EffortPoint[]=[{distanceMiles:13.109,timeSeconds:7871,ageDays:35,isTreadmill:false,tier:"RACE"},
    ...[3,5,7,9].map((distanceMiles,i)=>({distanceMiles,timeSeconds:distanceMiles*(i%2?600:560),ageDays:5+i*6,isTreadmill:false,tier:"BASELINE" as const}))];
  const fit=(efforts:EffortPoint[])=>predictSeconds(fitRiegel(efforts,13.109,3,{min:1.04,max:1.10})!,13.109);
  const before=fit(points),after=fit([...points,{distanceMiles:3,timeSeconds:3*569,ageDays:0,isTreadmill:false,tier:"BASELINE"}]);
  const syntheticPlan=Array.from({length:32},(_,i)=>({distanceMiles:[3,4,5,8][i%4],timeSeconds:[3,4,5,8][i%4]*690,ageDays:Math.floor(i/4)*7,isTreadmill:false,tier:"PLANNED" as const}));
  const aged=points.map(p=>({...p,ageDays:p.ageDays+56}));
  const fixture=workoutResearchFixture();
  const newer=researchRace("synthetic-new-half","2026-10-23",7440,true);
  const consistency=Array.from({length:8},(_,i)=>researchRun("consistent-extra-"+i,"2026-10-"+String(1+i*3).padStart(2,"0"),650,{avgHeartRate:null}));
  const scenarios=[
    {name:"Baseline",input:fixture},
    {name:"Add 9:29 easy run, no comparable effort evidence",input:{...fixture,workouts:[...fixture.workouts,researchRun("easy-extra","2026-10-24",569,{avgHeartRate:null})]}},
    {name:"Add strong tempo at higher HR",input:{...fixture,workouts:[...fixture.workouts,researchRun("tempo-extra","2026-10-24",540,{displayType:"Tempo",avgHeartRate:160})]}},
    {name:"Complete longer endurance run",input:{...fixture,workouts:[...fixture.workouts,researchRun("long-extra","2026-10-24",650,{distanceMiles:10,durationSeconds:6500,endDate:new Date("2026-10-24T13:48:20Z")})]}},
    {name:"Improve consistency across several weeks",input:{...fixture,workouts:[...fixture.workouts,...consistency]}},
    {name:"No supplied running for several weeks",input:{...fixture,workouts:fixture.workouts.filter(w=>w.startDate<new Date("2026-10-01"))}},
    {name:"Add a new confirmed maximal race",input:{...fixture,workouts:[...fixture.workouts,newer.workout],races:[...fixture.races,newer.race]}},
    {name:"Advance 51 days without new observations",input:{...fixture,asOf:"2026-12-15T16:00:00Z"}},
  ].map(({name,input})=>{
    const r=estimateWorkoutRaceResearch(input);return {name,asOf:r.asOf,models:r.models.map(m=>({method:m.method,minutes:m.finishMinutes,status:m.status,reason:m.reason})),
      signalRuns:r.modelingRuns.length,recentMiles:r.training.recentFourWeeks.miles,longestRecentMiles:r.training.longestRecentRun?.miles??null,matchedPairs:r.pairs.length};
  });
  const outcome=researchRace("synthetic-held-out","2026-10-26",7500,true);
  const outcomes={...fixture,asOf:"2026-10-27T16:00:00Z",capturedAt:"2026-10-27T16:00:00Z",workouts:[...fixture.workouts,outcome.workout],races:[...fixture.races,outcome.race]};
  return {kind:"synthetic_mechanism_and_stability_experiments",realAthleteAccuracy:null,
    legacy:{ordinaryRun:{paceSecondsPerMile:569,distanceMiles:3,beforeSeconds:before,afterSeconds:after,deltaSeconds:after-before,
      explanation:"Weighted log-distance/log-time regression changes slope/intercept and normalized weights after an ordinary training observation. Training pace is being treated as performance evidence, so a 9:29/mi run can move the fitted finish slower by approximately five seconds."},
      futurePlan:{beforeSeconds:before,agedRacePlusSyntheticPlanSeconds:fit([...aged,...syntheticPlan]),syntheticPlannedRuns:syntheticPlan.length,
        explanation:"The real anchor ages by 56 days while 32 synthetic planned easy efforts have fresh weights. The fit moves toward easy training pace. This isolates the underlying legacy weighted fit; it is not the final anchored/consistency-wrapped Production chart."}},
    scenarios,chronology:evaluateWorkoutResearchArchives([{label:"invented pre-race snapshot",input:fixture}],outcomes)};
}
