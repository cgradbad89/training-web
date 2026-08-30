import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  races: [] as Race[],
  workouts: [] as HealthWorkout[],
  plans: [{ id: "p1", name: "Half Plan", planType: "running" }],
  patchRaces: vi.fn(),
  createRace: vi.fn(),
  updateRace: vi.fn(),
  deleteRace: vi.fn(),
  setActiveRace: vi.fn(),
  associateRunWithRace: vi.fn(),
  disassociateRunFromRace: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" } }),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    races: h.races,
    workouts: h.workouts,
    plans: h.plans,
    racesLoading: false,
    workoutsLoading: false,
    plansLoading: false,
    patchRaces: h.patchRaces,
  }),
}));

vi.mock("@/services/races", () => ({
  createRace: h.createRace,
  updateRace: h.updateRace,
  deleteRace: h.deleteRace,
  setActiveRace: h.setActiveRace,
  associateRunWithRace: h.associateRunWithRace,
  disassociateRunFromRace: h.disassociateRunFromRace,
}));

import RacesPage from "../page";

const baseRace = (overrides: Partial<Race> = {}): Race => ({
  id: "r1",
  name: "Autumn Half",
  raceDate: "2026-08-29",
  raceDistance: "halfMarathon",
  isActive: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const run: HealthWorkout = {
  workoutId: "w1",
  displayType: "Outdoor Run",
  activityType: "running",
  isRunLike: true,
  startDate: new Date(2026, 7, 29, 23, 30),
  distanceMiles: 13.1,
  durationSeconds: 7200,
  avgPaceSecPerMile: 550,
} as HealthWorkout;

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clickText(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button, `button ${text}`).toBeTruthy();
  act(() => button!.click());
}

function clickContaining(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(text)
  );
  expect(button, `button containing ${text}`).toBeTruthy();
  act(() => button!.click());
}

function clickTitle(title: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  expect(button).toBeTruthy();
  act(() => button!.click());
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<RacesPage />);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 29, 12));
  h.races = [baseRace()];
  h.workouts = [run];
  h.patchRaces.mockReset().mockImplementation((updater: (races: Race[]) => Race[]) => {
    h.races = updater(h.races);
  });
  h.createRace.mockReset().mockResolvedValue("created");
  h.updateRace.mockReset().mockResolvedValue(undefined);
  h.deleteRace.mockReset().mockResolvedValue(undefined);
  h.setActiveRace.mockReset().mockResolvedValue(undefined);
  h.associateRunWithRace.mockReset().mockResolvedValue(undefined);
  h.disassociateRunFromRace.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RacesPage shared race freshness", () => {
  it("publishes create and edit mutations to shared races", async () => {
    await mount();
    clickText("Add Race");
    setInput(container.querySelector<HTMLInputElement>('input[type="text"]')!, "New Race");
    setInput(container.querySelector<HTMLInputElement>('input[type="date"]')!, "2026-09-10");
    clickText("Save");
    await flush();
    expect(h.races.some((race) => race.id === "created" && race.name === "New Race")).toBe(true);

    await act(async () => root.render(<RacesPage />));
    clickTitle("Edit");
    setInput(container.querySelector<HTMLInputElement>('input[type="text"]')!, "Edited Race");
    const planSelect = Array.from(container.querySelectorAll("select")).at(-1)!;
    setSelect(planSelect, "p1");
    clickText("Save");
    await flush();
    expect(h.races.find((race) => race.id === "r1")?.name).toBe("Edited Race");
    expect(h.races.find((race) => race.id === "r1")?.linkedPlanId).toBe("p1");

    await act(async () => root.render(<RacesPage />));
    clickTitle("Edit");
    setSelect(Array.from(container.querySelectorAll("select")).at(-1)!, "");
    clickText("Save");
    await flush();
    expect(h.races.find((race) => race.id === "r1")?.linkedPlanId).toBeUndefined();
  });

  it("publishes active switch, actual-run association, and deletion", async () => {
    await mount();
    clickText("Set as Goal Race");
    await flush();
    expect(h.races[0].isActive).toBe(true);

    clickText("＋ Link actual run");
    await flush();
    clickContaining("13.10 mi");
    await flush();
    expect(h.races[0]).toMatchObject({
      actualRunId: "w1",
      actualRunDate: "2026-08-29",
    });

    await act(async () => root.render(<RacesPage />));
    clickText("Remove");
    await flush();
    expect(h.races[0].actualRunId).toBeUndefined();

    await act(async () => root.render(<RacesPage />));
    clickTitle("Delete");
    clickText("Delete Race");
    await flush();
    expect(h.races).toEqual([]);
  });

  it("does not patch shared races when persistence fails", async () => {
    h.updateRace.mockRejectedValueOnce(new Error("write failed"));
    await mount();
    clickTitle("Edit");
    setInput(container.querySelector<HTMLInputElement>('input[type="text"]')!, "False Success");
    clickText("Save");
    await flush();

    expect(h.patchRaces).not.toHaveBeenCalled();
    expect(h.races[0].name).toBe("Autumn Half");
    expect(container.textContent).toContain("Could not save this race.");
  });
});
