import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { AppDataContextValue } from "@/contexts/AppDataContext";
import type { SavedPerformanceCurrent } from "@/types/performancePersistence";
import { ASSESSMENT_NOW, savedPerformanceFixture } from "@/utils/__tests__/fixtures/savedPerformanceFixture";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  app: {} as AppDataContextValue, user: {} as User, epoch: 1, valid: true,
  capture: vi.fn(), load: vi.fn(), estimator: vi.fn(), review: vi.fn(), run: vi.fn(),
}));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => h.app }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, sessionEpoch: h.epoch, isSessionCurrent, loading: false }) }));
vi.mock("@/services/performancePersistence", () => ({ capturePerformanceSession: h.capture, getSavedPerformance: h.load }));
vi.mock("@/services/manualPerformance", () => ({
  createManualPerformanceSession: h.capture, getManualPerformanceGate: () => ({ enabled: true, reason: null }),
  prepareManualPerformanceReview: h.review, runManualPerformanceUpdate: h.run, MANUAL_PERFORMANCE_SELECTION_LIMIT: 20,
}));
vi.mock("@/utils/experimentalCurrentPerformance", async original => {
  const actual = await original<typeof import("@/utils/experimentalCurrentPerformance")>();
  return { ...actual, estimateCurrentHalfMarathon: (...args: Parameters<typeof actual.estimateCurrentHalfMarathon>) => {
    h.estimator(...args); return actual.estimateCurrentHalfMarathon(...args);
  } };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/plan-insights", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: vi.fn(() => { throw new Error("No telemetry"); }) }));

import { PerformanceEvidenceProvider, usePerformanceEvidence } from "../PerformanceEvidenceContext";
import { PerformanceEvidenceStatus } from "@/components/insights/PerformanceEvidenceStatus";
import { PerformanceAnalysisPanel } from "@/components/PerformanceAnalysisPanel";
import PlanInsightsPage from "@/app/(app)/plan-insights/page";

let root: Root, container: HTMLDivElement, saved: SavedPerformanceCurrent;
let view: "none" | "plan" | "personal" | "both" | "actual-plan";
let latest: ReturnType<typeof usePerformanceEvidence>;
const isSessionCurrent = (epoch: number) => h.valid && epoch === h.epoch;
function Probe() { const value = usePerformanceEvidence(); React.useLayoutEffect(() => { latest = value; }); return null; }
function Harness() {
  return <PerformanceEvidenceProvider user={h.user} sessionEpoch={h.epoch} isSessionCurrent={isSessionCurrent}>
    {view !== "none" && <Probe />}
    {(view === "plan" || view === "both") && <PerformanceEvidenceStatus />}
    {(view === "personal" || view === "both") && <PerformanceAnalysisPanel />}
    {view === "actual-plan" && <PlanInsightsPage />}
  </PerformanceEvidenceProvider>;
}
async function render(next = view) { view = next; await act(async () => root.render(<Harness />)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(ASSESSMENT_NOW));
  saved = await savedPerformanceFixture();
  h.user = { uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as User;
  h.epoch = 1; h.valid = true;
  h.app = { workouts: [], overrides: {}, plans: [], races: [], maxHr: 185, restingHr: 55,
    trainingActivated: true, trainingActive: true, workoutsRefreshing: false, workoutsFullReconciliationVersion: 1,
    plansLoading: false, plansRefreshing: false, racesLoading: false, racesRefreshing: false,
    overridesLoading: false, overridesRefreshing: false, settingsLoading: false, settingsRefreshing: false,
    userSettings: null, workoutsMutationVersion: 0,
    refreshWorkouts: vi.fn(async () => {}), refreshPlans: vi.fn(async () => {}), patchPlan: vi.fn(),
    refreshRaces: vi.fn(async () => {}), refreshOverrides: vi.fn(async () => {}), refreshSettings: vi.fn(async () => {}),
    patchRaces: vi.fn(), patchOverrides: vi.fn(), publishWorkout: vi.fn(), removeWorkout: vi.fn(), patchTrainingLoad: vi.fn(),
    sourceHasLoaded: { workouts: true, overrides: true, plans: true, races: true, settings: true },
    workoutsLoading: false, workoutsResolution: "success", overridesResolution: "success", plansResolution: "success",
    racesResolution: "success", settingsResolution: "success", workoutsHistoryComplete: true };
  h.capture.mockResolvedValue({ uid: "owner", sessionEpoch: 1 }); h.load.mockResolvedValue({ current: saved, documentsRead: 1 });
  view = "none"; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("shared Insights owner and presentation", () => {
  it("keeps a non-Insights session dormant", async () => {
    await render(); expect(h.capture).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
  });
  it.each(["plan", "personal"] as const)("shares a cold %s entry across navigation and concurrent consumers", async first => {
    await render(first); await render("both"); await render("none"); await render(first);
    expect(h.load).toHaveBeenCalledOnce(); expect(h.capture).toHaveBeenCalledOnce();
    expect(latest.state.current).toBe(saved); expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it("deduplicates Strict Mode concurrent consumer effects", async () => {
    view = "both"; await act(async () => root.render(<React.StrictMode><Harness /></React.StrictMode>));
    expect(h.load).toHaveBeenCalledOnce(); expect(latest.state.current).toBe(saved);
  });
  it("distinguishes successful absence and failed load without automatic retry", async () => {
    h.load.mockRejectedValueOnce(new Error("Synthetic denied")); await render("both");
    expect(latest.freshness.status).toBe("unable_to_verify"); expect(container.textContent).not.toContain("No saved detailed");
    await render("plan"); expect(h.load).toHaveBeenCalledOnce();
    h.load.mockResolvedValueOnce({ current: null, documentsRead: 1 });
    await act(async () => { await latest.retry(); });
    expect(latest.freshness.status).toBe("no_saved_analysis");
  });
  it("replaces the owner epoch while a read is pending, ignoring the old result", async () => {
    const pending = deferred<{ current: SavedPerformanceCurrent; documentsRead: number }>();
    h.load.mockReturnValueOnce(pending.promise); await render("plan");
    h.epoch = 2; const replacement = { ...saved, snapshotId: "d".repeat(64) }; h.load.mockResolvedValue({ current: replacement, documentsRead: 1 });
    await render("both"); await act(async () => pending.resolve({ current: saved, documentsRead: 1 }));
    expect(latest.state.current).toBe(replacement); expect(latest.evidence.owner).toEqual({ uid: "owner", sessionEpoch: 2 });
  });
  it("propagates confirmed/unchanged/failed publication without another read", async () => {
    await render("both");
    const next = structuredClone(saved); next.revision = 2; next.snapshotId = "d".repeat(64); next.publicationDigest = "e".repeat(64);
    await act(async () => latest.receivePublication(next, true));
    expect(latest.state.current).toBe(next); expect(container.querySelectorAll('[data-testid="performance-evidence-status"]')).toHaveLength(2);
    await act(async () => latest.receivePublication(structuredClone(next), false));
    expect(latest.state.current).toBe(next); expect(latest.state.publication).toBe("unchanged");
    await act(async () => latest.failPublication("Conflict"));
    expect(latest.state.current).toBe(next); expect(container.textContent).toContain("last performance update failed"); expect(h.load).toHaveBeenCalledOnce();
  });
  it("updates both inline statuses for loaded new evidence without review or processing", async () => {
    await render("both"); const fixture = currentFixture();
    h.app = { ...h.app, workouts: [...fixture.workouts] };
    await render(); const notices = [...container.querySelectorAll('[data-testid="performance-evidence-status"]')];
    expect(notices.map(notice => notice.getAttribute("data-status"))).toEqual(["update_available", "update_available"]);
    expect(notices[0].textContent).toContain("may need updating"); expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });
  it("does not rerun the actual Plan estimator when only manual publication changes", async () => {
    const fixture = currentFixture(); vi.setSystemTime(new Date(fixture.asOf));
    h.app = { ...h.app, workouts: [...fixture.workouts], overrides: fixture.overrides ?? {}, races: [...fixture.races] };
    await render("actual-plan");
    const estimate = container.querySelector('[data-testid="experimental-current-estimate"]')?.textContent;
    expect(estimate).toBeTruthy(); const calls = h.estimator.mock.calls.length;
    await act(async () => latest.receivePublication({ ...saved, revision: 2, snapshotId: "d".repeat(64) }, true));
    expect(h.estimator).toHaveBeenCalledTimes(calls);
    expect(container.querySelector('[data-testid="experimental-current-estimate"]')?.textContent).toBe(estimate);
    expect(container.textContent).toContain("Race-day forecastWithheld");
  });
  it("publishes a successful manual update even after its panel navigates away", async () => {
    const pending = deferred<{ current: SavedPerformanceCurrent; snapshotCreated: boolean; processedWorkoutIds: string[]; skippedWorkoutIds: string[]; documentReads: number }>();
    h.review.mockResolvedValue({ candidates: [{ workoutId: "new", label: "New Run", startedAt: ASSESSMENT_NOW, status: "new", concerns: [], preselected: true }], documentsRead: 1, limitations: [], expectedCurrentRevision: 1 });
    h.run.mockReturnValue(pending.promise); await render("personal");
    async function click(text: string) { await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === text)!.click()); }
    await click("Update Performance");
    const ready = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.closest("label")?.textContent?.includes("finished syncing"))!;
    await act(async () => ready.click()); await click("Analyze 1 selected run"); await render("plan");
    await render("personal");
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Update Performance")?.disabled).toBe(true);
    await render("plan");
    const next = { ...saved, revision: 2, snapshotId: "d".repeat(64) };
    await act(async () => pending.resolve({ current: next, snapshotCreated: true, processedWorkoutIds: ["new"], skippedWorkoutIds: [], documentReads: 2 }));
    expect(latest.state.current).toBe(next); expect(h.load).toHaveBeenCalledOnce();
  });
});
