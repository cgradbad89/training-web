import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RunningShoe } from "@/types/shoe";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  uid: "A", epoch: 1, currentEpoch: 1, current: (epoch: number): boolean => h.currentEpoch === epoch,
  overrides: {}, plans: [],
  workouts: [] as HealthWorkout[], shoes: [] as RunningShoe[], persisted: {} as Record<string, string | null>,
  save: vi.fn(), fetch: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: h.uid }, sessionEpoch: h.epoch, isSessionCurrent: h.current }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({
  workouts: h.workouts, overrides: h.overrides, plans: h.plans, maxHr: 185, restingHr: 60,
  workoutsLoading: false, settingsResolution: "success", userSettings: null,
  patchTrainingLoad: vi.fn(), patchOverrides: vi.fn(), refreshWorkouts: h.refresh,
}) }));
vi.mock("@/hooks/useEnrichTrainingLoads", () => ({ useEnrichTrainingLoads: vi.fn() }));
vi.mock("@/utils/routeCache", () => ({ prefetchRoutes: vi.fn() }));
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/services/shoes", () => ({
  fetchShoes: () => Promise.resolve(h.shoes), fetchManualShoeAssignmentsMap: h.fetch,
  saveManualAssignments: h.save, createShoe: vi.fn(), updateShoe: vi.fn(), deleteShoe: vi.fn(),
}));
import RunsPage from "../../runs/page";
import ShoesPage from "../page";

