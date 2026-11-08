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
  saveRaceConfirmation: vi.fn(),
  user: { uid: "u1" } as { uid: string; email?: string | null; emailVerified?: boolean },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: h.user, sessionEpoch: 1, isSessionCurrent: () => true }),
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
    overrides: {}, overridesLoading: false, overridesResolution: "success",
  }),
}));

vi.mock("@/services/raceConfirmations", () => ({ saveRaceConfirmation: h.saveRaceConfirmation }));

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
  vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "false");
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
  h.saveRaceConfirmation.mockReset();
  h.user = { uid: "u1" };
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
  vi.unstubAllEnvs();
});

describe("RacesPage confirmation gate", () => {
  it.each(["production", "preview"])("does not expose confirmation without the required opt-in in %s", async (deployment) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", deployment === "production" ? "true" : "false");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    await mount();
    expect(container.textContent).not.toContain("Confirm race result");
    expect(h.saveRaceConfirmation).not.toHaveBeenCalled();
  });

  it("opens the actual race confirmation without making a write", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    h.races = [baseRace({ actualRunId: "w1" })];
    await mount(); clickText("Confirm race result"); await flush();
    expect(container.querySelector('[role="dialog"][aria-label="Confirm race result"]')).toBeTruthy();
    expect(container.textContent).toContain("Linked workout: w1");
    expect(h.saveRaceConfirmation).not.toHaveBeenCalled();
    expect(h.updateRace).not.toHaveBeenCalled();
  });
});

