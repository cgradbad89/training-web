import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectivePerformanceWorkout } from "@/types/performanceAnalysis";
import type { StoredPerformanceFeature } from "@/types/performancePersistence";
import { hashPerformanceValue } from "@/utils/performanceEvidence";
import { extractWorkoutPerformanceFeature } from "@/utils/aerobicPerformance";
import { PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS } from "@/utils/performanceAnalysis";

const h = vi.hoisted(() => ({ enabled: true, validSession: true, parents: [] as { id:string; data:Record<string,unknown> }[],
  overrides: [] as {id:string;data:Record<string,unknown>}[], features: [] as unknown[], current: null as unknown,
  reads: vi.fn(), save: vi.fn(), publish: vi.fn(), extract: vi.fn(), supporting: [] as unknown[], telemetryHr: 142 }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/lib/performanceGate", () => ({
  getPerformanceUpdateGate: () => ({enabled:h.enabled,reason:"Owner configuration required"}),
  assertPerformanceUpdateEnabled: () => { if(!h.enabled) throw new Error("disabled"); },
}));
vi.mock("firebase/firestore", () => ({
  collection: (_:unknown,...p:string[]) => p.join("/"), documentId:()=>"__name__", limit:(n:number)=>({limit:n}),
  orderBy:()=>({}), where:()=>({}), query:(path:string,...constraints:unknown[])=>({path,constraints}),
  getDocsFromServer: async (q:{path:string}) => {
    h.reads(q.path);
    const rows = q.path.endsWith("healthWorkouts") ? h.parents : q.path.endsWith("workoutOverrides") ? h.overrides : [];
    return {size:rows.length,docs:rows.map(r=>({id:r.id,data:()=>r.data}))};
  },
}));
vi.mock("@/services/healthWorkouts", () => ({ docToHealthWorkout: (id:string,data:Record<string,unknown>)=>({...data,workoutId:data.workoutId??id}) }));
vi.mock("@/services/performancePersistence", () => ({
  capturePerformanceSession: vi.fn(),
  assertPerformanceSession: () => {if(!h.validSession) throw new Error("session changed");},
  getSavedPerformance: async()=>({current:h.current,documentsRead:1}),
  getPerformanceFeatures: async(_:unknown,ids:string[])=>({features:h.features,documentsRead:ids.length}),
  savePerformanceFeature: (...args:unknown[])=>h.save(...args), publishPerformance:(...args:unknown[])=>h.publish(...args),
}));
vi.mock("@/services/performanceTelemetry", () => ({
  createPerformanceReadBudget:(limit=5000)=>{if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw new Error("budget");return {limit,documentsRead:0};},
  extractFreshWorkoutPerformance:(...args:unknown[])=>h.extract(...args),
}));
import { prepareManualPerformanceReview, runManualPerformanceUpdate, reusablePerformanceReceipt } from "../manualPerformance";
const session = {uid:"owner"} as Parameters<typeof prepareManualPerformanceReview>[0];
function parent(id="run-1",extra:Record<string,unknown>={}) {
  return { id, data: {workoutId:id,name:"Run",activityType:"running",displayType:"Run",startDate:new Date("2026-10-18T12:00:00Z"),
    endDate:new Date("2026-10-18T12:30:00Z"),durationSeconds:1800,sourceName:"watch",isRunLike:true,hasRoute:true,
    routeComplete:true,hasHRStream:true,syncedAt:new Date("2026-10-18T13:00:00Z"),calories:300,avgHeartRate:142,
    distanceMiles:5400/1609.344,distanceMeters:5400,avgPaceSecPerMile:null,avgSpeedMPS:3,hrDriftPct:null,
    cadenceSPM:null,efficiencyRaw:null,efficiencyScore:null,elevationGainM:20,...extra } };
}
const options = {selectedWorkoutIds:["run-1"],forceReprocessWorkoutIds:[],userConfirmedReady:true as const,readBudget:5000};
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-21T14:00:00Z"));
  h.enabled=true;h.validSession=true;h.parents=[parent()];h.overrides=[];h.features=[];h.current=null;
  h.telemetryHr=142;
  h.reads.mockReset();h.save.mockReset();h.publish.mockReset();h.extract.mockReset();
  h.extract.mockImplementation(async(input:{workout:EffectivePerformanceWorkout;budget:{documentsRead:number}})=>{
    input.budget.documentsRead+=181;
    const intervals=Array.from({length:180},(_,i)=>({startSeconds:i*10,endSeconds:(i+1)*10,speedMps:3,hrBpm:h.telemetryHr}));
    const workout={...input.workout,telemetry:{state:"complete" as const,verification:"supplied_content" as const,contentDigest:await hashPerformanceValue({intervals,sourceSampleCount:181})}};
    const feature=await extractWorkoutPerformanceFeature({workout,intervals,sourceSampleCount:181,asOf:new Date().toISOString(),extractedAt:new Date().toISOString(),versions:PERFORMANCE_VERSIONS,policy:PERFORMANCE_DEFAULTS.qualityPolicy});
    return {workout,feature};
  });
  h.save.mockImplementation(async(_:unknown,input:{workout:EffectivePerformanceWorkout;feature:StoredPerformanceFeature["feature"]})=>{
    const stored={...input,schemaVersion:1,workoutId:input.workout.workoutId,revision:1,featureDigest:await hashPerformanceValue(input)};
    h.features=[...h.features.filter(f=>(f as StoredPerformanceFeature).workoutId!==stored.workoutId),stored];return stored;
  });
  h.publish.mockImplementation(async(_:unknown,input:Record<string,unknown>)=>({current:{revision:1,payload:input.payload},snapshotCreated:true,documentsRead:3,documentsWritten:2}));
});
afterEach(()=>vi.useRealTimers());

