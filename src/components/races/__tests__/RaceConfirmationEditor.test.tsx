import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RaceConfirmationEditor, type RaceConfirmationEditorProps } from "../RaceConfirmationEditor";
import { createRaceConfirmationPreviewFixtures } from "../raceConfirmationPreviewFixtures";
import { buildRaceConfirmationInput } from "@/utils/raceConfirmation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const fixtures = createRaceConfirmationPreviewFixtures();
const race = fixtures.races[1], workout = fixtures.workouts[1];
const save = vi.fn();
const close = vi.fn();
function render(props: Partial<RaceConfirmationEditorProps> = {}) {
  act(() => root.render(<RaceConfirmationEditor race={race} workout={workout} onSave={save} onClose={close} {...props} />));
}
function field(label: string) {
  const element = [...container.querySelectorAll("label")].find((item) => item.textContent === label)!;
  expect(element, label).toBeTruthy();
  return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}
function change(label: string, value: string) {
  const element = field(label);
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  save.mockReset().mockResolvedValue(undefined); close.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("race confirmation editor", () => {
  it("never fills official finish from workout timing or saves on mount", () => {
    render();
    expect(field("Confirmed finish time").value).toBe("");
    expect(field("Race effort").value).toBe("unknown");
    expect(container.textContent).toContain("Workout duration");
    expect(container.textContent).toContain("Start/end elapsed");
    expect(save).not.toHaveBeenCalled();
  });
  it("discloses discrepant recorded clocks and does not assume the shorter chip time", () => {
    render({ race: fixtures.races[0], workout: fixtures.workouts[0] });
    expect(container.textContent).toContain("2:08:00"); expect(container.textContent).toContain("2:17:00");
    expect(container.textContent).toContain("Timing discrepancy: 9:00");
    expect(field("Confirmed finish time").value).toBe("");
  });
  it("separates official URL from owner provenance and does not infer maximal effort", async () => {
    render(); change("Verification category", "verified"); change("Official result URL", "https://example.com/result"); change("Confirmed finish time", "2:04:00");
    await submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: "verified", source: "https://example.com/result", finishSeconds: 7440, effort: "unknown", timeBasis: "chip" }));
  });
  it("requires a separately entered valid finish and preserves original data", async () => {
    const before = JSON.stringify({ race, workout }); render(); change("Confirmed finish time", "2:99:00"); await submit();
    expect(save).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter a finish time");
    expect(JSON.stringify({ race, workout })).toBe(before);
  });
  it("cannot save when the linked workout is missing", async () => {
    render({ workout: null }); change("Confirmed finish time", "2:04:00"); await submit();
    expect(save).not.toHaveBeenCalled(); expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
  it("shows effective overrides separately without replacing original observations", () => {
    render({ override: { workoutId: workout.workoutId, userId: "owner", isExcluded: false, distanceMilesOverride: 13.109, durationSecondsOverride: 7200, updatedAt: "2026-10-25T12:00:00Z" } });
    expect(container.textContent).toContain("2:04:00");
    expect(container.textContent).toContain("Effective duration: 2:00:00");
    expect(container.textContent).toContain("Effective distance: 13.11 mi");
    expect(workout.durationSeconds).toBe(7440);
  });
  it("retains edits and displays a stale-submission failure", async () => {
    save.mockRejectedValue(new Error("Race changed. Reload before submitting.")); render(); change("Confirmed finish time", "2:04:00"); await submit();
    expect(field("Confirmed finish time").value).toBe("2:04:00"); expect(container.textContent).toContain("Race changed. Reload before submitting."); expect(close).not.toHaveBeenCalled();
  });
  it("allows only one pending submission", async () => {
    let resolve!: () => void; save.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    render(); change("Confirmed finish time", "2:04:00"); await submit(); await submit(); expect(save).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
  });
  it("shows validation failure for missing official source without writing", async () => {
    const persist = vi.fn(); save.mockImplementation(async (draft) => { const input = buildRaceConfirmationInput({ race, workout, override: null, timeZone: "America/New_York", draft, requestId: "editor-test-001" }); persist(input); });
    render(); change("Verification category", "verified"); change("Confirmed finish time", "2:04:00"); change("Conditions and limitations", "Cool, flat course."); await submit();
    expect(persist).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Result URL");
  });
  it("protects unsaved edits on cancel", () => {
    render(); change("Confirmed finish time", "2:04:00"); act(() => container.querySelector<HTMLButtonElement>("[data-confirmation-cancel]")!.click());
    expect(close).not.toHaveBeenCalled(); expect(container.textContent).toContain("Discard confirmation edits?");
  });
});