describe("RacesPage temporary owner-only Production confirmation", () => {
  const OWNER = { uid: "u1", email: "folstromjohn@gmail.com", emailVerified: true };
  const production = (flag: string | null = "true") => {
    vi.setSystemTime(new Date("2026-11-08T17:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "false");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", flag ?? undefined);
  };
  const sep = () => baseRace({ id: "sep", name: "DC Half", raceDate: "2026-09-20", actualRunId: "w-sep", actualRunDurationSeconds: 7871 });
  const sepRun = { ...run, workoutId: "w-sep", startDate: new Date("2026-09-20T12:00:00.000Z"), endDate: new Date("2026-09-20T14:11:11.000Z"), durationSeconds: 7871, distanceMiles: 13.109, distanceMeters: 21097.5, syncedAt: new Date("2026-09-20T15:00:00.000Z") } as HealthWorkout;
  const field = (label: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[id$="-${label}"]`)!;

  it("shows the editor to the verified owner only, with the explicit flag, and nothing is written on open", async () => {
    production(); h.user = OWNER; h.races = [sep()]; h.workouts = [sepRun];
    await mount(); clickText("Confirm race result"); await flush();
    expect(container.querySelector('[role="dialog"][aria-label="Confirm race result"]')).toBeTruthy();
    expect(container.textContent).toContain("Temporary owner confirmation");
    expect(h.saveRaceConfirmation).not.toHaveBeenCalled(); expect(h.updateRace).not.toHaveBeenCalled();
  });
  it.each([
    ["no email", { uid: "u1" }], ["another account", { uid: "u1", email: "someone.else@example.com", emailVerified: true }],
    ["an unverified owner email", { uid: "u1", email: "folstromjohn@gmail.com", emailVerified: false }],
  ])("does not expose it to %s", async (_label, user) => {
    production(); h.user = user; h.races = [sep()]; h.workouts = [sepRun];
    await mount();
    expect(container.textContent).not.toContain("Confirm race result");
  });
  it.each([null, "false", "1", "TRUE"])("does not expose it in Production without the exact flag (%s)", async flag => {
    production(flag); h.user = OWNER; h.races = [sep()]; h.workouts = [sepRun];
    await mount();
    expect(container.textContent).not.toContain("Confirm race result");
  });
  it("prefills September from the owner's description for review: official chip 2:11:11, hard effort, percentage only in the note; saving is a separate owner action", async () => {
    production(); h.user = OWNER; h.races = [sep()]; h.workouts = [sepRun];
    await mount(); clickText("Confirm race result"); await flush();
    expect(container.querySelector('[data-testid="confirmation-prefill-notice"]')).toBeTruthy();
    expect(field("finish").value).toBe("2:11:11"); expect(field("basis").value).toBe("chip"); expect(field("effort").value).toBe("hard"); expect(field("status").value).toBe("owner_confirmed");
    expect(field("conditions").value).toMatch(/approximately 90% \(subjective, not a physiological measurement\)/);
    expect(field("reconciliation").value).toBe("");
    expect(h.saveRaceConfirmation).not.toHaveBeenCalled();
    h.saveRaceConfirmation.mockResolvedValue({ ...sep() });
    const form = container.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(h.saveRaceConfirmation).toHaveBeenCalledTimes(1);
    const [uid, payload] = h.saveRaceConfirmation.mock.calls[0];
    expect(uid).toBe("u1");
    expect(payload.details).toMatchObject({ finishSeconds: 7871, effort: "hard", status: "owner_confirmed", timeBasis: "chip", linkedWorkoutId: "w-sep", kind: "official_race" });
  });
  it("prefills April with the timing explanation and an unestablished (not assumed) time basis, and the form shows the 10:29 discrepancy", async () => {
    production(); h.user = OWNER;
    const apr = baseRace({ id: "apr", name: "PNC Alexandria Half", raceDate: "2026-04-26", actualRunId: "w-apr", actualRunDurationSeconds: 8130 });
    const aprRun = { ...run, workoutId: "w-apr", startDate: new Date("2026-04-26T12:00:00.000Z"), endDate: new Date(Date.parse("2026-04-26T12:00:00.000Z") + 8759 * 1000), durationSeconds: 8130, distanceMiles: 13.109, distanceMeters: 21097.5, syncedAt: new Date("2026-04-27T22:32:00.000Z") } as HealthWorkout;
    h.races = [apr]; h.workouts = [aprRun];
    await mount(); clickText("Confirm race result"); await flush();
    expect(field("finish").value).toBe("2:15:30"); expect(field("effort").value).toBe("nonmaximal"); expect(field("basis").value).toBe("other");
    expect(field("conditions").value).toMatch(/approximately 80% \(subjective, not a physiological measurement\)/);
    expect(field("reconciliation").value).toMatch(/10 minutes 29 seconds before the timed race start/);
    expect(container.textContent).toMatch(/Timing discrepancy/);
    h.saveRaceConfirmation.mockResolvedValue({ ...apr });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(h.saveRaceConfirmation.mock.calls[0][1].details).toMatchObject({ finishSeconds: 8130, effort: "nonmaximal", timeBasis: "other", linkedWorkoutId: "w-apr" });
    expect(h.saveRaceConfirmation.mock.calls[0][1].details.timingReconciliation).toMatch(/standing-level heart rate/);
  });
  it("does not prefill an unrelated race or one that already has a confirmation", async () => {
    production(); h.user = OWNER; h.races = [baseRace({ actualRunId: "w1" })]; h.workouts = [run];
    await mount(); clickText("Confirm race result"); await flush();
    expect(container.querySelector('[data-testid="confirmation-prefill-notice"]')).toBeNull();
    expect(field("finish").value).toBe("");
  });
});

describe("RacesPage shared race freshness", () => {
  it("edits and clears ordinary fields in Production while retaining confirmation history", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    const confirmationHistory = { schemaVersion: 1 as const, chronology: "client_document_untrusted" as const, currentRevisionId: "kept", revisions: {} };
    h.races = [baseRace({ linkedPlanId: "p1", result: "2:00:00", actualRunId: "w1", confirmationHistory })];
    await mount();
    expect(container.textContent).not.toContain("Review result confirmation");
    clickTitle("Edit");
    setInput(container.querySelector<HTMLInputElement>('input[type="text"]')!, "Ordinary edit");
    setSelect(Array.from(container.querySelectorAll("select")).at(-1)!, "");
    clickText("Save"); await flush();
    const writes = h.updateRace.mock.calls[0][2];
    expect(writes).not.toHaveProperty("confirmationHistory");
    expect(writes).not.toHaveProperty("performanceEvidence");
    expect(writes.linkedPlanId).toBeUndefined();
    expect(h.races[0]).toMatchObject({ name: "Ordinary edit", actualRunId: "w1", result: "2:00:00", confirmationHistory });
    expect(h.races[0]).not.toHaveProperty("linkedPlanId");
    expect(h.saveRaceConfirmation).not.toHaveBeenCalled();
  });

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
