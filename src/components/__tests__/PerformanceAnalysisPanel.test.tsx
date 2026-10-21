import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuthState } from "@/hooks/useAuth";
import type { ManualPerformanceProgress, ManualPerformanceReview, ManualPerformanceUpdateResult, StoredPerformanceCurrent } from "@/services/manualPerformance";
import type { PerformanceAnalysisResult } from "@/types/performanceAnalysis";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  auth: {} as AuthState,
  gate: { enabled: true, reason: null as string | null },
  capture: vi.fn(), load: vi.fn(), review: vi.fn(), run: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => h.auth }));
vi.mock("@/services/manualPerformance", () => ({
  createManualPerformanceSession: h.capture,
  getManualPerformanceGate: () => h.gate,
  loadSavedPerformance: h.load,
  prepareManualPerformanceReview: h.review,
  runManualPerformanceUpdate: h.run,
  MANUAL_PERFORMANCE_SELECTION_LIMIT: 20,
}));

import { PerformanceAnalysisPanel } from "@/components/PerformanceAnalysisPanel";

const dayWindow = { startDate: "2026-09-24", endDate: "2026-10-21" };
function saved(calculatedAt = "2026-10-21T14:00:00Z"): StoredPerformanceCurrent {
  const result: PerformanceAnalysisResult = {
    versions: { schema: 1, model: "manual-performance-v1", extractor: "steady-interval-v1", qualityPolicy: "observational-v1" },
    asOf: calculatedAt, timeZone: "America/New_York", observationWindow: dayWindow,
    demonstratedRaces: [{ raceId: "race", workoutId: "race-run", raceDate: "2026-09-20", nominalDistanceMeters: 21097.5,
      copiedDurationSeconds: 7871, recordedDistanceMeters: 21409, durationSeconds: 7871, elapsedSeconds: 7871,
      timingBasis: "effective_workout_duration", officialChipTimeVerified: false, timingAgreement: "agrees",
      provenance: { source: "Workout-linked race", sourceId: "race", notes: [] }, limitations: ["Official time is unverified."] }],
    aerobic: { status: "insufficient", currentWindow: dayWindow, referenceWindow: dayWindow, independentWorkoutCount: 2,
      bands: [{ lowerBpmInclusive: 140, upperBpmExclusive: 145, currentWorkoutCount: 2, referenceWorkoutCount: 0,
        currentMedianSpeedMps: 3, referenceMedianSpeedMps: null, currentMedianHrBpm: 142, referenceMedianHrBpm: null,
        speedChangePct: null, status: "insufficient", observationDates: ["2026-10-20"] }], limitations: [] },
    deviceVo2: { status: "insufficient", currentWindow: dayWindow, referenceWindow: dayWindow, measurementDateCount: 0, latest: null, groups: [], measurements: [], limitations: [] },
    preparation: { recentWindow: dayWindow, longRunWindow: dayWindow, longRunDefinitionMeters: 12874.752,
      recent: { meters: 16093.44, seconds: 6000, runCount: 2, runDays: 2, runsPerWeek: 0.5 },
      longestRecentRun: { workoutId: "run-old", date: "2026-10-15", meters: 8046.72, seconds: 3000 }, longRunCount: 0,
      weekly: [], consistency: { completeWeeks: 0, weeksWithRuns: 1, fraction: null }, limitations: [] },
    capability: { distance: "half_marathon", status: "unavailable", estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_estimator" },
    completeness: { coverage: { window: dayWindow, workouts: "partial", telemetry: "partial", deviceVo2: "unknown", expectedWorkoutCount: null,
      limitations: ["Historical coverage is partial."] }, effectiveWorkoutCount: 10, acceptedFeatureCount: 2,
      unresolvedWorkoutIds: ["run-unknown"], rejectedWorkoutIds: ["run-invalid"] },
    warnings: [], limitations: ["Matching parent records do not prove unchanged child telemetry."], evidenceDigest: "a".repeat(64),
  };
  return { schemaVersion: 1, revision: 1, snapshotId: "s".repeat(64), previousSnapshotId: null, publicationDigest: "b".repeat(64),
    featureRevisions: [], committedAt: null,
    payload: { result, evidenceDigest: result.evidenceDigest, versions: result.versions, reason: "analyze_new_workouts", historyBasis: "actual_calculation",
      calculationStartedAt: calculatedAt, calculationCompletedAt: calculatedAt, evidenceAsOf: calculatedAt, provenance: [], coverage: result.completeness.coverage } };
}
function review(): ManualPerformanceReview {
  return { candidates: [
    { workoutId: "run-new", label: "Morning Run", startedAt: "2026-10-20T12:00:00Z", status: "new", concerns: [], preselected: true },
    { workoutId: "run-old", label: "Older Run", startedAt: "2026-10-15T12:00:00Z", status: "analyzed", concerns: ["Parent unchanged; child-only HR changes remain undetectable."], preselected: false },
    { workoutId: "run-changed", label: "Corrected Run", startedAt: "2026-10-14T12:00:00Z", status: "changed", concerns: ["Parent evidence changed."], preselected: false },
    { workoutId: "run-syncing", label: "Syncing Run", startedAt: "2026-10-13T12:00:00Z", status: "incomplete", concerns: ["Route incomplete; HR coverage uncertain."], preselected: false },
  ], documentsRead: 14, limitations: ["Review is bounded; additional history can be selected in later updates."], expectedCurrentRevision: 1 };
}
function success(snapshotCreated = true): ManualPerformanceUpdateResult {
  return { current: saved("2026-10-21T15:00:00Z"), snapshotCreated, processedWorkoutIds: ["run-new"], skippedWorkoutIds: [], documentReads: 270 };
}
let container: HTMLDivElement;
let root: Root;
async function mount() {
  container = document.createElement("div"); document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(<PerformanceAnalysisPanel />); });
}
function text() { return container.textContent ?? ""; }
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === label);
  expect(found, label).toBeTruthy(); return found!;
}
function selection(label: string) { return container.querySelector<HTMLInputElement>(`input[aria-label^="Select ${label} ("]`)!; }
function readiness() { return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest("label")?.textContent?.includes("My selected runs have finished syncing"))!; }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function setBudget(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  h.auth = { user: { uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as AuthState["user"], loading: false,
    authorizationStatus: "authorized", authorizationError: null, sessionEpoch: 1, isSessionCurrent: vi.fn(epoch => epoch === h.auth.sessionEpoch && h.auth.user !== null) };
  h.gate = { enabled: true, reason: null };
  h.capture.mockReset().mockResolvedValue({ uid: "owner", sessionEpoch: 1 });
  h.load.mockReset().mockResolvedValue(saved());
  h.review.mockReset().mockResolvedValue(review());
  h.run.mockReset().mockResolvedValue(success());
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("manual PerformanceAnalysisPanel", () => {
  it("loads only the saved receipt on mount and displays separate dated evidence with no numerical prediction", async () => {
    await mount();
    expect(h.load).toHaveBeenCalledOnce(); expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
    expect(button("Update Performance").disabled).toBe(false);
    expect(text()).toContain("Last calculated:"); expect(text()).toContain("2:11:11"); expect(text()).toContain("Sep 20, 2026");
    expect(text()).toContain("Official timing unverified"); expect(text()).toContain("Measured aerobic running");
    expect(text()).toContain("No device VO₂ max measurements"); expect(text()).toContain("10.0 miles");
    expect(text()).toContain("Current estimated half-marathon time: Unavailable"); expect(text()).toContain("validated numerical race prediction");
    expect(text()).toContain("Workouts: partial"); expect(text()).not.toMatch(/weekly reminder|stale|update due/i);
    await act(async () => root.render(<PerformanceAnalysisPanel />));
    expect(h.load).toHaveBeenCalledOnce(); expect(h.run).not.toHaveBeenCalled();
  });

  it("keeps saved results visible while the production gate disables review and writes", async () => {
    h.gate = { enabled: false, reason: "Updates are disabled pending owner Firebase Console setup." };
    await mount(); await click(button("Update Performance"));
    expect(button("Update Performance").disabled).toBe(true); expect(text()).toContain("pending owner Firebase Console setup");
    expect(text()).toContain("2:11:11"); expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });

  it("opens review only after Update is clicked and requires sync readiness before processing", async () => {
    h.load.mockResolvedValue(null); await mount();
    expect(text()).toContain("No saved performance analysis");
    await click(button("Update Performance"));
    expect(h.review).toHaveBeenCalledOnce(); expect(h.run).not.toHaveBeenCalled();
    expect(selection("Morning Run").checked).toBe(true); expect(selection("Older Run").checked).toBe(false);
    expect(text()).toContain("New / unprocessed"); expect(text()).toContain("Previously analyzed");
    expect(text()).toContain("Potentially changed"); expect(text()).toContain("Incomplete or uncertain"); expect(text()).toContain("Route incomplete; HR coverage uncertain");
    expect(button("Analyze 1 selected run").disabled).toBe(true);
    await click(readiness()); await click(button("Analyze 1 selected run"));
    expect(h.run.mock.calls[0][2]).toEqual({ selectedWorkoutIds: ["run-new"], forceReprocessWorkoutIds: [], userConfirmedReady: true, readBudget: 5000 });
    expect(h.run.mock.calls[0][0]).toBe(h.review.mock.calls[0][0]);
  });

  it("allows older workouts to be forced and invalidates readiness when selection changes", async () => {
    await mount(); await click(button("Update Performance")); await click(readiness());
    await click(selection("Morning Run")); expect(button("Analyze 0 selected runs").disabled).toBe(true);
    expect(readiness().checked).toBe(false);
    await click(selection("Older Run")); expect(text()).toContain("Selected for reprocessing (fresh telemetry)");
    await click(readiness()); await click(button("Analyze 1 selected run"));
    expect(h.run.mock.calls[0][2]).toMatchObject({ selectedWorkoutIds: ["run-old"], forceReprocessWorkoutIds: ["run-old"] });
  });

  it("preselects at most three new runs and does not select uncertain runs automatically", async () => {
    const data = review(); data.candidates = [0, 1, 2, 3, 4].map(index => ({ ...data.candidates[0], workoutId: `new-${index}`, label: `Run ${index}`, preselected: true }));
    h.review.mockResolvedValue(data); await mount(); await click(button("Update Performance"));
    expect([...container.querySelectorAll('fieldset input:checked')]).toHaveLength(3);
    expect(selection("Run 3").checked).toBe(false);
  });

  it("supports a no-new-runs review and disables processing with no selection", async () => {
    const data = review(); data.candidates = data.candidates.filter(candidate => candidate.status !== "new");
    h.review.mockResolvedValue(data); await mount(); await click(button("Update Performance"));
    expect(text()).toContain("No newly recorded runs were found");
    await click(readiness()); expect(button("Analyze 0 selected runs").disabled).toBe(true); expect(h.run).not.toHaveBeenCalled();
  });

  it("reports progress, blocks duplicate submission, and changes the display only after publication succeeds", async () => {
    let resolve!: (result: ManualPerformanceUpdateResult) => void;
    h.run.mockReturnValue(new Promise<ManualPerformanceUpdateResult>(done => { resolve = done; }));
    await mount(); await click(button("Update Performance")); await click(readiness());
    const analyze = button("Analyze 1 selected run");
    await act(async () => { analyze.click(); analyze.click(); });
    expect(h.run).toHaveBeenCalledOnce(); expect(analyze.disabled).toBe(true);
    const progressCallback = h.run.mock.calls[0][3] as (progress: ManualPerformanceProgress) => void;
    await act(async () => progressCallback({ selected: 1, completed: 0, skipped: 0, documentReads: 250, status: "Reading GPS page 1" }));
    expect(text()).toContain("Reading GPS page 1"); expect(text()).toContain("Selected: 1 · Completed: 0 · Skipped / rejected: 0 · Firestore document reads: 250");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-21T14:00:00Z");
    expect(text()).not.toContain("Performance analysis saved");
    await act(async () => resolve(success()));
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-21T15:00:00Z");
    expect(text()).toContain("new dated historical snapshot"); expect(text()).toContain("Processed workouts: run-new");
    expect(text()).toContain("does not certify that all historical telemetry is current");
  });

  it("retains the saved summary on failure and allows an explicit higher-budget retry", async () => {
    h.run.mockRejectedValueOnce(new Error("Read budget exceeded. Select a higher budget and retry."));
    await mount(); await click(button("Update Performance")); await click(readiness()); await click(button("Analyze 1 selected run"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Read budget exceeded");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-21T14:00:00Z"); expect(text()).not.toContain("Performance analysis saved");
    await setBudget("10000"); expect(readiness().checked).toBe(false);
    await click(readiness()); await click(button("Analyze 1 selected run"));
    expect(h.run).toHaveBeenCalledTimes(2); expect(h.run.mock.calls[1][2].readBudget).toBe(10000);
    expect(text()).toContain("Performance analysis saved");
  });

  it("rejects an invalid budget without invoking processing", async () => {
    await mount(); await click(button("Update Performance")); await setBudget("25001"); await click(readiness());
    expect(button("Analyze 1 selected run").disabled).toBe(true); expect(h.run).not.toHaveBeenCalled();
  });

  it("explains a deduplicated successful publication without claiming a new snapshot", async () => {
    h.run.mockResolvedValue(success(false)); await mount(); await click(button("Update Performance")); await click(readiness()); await click(button("Analyze 1 selected run"));
    expect(text()).toContain("evidence and result were unchanged; no duplicate historical snapshot");
  });

  it("shows permission errors without an update success", async () => {
    h.review.mockRejectedValue(new Error("Missing or insufficient permissions."));
    await mount(); await click(button("Update Performance"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("insufficient permissions");
    expect(text()).not.toContain("Performance analysis saved"); expect(h.run).not.toHaveBeenCalled(); expect(button("Update Performance").disabled).toBe(false);
  });

  it("reports a saved-read failure without claiming no saved analysis exists", async () => {
    h.load.mockRejectedValue(new Error("Saved result access denied."));
    await mount();
    expect(text()).toContain("The saved performance analysis could not be retrieved");
    expect(text()).toContain("Saved result access denied"); expect(text()).not.toContain("No saved performance analysis");
    expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });

  it("keeps a pending old-session saved read out of the next session", async () => {
    let resolve!: (value: StoredPerformanceCurrent) => void;
    h.load.mockReturnValueOnce(new Promise<StoredPerformanceCurrent>(done => { resolve = done; }));
    await mount();
    h.auth = { ...h.auth, sessionEpoch: 2 };
    h.load.mockResolvedValue(saved("2026-10-21T16:00:00Z"));
    await act(async () => root.render(<PerformanceAnalysisPanel />));
    await act(async () => resolve(saved("2026-10-21T12:00:00Z")));
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-21T16:00:00Z");
  });

  it("does not render or load records for an unauthorized account", async () => {
    h.auth = { ...h.auth, user: { uid: "other", email: "other@example.com", emailVerified: true } as AuthState["user"] };
    await mount(); expect(text()).toBe(""); expect(h.capture).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
  });

  it("ignores a pending update after sign-out", async () => {
    let resolve!: (result: ManualPerformanceUpdateResult) => void;
    h.run.mockReturnValue(new Promise<ManualPerformanceUpdateResult>(done => { resolve = done; }));
    await mount(); await click(button("Update Performance")); await click(readiness()); await click(button("Analyze 1 selected run"));
    h.auth = { ...h.auth, user: null, sessionEpoch: 2 };
    await act(async () => root.render(<PerformanceAnalysisPanel />));
    await act(async () => resolve(success()));
    expect(text()).toBe("");
  });
});
