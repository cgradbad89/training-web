/** Pure research implementation. No app consumer, persistence, child telemetry,
 * wall clock, fitted owner coefficients or Production capability mutation. */
import type { HealthWorkout } from "@/types/healthWorkout";
import { applyOverride } from "@/types/workoutOverride";
import type { ResearchPair, ResearchRun, WorkoutRaceResearchInput, WorkoutRaceResearchResult, ResearchEstimate } from "@/types/workoutRaceResearch";
import { canonicalizePerformanceValue, isPerformanceInstant, performanceLocalDate, shiftPerformanceDate } from "./performanceEvidence";
import { buildRaceTrainingContext } from "./raceTrainingContext";
/** Same local-date boundary search as the existing chronological evaluator. */
export function researchRaceCutoff(raceDate:string,timeZone:string):string {
  const nominal=Date.parse(raceDate+"T00:00:00.000Z");
  let low=nominal-36*3600000,high=nominal+36*3600000;
  while(high-low>1){const middle=Math.floor((low+high)/2);if(performanceLocalDate(new Date(middle).toISOString(),timeZone)<raceDate)low=middle;else high=middle;}
  return new Date(high-1).toISOString();
}
import { buildRaceEvidence, DEFAULT_RACE_PERFORMANCE_POLICY, HALF_MARATHON_METERS, researchRiegelSeconds, researchVdotSeconds } from "./racePerformance";

/** Preregistered screening/robustness choices, NOT physiological calibration. */
export const WORKOUT_RESEARCH_POLICY = Object.freeze({
  baselineDays: 56, recentDays: 28, signalDays: 56,
  minimumPairs: 3, minimumRecentWeeks: 3,
  maximumHeartRateDifference: 3, maximumDurationRatioDifference: 0.15,
  minimumDurationSeconds: 20 * 60, maximumDurationSeconds: 90 * 60,
  maximumTemperatureDifferenceF: 5, maximumHumidityDifference: 15, maximumWindDifferenceMph: 3,
  maximumClimbDifferenceMetersPerMile: 5,
  maximumPairRatioSpread: 0.10, minimumMedianRatio: 0.85, maximumMedianRatio: 1.15,
  staleAnchorDays: 180,
});
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const dayDifference = (a: string, b: string) => Math.round((Date.parse(b+"T00:00:00Z")-Date.parse(a+"T00:00:00Z"))/86_400_000);
const median = (values: number[]) => { const a=[...values].sort((a,b)=>a-b); return a.length%2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2; };
const instant = (d: Date | undefined) => d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
const monday = (date: string) => shiftPerformanceDate(date,-((new Date(date+"T00:00:00Z").getUTCDay()+6)%7));
const hardLabel = (w: HealthWorkout) => /tempo|interval|race|fartlek|hill repeat/i.test(w.displayType ?? "");

/** Model-relevant snapshot excludes enrichment caches/children entirely. */
function signature(w: HealthWorkout) {
  return canonicalizePerformanceValue(JSON.parse(JSON.stringify({ start: instant(w.startDate), end: instant(w.endDate), synced: instant(w.syncedAt),
    run: w.isRunLike, miles: w.distanceMiles, seconds: w.durationSeconds, type: w.displayType,
    hr: w.avgHeartRate, route: w.routeClusterId, climb: w.elevationGainM, weather: w.weather })));
}

