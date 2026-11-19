import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHrTimedSamples } from "@/hooks/useHrTimedSamples";
import { fetchHRStream } from "@/services/hrStream";
import type { HrTimedSample } from "@/utils/hrTarget";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" } }),
}));
vi.mock("@/services/hrStream", () => ({
  fetchHRStream: vi.fn(),
}));

const STREAM = [
  { timestamp: "2026-11-18T12:00:00.000Z", hr: 120 },
  { timestamp: "2026-11-18T12:00:10.000Z", hr: 140 },
];

let container: HTMLDivElement;
let root: Root;
/** Read the hook's latest return value back out of the DOM the probe renders. */
function latest(): { samples: HrTimedSample[] | null; loading: boolean } {
  const el = container.querySelector("output");
  return JSON.parse(el?.textContent ?? "null");
}

function Probe({ id, enabled }: { id: string | null; enabled: boolean }) {
  const value = useHrTimedSamples(id, enabled);
  return <output>{JSON.stringify(value)}</output>;
}

async function render(id: string | null, enabled: boolean) {
  await act(async () => {
    root.render(<Probe id={id} enabled={enabled} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(fetchHRStream).mockReset().mockResolvedValue(STREAM);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useHrTimedSamples", () => {
  it("does not fetch when disabled", async () => {
    await render("w1", false);
    expect(fetchHRStream).not.toHaveBeenCalled();
    expect(latest()).toEqual({ samples: null, loading: false });
  });

  it("does not fetch without a workout id", async () => {
    await render(null, true);
    expect(fetchHRStream).not.toHaveBeenCalled();
  });

  it("fetches once when enabled and returns timed samples", async () => {
    await render("w1", true);
    expect(fetchHRStream).toHaveBeenCalledTimes(1);
    expect(fetchHRStream).toHaveBeenCalledWith("u1", "w1");
    expect(latest().loading).toBe(false);
    expect(latest().samples).toEqual([
      { tSec: 0, bpm: 120 },
      { tSec: 10, bpm: 140 },
    ]);
  });

  it("reports loading while the read is in flight", async () => {
    let resolve!: (v: typeof STREAM) => void;
    vi.mocked(fetchHRStream).mockReturnValue(new Promise((r) => (resolve = r)));
    await render("w1", true);
    expect(latest()).toEqual({ samples: null, loading: true });
    await act(async () => resolve(STREAM));
    expect(latest().loading).toBe(false);
    expect(latest().samples).toHaveLength(2);
  });

  it("does not refetch on re-render or when toggled off and on for the same id", async () => {
    await render("w1", true);
    await render("w1", true);
    await render("w1", false);
    await render("w1", true);
    expect(fetchHRStream).toHaveBeenCalledTimes(1);
    expect(latest().samples).toHaveLength(2);
  });

  it("fetches again for a different workout id", async () => {
    await render("w1", true);
    await render("w2", true);
    expect(fetchHRStream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchHRStream).mock.calls[1]).toEqual(["u1", "w2"]);
  });

  it("ignores a result that arrives after unmount", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (v: typeof STREAM) => void;
    vi.mocked(fetchHRStream).mockReturnValue(new Promise((r) => (resolve = r)));
    await render("w1", true);
    act(() => root.unmount());
    await act(async () => resolve(STREAM));
    // No state update on an unmounted hook → no React warning/error logged.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    root = createRoot(container); // so afterEach's unmount has a live root
  });

  it("yields null samples (not an error) when the read fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetchHRStream).mockRejectedValue(new Error("boom"));
    await render("w1", true);
    expect(latest()).toEqual({ samples: null, loading: false });
    errors.mockRestore();
  });
});
