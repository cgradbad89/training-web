import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { SavedPerformanceCurrent } from "@/types/performancePersistence";
import type { RacePerformanceResult } from "@/types/racePerformance";
import type {
  CurrentCapabilityEvidence, EvidenceAdapterContext, EvidenceRetrieval,
  PerformanceRaceGoalContext, SavedManualEvidenceInput, WithheldRaceDayForecast,
} from "@/types/sharedPerformanceEvidence";
import { SHARED_PERFORMANCE_EVIDENCE_VERSION } from "@/types/sharedPerformanceEvidence";
import {
  adaptExperimentalCurrentPerformance, adaptRacePerformance, adaptSavedManualPerformance,
  createWithheldRaceDayOutlook, withholdRaceDayForecast, withholdValidatedCapability,
} from "../sharedPerformanceEvidence";
import {
  buildPerformanceSnapshotPayload, calculatePerformanceAnalysis, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS,
} from "../performanceAnalysis";
import { performanceObservationWindow, toEffectivePerformanceWorkout } from "../performanceEvidence";
import { DEFAULT_RACE_PERFORMANCE_POLICY, evaluateRacePerformance } from "../racePerformance";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { currentFixture } from "./fixtures/currentPerformanceFixture";
import { researchRace, workoutResearchFixture } from "./fixtures/workoutRaceResearchFixture";

const asOf = "2026-10-26T16:00:00.000Z";
const timeZone = "America/New_York";
const context: EvidenceAdapterContext = {
  owner: { uid: "synthetic-owner", sessionEpoch: 7 },
  retrieval: { status: "success", origin: "server", retrievedAt: "2026-11-04T15:00:00.000Z", error: null },
};
let saved: SavedPerformanceCurrent;