export function selectResearchRuns(input: WorkoutRaceResearchInput) {
  const cutoff=Math.min(Date.parse(input.asOf),Date.parse(input.capturedAt));
  const exclusions: WorkoutRaceResearchResult["history"]["exclusions"]=[];
  const groups=new Map<string, HealthWorkout[]>();
  for(const w of input.workouts) groups.set(w.workoutId,[...(groups.get(w.workoutId)??[]),w]);
  const runs: ResearchRun[]=[];
  const seen=new Map<string,string>();
  for(const [id, versions] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    const reject=(reason: string)=>exclusions.push({workoutId:id,reason});
    if(!id){reject("missing_workout_identity");continue;}
    const override=input.overrides[id];
    if(override && (override.workoutId!==id || !isPerformanceInstant(override.updatedAt) || Date.parse(override.updatedAt)>cutoff)) { reject("override_identity_or_availability_unresolved"); continue; }
    if(override?.isExcluded) { reject("canonical_owner_exclusion"); continue; }
    // Detect conflicting raw records BEFORE applying a shared override.
    if(new Set(versions.map(signature)).size>1) { reject("conflicting_parent_versions"); continue; }
    if(versions.length>1) reject(`collapsed_${versions.length-1}_repeated_same_id_records`);
    const w=applyOverride(versions[0],override??null);
    if(!w.isRunLike) { reject("not_running"); continue; }
    const start=instant(w.startDate),end=instant(w.endDate),known=instant(w.syncedAt);
    if(start===null || end===null || end<=start) { reject("invalid_or_missing_completion_dates"); continue; }
    if(end>cutoff) { reject("not_completed_at_cutoff"); continue; }
    if(known===null || known>cutoff) { reject("summary_availability_unknown_or_after_cutoff"); continue; }
    if(!positive(w.durationSeconds)||!positive(w.distanceMiles)) { reject("missing_or_invalid_distance_or_duration"); continue; }
    const duplicateKey=canonicalizePerformanceValue([start,end,w.distanceMiles,w.durationSeconds]);
    if(seen.has(duplicateKey)) { reject(`repeated_activity_of_${seen.get(duplicateKey)}`); continue; }
    seen.set(duplicateKey,id);
    runs.push({workout:w,date:performanceLocalDate(w.startDate.toISOString(),input.timeZone),
      paceSecondsPerMile:w.durationSeconds/w.distanceMiles,recordedType:w.displayType||w.activityType||"Unclassified run"});
  }
  runs.sort((a,b)=>a.date.localeCompare(b.date)||a.workout.workoutId.localeCompare(b.workout.workoutId));
  return {runs,exclusions};
}

function comparableContext(a: ResearchRun,b: ResearchRun,asOf: string): string | null {
  const x=a.workout,y=b.workout,p=WORKOUT_RESEARCH_POLICY;
  if(!positive(x.avgHeartRate)||!positive(y.avgHeartRate)||x.avgHeartRate<40||x.avgHeartRate>220||y.avgHeartRate<40||y.avgHeartRate>220||Math.abs(x.avgHeartRate-y.avgHeartRate)>p.maximumHeartRateDifference) return null;
  if(Math.abs(x.durationSeconds/y.durationSeconds-1)>p.maximumDurationRatioDifference) return null;
  for(const w of [x,y]) {
    const elapsed=(w.endDate.getTime()-w.startDate.getTime())/1000;
    if(Math.abs(elapsed-w.durationSeconds)>Math.max(60,w.durationSeconds*.01))return null;
  }
  const treadmill=(w: HealthWorkout)=>/treadmill|indoor/i.test(w.displayType??"");
  if(treadmill(x)||treadmill(y)) {
    // Indoor pace/incline/equipment are not measured reliably by these parents.
    // Count their training, but do not invent comparable terrain/effort evidence.
    return null;
  }
  if(!x.routeClusterId || x.routeClusterId!==y.routeClusterId) return null;
  if(!finite(x.elevationGainM)||!finite(y.elevationGainM)
    || Math.abs(x.elevationGainM/x.distanceMiles-y.elevationGainM/y.distanceMiles)>p.maximumClimbDifferenceMetersPerMile) return null;
  const wx=x.weather,wy=y.weather;
  if(!wx||!wy||!isPerformanceInstant(wx.fetchedAt)||!isPerformanceInstant(wy.fetchedAt)
    || Date.parse(wx.fetchedAt)>Date.parse(asOf)||Date.parse(wy.fetchedAt)>Date.parse(asOf)) return null;
  for(const [key,tolerance] of [["tempF",p.maximumTemperatureDifferenceF],["humidity",p.maximumHumidityDifference],["windMph",p.maximumWindDifferenceMph]] as const) {
    if(!finite(wx[key])||!finite(wy[key])||Math.abs(wx[key]-wy[key])>tolerance) return null;
  }
  if(!finite(wx.conditionCode)||!finite(wy.conditionCode)||wx.conditionCode!==wy.conditionCode) return null;
  return "Same supplied route, comparable climb/duration/mean HR and available weather; steady effort remains an explicit unvalidated assumption.";
}