describe("manual performance workflow",()=>{
  it("module import does not load or calculate anything",()=>{expect(h.reads).not.toHaveBeenCalled();expect(h.extract).not.toHaveBeenCalled();});
  it("disabled workflow stops before all reads and writes",async()=>{h.enabled=false;await expect(prepareManualPerformanceReview(session)).rejects.toThrow("disabled");expect(h.reads).not.toHaveBeenCalled();});
  it("review reads bounded parents and features without any child telemetry or writes",async()=>{
    const review=await prepareManualPerformanceReview(session);expect(review.candidates[0]).toMatchObject({status:"new",preselected:true});
    expect(h.extract).not.toHaveBeenCalled();expect(h.save).not.toHaveBeenCalled();expect(h.reads.mock.calls.every(([p])=>!p.endsWith("route"))).toBe(true);
  });
  it("only preselects three new runs and does no backfill",async()=>{h.parents=Array.from({length:10},(_,i)=>parent(`run-${i}`));const review=await prepareManualPerformanceReview(session);expect(review.candidates.filter(c=>c.preselected)).toHaveLength(3);expect(h.extract).not.toHaveBeenCalled();});
  it("shows incomplete parent evidence and missing completion concerns",async()=>{h.parents=[parent("run-1",{routeComplete:false}),parent("run-2",{routeComplete:undefined})];const review=await prepareManualPerformanceReview(session);expect(review.candidates[0].status).toBe("incomplete");expect(review.candidates[1].concerns.join(" ")).toContain("absent");});
  it("requires at least one selected workout",async()=>{const review=await prepareManualPerformanceReview(session);await expect(runManualPerformanceUpdate(session,review,{...options,selectedWorkoutIds:[]},vi.fn())).rejects.toThrow("Select at least");expect(h.extract).not.toHaveBeenCalled();});
  it("requires readiness confirmation",async()=>{const review=await prepareManualPerformanceReview(session);await expect(runManualPerformanceUpdate(session,review,{...options,userConfirmedReady:false as true},vi.fn())).rejects.toThrow("confirm");});
  it("rejects arbitrary or session-replaced review input",async()=>{const review=await prepareManualPerformanceReview(session);await expect(runManualPerformanceUpdate({...session},review,options,vi.fn())).rejects.toThrow("Review expired");});
  it("prevents disabling gate between review and execution",async()=>{const review=await prepareManualPerformanceReview(session);h.enabled=false;await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("disabled");expect(h.save).not.toHaveBeenCalled();});
  it("publishes actual partial evidence with a null half-marathon estimate",async()=>{
    const review=await prepareManualPerformanceReview(session);const progress=vi.fn();const outcome=await runManualPerformanceUpdate(session,review,options,progress);
    expect(outcome.snapshotCreated).toBe(true);expect(outcome.processedWorkoutIds).toEqual(["run-1"]);
    const input=h.publish.mock.calls[0][1];expect(input.payload.historyBasis).toBe("actual_calculation");
    expect(input.payload.result.capability).toMatchObject({estimatedSeconds:null,confidenceInterval:null});
    expect(input.payload.result.completeness.coverage.telemetry).toBe("partial");expect(input.features).toHaveLength(1);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({completed:1,selected:1});
  });
  it("always fetches fresh telemetry for selected previously analyzed workouts",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());
    review=await prepareManualPerformanceReview(session);expect(review.candidates[0].status).toBe("analyzed");
    h.extract.mockClear();await runManualPerformanceUpdate(session,review,{...options,forceReprocessWorkoutIds:["run-1"]},vi.fn());expect(h.extract).toHaveBeenCalledOnce();
  });
  it("captures changed HR children on a forced run even while parent identity is unchanged",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());
    const first=h.publish.mock.calls[0][1];const prior=h.features[0] as StoredPerformanceFeature;
    const parentDigest=prior.workout.parentDigest;const telemetryDigest=prior.feature.telemetryDigest;
    h.telemetryHr=162;
    review=await prepareManualPerformanceReview(session);expect(review.candidates[0].status).toBe("analyzed");
    const outcome=await runManualPerformanceUpdate(session,review,{...options,forceReprocessWorkoutIds:["run-1"]},vi.fn());
    const stored=h.features[0] as StoredPerformanceFeature;
    expect(stored.workout.parentDigest).toBe(parentDigest);expect(stored.feature.telemetryDigest).not.toBe(telemetryDigest);
    expect(stored.feature.observations[0].medianHrBpm).toBe(162);
    expect(h.publish.mock.calls[1][1].publicationDigest).not.toBe(first.publicationDigest);expect(outcome.snapshotCreated).toBe(true);
  });
  it("creates a new evidence identity for another independent run even when median speed does not change",async()=>{
    h.parents=[parent("run-1"),parent("run-2"),parent("run-3")];
    let review=await prepareManualPerformanceReview(session);
    await runManualPerformanceUpdate(session,review,{...options,selectedWorkoutIds:["run-1","run-2","run-3"]},vi.fn());
    const first=h.publish.mock.calls[0][1];
    h.parents=[...h.parents,parent("run-4")];review=await prepareManualPerformanceReview(session);
    const outcome=await runManualPerformanceUpdate(session,review,{...options,selectedWorkoutIds:["run-4"]},vi.fn());
    const second=h.publish.mock.calls[1][1];
    expect(first.payload.result.aerobic.bands[0].currentMedianSpeedMps).toBe(second.payload.result.aerobic.bands[0].currentMedianSpeedMps);
    expect(second.payload.result.aerobic.independentWorkoutCount).toBe(4);
    expect(second.publicationDigest).not.toBe(first.publicationDigest);expect(outcome.snapshotCreated).toBe(true);
  });
  it("rejects a duplicate in-flight update and releases the guard after completion",async()=>{
    const review=await prepareManualPerformanceReview(session);
    const delegate=h.extract.getMockImplementation()!;
    let release!:()=>void;let markStarted!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{markStarted=resolve;});
    h.extract.mockImplementationOnce(async(...args:unknown[])=>{markStarted();await blocked;return delegate(...args);});
    const first=runManualPerformanceUpdate(session,review,options,vi.fn());await started;
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("already running");
    release();await first;expect(h.extract).toHaveBeenCalledOnce();expect(h.publish).toHaveBeenCalledOnce();
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).resolves.toMatchObject({processedWorkoutIds:["run-1"]});
  });
  it("reuses compatible unselected extraction receipts without reading their children",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());
    h.parents.push(parent("run-2"));review=await prepareManualPerformanceReview(session);h.extract.mockClear();
    await runManualPerformanceUpdate(session,review,{...options,selectedWorkoutIds:["run-2"]},vi.fn());
    expect(h.extract).toHaveBeenCalledOnce();expect(h.extract.mock.calls[0][0].workout.workoutId).toBe("run-2");expect(h.publish.mock.calls.at(-1)?.[1].features).toHaveLength(2);
  });
  it("invalidates changed parents and incompatible feature versions",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());
    h.parents=[parent("run-1",{durationSeconds:1900})];review=await prepareManualPerformanceReview(session);expect(review.candidates[0].status).toBe("changed");
    h.parents=[parent()];(h.features[0] as StoredPerformanceFeature).feature.extractorVersion="old";review=await prepareManualPerformanceReview(session);expect(review.candidates[0].status).toBe("changed");
  });
  it("does not use rejected old evidence after exclusion",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());
    h.overrides=[{id:"run-1",data:{workoutId:"run-1",userId:"owner",isExcluded:true}}];review=await prepareManualPerformanceReview(session);
    h.extract.mockClear();await runManualPerformanceUpdate(session,review,options,vi.fn());expect(h.extract).not.toHaveBeenCalled();expect(h.publish.mock.calls.at(-1)?.[1].features).toHaveLength(0);
  });
  it("binds override UID to authenticated owner",async()=>{h.overrides=[{id:"run-1",data:{workoutId:"run-1",userId:"other"}}];await expect(prepareManualPerformanceReview(session)).rejects.toThrow("ownership");});
  it("does not publish after failed feature writes and permits retry",async()=>{
    const review=await prepareManualPerformanceReview(session);h.save.mockRejectedValueOnce(new Error("permission denied"));
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("permission denied");expect(h.publish).not.toHaveBeenCalled();
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).resolves.toMatchObject({snapshotCreated:true});
  });
  it("aborts publication after a detectable parent correction during extraction",async()=>{
    const review=await prepareManualPerformanceReview(session);const delegate=h.extract.getMockImplementation()!;
    h.extract.mockImplementationOnce(async(...args:unknown[])=>{const result=await delegate(...args);h.parents=[parent("run-1",{distanceMeters:5500})];return result;});
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("inputs changed during analysis");
    expect(h.features).toHaveLength(1);expect(h.publish).not.toHaveBeenCalled();
  });
  it("aborts publication after an override changes during extraction",async()=>{
    const review=await prepareManualPerformanceReview(session);const delegate=h.extract.getMockImplementation()!;
    h.extract.mockImplementationOnce(async(...args:unknown[])=>{const result=await delegate(...args);h.overrides=[{id:"run-1",data:{workoutId:"run-1",userId:"owner",isExcluded:true}}];return result;});
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("inputs changed during analysis");expect(h.publish).not.toHaveBeenCalled();
  });
  it("aborts publication after recorded run membership changes during extraction",async()=>{
    const review=await prepareManualPerformanceReview(session);const delegate=h.extract.getMockImplementation()!;
    h.extract.mockImplementationOnce(async(...args:unknown[])=>{const result=await delegate(...args);h.parents=[...h.parents,parent("run-2")];return result;});
    await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("inputs changed during analysis");expect(h.publish).not.toHaveBeenCalled();
  });
  it("does not claim success after publication failure",async()=>{const review=await prepareManualPerformanceReview(session);h.publish.mockRejectedValueOnce(new Error("network interruption"));await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("network interruption");expect(h.features).toHaveLength(1);});
  it("aborts when session changes during acquisition",async()=>{const review=await prepareManualPerformanceReview(session);h.extract.mockImplementationOnce(async()=>{h.validSession=false;throw new Error("session changed");});await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("session changed");expect(h.save).not.toHaveBeenCalled();});
  it("preserves a deterministic publication identity when only actual calculation time changes",async()=>{
    let review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());const first=h.publish.mock.calls[0][1];
    vi.setSystemTime(new Date("2026-10-21T15:00:00Z"));review=await prepareManualPerformanceReview(session);await runManualPerformanceUpdate(session,review,options,vi.fn());const second=h.publish.mock.calls[1][1];
    expect(first.payload.result.evidenceDigest).not.toBe(second.payload.result.evidenceDigest);expect(first.publicationDigest).toBe(second.publicationDigest);
  });
  it("does not publish truncated telemetry after a budget failure",async()=>{const review=await prepareManualPerformanceReview(session);h.extract.mockRejectedValueOnce(new Error("read budget exceeded"));await expect(runManualPerformanceUpdate(session,review,options,vi.fn())).rejects.toThrow("budget");expect(h.save).not.toHaveBeenCalled();expect(h.publish).not.toHaveBeenCalled();});
  it("converts no saved receipt into no reusable evidence",async()=>{expect(await reusablePerformanceReceipt({parentDigest:"x"} as EffectivePerformanceWorkout)).toBeNull();});
});