beforeAll(async () => {
  const { race, workout } = researchRace("manual-half", "2026-09-20", 7871);
  workout.distanceMeters = 21409; // Recorded overdistance must not shorten a race result.
  const effective = await toEffectivePerformanceWorkout({ workout, override: null, completion: "completed", availableAt: null });
  const result = await calculatePerformanceAnalysis({
    asOf, timeZone, workouts: [effective], features: [], deviceVo2: [],
    linkedRaces: [{ raceId: race.id, workoutId: workout.workoutId, raceDate: race.raceDate,
      nominalDistanceMeters: 21097.5, copiedDurationSeconds: 7871,
      provenance: { source: "Synthetic linked workout", sourceId: race.id, notes: ["Unverified official time"] }, limitations: [] }],
    versions: PERFORMANCE_VERSIONS, ...PERFORMANCE_DEFAULTS,
    coverage: { window: performanceObservationWindow(asOf, timeZone, 180), workouts: "partial",
      telemetry: "partial", deviceVo2: "partial", expectedWorkoutCount: null, limitations: ["Synthetic bounded history"] },
  });
  saved = {
    schemaVersion: 1, revision: 3, snapshotId: "a".repeat(64), previousSnapshotId: "b".repeat(64),
    publicationDigest: "c".repeat(64), committedAt: null,
    featureRevisions: [{ workoutId: workout.workoutId, revision: 2, featureDigest: "d".repeat(64) }],
    payload: buildPerformanceSnapshotPayload({ result, reason: "reprocess_selected_workouts",
      calculationStartedAt: asOf, calculationCompletedAt: "2026-10-26T16:00:12.000Z",
      provenance: [effective.provenance] }),
  };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function raceResult(status: "verified" | "owner_confirmed" | "recorded_unverified" | "inconsistent" = "owner_confirmed") {
  const fixture = researchRace("qualified-half", "2026-09-20", 7871, status !== "recorded_unverified");
  if (status === "verified") {
    fixture.race.performanceEvidence!.status = "verified";
    fixture.race.performanceEvidence!.kind = "official_race";
  }
  if (status === "inconsistent") fixture.workout.endDate = new Date(fixture.workout.endDate.getTime() + 600_000);
  return evaluateRacePerformance({ races: [fixture.race], workouts: [fixture.workout], asOf, timeZone });
}

describe("saved manual evidence read model", () => {
  it("accepts the existing persisted type without changing that type or schema", () => {
    expectTypeOf<SavedPerformanceCurrent>().toExtend<SavedManualEvidenceInput>();
    const model = adaptSavedManualPerformance(saved, context);
    expect(model.contractVersion).toBe(SHARED_PERFORMANCE_EVIDENCE_VERSION);
    expect(model.availability).toBe("available");
    expect(model.owner).toEqual(context.owner);
  });

  it("preserves measured values, race observations, eligibility, versions and evidence identity", () => {
    const value = adaptSavedManualPerformance(saved).evidence!.value;
    expect(value.analysis).toEqual(saved.payload.result);
    expect(value.analysis.demonstratedRaces[0]).toMatchObject({ durationSeconds: 7871,
      recordedDistanceMeters: 21409, officialChipTimeVerified: false });
    expect(value.analysis.completeness.unresolvedWorkoutIds).toEqual(saved.payload.result.completeness.unresolvedWorkoutIds);
    expect(value.analysis.capability.estimatedSeconds).toBeNull();
    expect(value.publication).toMatchObject({ schemaVersion: 1, revision: 3,
      snapshotId: saved.snapshotId, previousSnapshotId: saved.previousSnapshotId,
      publicationDigest: saved.publicationDigest, payloadEvidenceDigest: saved.payload.evidenceDigest,
      payloadVersions: saved.payload.versions, evidenceAsOf: asOf, reason: "reprocess_selected_workouts",
      historyBasis: "actual_calculation", featureRevisions: saved.featureRevisions });
  });

  it("does not promote linked workout timing into owner confirmation or a qualified benchmark", () => {
    const value = adaptSavedManualPerformance(saved).evidence!.value;
    expect(value.demonstratedRaces[0]).toMatchObject({ origin: "manual_linked_workout",
      confirmation: "unverified", independentSourceVerification: "not_established", benchmarkQualification: "not_assessed" });
    expect(value.workoutObservations).toBeNull();
  });

  it("keeps successful retrieval separate from partial coverage and unknown parent availability", () => {
    const model = adaptSavedManualPerformance(saved, context);
    expect(model.retrieval.status).toBe("success");
    expect(model.evidence!.metadata.coverage).toEqual(saved.payload.result.completeness.coverage);
    expect(model.evidence!.metadata.coverage.workouts).toBe("partial");
    expect(model.evidence!.metadata.coverage.telemetry).toBe("partial");
    expect(model.evidence!.metadata.parentAvailabilityThrough).toBeNull();
  });

  it("does not relabel old analysis as fresh because its saved document was retrieved today", () => {
    const model = adaptSavedManualPerformance(saved, { ...context, timeZone: "Pacific/Honolulu" });
    expect(model.evidence!.metadata).toMatchObject({ evidenceCutoff: asOf, timeZone,
      calculationStartedAt: asOf, calculationCompletedAt: "2026-10-26T16:00:12.000Z",
      latestIncludedWorkout: { workoutId: null, date: null } });
    expect(model.retrieval.retrievedAt).toBe("2026-11-04T15:00:00.000Z");
    expect(model.applicability).toEqual({ status: "not_assessed", assessedAt: null, reasons: [] });
  });

  it("represents missing legacy receipt metadata as unknown without inferring it from the result", () => {
    const model = adaptSavedManualPerformance({ payload: { result: saved.payload.result } });
    const evidence = model.evidence!;
    expect(evidence.value.analysis).toEqual(saved.payload.result);
    expect(evidence.metadata).toMatchObject({ evidenceCutoff: asOf, calculationStartedAt: null,
      calculationCompletedAt: null, provenance: null, parentAvailabilityThrough: null });
    expect(Object.values(evidence.value.publication).every(value => value === null)).toBe(true);
    expect(evidence.metadata.versions).toEqual({ model: "manual-performance-v1", extractor: "steady-interval-v2",
      qualityPolicy: "observational-v1", qualityPolicyDigest: null });
  });

  it("does not invoke or retain SDK timestamps; accepts only an explicitly normalized receipt time", () => {
    const sdkTimestamp = { toDate: vi.fn(() => { throw new Error("SDK conversion must stay outside the adapter"); }) };
    const input = { ...saved, committedAt: sdkTimestamp };
    expect(adaptSavedManualPerformance(input).evidence!.value.publication.committedAt).toBeNull();
    expect(adaptSavedManualPerformance(input, { committedAt: "2026-10-26T16:00:13.000Z" })
      .evidence!.value.publication.committedAt).toBe("2026-10-26T16:00:13.000Z");
    expect(sdkTimestamp.toDate).not.toHaveBeenCalled();
  });

  it("retains resident dated evidence after a failed refresh without claiming current applicability", () => {
    const model = adaptSavedManualPerformance(saved, { retrieval: { status: "error", origin: "server",
      retrievedAt: null, error: "permission-denied" } });
    expect(model.availability).toBe("available");
    expect(model.evidence!.value.analysis).toEqual(saved.payload.result);
    expect(model.retrieval.error).toBe("permission-denied");
    expect(model.applicability.status).toBe("not_assessed");
  });

  it("carries an explicit applicability assessment without recomputing saved history", () => {
    const applicability = { status: "inputs_changed" as const, assessedAt: "2026-11-04T15:00:00.000Z",
      reasons: ["A saved workout override changed"] };
    const model = adaptSavedManualPerformance(saved, { applicability });
    expect(model.applicability).toEqual(applicability);
    expect(model.evidence!.value.analysis).toEqual(saved.payload.result);
    expect(model.evidence!.value.publication.snapshotId).toBe(saved.snapshotId);
  });

  it("detaches results and metadata so consumers cannot mutate the saved record or caller context", () => {
    const before = structuredClone(saved);
    const model = adaptSavedManualPerformance(saved, context);
    model.evidence!.value.analysis.preparation.recent.meters = 1;
    model.evidence!.value.publication.featureRevisions![0].revision = 99;
    model.owner!.uid = "changed";
    model.retrieval.retrievedAt = null;
    expect(saved).toEqual(before);
    expect(context.owner!.uid).toBe("synthetic-owner");
    expect(context.retrieval!.retrievedAt).not.toBeNull();
  });
});

describe("missing evidence and initial source failures", () => {
  it.each([
    ["unknown", "not_loaded"], ["not_loaded", "not_loaded"], ["loading", "not_loaded"],
    ["error", "unavailable"], ["success", "absent"],
  ] as const)("keeps %s retrieval distinct from evidence absence", (status, availability) => {
    const retrieval: EvidenceRetrieval = { status, origin: "unknown", retrievedAt: null,
      error: status === "error" ? "offline" : null };
    const models = [adaptSavedManualPerformance(null, { retrieval }), adaptRacePerformance(null, { retrieval }),
      adaptExperimentalCurrentPerformance(null, true, { retrieval })];
    for (const model of models) {
      expect(model.availability).toBe(availability);
      expect(model.retrieval).toEqual(retrieval);
      expect(model.evidence).toBeNull();
    }
  });
});

describe("existing Race Performance evidence", () => {
  it.each(["verified", "owner_confirmed", "recorded_unverified", "inconsistent"] as const)
    ("preserves %s eligibility and timing without rerunning qualification", status => {
      const original = raceResult(status);
      const before = structuredClone(original);
      const value = adaptRacePerformance(original).evidence!.value;
      expect(value.result).toEqual(before);
      expect(value.demonstratedRaces[0].observation).toEqual(before.evidence[0]);
      expect(value.validatedCapability.estimatedSeconds).toBeNull();
      expect(value.futureForecast.estimatedSeconds).toBeNull();
      expect(original).toEqual(before);
    });

  it("distinguishes reported source verification from owner confirmation and independent verification", () => {
    const verified = adaptRacePerformance(raceResult("verified")).evidence!.value.demonstratedRaces[0];
    const owner = adaptRacePerformance(raceResult("owner_confirmed")).evidence!.value.demonstratedRaces[0];
    expect(verified.confirmation).toBe("reported_verified");
    expect(owner.confirmation).toBe("owner_confirmed");
    expect(verified.independentSourceVerification).toBe("not_established");
    expect(owner.independentSourceVerification).toBe("not_established");
  });

  it("preserves missing legacy confirmation chronology rather than inventing a revision", () => {
    const original = raceResult();
    delete original.evidence[0].confirmationRevisionId;
    delete original.evidence[0].confirmationChronology;
    const observation = adaptRacePerformance(original).evidence!.value.demonstratedRaces[0].observation;
    expect(observation).not.toHaveProperty("confirmationRevisionId");
    expect(observation).not.toHaveProperty("confirmationChronology");
  });

  it("does not infer query/telemetry coverage, latest workout, timezone, policy or completion time", () => {
    const fixture = researchRace("custom-policy", "2026-09-20", 7871);
    const result = evaluateRacePerformance({ races: [fixture.race], workouts: [fixture.workout], asOf, timeZone,
      policy: { ...DEFAULT_RACE_PERFORMANCE_POLICY, version: "synthetic-custom-policy" } });
    const basis = adaptRacePerformance(result, context).evidence!.metadata;
    expect(basis).toMatchObject({ evidenceCutoff: asOf, timeZone: null, calculationStartedAt: null,
      calculationCompletedAt: null, latestIncludedWorkout: { workoutId: null, date: null },
      parentAvailabilityThrough: null, coverage: { workouts: "unknown", telemetry: "unknown", window: null },
      versions: { model: result.version, qualityPolicy: null } });
    expect(adaptRacePerformance(result, { timeZone }).evidence!.metadata.timeZone).toBe(timeZone);
  });

  it("does not alter research equivalents or convert them into capability", () => {
    const fixture = researchRace("ten-k", "2026-09-20", 3600, true);
    fixture.race.raceDistance = "10K";
    fixture.race.performanceEvidence!.distanceMeters = 10000;
    fixture.workout.distanceMeters = 10000;
    fixture.workout.distanceMiles = 10000 / 1609.344;
    const result = evaluateRacePerformance({ races: [fixture.race], workouts: [fixture.workout], asOf, timeZone });
    expect(result.researchEquivalences).toHaveLength(2);
    const value = adaptRacePerformance(result).evidence!.value;
    expect(value.result.researchEquivalences).toEqual(result.researchEquivalences);
    expect(value.validatedCapability).toEqual(withholdValidatedCapability());
  });
});

describe("experimental current capability and withheld forecasts", () => {
  it.each([
    ["stable", () => currentFixture()], ["stronger", () => currentFixture(1.5, 4, 9)],
    ["reduced", () => currentFixture(0.5, 2, 4)], ["matched effort", () => workoutResearchFixture()],
  ] as const)("preserves %s numbers, anchor and adjustment evidence in native units", (_name, fixture) => {
    const estimate = estimateCurrentHalfMarathon(fixture());
    const before = structuredClone(estimate);
    const model = adaptExperimentalCurrentPerformance(estimate, true, { timeZone });
    const value = model.evidence!.value;
    expect(value.status).toBe("experimental");
    expect(value.validated).toBe(false);
    expect(value.confidenceInterval).toBeNull();
    expect(value).not.toHaveProperty("estimatedSeconds");
    expect(value.sourceEstimate).toEqual(before);
    expect(model.evidence!.metadata).toMatchObject({ evidenceCutoff: before.asOf,
      calculationCompletedAt: null, latestIncludedWorkout: { workoutId: null, date: before.dataThrough },
      versions: { model: before.version, extractor: null } });
    expect(model.evidence!.metadata.limitations).toEqual([...before.gaps, ...before.assumptions]);
    expect(estimate).toEqual(before);
  });

  it("withholds unsupported capability while retaining the original insufficiency explanation", () => {
    const input = currentFixture(); input.workouts = input.workouts.slice(0, 2);
    const estimate = estimateCurrentHalfMarathon(input);
    const value = adaptExperimentalCurrentPerformance(estimate, true).evidence!.value;
    expect(value).toMatchObject({ status: "withheld", validated: false, estimatedSeconds: null,
      reason: estimate.reason, sourceEstimate: estimate });
  });

  it("does not expose supplied numerical output when the caller's experiment gate is disabled", () => {
    const estimate = estimateCurrentHalfMarathon(currentFixture());
    const model = adaptExperimentalCurrentPerformance(estimate, false);
    expect(model.evidence!.value).toEqual({ kind: "current_capability", status: "withheld", validated: false,
      estimatedSeconds: null, confidenceInterval: null, reason: "experiment_not_enabled", sourceEstimate: null });
    expect(model.evidence!.metadata.evidenceCutoff).toBeNull();
  });

  it("provides no validated numerical capability branch", () => {
    expectTypeOf<CurrentCapabilityEvidence["status"]>().toEqualTypeOf<"experimental" | "withheld">();
    expect(withholdValidatedCapability()).toEqual({ status: "withheld", validated: false,
      estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_estimator" });
  });

  it("keeps future forecasts withheld independently of the owner's goal", () => {
    expectTypeOf<WithheldRaceDayForecast["estimatedSeconds"]>().toEqualTypeOf<null>();
    const estimate = estimateCurrentHalfMarathon(currentFixture());
    const capability = adaptExperimentalCurrentPerformance(estimate, true);
    const goal: PerformanceRaceGoalContext = { raceId: "future-goal", raceDate: "2027-03-20",
      distanceMeters: 21097.5, linkedPlanId: "plan", targetPaceSecondsPerMile: 500, targetFinishSeconds: 6500 };
    const first = createWithheldRaceDayOutlook(goal);
    const second = createWithheldRaceDayOutlook({ ...goal, targetFinishSeconds: 9000 });
    expect(first.goal).toEqual(goal);
    expect(first.forecast).toEqual(withholdRaceDayForecast());
    expect(second.forecast).toEqual(first.forecast);
    expect(createWithheldRaceDayOutlook().goal).toBeNull();
    expect(capability).not.toHaveProperty("goal");
    expect(capability.evidence!.value.sourceEstimate).not.toHaveProperty("goal");
    expect(adaptExperimentalCurrentPerformance(estimate, true)).toEqual(capability);
    first.goal!.targetFinishSeconds = 1;
    expect(goal.targetFinishSeconds).toBe(6500);
  });
});

describe("pure, unwired dependency boundary", () => {
  const adapterPath = resolve("src/utils/sharedPerformanceEvidence.ts");
  const contractPath = resolve("src/types/sharedPerformanceEvidence.ts");

  function runtimeImports(file: string): string[] {
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const parsed = ts.createSourceFile(file + ".js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) throw new Error("Dynamic runtime dependency in pure evidence layer");
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    return imports;
  }

  it("emits only its local contract dependency, with no SDK, services, model or extraction imports", () => {
    expect(runtimeImports(adapterPath)).toEqual(["@/types/sharedPerformanceEvidence"]);
    expect(runtimeImports(contractPath)).toEqual([]);
  });

  it("does not read a clock, environment, network or timer while adapting supplied results", () => {
    const result: RacePerformanceResult = raceResult();
    const estimate = estimateCurrentHalfMarathon(currentFixture());
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("No implicit clock"); });
    const fetch = vi.fn(() => { throw new Error("No network"); });
    vi.stubGlobal("fetch", fetch);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const env = process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE;
    const run = () => [adaptSavedManualPerformance(saved), adaptRacePerformance(result),
      adaptExperimentalCurrentPerformance(estimate, true), createWithheldRaceDayOutlook()];
    const first = run();
    process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE = env === "true" ? "false" : "true";
    try { expect(run()).toEqual(first); }
    finally {
      if (env === undefined) delete process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE;
      else process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE = env;
    }
    expect(clock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });

  it("limits application consumers to the explicit session boundary and type contracts", () => {
    function sources(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.name === "__tests__") return [];
        const file = resolve(directory, entry.name);
        return entry.isDirectory() ? sources(file) : /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|spec)\./.test(file) ? [file] : [];
      });
    }
    const consumers: string[] = [];
    for (const file of sources(resolve("src"))) {
      if (file === adapterPath || file === contractPath) continue;
      const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isStringLiteral(node)) {
          const imported = node.text.startsWith("@/") ? resolve("src", node.text.slice(2)) : resolve(dirname(file), node.text);
          if ([adapterPath, contractPath].some(target => imported === target || imported + ".ts" === target)) consumers.push(file);
        }
        ts.forEachChild(node, visit);
      }
      visit(parsed);
    }
    expect([...new Set(consumers)].sort()).toEqual([
      resolve("src/contexts/PerformanceEvidenceContext.tsx"),
      resolve("src/types/performanceFreshness.ts"),
    ].sort());
  });
});