function pairRuns(runs: ResearchRun[],anchorDate: string,asOfDate: string,asOf: string,raceIds: Set<string>) {
  const p=WORKOUT_RESEARCH_POLICY;
  const baselineStart=shiftPerformanceDate(anchorDate,-p.baselineDays);
  const eligible=(r:ResearchRun)=>!raceIds.has(r.workout.workoutId)&&!hardLabel(r.workout)
    && r.workout.durationSeconds>=p.minimumDurationSeconds&&r.workout.durationSeconds<=p.maximumDurationSeconds;
  const baseline=runs.filter(r=>r.date>=baselineStart&&r.date<anchorDate&&eligible(r));
  const recent=runs.filter(r=>r.date>=shiftPerformanceDate(asOfDate,-p.recentDays+1)&&r.date>anchorDate&&eligible(r));
  const unused=new Set(baseline.map(r=>r.workout.workoutId));
  const pairs:ResearchPair[]=[];
  const rejected:{workoutId:string;reason:string}[]=[];
  // Global deterministic closest-context matching; each run can contribute once.
  const candidates=recent.flatMap(r=>baseline.flatMap(b=>{
    const context=comparableContext(b,r,asOf);
    return context?[{b,r,context,score:Math.abs(b.workout.avgHeartRate!-r.workout.avgHeartRate!)+Math.abs(b.workout.durationSeconds/r.workout.durationSeconds-1)}]:[];
  })).sort((a,b)=>a.score-b.score||a.r.workout.workoutId.localeCompare(b.r.workout.workoutId)||a.b.workout.workoutId.localeCompare(b.b.workout.workoutId));
  const matched=new Set<string>();
  for(const {b,r,context} of candidates) {
    if(!unused.has(b.workout.workoutId)||matched.has(r.workout.workoutId))continue;
    unused.delete(b.workout.workoutId);matched.add(r.workout.workoutId);
    pairs.push({baselineId:b.workout.workoutId,recentId:r.workout.workoutId,recentDate:r.date,
      baselinePace:b.paceSecondsPerMile,recentPace:r.paceSecondsPerMile,paceRatio:r.paceSecondsPerMile/b.paceSecondsPerMile,
      heartRateDifference:r.workout.avgHeartRate!-b.workout.avgHeartRate!,context});
  }
  for(const r of recent)if(!matched.has(r.workout.workoutId))rejected.push({workoutId:r.workout.workoutId,reason:"No unused baseline run with required HR, route, terrain, duration and weather comparability."});
  return {pairs: pairs.sort((a,b)=>a.recentDate.localeCompare(b.recentDate)||a.recentId.localeCompare(b.recentId)),rejected};
}

