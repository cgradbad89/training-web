import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RaceConfirmationPreview } from "../RaceConfirmationPreview";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  act(() => root.render(<RaceConfirmationPreview />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function field(label: string) {
  const associated = [...container.querySelectorAll("label")].find(node => node.textContent === label);
  if (!associated?.htmlFor) throw new Error(`Missing field: ${label}`);
  return document.getElementById(associated.htmlFor) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}
function fill(label: string, value: string) {
  const element = field(label);
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(node => node.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
function completeResult(status: "verified" | "owner_confirmed", finish = "2:03:55") {
  fill("Confirmed finish time", finish);
  fill("Verification category", status);
  fill(status === "verified" ? "Official result URL" : "Owner attestation / provenance", status === "verified"
    ? "https://example.com/synthetic-results/autumn"
    : "I attest that this invented example was a maximal race result I personally checked.");
  fill("Race effort", "maximal");
  fill("Conditions and limitations", "Invented cool, flat-course example; not owner observations.");
}

describe("synthetic confirmation flow through the real editor", () => {
  it("records an official sample result, preserves observations and keeps numerical forecasts withheld", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    completeResult("verified");
    await submit();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Synthetic revision 1 saved in memory");
    expect(container.textContent).toContain("Official result verified");
    expect(container.textContent).toContain("Eligible dated historical benchmark");
    expect(container.querySelector('[aria-label="Original observations"]')?.textContent).toContain("2:04:00");
    expect(container.querySelector('[aria-label="Confirmation history"]')?.textContent).toContain("2:03:55");
    expect(container.textContent).toContain("Current capability estimateUnavailable");
    expect(container.textContent).toContain("Race-day forecastWithheld");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains owner attestation and both correction revisions with their original event date", async () => {
    completeResult("owner_confirmed");
    await submit();
    expect(container.textContent).toContain("Owner confirmed");
    expect(field("Confirmed finish time").value).toBe("2:03:55");
    fill("Confirmed finish time", "2:03:50");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("correction reason is required");
    expect(container.querySelectorAll('[aria-label="Confirmation history"] details')).toHaveLength(1);
    fill("Reason for correction", "Synthetic correction after checking the example receipt again.");
    await submit();
    const history = container.querySelector('[aria-label="Confirmation history"]')!;
    expect(history.querySelectorAll("details")).toHaveLength(2);
    expect(history.textContent).toContain("2:03:55");
    expect(history.textContent).toContain("2:03:50");
    expect(history.textContent).toContain("2026-10-25T16:01:00.000Z");
    expect(history.textContent).toContain("2026-10-25T16:02:00.000Z");
    expect(container.querySelector('[aria-label="Synthetic evidence outcome"]')?.textContent).toContain("Event date: 2026-09-06");
  });

  it("requires an explicit explanation for the conflicting-clock example", async () => {
    click("Synthetic Spring Half");
    completeResult("verified", "2:07:50");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("explicit timing explanation");
    expect(container.querySelector('[aria-label="Confirmation history"]')).toBeNull();
    fill("Timing discrepancy explanation", "Synthetic race clock began after the workout; the example source establishes chip time.");
    await submit();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-label="Synthetic evidence outcome"]')?.textContent).toContain("Timing: reconciled");
    expect(container.querySelector('[aria-label="Original observations"]')?.textContent).toContain("2:17:00");
  });

  it("resets both saved sample revisions and any unfinished form values", async () => {
    completeResult("verified");
    await submit();
    fill("Confirmed finish time", "2:00:00");
    click("Reset examples");
    expect(container.querySelector('[aria-label="Confirmation history"]')).toBeNull();
    expect(field("Confirmed finish time").value).toBe("");
    expect(container.querySelector('[aria-label="Synthetic evidence outcome"]')?.textContent).toContain("Recorded, unverified");
  });
});
