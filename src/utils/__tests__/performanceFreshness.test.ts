import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessPerformanceFreshness, observePerformanceMetadata } from "../performanceFreshness";
import { adaptSavedManualPerformance } from "../sharedPerformanceEvidence";
import { ASSESSMENT_NOW, metadataRun, savedPerformanceFixture } from "./fixtures/savedPerformanceFixture";
import type { PerformanceFreshnessInput } from "@/types/performanceFreshness";
import type { WorkoutOverride } from "@/types/workoutOverride";

let input: PerformanceFreshnessInput;
beforeEach(async () => {
  input = { evidence: adaptSavedManualPerformance(await savedPerformanceFixture(), {
    retrieval: { status: "success", origin: "server", retrievedAt: ASSESSMENT_NOW, error: null },
  }), workouts: [metadataRun()], overrides: {}, sources: {
    workouts: { hasLoaded: true, resolution: "success" }, overrides: { hasLoaded: true, resolution: "success" },
  }, workoutsHistoryComplete: true, observation: null, now: ASSESSMENT_NOW };
});
const assess = () => assessPerformanceFreshness(input);
function observe() { input.observation = observePerformanceMetadata(input); }
function override(patch: Partial<WorkoutOverride> = {}): WorkoutOverride {
  return { workoutId: "incorporated", userId: "owner", isExcluded: false, excludedAt: null, excludedReason: null,
    distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: ASSESSMENT_NOW, ...patch };
}

