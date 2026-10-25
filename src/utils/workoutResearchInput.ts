import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";
import { normalizeRaceConfirmationHistory } from "./raceConfirmation";
import {isPerformanceInstant} from "./performanceEvidence";

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
function date(value:unknown):Date {
  if(value instanceof Date)return new Date(value);
  const raw=object(value);const seconds=raw._seconds??raw.seconds;
  if(typeof seconds==="number")return new Date(seconds*1000+Number(raw._nanoseconds??raw.nanoseconds??0)/1_000_000);
  return new Date(typeof value==="string"||typeof value==="number"?value:NaN);
}
/** Explicit parent-only projection. Never inspect or copy route/hrStream/splits,
 * caches, settings, user docs, credentials or unrelated archive collections. */
export function normalizeWorkoutResearchExport(value:unknown):WorkoutRaceResearchInput {
  const input=object(value);
  const retained=Array.isArray(input.workouts)?input.workouts:Array.isArray(input.healthWorkouts)?input.healthWorkouts:[];
  const rejected=(Array.isArray(input.invalidWorkouts)?input.invalidWorkouts:[]).map(row=>{const raw=object(object(row).record);return {id:raw.id,doc:raw.data};});
  const rows=[...retained,...rejected];
  const workouts=rows.map((row):HealthWorkout=>{
    const record=object(row);const doc=record.doc?object(record.doc):record;
    if(record.id!=null&&doc.workoutId!=null&&record.id!==doc.workoutId)throw new TypeError("Parent document and workout identities conflict.");
    const id=String(record.id??doc.workoutId??"");
    return {workoutId:id,name:String(doc.name??doc.displayType??"Unknown"),displayType:String(doc.displayType??"Unknown"),activityType:String(doc.activityType??"Unknown"),
      startDate:date(doc.startDate),endDate:date(doc.endDate),syncedAt:date(doc.syncedAt),isRunLike:doc.isRunLike===true,
      distanceMiles:typeof doc.distanceMiles==="number"?doc.distanceMiles:typeof doc.distanceMeters==="number"?doc.distanceMeters/1609.344:NaN,
      distanceMeters:typeof doc.distanceMeters==="number"?doc.distanceMeters:null,durationSeconds:typeof doc.durationSeconds==="number"?doc.durationSeconds:NaN,
      avgPaceSecPerMile:typeof doc.avgPaceSecPerMile==="number"?doc.avgPaceSecPerMile:null,
      avgHeartRate:typeof doc.avgHeartRate==="number"?doc.avgHeartRate:null,elevationGainM:typeof doc.elevationGainM==="number"?doc.elevationGainM:null,
      routeClusterId:typeof doc.routeClusterId==="string"?doc.routeClusterId:undefined,
      weather:doc.weather?object(doc.weather) as unknown as HealthWorkout["weather"]:null,
      hasRoute:doc.hasRoute===true,hasHRStream:doc.hasHRStream===true,sourceName:String(doc.sourceName??"Unknown"),
      calories:NaN,avgSpeedMPS:null,hrDriftPct:null,cadenceSPM:null,efficiencyRaw:null,efficiencyScore:null};
  });
  const raceRows=Array.isArray(input.races)?input.races:Array.isArray(input.halfMarathonRaces)?input.halfMarathonRaces:[];
  const races=raceRows.map(row=>{const raw=object(row);const doc=raw.doc?object(raw.doc):raw;
    const raceDate=date(doc.raceDate),createdAt=date(doc.createdAt);
    return {...doc,id:String(raw.id??doc.id??""),
    raceDate:typeof doc.raceDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(doc.raceDate)?doc.raceDate:Number.isFinite(raceDate.getTime())?raceDate.toISOString().slice(0,10):"",
    createdAt:Number.isFinite(createdAt.getTime())?createdAt.toISOString():"",
    ...(Object.hasOwn(doc,"confirmationHistory")?{confirmationHistory:normalizeRaceConfirmationHistory(doc.confirmationHistory)}:{})} as unknown as Race;});
  const overrides=(input.overrides?object(input.overrides):Object.fromEntries((Array.isArray(input.workoutOverrides)?input.workoutOverrides:[]).map(row=>{const raw=object(row);return [String(raw.id),raw.doc];}))) as Record<string,WorkoutOverride>;
  const capturedAt=String(input.capturedAt??input.loadedAt??input.exportedAt??"");
  const asOf=String(input.asOf??capturedAt);
  if(!isPerformanceInstant(capturedAt)||!isPerformanceInstant(asOf))throw new TypeError("The archive needs valid fixed capturedAt/exportedAt and asOf timestamps.");
  const timeZone=String(input.timeZone??"America/New_York");
  try{new Intl.DateTimeFormat("en-US",{timeZone}).format(new Date(capturedAt));}catch{throw new TypeError("The archive needs a supported IANA time zone.");}
  const scope=object(input.reportingScope);
  const sourceNotes=[...(Array.isArray(input.sourceNotes)?input.sourceNotes:[]),...(Array.isArray(scope.limitations)?scope.limitations:[])].filter((n):n is string=>typeof n==="string");
  return {workouts,races,overrides,capturedAt,asOf,timeZone,sourceNotes,
    source:input.source==="synthetic"?"synthetic":"owner_parent_export",
    complete:{workouts:(Array.isArray(input.workouts)||Array.isArray(input.healthWorkouts))&&object(input.complete).workouts!==false,
      races:(Array.isArray(input.races)||Array.isArray(input.halfMarathonRaces))&&object(input.complete).races!==false,
      overrides:((!!input.overrides&&typeof input.overrides==="object"&&!Array.isArray(input.overrides))||Array.isArray(input.workoutOverrides))&&object(input.complete).overrides!==false},
    allowSummaryPaceTransfer:false};
}
