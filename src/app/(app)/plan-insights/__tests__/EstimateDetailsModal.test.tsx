import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { AppDataContextValue } from "@/contexts/AppDataContext";
import type { CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import { ASSESSMENT_NOW } from "@/utils/__tests__/fixtures/savedPerformanceFixture";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";

/** Synthetic owner data only. Exercises the real Plan page after the legacy Performance Analysis
 * workflow was retired: Estimate Details remains, and nothing legacy is read, rendered or started. */
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/plan-insights", useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import PlanInsightsPage from "../page";

let root: Root, container: HTMLDivElement;
const isSessionCurrent = (epoch: number) => h.valid && epoch === h.epoch;
const fixture = currentFixture(1.5, 4, 9);
async function render() { await act(async () => root.render(<PlanInsightsPage />)); }
const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const dialog = () => q("estimate-details-dialog");
const trigger = () => q<HTMLButtonElement>("view-estimate-details")!;
async function open() { await act(async () => trigger().click()); return dialog()!; }
async function key(name: string, shiftKey = false) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true })); });
}
function expectNoLegacyReads() {
  for (const [name, fn] of Object.entries(h.firestore)) expect(fn, name).not.toHaveBeenCalled();
  expect(h.capture).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
  expect(h.review).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled(); expect(h.hydrate).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.resetAllMocks(); h.estimates = [];
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(ASSESSMENT_NOW));
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
  window.history.replaceState(null, "", "/plan-insights");
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
    expect(methodology).toContain(`${Number(estimate.adjustmentSeconds.toFixed(2))} seconds`);
    expect(methodology).toContain(`Race-equivalent baseline: `); expect(methodology).toContain(estimate.anchor!.name);
    expect(methodology).toContain("Recorded time; official result and maximal effort need confirmation");
    expect(methodology).toContain("Unvalidated training adjustment"); expect(methodology).toContain("No confidence interval is supported");
    expect(methodology).toContain("has not been validated for your individual accuracy");
    expect(methodology).toContain(`Model ${estimate.version}`); expect(methodology).toContain(`Calculation cutoff ${estimate.asOf}`);
    for (const gap of estimate.gaps) expect(methodology).toContain(gap);
    expect(view.querySelector("details summary")?.textContent).toBe("Model assumptions");
    expect(h.estimates.length).toBe(calls);
  });
});

describe("Plan Insights after the Performance Analysis retirement", () => {
  it("offers only Estimate Details: no legacy button, dialog, saved-analysis section or freshness prompts", async () => {
    await render();
    expect(q("view-performance-analysis")).toBeNull();
    expect(q("performance-analysis-dialog")).toBeNull();
    expect(document.getElementById("performance-analysis")).toBeNull();
    expect(q("performance-evidence-notice")).toBeNull(); expect(q("performance-evidence-status")).toBeNull();
    for (const label of ["Performance Analysis", "Update Performance", "Saved Performance Analysis", "New / unprocessed", "Potentially changed", "Review Performance Updates", "read budget"]) {
      expect(container.textContent, label).not.toContain(label);
    }
    expect(trigger().textContent).toBe("View Estimate Details");
    const view = await open();
    for (const label of ["Performance Analysis", "Saved Performance Evidence", "Update Performance", "Retry saved analysis load"]) expect(view.textContent, label).not.toContain(label);
    expect(q("estimate-saved-evidence")).toBeNull();
    expect(view.textContent).toContain("Estimate methodology"); expect(q("estimate-breakdown")).toBeTruthy(); expect(q("training-adjustment")).toBeTruthy();
    expect(view.textContent).toContain("How to strengthen the race evidence");
  });

  it("reads no saved-analysis document, child document, feature receipt or Firestore data and starts no processing", async () => {
    await render(); await open(); await key("Escape"); await open();
    expectNoLegacyReads();
  });

  it("handles an old Performance Analysis deep link by explaining the retirement once, cleaning the URL and keeping focus put", async () => {
    window.history.replaceState(null, "", "/plan-insights?performance-analysis=1&keep=1#top");
    const before = document.activeElement;
    await render();
    const notice = q("performance-analysis-retired")!;
    expect(notice.getAttribute("role")).toBe("status"); expect(notice.textContent).toContain("has been retired");
    expect(notice.textContent).toContain("Saved analyses are preserved");
    expect(dialog()).toBeNull(); expect(q("performance-analysis-dialog")).toBeNull();
    expect(window.location.search).toBe("?keep=1"); expect(window.location.hash).toBe("#top");
    expect(document.activeElement).toBe(before);
    expect(trigger().textContent).toBe("View Estimate Details");
    await act(async () => [...notice.querySelectorAll("button")].find(b => b.textContent === "Dismiss")!.click());
    expect(q("performance-analysis-retired")).toBeNull();
    expectNoLegacyReads();
  });

  it("does not show the retirement notice without a legacy link", async () => {
    await render();
    expect(q("performance-analysis-retired")).toBeNull();
  });
});