describe("bounded automatic manual-performance freshness", () => {
  it("detects an eligible completed run after the actual saved cutoff", () => {
    input.workouts = [...input.workouts, metadataRun("new", "2026-11-03T12:00:00Z")];
    expect(assess()).toMatchObject({ status: "update_available", newWorkoutIds: ["new"] });
  });
  it("does not call historical missing features new runs", () => {
    input.workouts = [metadataRun("historical")];
    expect(assess()).toMatchObject({ status: "unable_to_verify", newWorkoutIds: [], uncertainWorkoutIds: ["historical"] });
  });
  it("does not reinterpret known rejected/unresolved history as newly recorded", () => {
    input.evidence.evidence!.value.analysis.completeness.unresolvedWorkoutIds = ["historical"];
    input.workouts = [metadataRun("historical")];
    expect(assess().status).toBe("no_detected_changes");
  });
  it("detects an older run newly visible after a full reconciliation within covered scope", () => {
    observe(); input.workouts = [...input.workouts, metadataRun("late", "2026-10-10T12:00:00Z")];
    expect(assess()).toMatchObject({ status: "update_available", newWorkoutIds: [], newlyVisibleWorkoutIds: ["late"] });
  });
  it("does not claim new visibility outside a bounded prior population", () => {
    input.workoutsHistoryComplete = false; observe();
    input.workouts = [...input.workouts, metadataRun("late", "2026-10-10T12:00:00Z")];
    expect(assess()).toMatchObject({ status: "unable_to_verify", newlyVisibleWorkoutIds: [] });
  });
  it("recognizes a changed source value against an actual session observation", () => {
    observe(); input.workouts = [{ ...input.workouts[0], durationSeconds: 1900 }];
    expect(assess()).toMatchObject({ status: "update_available", changedWorkoutIds: ["incorporated"] });
  });
  it("recognizes an override correction and exclusion against observed source values", () => {
    observe(); input.overrides = { incorporated: override({ isExcluded: true }) };
    expect(assess()).toMatchObject({ status: "update_available", changedWorkoutIds: ["incorporated"] });
  });
  it("does not turn a later sync or override timestamp alone into a verified correction", () => {
    input.overrides = { incorporated: override() }; observe();
    input.workouts = [{ ...input.workouts[0], syncedAt: new Date(ASSESSMENT_NOW) }];
    input.overrides = { incorporated: override({ updatedAt: "2026-11-04T15:00:00Z" }) };
    expect(assess().status).toBe("no_detected_changes");
  });
  it("does not invent prior digests from a feature manifest", () => {
    input.workouts = [{ ...input.workouts[0], durationSeconds: 1900 }];
    expect(assess()).toMatchObject({ status: "no_detected_changes", changedWorkoutIds: [] });
    expect(assess().limitations.join(" ")).toContain("no prior parent digest");
  });
  it("recognizes incomplete route upload without reading its children", () => {
    input.workouts = [{ ...metadataRun("incomplete", "2026-11-03T12:00:00Z"), routeComplete: false }];
    expect(assess()).toMatchObject({ status: "incomplete_sync", incompleteWorkoutIds: ["incomplete"], newWorkoutIds: [] });
  });
  it("keeps unknown child completeness unknown even with completed parents", () => {
    input.workouts = [{ ...input.workouts[0], routeComplete: undefined }]; observe();
    expect(assess().status).toBe("no_detected_changes");
    expect(assess().limitations.join(" ")).toContain("cannot verify GPS/HR completeness");
  });
  it("cannot establish child-only changes from unchanged parents", () => {
    observe(); expect(assess()).toMatchObject({ status: "no_detected_changes", changedWorkoutIds: [] });
    expect(assess().limitations.join(" ")).toContain("child-only corrections");
  });
  it("ignores historical records outside the manual observation scope", () => {
    input.workouts = [...input.workouts, metadataRun("old", "2025-01-01T12:00:00Z")];
    expect(assess().status).toBe("no_detected_changes");
  });
  it("caps parents before run filtering", () => {
    input.workouts = [...Array.from({ length: 300 }, (_, index) => ({ ...metadataRun(`nonrun-${index}`, "2026-11-03T12:00:00Z"), isRunLike: false })), metadataRun("late", "2026-10-10T12:00:00Z")];
    expect(assess().newlyVisibleWorkoutIds).toEqual([]); expect(assess().uncertainWorkoutIds).toEqual([]);
  });
  it("preserves partial coverage disclosures without claiming fully current", () => {
    input.workoutsHistoryComplete = false;
    expect(assess().status).toBe("no_detected_changes");
    expect(assess().limitations.join(" ")).toContain("bounded or partial");
  });
  it.each(["workouts", "overrides"] as const)("treats failed initial %s as unable, never no training", source => {
    input.sources[source] = { hasLoaded: false, resolution: "error" };
    expect(assess().status).toBe("unable_to_verify");
  });
  it("retains actionable resident evidence with a failed refresh disclosure", () => {
    input.workouts = [...input.workouts, metadataRun("new", "2026-11-03T12:00:00Z")];
    input.sources.workouts.resolution = "error";
    expect(assess()).toMatchObject({ status: "update_available", refreshFailed: true });
  });
  it("never claims no change when a refresh failed", () => {
    input.sources.overrides.resolution = "error";
    expect(assess().status).toBe("unable_to_verify");
  });
  it("distinguishes checking from success and saved-result absence", () => {
    input.sources.workouts = { hasLoaded: false, resolution: "loading" };
    expect(assess().status).toBe("checking");
    input.evidence = adaptSavedManualPerformance(null, { retrieval: { status: "success", origin: "server", retrievedAt: ASSESSMENT_NOW, error: null } });
    expect(assess().status).toBe("no_saved_analysis");
  });
  it("does not classify new evidence without a legacy feature manifest", () => {
    input.evidence.evidence!.value.publication.featureRevisions = null;
    input.workouts = [metadataRun("new", "2026-11-03T12:00:00Z")];
    expect(assess()).toMatchObject({ status: "unable_to_verify", newWorkoutIds: [] });
  });
  it("does not reuse observations from a different publication", () => {
    observe(); input.observation!.publicationDigest = "different";
    input.workouts = [{ ...input.workouts[0], durationSeconds: 1900 }];
    expect(assess().changedWorkoutIds).toEqual([]);
  });
  it("does not include excluded, nonrunning, invalid or unfinished runs as new", () => {
    input.workouts = [{ ...metadataRun("incorporated", "2026-11-03T12:00:00Z"), isRunLike: false },
      { ...metadataRun("invalid", "2026-11-03T12:00:00Z"), distanceMeters: NaN }, metadataRun("excluded", "2026-11-03T12:00:00Z")];
    input.overrides = { excluded: { ...override({ isExcluded: true }), workoutId: "excluded" } };
    expect(assess().newWorkoutIds).toEqual([]);
  });
  it("is deterministic, leaves inputs untouched, and performs no IO or implicit clock reads", () => {
    const before = structuredClone(input);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No IO"));
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("No implicit clock"); });
    try { expect(assess()).toEqual(assess()); expect(input).toEqual(before); expect(network).not.toHaveBeenCalled(); }
    finally { clock.mockRestore(); network.mockRestore(); }
  });
});
