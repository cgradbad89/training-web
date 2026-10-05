import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthMetric } from "@/services/healthMetrics";
import type { HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  uid: "A", epoch: 1, currentEpoch: 1, range: vi.fn(), goals: vi.fn(), refresh: vi.fn(),
  current: (epoch: number): boolean => epoch === h.currentEpoch,
  workouts: [] as HealthWorkout[],
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: h.uid }, sessionEpoch: h.epoch, isSessionCurrent: h.current }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({
  workouts: h.workouts, overrides: {}, plans: [], maxHr: 185, restingHr: 60,
  workoutsLoading: false, plansLoading: false, plansResolution: "success", settingsLoading: false,
  patchOverrides: vi.fn(), refreshWorkouts: h.refresh,
}) }));
vi.mock("@/services/healthMetrics", () => ({ fetchHealthMetricsRange: h.range }));
vi.mock("@/services/healthGoals", () => ({ fetchHealthGoals: h.goals }));
vi.mock("@/components/WeekCalendar", () => ({ WeekCalendar: () => null }));
vi.mock("@/components/WorkoutDetailModal", () => ({ WorkoutDetailModal: () => null }));
vi.mock("@/components/runs/RunActivityModal", () => ({ RunActivityModal: () => null }));
vi.mock("@/components/layout/WeekNavigator", () => ({ WeekNavigator: ({ weekStart, onChange }: { weekStart: Date; onChange: (date: Date) => void }) => <>
  <button onClick={() => onChange(new Date(weekStart))}>Same week</button>
  <button onClick={() => { const date = new Date(weekStart); date.setDate(date.getDate() - 7); onChange(date); }}>Previous week</button>
</> }));
import DashboardPage from "../page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let weeks: ReturnType<typeof deferred<HealthMetric[]>>[];
async function render(strict = false) {
  await act(async () => root.render(strict ? <StrictMode><DashboardPage /></StrictMode> : <DashboardPage />));
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 9, 5, 12));
  h.uid = "A"; h.epoch = h.currentEpoch = 1; h.workouts = [];
  weeks = [];
  h.range.mockReset().mockImplementation((_uid, from, to) => {
    if (from === to) return new Promise(() => {});
    const request = deferred<HealthMetric[]>(); weeks.push(request); return request.promise;
  });
  h.goals.mockReset().mockReturnValue(new Promise(() => {}));
  h.refresh.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Dashboard stable logical week", () => {
  it("starts one query and does not loop after six fresh response/render cycles", async () => {
    await render();
    expect(weeks).toHaveLength(1);
    // The audited source requests a fresh array again on every response. The
    // corrected source settles once; subsequent unrelated renders stay quiet.
    for (let i = 0; i < 6; i++) {
      if (weeks[i]) await act(async () => weeks[i].resolve([]));
      else await render();
    }
    expect(weeks).toHaveLength(1);
    expect(h.range.mock.calls.filter(([, from, to]) => from !== to)).toEqual([["A", "2026-10-05", "2026-10-11"]]);
  });

  it("fetches a changed week but not a new Date for the same week", async () => {
    await render(); await click("Same week"); expect(weeks).toHaveLength(1);
    await click("Previous week"); expect(weeks).toHaveLength(2);
    expect(h.range).toHaveBeenLastCalledWith("A", "2026-09-28", "2026-10-04");
  });

  it("keeps canonical source and explicit workout refresh without duplicating Health reads", async () => {
    await render(); await act(async () => weeks[0].resolve([]));
    h.workouts = [...h.workouts]; await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Refresh workouts"]')!.click());
    expect(h.refresh).toHaveBeenCalledOnce(); expect(weeks).toHaveLength(1);
    // Dashboard Health's existing policy is mount/week/session only. Canonical
    // W refresh and visibility remain owned by AppData, not this range effect.
  });

  it.each(["uid", "same-uid epoch"])("rejects late old results after %s replacement", async kind => {
    await render(); const old = weeks[0];
    h.currentEpoch = h.epoch = 2; if (kind === "uid") h.uid = "B";
    await render(); expect(weeks).toHaveLength(2);
    await act(async () => weeks[1].resolve([{ date: "2026-10-05", steps: 2222 } as HealthMetric]));
    expect(container.textContent).toContain("2,222");
    await act(async () => old.resolve([{ date: "2026-10-05", steps: 9999 } as HealthMetric]));
    expect(container.textContent).toContain("2,222"); expect(container.textContent).not.toContain("9,999");
  });

  it("uses synchronous session retirement before a replacement render", async () => {
    await render(); h.currentEpoch = 2;
    await act(async () => weeks[0].resolve([{ date: "2026-10-05", steps: 9999 } as HealthMetric]));
    expect(container.textContent).not.toContain("9,999");
  });

  it("retires Strict Mode's first generation without a success feedback loop", async () => {
    await render(true); expect(weeks).toHaveLength(2);
    await act(async () => weeks[1].resolve([{ date: "2026-10-05", steps: 2222 } as HealthMetric]));
    await act(async () => weeks[0].resolve([{ date: "2026-10-05", steps: 9999 } as HealthMetric]));
    expect(weeks).toHaveLength(2); expect(container.textContent).toContain("2,222"); expect(container.textContent).not.toContain("9,999");
  });

  it("does not publish after genuine unmount and remounts with fresh required work", async () => {
    await render(); await act(async () => root.render(null));
    await act(async () => weeks[0].resolve([])); expect(weeks).toHaveLength(1);
    await render(); expect(weeks).toHaveLength(2);
  });

  it("does not loop on a failed read and retries on week reselection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render(); await act(async () => weeks[0].reject(new Error("offline")));
    expect(weeks).toHaveLength(1); await click("Previous week"); expect(weeks).toHaveLength(2);
  });
});
