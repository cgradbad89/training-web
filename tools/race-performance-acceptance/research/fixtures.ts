import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";

/** Invented observations only. No owner identities, source IDs or race results. */
export function createResearchDemo():WorkoutRaceResearchInput {
  const workouts:HealthWorkout[]=[];
  const run=(id:string,date:string,pace:number,miles=5,extra:Partial<HealthWorkout>={})=>{
    const startDate=new Date(date+"T12:00:00Z"),durationSeconds=miles*pace;
    const w={workoutId:id,name:"Invented run",displayType:"Outdoor Run",activityType:"running",isRunLike:true,startDate,
      endDate:new Date(startDate.getTime()+durationSeconds*1000),syncedAt:new Date(startDate.getTime()+durationSeconds*1000+1000),
      distanceMiles:miles,distanceMeters:miles*1609.344,durationSeconds,avgPaceSecPerMile:pace,avgHeartRate:140,
      sourceName:"Invented watch",hasRoute:false,hasHRStream:false,elevationGainM:30,routeClusterId:"invented-river-loop",
      weather:{tempF:60,feelsLikeF:60,humidity:50,windMph:3,dewPointF:45,conditionCode:1,conditionText:"Clear",fetchedAt:new Date(startDate.getTime()+durationSeconds*1000+2000).toISOString()},
      calories:NaN,avgSpeedMPS:null,hrDriftPct:null,cadenceSPM:null,efficiencyRaw:null,efficiencyScore:null,...extra} as HealthWorkout;
    workouts.push(w);return w;
  };
  const anchor=run("invented-half","2026-08-30",7800/13.109,13.109,{displayType:"Race",distanceMeters:21097.5});
  const races:Race[]=[{id:"invented-half-event",name:"Invented River Half",raceDate:"2026-08-30",raceDistance:"halfMarathon",isActive:false,createdAt:"2026-08-30T16:00:00Z",actualRunId:anchor.workoutId,
    performanceEvidence:{status:"owner_confirmed",kind:"race",knownAt:"2026-08-30T16:00:00Z",raceDate:"2026-08-30",distanceMeters:21097.5,finishSeconds:7800,effort:"maximal",conditions:"Invented controlled example",source:"Synthetic offline fixture"}}];
  for(let i=0;i<6;i++) {
    run("invented-before-"+i,"2026-08-"+String(3+i*4).padStart(2,"0"),600);
    run("invented-after-"+i,"2026-10-"+String(2+i*4).padStart(2,"0"),576);
  }
  run("invented-long","2026-10-24",640,10,{displayType:"Long Run",avgHeartRate:null,routeClusterId:undefined,weather:null});
  run("invented-tempo","2026-10-20",540,6,{displayType:"Tempo",avgHeartRate:160});
  run("invented-recovery","2026-10-23",660,3,{displayType:"Recovery",avgHeartRate:null});
  return {workouts,races,overrides:{},asOf:"2026-10-25T16:00:00Z",capturedAt:"2026-10-25T16:00:00Z",timeZone:"America/New_York",source:"synthetic",
    complete:{workouts:true,races:true,overrides:true},allowSummaryPaceTransfer:true};
}