export function estimateWorkoutRaceResearch(input: WorkoutRaceResearchInput): WorkoutRaceResearchResult {
  if(!isPerformanceInstant(input.asOf)||!isPerformanceInstant(input.capturedAt))throw new TypeError("Explicit valid as-of and snapshot capture instants are required.");
  const asOfDate=performanceLocalDate(input.asOf,input.timeZone);
  const retrospective=Date.parse(input.asOf)<Date.parse(input.capturedAt);
  const {runs,exclusions}=selectResearchRuns(input);
  // Evidence adapter is unchanged; discarded/unknown parent revisions cannot be
  // resurrected through the race path after the training selector rejected them.
  const rawEligibleIds=new Set(runs.map(r=>r.workout.workoutId));
  const eligibleRaw=input.workouts.filter(w=>rawEligibleIds.has(w.workoutId));
  const evidence=buildRaceEvidence({races:input.races,workouts:eligibleRaw,overrides:input.overrides,asOf:new Date(Math.min(Date.parse(input.asOf),Date.parse(input.capturedAt))).toISOString(),timeZone:input.timeZone,asOfMode:input.historical?"historical":"current"}).map(e=>{
    const ageDays=e.ageDays===null?null:dayDifference(e.raceDate,asOfDate);
    const stale=ageDays!==null&&ageDays>DEFAULT_RACE_PERFORMANCE_POLICY.staleAfterDays;
    return {...e,ageDays,stale,reasons:stale?[...new Set([...e.reasons,"historical_benchmark_not_current_capability"])]:e.reasons};
  });
  const confirmed=evidence.filter(e=>e.eligibleForEquivalence);
  const provisional=input.historical?[]:evidence.filter(e=>e.status==="recorded_unverified"&&e.availableAsOf&&e.timingAgreement==="consistent"
    &&e.timingBasis==="recorded_workout_duration"&&e.distanceMeters!==null&&e.finishSeconds!==null
    &&!Object.hasOwn(input.races.find(r=>r.id===e.raceId)!,"confirmationHistory")
    &&!e.reasons.some(r=>/invalid|mismatch|conflict|excluded|unavailable/.test(r)));
  const candidates=confirmed.length?confirmed:provisional;
  const sameDistance=candidates.filter(e=>Math.abs(e.distanceMeters!-HALF_MARATHON_METERS)<=5);
  const anchor=[...(sameDistance.length?sameDistance:candidates)].sort((a,b)=>b.raceDate.localeCompare(a.raceDate)||a.raceId.localeCompare(b.raceId))[0]??null;
  const rawSeconds=anchor?researchRiegelSeconds(anchor.finishSeconds!,anchor.distanceMeters!,HALF_MARATHON_METERS):null;
  const vdot=anchor?researchVdotSeconds(anchor.finishSeconds!,anchor.distanceMeters!,HALF_MARATHON_METERS):null;
  const complete=Object.values(input.complete).every(Boolean);
  const available=complete&&!retrospective;
  const referenceMinutes=available&&rawSeconds!==null?Math.round(rawSeconds/60):null;
  const estimate=(method:ResearchEstimate["method"],name:string,minutes:number|null,reason:string,assumptions:string[]=[],status:ResearchEstimate["status"]="experimental"):ResearchEstimate=>({method,name,
    status:minutes===null?"unavailable":status,finishMinutes:minutes,paceSecondsPerMile:minutes===null?null:Math.round(minutes*60/(HALF_MARATHON_METERS/1609.344)/5)*5,
    adjustmentMinutes:minutes===null||referenceMinutes===null?null:minutes-referenceMinutes,reason,assumptions});
  const withheld=!complete?"Required parent collection coverage is incomplete; exclusion/race context cannot be assumed empty.":retrospective?"This snapshot was captured after the requested cutoff. Earlier parent/confirmation revisions cannot be reconstructed; numerical replay is withheld.":!anchor?"No usable confirmed or consistent provisional race anchor.":null;
  const modelA=estimate("A","Race-only comparator",referenceMinutes,withheld??(anchor!.status==="recorded_unverified"?"Provisional recorded race duration, not a checked official result or proof of maximal effort.":"Most recent eligible same-distance benchmark, or fixed Riegel equivalence."),["Race equivalence is not proof of current fitness; stale anchors are not automatically decayed."],"comparator_only");
  const pairResult=anchor?pairRuns(runs,anchor.raceDate,asOfDate,new Date(Math.min(Date.parse(input.asOf),Date.parse(input.capturedAt))).toISOString(),new Set(input.races.flatMap(r=>r.actualRunId?[r.actualRunId]:[]))):{pairs:[],rejected:[]};
  const ratios=pairResult.pairs.map(p=>p.paceRatio);
  const ratio=ratios.length?median(ratios):null;
  const weeks=new Set(pairResult.pairs.map(p=>monday(p.recentDate))).size;
  let adjustmentReason=withheld;
  if(!adjustmentReason&&!input.allowSummaryPaceTransfer)adjustmentReason="Summary pace transfer was not explicitly selected. Training evidence remains descriptive.";
  if(!adjustmentReason&&dayDifference(anchor!.raceDate,asOfDate)>WORKOUT_RESEARCH_POLICY.staleAnchorDays)adjustmentReason="Race anchor is older than the research freshness screen; a current pace transfer is withheld.";
  if(!adjustmentReason&&(ratios.length<WORKOUT_RESEARCH_POLICY.minimumPairs||weeks<WORKOUT_RESEARCH_POLICY.minimumRecentWeeks))adjustmentReason="Fewer than three independent matched pairs spanning three recent weeks; no reliable training pace contrast.";
  if(!adjustmentReason&&(ratio===null||ratio<WORKOUT_RESEARCH_POLICY.minimumMedianRatio||ratio>WORKOUT_RESEARCH_POLICY.maximumMedianRatio||Math.max(...ratios)-Math.min(...ratios)>WORKOUT_RESEARCH_POLICY.maximumPairRatioSpread))adjustmentReason="Matched pace ratios exceed the predeclared spread/magnitude screen; review comparability rather than clipping a result.";
  const modelB=estimate("B","Race + conditional workout pace transfer",adjustmentReason?referenceMinutes:Math.round(rawSeconds!*ratio!/60),adjustmentReason??"Apply the median recent/baseline matched-summary pace ratio once to the original race anchor. No cumulative mileage/plan credits.",[
    "Unvalidated hypothesis: matched whole-session mean HR represents comparable steady effort and the pace contrast transfers proportionally to half-marathon performance.",
    "Same HR does not prove equal physiological effort; drugs, fatigue, sensor error, conditions and intensity distribution can still confound this scenario.",
    "This is a conditional numerical experiment, not demonstrated fitness improvement or a validated prediction.",
  ],adjustmentReason?"comparator_only":"experimental");
  const modelC=estimate("C","Published fitness–fatigue methodology",null,"Morton–Fitz-Clarke–Banister impulse-response modeling requires athlete-specific performance/load calibration. Existing CTL/ATL is not a finish-time equation; two unverified half marathons cannot identify or independently validate the gains and time constants.");
  const training=buildRaceTrainingContext({workouts:runs.map(r=>r.workout),asOf:new Date(input.asOf),timeZone:input.timeZone,targetRaceDate:"2027-03-20"});
  const anchorTraining=anchor?buildRaceTrainingContext({workouts:runs.filter(r=>r.date<anchor.raceDate).map(r=>r.workout),asOf:new Date(researchRaceCutoff(anchor.raceDate,input.timeZone)),timeZone:input.timeZone}):null;
  const modelingRuns=runs.filter(r=>r.date>=shiftPerformanceDate(asOfDate,-55));
  const dates=[...new Set(modelingRuns.map(r=>r.date))];
  const gaps=dates.slice(1).map((d,i)=>dayDifference(dates[i],d));
  const last=runs.at(-1)?.date;
  const since=anchor?runs.filter(r=>r.date>anchor.raceDate):null;
  const missing={heartRate:0,recordedPace:0,route:0,weather:0};
  const types:Record<string,number>={};
  for(const r of modelingRuns){types[r.recordedType]=(types[r.recordedType]??0)+1;if(!positive(r.workout.avgHeartRate))missing.heartRate++;if(!positive(r.workout.avgPaceSecPerMile))missing.recordedPace++;if(!r.workout.hasRoute)missing.route++;if(!r.workout.weather||!isPerformanceInstant(r.workout.weather.fetchedAt)||Date.parse(r.workout.weather.fetchedAt)>Math.min(Date.parse(input.asOf),Date.parse(input.capturedAt))||![r.workout.weather.tempF,r.workout.weather.humidity,r.workout.weather.windMph,r.workout.weather.conditionCode].every(finite))missing.weather++;}
  return {version:"phase3b2-conditional-research-v1",researchOnly:true,validated:false,asOf:input.asOf,capturedAt:input.capturedAt,retrospective,anchor,raceEvidence:evidence,
    raceEquivalences:{riegelMinutes:referenceMinutes,vdotMinutes:available&&vdot!==null?Math.round(vdot/60):null},models:[modelA,modelB,modelC],
    history:{runs,exclusions,dateRange:runs.length?{first:runs[0].date,last:runs.at(-1)!.date}:null,miles:runs.reduce((s,r)=>s+r.workout.distanceMiles,0),types,missing},
    modelingRuns,training,anchorTraining,sinceAnchor:since?{sessions:since.length,miles:since.reduce((s,r)=>s+r.workout.distanceMiles,0)}:null,
    pairs:pairResult.pairs,pairRejections:pairResult.rejected,longestObservedGapDays:gaps.length?Math.max(...gaps):null,daysSinceLatestRun:last?dayDifference(last,asOfDate):null,
    contributions:[{feature:"Matched-summary pace contrast",role:modelB.status==="experimental"?"conditional_numeric":"descriptive",minutes:modelB.status==="experimental"?modelB.adjustmentMinutes:null,explanation:modelB.reason},
      ...["Mileage / rolling 4- and 8-week volume","Frequency / consistency / observed gaps","Long-run frequency and progression","Recorded workout intensity / missing HR / race age"].map(feature=>({feature,role:"descriptive" as const,minutes:null,explanation:"No calibrated within-athlete seconds coefficient. This feature contributes evidence and eligibility context, not a percentage time credit."}))],
    limitations:[...(input.sourceNotes??[]),"Loaded parents may omit activities, exclusions or revisions. Observed gaps are not proven training interruptions.","Pace is derived from positive duration/distance when recorded pace is missing; HR/GPS are never required for volume or frequency.","Whole-minute finish and five-second pace rounding are presentation choices, not confidence or accuracy.","Provisional race duration has unknown maximality and no official verification. Timing conflict is never silently reconciled.","Historical confirmation chronology remains client_document_untrusted; a snapshot captured later cannot establish an earlier forecast.","No planned sessions, goal pace, synthetic future workouts, GPS points or HR streams enter this estimator."],
    future:{targetName:"Rock and Roll Half Marathon",targetDate:"2027-03-20",finishMinutes:null,reason:"A future race forecast is withheld. Completed-workout research scenarios do not establish future training adherence or validated lead-time accuracy."}};
}