let container: HTMLDivElement;
let root: Root;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; }); return { promise, resolve };
}
async function render(surface: "runs" | "shoes", strict = false) {
  const page = surface === "runs" ? <RunsPage /> : <ShoesPage />;
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
}
async function click(text: string, scope: Element = container) {
  const b = Array.from(scope.querySelectorAll("button")).find(b => b.textContent?.trim() === text);
  expect(b, text).toBeTruthy(); await act(async () => b!.click());
}
function runShoe() { return container.querySelector('[data-shoe-dropdown] > button')?.textContent?.trim(); }
function shoeCard(name: string) { return Array.from(container.querySelectorAll("h3")).find(h => h.textContent === name)!.closest("div.bg-card")!; }
function cardText(name: string) { return shoeCard(name).textContent!; }
async function rederive(surface: "runs" | "shoes") {
  h.workouts = h.workouts.map(w => ({ ...w })); await render(surface);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 5, 12));
  h.uid = "A"; h.epoch = h.currentEpoch = 1;
  h.workouts = [{ workoutId: "run", isRunLike: true, hasRoute: false, activityType: "HKWorkoutActivityTypeRunning", displayType: "Outdoor Run", startDate: new Date(2026, 9, 5, 8), distanceMiles: 3, durationSeconds: 1800, avgPaceSecPerMile: 600, avgHeartRate: 140 } as HealthWorkout];
  h.shoes = ["A", "B"].map(id => ({ id, name: `Shoe ${id}`, brand: "", model: "", startMileageOffset: 0, isRetired: false, addedAt: "2026-01-01" }));
  h.persisted = { run: "A" };
  h.fetch.mockReset().mockImplementation(async () => ({ ...h.persisted }));
  h.save.mockReset().mockImplementation(async (_uid, patch) => { Object.assign(h.persisted, patch); });
  h.refresh.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("persisted shoe assignment publication", () => {
  it("Runs keeps Shoe B canonical across six workout re-derivations", async () => {
    await render("runs"); expect(runShoe()).toBe("Shoe A");
    await click("Shoe A"); await click("Shoe B");
    expect(h.persisted.run).toBe("B"); expect(runShoe()).toBe("Shoe B");
    for (let i = 0; i < 6; i++) await rederive("runs");
    expect(runShoe()).toBe("Shoe B"); expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("Runs publishes only after persistence succeeds", async () => {
    const save = deferred(); h.save.mockReturnValue(save.promise);
    await render("runs"); await click("Shoe A"); await click("Shoe B");
    expect(runShoe()).toBe("Shoe A"); await rederive("runs"); expect(runShoe()).toBe("Shoe A");
    await act(async () => save.resolve()); expect(runShoe()).toBe("Shoe B");
  });

  it("Runs preserves explicit removal against an auto-rule after refresh", async () => {
    h.shoes[0].autoAssignRules = [{ id: "rule", shoeId: "A", isEnabled: true, scope: "any" }];
    await render("runs"); await click("Shoe A"); await click("Unassigned");
    expect(h.persisted.run).toBeNull(); await rederive("runs"); expect(runShoe()).toBe("— assign");
  });

  it("Runs keeps the persisted assignment on failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); h.save.mockRejectedValue(new Error("offline"));
    await render("runs"); await click("Shoe A"); await click("Shoe B");
    expect(h.persisted.run).toBe("A"); expect(runShoe()).toBe("Shoe A"); await rederive("runs"); expect(runShoe()).toBe("Shoe A");
  });

  it("Shoes removal updates the canonical source and stays removed", async () => {
    await render("shoes"); await click("Manage Runs →", shoeCard("Shoe A"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove assignment"]')!.click());
    expect(h.persisted.run).toBeNull(); await rederive("shoes");
    expect(container.querySelector('[aria-label="Remove assignment"]')).toBeNull(); expect(cardText("Shoe A")).toContain("0.0");
  });

  it("Shoes failed removal retains the prior persisted assignment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); h.save.mockRejectedValue(new Error("offline"));
    await render("shoes"); await click("Manage Runs →", shoeCard("Shoe A"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove assignment"]')!.click());
    expect(h.persisted.run).toBe("A"); await rederive("shoes"); expect(container.querySelector('[aria-label="Remove assignment"]')).toBeTruthy();
  });

  it("Shoes saves auto-assignments into raw canonical state before rule changes", async () => {
    h.persisted = {}; h.shoes[1].autoAssignRules = [{ id: "rule", shoeId: "B", isEnabled: true, scope: "any" }];
    await render("shoes"); expect(cardText("Shoe B")).toContain("3.0"); await click("Save Auto-Assignments");
    expect(h.persisted.run).toBe("B"); expect(container.textContent).not.toContain("Save Auto-Assignments");
    h.shoes[1].autoAssignRules = []; await rederive("shoes");
    expect(cardText("Shoe B")).toContain("3.0"); expect(container.textContent).not.toContain("Save Auto-Assignments");
  });

  it("Shoes failed auto-save remains unsaved and retryable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); h.save.mockRejectedValue(new Error("offline"));
    h.persisted = {}; h.shoes[1].autoAssignRules = [{ id: "rule", shoeId: "B", isEnabled: true, scope: "any" }];
    await render("shoes"); await click("Save Auto-Assignments"); expect(h.persisted).toEqual({});
    await rederive("shoes"); expect(container.textContent).toContain("Save Auto-Assignments");
  });

  it("a persisted Runs change is consistent on subsequent Shoes and Runs mounts", async () => {
    await render("runs"); await click("Shoe A"); await click("Shoe B");
    await render("shoes"); expect(cardText("Shoe A")).toContain("0.0"); expect(cardText("Shoe B")).toContain("3.0");
    await render("runs"); expect(runShoe()).toBe("Shoe B");
  });

  it.each(["uid", "same-uid epoch", "unmount"])("retired Runs writes cannot publish after %s", async kind => {
    const save = deferred(); h.save.mockReturnValue(save.promise);
    await render("runs"); await click("Shoe A"); await click("Shoe B");
    if (kind === "unmount") { await act(async () => root.render(null)); await render("runs"); }
    else { h.currentEpoch = h.epoch = 2; if (kind === "uid") h.uid = "B"; await render("runs"); }
    await act(async () => save.resolve()); await rederive("runs"); expect(runShoe()).toBe("Shoe A");
  });

  it.each(["uid", "same-uid epoch", "unmount"])("retired Shoes removals cannot publish after %s", async kind => {
    const save = deferred(); h.save.mockReturnValue(save.promise);
    await render("shoes"); await click("Manage Runs →", shoeCard("Shoe A"));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove assignment"]')!.click());
    if (kind === "unmount") { await act(async () => root.render(null)); await render("shoes"); }
    else { h.currentEpoch = h.epoch = 2; if (kind === "uid") h.uid = "B"; await render("shoes"); }
    await act(async () => save.resolve()); await rederive("shoes"); expect(cardText("Shoe A")).toContain("3.0");
  });

  it("Runs Strict Mode saves remain canonical", async () => {
    await render("runs", true); await click("Shoe A"); await click("Shoe B");
    await rederive("runs"); expect(runShoe()).toBe("Shoe B");
  });
});
