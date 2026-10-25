import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";

export function researchRun(id:string,date:string,pace=600,extra:Partial<HealthWorkout>={}):HealthWorkout {
  const startDate=new Date(date+"T12:00:00Z");
  const distanceMiles=5,durationSeconds=distanceMiles*pace;
  return {workoutId:id,name:"Synthetic completed run",displayType:"Outdoor Run",activityType:"running",isRunLike:true,
    startDate,endDate:new Date(startDate.getTime()+durationSeconds*1000),syncedAt:new Date(startDate.getTime()+durationSeconds*1000+1000),
    sourceName:"Synthetic watch",calories:400,avgHeartRate:140,distanceMiles,durationSeconds,distanceMeters:distanceMiles*1609.344,
    avgPaceSecPerMile:pace,avgSpeedMPS:null,hrDriftPct:null,cadenceSPM:null,efficiencyRaw:null,efficiencyScore:null,
    elevationGainM:30,hasRoute:false,hasHRStream:false,routeClusterId:"synthetic-loop",
    weather:{tempF:60,feelsLikeF:60,humidity:50,windMph:3,dewPointF:45,conditionCode:1,conditionText:"Clear",fetchedAt:new Date(startDate.getTime()+durationSeconds*1000+2000).toISOString()},...extra};
}
export function researchRace(id:string,date:string,seconds=7800,confirmed=false):{race:Race;workout:HealthWorkout} {
  const workout=researchRun(id+"-run",date,seconds/13.109,{distanceMiles:13.109,distanceMeters:21097.5,durationSeconds:seconds});
  workout.endDate=new Date(workout.startDate.getTime()+seconds*1000);
  workout.syncedAt=new Date(workout.endDate.getTime()+1000);
  const race:Race={id,name:"Synthetic "+id,raceDate:date,raceDistance:"halfMarathon",isActive:false,createdAt:new Date(workout.endDate.getTime()+2000).toISOString(),actualRunId:workout.workoutId,
    ...(confirmed?{performanceEvidence:{status:"owner_confirmed",kind:"race",knownAt:new Date(workout.endDate.getTime()+3000).toISOString(),raceDate:date,distanceMeters:21097.5,finishSeconds:seconds,effort:"maximal",conditions:"Synthetic controlled context",source:"Synthetic fixture only"}}:{})};
  return {race,workout};
}
export function workoutResearchFixture():WorkoutRaceResearchInput {
  const {race,workout}=researchRace("baseline-half","2026-08-30",7800,true);
  const workouts=[workout];
  for(let i=0;i<6;i++) {
    workouts.push(researchRun("before-"+i,"2026-08-"+String(3+i*4).padStart(2,"0"),600));
    workouts.push(researchRun("after-"+i,"2026-10-"+String(2+i*4).padStart(2,"0"),576));
  }
  return {workouts,races:[race],overrides:{},asOf:"2026-10-25T16:00:00.000Z",capturedAt:"2026-10-25T16:00:00.000Z",timeZone:"America/New_York",
    source:"synthetic",complete:{workouts:true,races:true,overrides:true},allowSummaryPaceTransfer:true};
}
