import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { AppDataContextValue } from "@/contexts/AppDataContext";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { SavedPerformanceCurrent } from "@/types/performancePersistence";
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import { ASSESSMENT_NOW, metadataRun, savedPerformanceFixture } from "@/utils/__tests__/fixtures/savedPerformanceFixture";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";

/** Synthetic owner data only. Exercises the real Plan page, shared provider and
 * pure freshness assessment; services are intercepted at their boundaries. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  app: {} as AppDataContextValue, user: {} as User, epoch: 1, valid: true,
  capture: vi.fn(), load: vi.fn(), review: vi.fn(), run: vi.fn(), hydrate: vi.fn(),
  estimates: [] as CurrentHalfEstimate[],
  firestore: { getDoc: vi.fn(), getDocs: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(), addDoc: vi.fn(),
    deleteDoc: vi.fn(), writeBatch: vi.fn(), runTransaction: vi.fn(), onSnapshot: vi.fn() },
}));
vi.mock("firebase/firestore", async original => ({ ...(await original<typeof import("firebase/firestore")>()), ...h.firestore }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => h.app }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, sessionEpoch: h.epoch, isSessionCurrent, loading: false }) }));
vi.mock("@/services/performancePersistence", () => ({ capturePerformanceSession: h.capture, getSavedPerformance: h.load }));
vi.mock("@/services/manualPerformance", () => ({
  createManualPerformanceSession: h.capture, getManualPerformanceGate: () => ({ enabled: true, reason: null }),
  prepareManualPerformanceReview: h.review, runManualPerformanceUpdate: h.run, MANUAL_PERFORMANCE_SELECTION_LIMIT: 20,
}));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: h.hydrate }));
vi.mock("@/utils/experimentalCurrentPerformance", async original => {
  const actual = await original<typeof import("@/utils/experimentalCurrentPerformance")>();
  return { ...actual, estimateCurrentHalfMarathon: (...args: Parameters<typeof actual.estimateCurrentHalfMarathon>) => {
    const result = actual.estimateCurrentHalfMarathon(...args); h.estimates.push(result); return result;
  } };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/plan-insights", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import { PerformanceEvidenceProvider } from "@/contexts/PerformanceEvidenceContext";
import PlanInsightsPage from "../page";

let root: Root, container: HTMLDivElement, saved: SavedPerformanceCurrent;
const isSessionCurrent = (epoch: number) => h.valid && epoch === h.epoch;
const fixture = currentFixture(1.5, 4, 9);
function Harness() {
  return <PerformanceEvidenceProvider user={h.user} sessionEpoch={h.epoch} isSessionCurrent={isSessionCurrent}>
    <PlanInsightsPage />
  </PerformanceEvidenceProvider>;
}
async function render() { await act(async () => root.render(<Harness />)); }
const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const dialog = () => q("estimate-details-dialog");
const trigger = () => q<HTMLButtonElement>("view-estimate-details")!;
async function open() { await act(async () => trigger().click()); return dialog()!; }
async function key(name: string, shiftKey = false) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true })); });
}
function withWorkouts(...extra: HealthWorkout[]) { h.app = { ...h.app, workouts: [...fixture.workouts, ...extra] }; }
const partial = (id: string, startedAt: string): HealthWorkout => ({ ...metadataRun(id, startedAt), routeComplete: false });
function incorporate(...ids: string[]) {
  saved.featureRevisions = [...fixture.workouts.map(w => w.workoutId), ...ids].map(workoutId => ({ workoutId, revision: 1, featureDigest: "c".repeat(64) }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

beforeEach(async () => {
  vi.resetAllMocks(); h.estimates = [];
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(ASSESSMENT_NOW));
  saved = await savedPerformanceFixture(); incorporate();
  h.user = { uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as User;
  h.epoch = 1; h.valid = true;
  h.app = { workouts: [...fixture.workouts], overrides: {}, plans: [], races: [...fixture.races], maxHr: 185, restingHr: 55,
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
  h.capture.mockResolvedValue({ uid: "owner", sessionEpoch: 1 });
  h.load.mockImplementation(async () => ({ current: saved, documentsRead: 1 }));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllEnvs();
  document.body.style.overflow = "";
});

describe("Plan Insights estimate tile and details modal", () => {
  it("shows the current estimate without opening the modal and drops the standalone evidence section", async () => {
    await render();
    const estimate = h.estimates.at(-1)!;
    expect(estimate.finishMinutes).not.toBeNull();
    const tile = q("experimental-current-estimate")!.textContent!;
    expect(tile).toContain(`~${Math.floor(estimate.finishMinutes! / 60)}:${String(estimate.finishMinutes! % 60).padStart(2, "0")}`);
    expect(tile).toContain(`~${Math.floor(estimate.paceSecondsPerMile! / 60)}:${String(estimate.paceSecondsPerMile! % 60).padStart(2, "0")}/mi`);
    expect(tile).toContain("Experimental"); expect(tile).toContain("Based on your Aug 30, 2026 race");
    expect(tile).toContain("Calculated as of:Nov 4, 2026"); expect(tile).toContain("Latest included run:");
    expect(dialog()).toBeNull(); expect(q("performance-evidence-status")).toBeNull();
    expect(container.textContent).not.toContain("Performance Evidence");
    expect(trigger().textContent).toBe("View Estimate Details");
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog"); expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Race-day forecastWithheld");
  });

  it("opens a labeled modal dialog, places and contains focus, and Escape returns focus to the trigger", async () => {
    await render(); trigger().focus();
    const view = await open();
    expect(view.getAttribute("role")).toBe("dialog"); expect(view.getAttribute("aria-modal")).toBe("true");
    const heading = document.getElementById(view.getAttribute("aria-labelledby")!)!;
    expect(heading.textContent).toBe("Estimate Details"); expect(document.activeElement).toBe(heading);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    const focusable = [...view.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), summary")];
    await key("Tab", true); expect(document.activeElement).toBe(focusable.at(-1));
    await key("Tab"); expect(document.activeElement).toBe(focusable[0]);
    focusable[0].focus(); await key("Tab", true); expect(document.activeElement).toBe(focusable.at(-1));
    await key("Escape");
    expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger()); expect(document.body.style.overflow).toBe("");
  });

  it("closes from the close button and backdrop, ignores inside clicks, and keeps sheet/centered layout contracts", async () => {
    await render();
    let view = await open();
    // Phone: near-full-height bottom sheet with safe areas, above the fixed tab bar (z-50).
    expect(view.className).toContain("rounded-t-2xl"); expect(view.className).toContain("h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)]");
    expect(view.className).toContain("max-w-full"); expect(view.lastElementChild!.className).toContain("overflow-x-hidden");
    expect(view.lastElementChild!.className).toContain("env(safe-area-inset-bottom)");
    // Desktop: centered, bounded dialog.
    expect(view.className).toContain("md:max-w-3xl"); expect(view.className).toContain("md:max-h-[90vh]");
    const backdrop = q("estimate-details-backdrop")!;
    expect(backdrop.className).toContain("z-[80]"); expect(backdrop.className).toContain("md:items-center");
    await act(async () => view.querySelector("h2")!.click()); expect(dialog()).not.toBeNull();
    await act(async () => view.querySelector<HTMLButtonElement>('button[aria-label="Close estimate details"]')!.click());
    expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger());
    view = await open(); expect(view).toBeTruthy();
    await act(async () => q("estimate-details-backdrop")!.click());
    expect(dialog()).toBeNull();
  });

  it("preserves the estimator's methodology values and disclosures without recalculating", async () => {
    await render(); const calls = h.estimates.length; const estimate = h.estimates.at(-1)!;
    const view = await open();
    const methodology = q("estimate-methodology")!.textContent!;
    const minutes = Math.round(estimate.adjustmentSeconds / 60);
    expect(q("training-adjustment")!.textContent).toContain(`${minutes < 0 ? "−" : "+"}${Math.abs(minutes)} min`);
    expect(methodology).toContain(`(${estimate.adjustmentSeconds} seconds)`);
    expect(methodology).toContain(`Race-equivalent baseline: `); expect(methodology).toContain(estimate.anchor!.name);
    expect(methodology).toContain("Recorded time; official result and maximal effort need confirmation");
    expect(methodology).toContain("Unvalidated training adjustment"); expect(methodology).toContain("No confidence interval is supported");
    expect(methodology).toContain("has not been validated for your individual accuracy");
    expect(methodology).toContain(`Model ${estimate.version}`); expect(methodology).toContain(`Calculation cutoff ${estimate.asOf}`);
    for (const gap of estimate.gaps) expect(methodology).toContain(gap);
    expect(view.querySelector("details summary")?.textContent).toBe("Model assumptions");
    expect(h.estimates.length).toBe(calls);
  });

  it("shows the shared saved analysis date and cutoff and separates manual measurements from the estimate", async () => {
    await render(); await open();
    const evidence = q("estimate-saved-evidence")!;
    expect(q("saved-evidence-dates")!.textContent).toBe("Last saved analysis:Oct 21, 2026Saved evidence cutoff:Oct 21, 2026");
    expect(evidence.querySelector(`time[dateTime="${saved.payload.result.asOf}"]`)).toBeTruthy();
    expect(q("evidence-estimate-separation")!.textContent).toContain("do not currently alter the experimental half-marathon estimate");
    expect(evidence.querySelector('a[href="/personal-insights#performance-analysis"]')).toBeTruthy();
    expect(evidence.textContent).toContain("No new actionable changes detected");
  });

  it("does not imply active syncing for historical partial-route markers", async () => {
    incorporate("h1", "h2", "h3");
    withWorkouts(partial("h1", "2026-09-01T12:00:00Z"), partial("h2", "2026-09-15T12:00:00Z"), partial("h3", "2026-10-01T12:00:00Z"));
    await render();
    expect(q("performance-evidence-notice")).toBeNull();
    await open();
    const evidence = q("estimate-saved-evidence")!.textContent!;
    expect(q("performance-evidence-status")!.getAttribute("data-status")).toBe("no_detected_changes");
    expect(evidence).not.toMatch(/wait for syncing|may still be syncing/i);
    expect(q("historical-incomplete-summary")!.textContent).toContain("3 older runs still carry a partial-route marker");
    expect(q("historical-incomplete-summary")!.textContent).toContain("3 included in the saved analysis");
    expect(q("historical-incomplete-summary")!.textContent).toContain("does not show that an upload is in progress");
    const links = [...q("evidence-historical-incomplete")!.querySelectorAll("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual(["/runs/h3", "/runs/h2", "/runs/h1"]);
    expect(links[0].textContent).toBe("Run · Oct 1, 2026");
  });

  it("keeps a recent genuinely incomplete upload identifiable in the tile and details", async () => {
    withWorkouts(partial("recent", "2026-11-03T12:00:00Z"));
    await render();
    expect(q("performance-evidence-notice")!.textContent).toContain("1 recent run reports a partial route or unfinished upload. It may still be syncing");
    await open();
    expect(q("performance-evidence-status")!.getAttribute("data-status")).toBe("incomplete_sync");
    expect(q("evidence-recent-incomplete")!.querySelector('a[href="/runs/recent"]')?.textContent).toBe("Run · Nov 3, 2026");
  });

  it("continues to surface new actionable runs with an update notice and review link", async () => {
    withWorkouts(metadataRun("new", "2026-11-03T12:00:00Z"));
    await render();
    expect(q("performance-evidence-notice")!.textContent).toContain("1 loaded run warrants review");
    await open();
    expect(q("evidence-new-runs")!.textContent).toContain("completed after the saved cutoff");
    expect(q("evidence-new-runs")!.querySelector('a[href="/runs/new"]')).toBeTruthy();
    expect(q("estimate-saved-evidence")!.querySelector('a[href="/personal-insights#performance-analysis"]')?.textContent)
      .toBe("Review Performance Updates in Personal Insights");
    expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
  });

  it("handles a failed saved-state read safely, keeping the estimate and offering only an explicit retry", async () => {
    h.load.mockRejectedValueOnce(new Error("Synthetic denied"));
    await render();
    expect(q("estimate-values")).toBeTruthy();
    expect(q("performance-evidence-notice")!.textContent).toContain("Saved performance evidence could not be loaded");
    await open();
    expect(q("saved-evidence-dates")!.textContent).toBe("Last saved analysis:UnavailableSaved evidence cutoff:Unavailable");
    const retry = [...dialog()!.querySelectorAll("button")].find(button => button.textContent === "Retry saved analysis load")!;
    expect(retry).toBeTruthy(); expect(h.load).toHaveBeenCalledOnce();
    await act(async () => retry.click());
    expect(h.load).toHaveBeenCalledTimes(2); expect(q("saved-evidence-dates")!.textContent).toContain("Oct 21, 2026");
  });

  it("distinguishes successfully absent saved evidence", async () => {
    h.load.mockResolvedValue({ current: null, documentsRead: 1 });
    await render(); await open();
    expect(q("estimate-saved-evidence")!.textContent).toContain("No saved detailed performance analysis");
    expect(q("saved-evidence-dates")!.textContent).toBe("Last saved analysis:None savedSaved evidence cutoff:Unavailable");
  });

  it("does not read saved state again when the modal closes and reopens", async () => {
    await render(); expect(h.load).toHaveBeenCalledOnce();
    for (let i = 0; i < 3; i++) { await open(); await key("Escape"); }
    await open(); expect(q("saved-evidence-dates")!.textContent).toContain("Oct 21, 2026");
    expect(h.load).toHaveBeenCalledOnce(); expect(h.capture).toHaveBeenCalledOnce();
  });

  it("performs no GPS/HR, split, feature or Firestore reads and no writes while viewing details", async () => {
    withWorkouts(metadataRun("new", "2026-11-03T12:00:00Z"), partial("h1", "2026-09-01T12:00:00Z"));
    await render(); await open(); await key("Escape"); await open();
    for (const [name, fn] of Object.entries(h.firestore)) expect(fn, name).not.toHaveBeenCalled();
    expect(h.hydrate).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
    expect(h.load).toHaveBeenCalledOnce();
  });

  it("does not expose a previous owner's saved evidence after an authentication change", async () => {
    await render(); await open();
    expect(q("saved-evidence-dates")!.textContent).toContain("Oct 21, 2026");
    const pending = deferred<{ current: SavedPerformanceCurrent | null; documentsRead: number }>();
    h.epoch = 2; h.load.mockReturnValueOnce(pending.promise);
    await render();
    if (!dialog()) await open();
    expect(q("saved-evidence-dates")!.textContent).toBe("Last saved analysis:UnavailableSaved evidence cutoff:Unavailable");
    expect(q("estimate-saved-evidence")!.textContent).toContain("Checking saved performance evidence");
    await act(async () => pending.resolve({ current: null, documentsRead: 1 }));
    expect(q("estimate-saved-evidence")!.textContent).toContain("No saved detailed performance analysis");
    expect(q("saved-evidence-dates")!.textContent).not.toContain("Oct 21, 2026");
  });
});
