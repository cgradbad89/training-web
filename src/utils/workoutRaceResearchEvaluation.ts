import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";
import { estimateWorkoutRaceResearch,researchRaceCutoff } from "./workoutRaceResearch";

export interface ResearchArchive { input: WorkoutRaceResearchInput; label: string }
export interface ResearchEvaluationCase {
  outcomeId: string; cutoff: string; snapshotLabel: string | null; capturedAt: string | null;
  model: "A" | "B" | "C"; predictedMinutes: number | null; actualMinutes: number;
  errorMinutes: number | null; reason: string;
}
export function evaluateWorkoutResearchArchives(archives: readonly ResearchArchive[], outcomes: WorkoutRaceResearchInput) {
  const labels=estimateWorkoutRaceResearch(outcomes).raceEvidence.filter(e=>e.eligibleForEquivalence&&Math.abs(e.distanceMeters!-21097.5)<=5);
  const cases:ResearchEvaluationCase[]=[];
  // An owner-editable export does not establish immutable past availability.
  // Only explicitly synthetic examples get numerical evaluation metrics here.
  // Real accuracy must await a separately reviewed independent archive basis.
  const synthetic=outcomes.source==="synthetic";
  for(const outcome of labels) {
    const cutoff=researchRaceCutoff(outcome.raceDate,outcomes.timeZone);
    const snapshot=archives.filter(a=>Date.parse(a.input.capturedAt)<=Date.parse(cutoff)
      && a.input.source===outcomes.source).sort((a,b)=>b.input.capturedAt.localeCompare(a.input.capturedAt)||a.label.localeCompare(b.label))[0];
    const result=synthetic&&snapshot?estimateWorkoutRaceResearch({...snapshot.input,asOf:cutoff,historical:true}):null;
    for(const model of ["A","B","C"] as const) {
      const estimate=result?.models.find(m=>m.method===model);
      cases.push({outcomeId:outcome.raceId,cutoff,snapshotLabel:snapshot?.label??null,capturedAt:snapshot?.input.capturedAt??null,model,
        predictedMinutes:estimate?.finishMinutes??null,actualMinutes:outcome.finishSeconds!/60,
        errorMinutes:estimate?.finishMinutes!=null?estimate.finishMinutes-outcome.finishSeconds!/60:null,
        reason:!synthetic?"Real historical accuracy withheld: no independently established immutable pre-race input archive.":!snapshot?"No snapshot captured before the outcome cutoff.":estimate!.reason});
    }
  }
  const methods=Object.fromEntries((["A","B","C"] as const).map(model=>{
    const all=cases.filter(c=>c.model===model),predicted=all.filter(c=>c.errorMinutes!==null);
    return [model,{attempts:all.length,predictions:predicted.length,abstentions:all.length-predicted.length,
      abstentionRate:all.length?(all.length-predicted.length)/all.length:null,
      meanAbsoluteErrorMinutes:predicted.length?predicted.reduce((s,c)=>s+Math.abs(c.errorMinutes!),0)/predicted.length:null,
      biasMinutes:predicted.length?predicted.reduce((s,c)=>s+c.errorMinutes!,0)/predicted.length:null}];
  }));
  return {kind:synthetic?"simulated_chronological_evaluation":"real_accuracy_withheld",eligibleOutcomeCount:labels.length,
    independentlyVerifiedRealComparisonCount:0,realAccuracy:null,methods,cases,
    limitations:["Simulated outcomes test calculation and chronology, not athlete accuracy.","Current writable parent/confirmation revisions cannot prove pre-race availability.","No uncertainty interval or personalized calibration is inferred from two half marathons."]};
}

/** Input removals are a same-snapshot sensitivity experiment, not a historical
 * assertion about what was known before the selected workout/week. */
export function explainWorkoutRemoval(input:WorkoutRaceResearchInput,ids:readonly string[]) {
  const set=new Set(ids);
  const full=estimateWorkoutRaceResearch(input);
  const without=estimateWorkoutRaceResearch({...input,workouts:input.workouts.filter(w=>!set.has(w.workoutId))});
  return {kind:"same_snapshot_counterfactual",removedIds:[...ids],
    models:full.models.map((model,index)=>({method:model.method,withMinutes:model.finishMinutes,withoutMinutes:without.models[index].finishMinutes,
      effectMinutes:model.finishMinutes!==null&&without.models[index].finishMinutes!==null?model.finishMinutes-without.models[index].finishMinutes!:null,
      reason:model.reason,withoutReason:without.models[index].reason})),
    features:{sessions:full.modelingRuns.length-without.modelingRuns.length,miles:full.training.recentFourWeeks.miles-without.training.recentFourWeeks.miles,
      matchedPairs:full.pairs.length-without.pairs.length},
    warning:"A zero rounded-minute effect is not proof of no adaptation. Training intent and conditioning are not inferred from one run."};
}
