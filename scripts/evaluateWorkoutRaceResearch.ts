import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {normalizeWorkoutResearchExport} from "../src/utils/workoutResearchInput";
import {estimateWorkoutRaceResearch} from "../src/utils/workoutRaceResearch";
import {evaluateWorkoutResearchArchives} from "../src/utils/workoutRaceResearchEvaluation";

export function runOfflineWorkoutResearch(inputPath:string,outputPath:string){
  const contents=readFileSync(inputPath),input=normalizeWorkoutResearchExport(JSON.parse(contents.toString("utf8")));
  const result=estimateWorkoutRaceResearch(input);
  const conditional=estimateWorkoutRaceResearch({...input,allowSummaryPaceTransfer:true});
  const report={source:{inputSha256:createHash("sha256").update(contents).digest("hex"),capturedAt:input.capturedAt,asOf:input.asOf,
    kind:input.source,complete:input.complete,suppliedParents:input.workouts.length,raceRecords:input.races.length,overrideRecords:Object.keys(input.overrides).length,
    childCollectionsUsed:[],databaseReads:0,databaseWrites:0},
    summary:{eligibleSuppliedRuns:result.history.runs.length,modelingRunCount:result.modelingRuns.length,dateRange:result.history.dateRange,
      miles:result.history.miles,types:result.history.types,missing:result.history.missing,recentFourWeeks:result.training.recentFourWeeks,
      priorFourWeeks:result.training.priorFourWeeks,longRuns:result.training.longRuns,consistency:result.training.consistency,
      exclusions:result.history.exclusions,anchor:result.anchor,raceEvidence:result.raceEvidence,models:result.models,pairs:result.pairs,
      selectedAssumptionModelB:conditional.models[1],pairRejections:conditional.pairRejections,
      sinceAnchor:result.sinceAnchor,anchorTraining:result.anchorTraining,limitations:result.limitations},
    chronology:evaluateWorkoutResearchArchives([],input)};
  writeFileSync(outputPath,JSON.stringify(report,null,2)+"\n");return report;
}
