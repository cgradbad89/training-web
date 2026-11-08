import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningPlan } from "@/types/plan";
import type { HrSample } from "@/types/hybridPerformance";
import { athleteV11, type AthleteV11Options } from "@/utils/__tests__/fixtures/hybridV11Fixture";
import { HYBRID_AS_OF } from "@/utils/__tests__/fixtures/hybridFixture";
import { RacePerformancePanel, type RacePerformanceSources } from "../RacePerformancePanel";
import { usePhysiologyEvidence } from "@/hooks/usePhysiologyEvidence";
import { isExperimentalHybridV11Enabled, isPhysiologyHydrationEnabled } from "@/lib/racePerformanceGate";

const fetchers = vi.hoisted(() => ({ vo2: vi.fn(), stream: vi.fn() }));
vi.mock("@/services/physiologyEvidenceFirestore", () => ({ fetchVo2EvidenceWindow: fetchers.vo2, fetchHrStreamBounded: fetchers.stream }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = { hasLoaded: true, resolution: "success" as const };
const sources: RacePerformanceSources = { workouts: ready, overrides: ready, races: ready, plans: ready };
const PLAN: RunningPlan = { id: "p", name: "Spring HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "x", updatedAt: "x",
  weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 }, { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) }] })) };
const eff = (date: string, miles: number, pace: number, hr = 172) => ({ date, miles, pace, hr });
const improved = [eff("2026-10-02", 6, 548), eff("2026-10-16", 7, 552), eff("2026-10-28", 6, 546)];
const OLD = "2026-07-30";

let root: Root, container: HTMLDivElement, uidCounter = 0;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(HYBRID_AS_OF));
  fetchers.vo2.mockReset(); fetchers.stream.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => q(id)?.textContent ?? "";
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const dayBefore = (n: number) => new Date(Date.parse("2026-11-06T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);
const vo2Entries = (recent: number, prior: number) => [
  ...Array.from({ length: 6 }, (_, i) => ({ date: dayBefore(i * 4), value: recent })), ...Array.from({ length: 6 }, (_, i) => ({ date: dayBefore(30 + i * 4), value: prior })) ];
const steady = (): HrSample[] => Array.from({ length: 2400 }, (_, t) => ({ t, bpm: Math.round(t < 300 ? 100 + 50 * t / 300 : 150 + ((t * 7919) % 5) - 2) }));

function athlete(o: AthleteV11Options = {}) {
  const a = athleteV11({ raceDate: OLD, strong: improved, ...o });
  return { ...a, workouts: a.workouts.map(w => (w.workoutId.startsWith("ord-") ? { ...w, hasHRStream: true } : w)) };
}
function Harness({ a, uid, enabled = true, isReady = true }: { a: ReturnType<typeof athlete>; uid: string | null; enabled?: boolean; isReady?: boolean }) {
  const physiology = usePhysiologyEvidence({ enabled, uid, sessionEpoch: 1, isSessionCurrent: () => true, races: a.races, workouts: a.workouts, overrides: a.overrides,
    timeZone: a.timeZone, day: "2026-11-07", ready: isReady });
  return <RacePerformancePanel races={a.races} workouts={a.workouts} overrides={a.overrides} plan={PLAN} selectedRace={null} sources={sources} asOf={new Date(a.asOf)} timeZone={a.timeZone} physiology={physiology} />;
}
const newUid = () => `user-${++uidCounter}`;
function mount(a: ReturnType<typeof athlete>, uid: string | null = newUid(), extra: Partial<React.ComponentProps<typeof Harness>> = {}) {
  act(() => root.render(<Harness a={a} uid={uid} {...extra} />));
  return uid;
}
function panelOnly(o: AthleteV11Options = {}, extra: Partial<React.ComponentProps<typeof RacePerformancePanel>> = {}) {
  const a = athleteV11(o);
  act(() => root.render(<RacePerformancePanel races={a.races} workouts={a.workouts} overrides={a.overrides} plan={PLAN} selectedRace={null} sources={sources}
    asOf={new Date(a.asOf)} timeZone={a.timeZone} {...extra} />));
  return a;
}

describe("service → hook → panel → hybrid v1.1: real readings reach the production calculation", () => {
  it("VO₂ max readings and warm-up-trimmed HR streams are fetched (bounded), flow into the estimate, and are disclosed", async () => {
    fetchers.vo2.mockResolvedValue({ entries: vo2Entries(47.8, 46.5), docsRead: 47 });
    fetchers.stream.mockImplementation(async () => ({ samples: steady(), chunks: 6 }));
    const uid = mount(athlete());
    expect(text("physiology-loading")).toMatch(/Loading VO₂ max and heart-rate evidence/);       // loading state is visible and the estimate is already shown
    expect(q("hybrid-v11-estimate")).toBeTruthy();
    await flush();
    expect(fetchers.vo2).toHaveBeenCalledTimes(1); expect(fetchers.vo2.mock.calls[0][0]).toBe(uid);
    expect(fetchers.stream.mock.calls.length).toBeGreaterThan(0); expect(fetchers.stream.mock.calls.length).toBeLessThanOrEqual(16);
    for (const c of fetchers.stream.mock.calls) { expect(c[0]).toBe(uid); expect(c[2]).toBe(40); }
    expect(q("physiology-loading")).toBeNull();
    const phys = text("hybrid-v11-physiology");
    expect(phys).toMatch(/VO₂ max improving \(46\.5 → 47\.8\)/); expect(phys).toMatch(/corroboration only, never converted to a finish time/);
    expect(phys).toMatch(/comparison runs use warm-up-trimmed heart rate/);
  });
  it("re-rendering and revisiting the page read nothing again (deduplicated, in memory, per session)", async () => {
    fetchers.vo2.mockResolvedValue({ entries: vo2Entries(47, 47), docsRead: 40 });
    fetchers.stream.mockImplementation(async () => ({ samples: steady(), chunks: 6 }));
    const a = athlete(), uid = mount(athlete());
    await flush();
    const v = fetchers.vo2.mock.calls.length, s = fetchers.stream.mock.calls.length;
    mount(a, uid); await flush(); mount(a, uid); await flush();
    act(() => root.unmount()); root = createRoot(container); mount(a, uid); await flush();      // a fresh visit inside the same session
    expect(fetchers.vo2.mock.calls.length).toBe(v); expect(fetchers.stream.mock.calls.length).toBe(s);
  });
  it("a failed VO₂ and stream load degrades to the lower-evidence calculation, discloses it, and never changes the number", async () => {
    panelOnly({ raceDate: OLD, strong: improved });
    const baseline = text("hybrid-v11-value");
    fetchers.vo2.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    fetchers.stream.mockRejectedValue(new Error("offline"));
    act(() => root.unmount()); root = createRoot(container);
    mount(athlete());
    await flush();
    expect(text("hybrid-v11-value")).toBe(baseline);
    const phys = text("hybrid-v11-physiology");
    expect(phys).toMatch(/VO₂ max readings could not be loaded/); expect(phys).toMatch(/Heart-rate streams could not be loaded; whole-workout average heart rate was used/);
    expect(q("physiology-loading")).toBeNull();
  });
  it("reads nothing when the experiment or hydration is disabled, or the inputs are not loaded yet", async () => {
    mount(athlete(), newUid(), { enabled: false }); await flush();
    mount(athlete(), newUid(), { isReady: false }); await flush();
    mount(athlete(), null); await flush();
    expect(fetchers.vo2).not.toHaveBeenCalled(); expect(fetchers.stream).not.toHaveBeenCalled();
    expect(text("hybrid-v11-physiology")).toMatch(/not supplied|not requested/i);
  });
  it("another account never sees the previous account's evidence: a user change reloads and shows only the new readings", async () => {
    fetchers.vo2.mockImplementation(async (uid: string) => ({ entries: uid === "acct-a" ? vo2Entries(47.8, 46.5) : vo2Entries(46.5, 47.8), docsRead: 40 }));
    fetchers.stream.mockImplementation(async () => ({ samples: steady(), chunks: 6 }));
    const a = athlete();
    mount(a, "acct-a"); await flush();
    expect(text("hybrid-v11-physiology")).toMatch(/improving/);
    mount(a, "acct-b"); await flush();
    expect(fetchers.vo2.mock.calls.map(c => c[0])).toEqual(["acct-a", "acct-b"]);
    expect(text("hybrid-v11-physiology")).toMatch(/declining/); expect(text("hybrid-v11-physiology")).not.toMatch(/improving/);
  });
  it("at the instant a different account takes over, the previous account's readings are never shown (loading, not stale data)", async () => {
    let release!: (v: { entries: ReturnType<typeof vo2Entries>; docsRead: number }) => void;
    fetchers.vo2.mockImplementation((uid: string) => uid === "acct-c" ? Promise.resolve({ entries: vo2Entries(47.8, 46.5), docsRead: 40 }) : new Promise(r => { release = r; }));
    fetchers.stream.mockImplementation(async () => ({ samples: steady(), chunks: 6 }));
    const a = athlete();
    mount(a, "acct-c"); await flush();
    expect(text("hybrid-v11-physiology")).toMatch(/improving/);
    mount(a, "acct-d");                                                                      // new account, its own read still pending
    expect(text("hybrid-v11-physiology")).not.toMatch(/improving/); expect(text("physiology-loading")).toMatch(/Loading VO₂ max/);
    release({ entries: vo2Entries(46.5, 47.8), docsRead: 40 }); await flush();
    expect(text("hybrid-v11-physiology")).toMatch(/declining/);
  });
});

describe("panel states for hybrid v1.1", () => {
  it("populated: experimental, provisional, beside the official rows, with a separate forecast and an explicit influence breakdown", () => {
    panelOnly({ raceDate: OLD, strong: improved });
    const row = q("hybrid-v11-estimate")!;
    expect(row.textContent).toMatch(/Experimental — Hybrid Performance Model v1\.1/); expect(row.textContent).toMatch(/not independently validated/);
    expect(q("estimate-values")).toBeTruthy();                                                  // official v2 row unchanged
    expect(q("hybrid-estimate")).toBeNull();                                                    // v1 row replaced by v1.1
    expect(text("hybrid-v11-range")).toMatch(/not a statistical interval/);
    const inf = text("hybrid-v11-influence");
    expect(inf).toMatch(/Latest race: Jul 30, 2026, 100 days ago/); expect(inf).toMatch(/Newer qualified efforts: 3/); expect(inf).toMatch(/Independent observations used: 4/);
    expect(text("hybrid-v11-items")).toMatch(/Recorded race · Jul 30, 2026 \(100 d\)/); expect(text("hybrid-v11-items")).toMatch(/Strong whole-run effort/);
    expect(text("hybrid-v11-why")).toMatch(/moved the base .* faster than the race alone implies/);
    expect(text("race-day-forecast-summary")).toMatch(/provisional · experimental/);
    expect(container.textContent).toMatch(/experimental-raceday-forecast-v2/);
    expect(text("hybrid-v11-evidence-counts")).toMatch(/Evidence quality/);
    expect(q("hybrid-v11-vs-v1")).toBeNull();
  });
  it("race-dependent: says so on the primary card when an aging race carries the estimate", () => {
    panelOnly({ raceDate: OLD });
    expect(text("hybrid-v11-race-dependent")).toMatch(/Still race-dependent: 100% rests on your Jul 30, 2026 race \(100 days old\)/);
    expect(text("hybrid-v11-reason")).toMatch(/age has not changed it, only how certain it is/);
    expect(q("hybrid-v11-estimate")!.getAttribute("data-status")).toBe("provisional");
  });
  it("excluded workouts are explained: a fast segment with ordinary heart rate is listed with its reason", () => {
    panelOnly({ raceDate: OLD, segments: [{ date: "2026-10-28", hostMiles: 8, hostPace: 585, hr: 148, key: "10k", segPace: 545, type: "Tempo Run" }] });
    expect(text("hybrid-v11-excluded")).toMatch(/1 × a fast segment whose run had ordinary heart rate/);
  });
  it("unavailable: an expired race with nothing recent gives an explicit reason and no number", () => {
    panelOnly({ raceDate: "2026-04-01" });
    expect(text("hybrid-v11-value")).toBe("Not available"); expect(text("hybrid-v11-status")).toBe("Unavailable");
    expect(text("hybrid-v11-reason")).toMatch(/older than 180 days/);
    expect(q("hybrid-v11-estimate")!.getAttribute("data-status")).toBe("unavailable");
  });
  it("conflicting signals are shown, not hidden", () => {
    panelOnly({ raceDate: OLD, strong: improved, paceChangeFrom: "2026-09-10", paceFactorAfter: 1.05 });
    expect(text("hybrid-v11-conflict")).toMatch(/Signals disagree/); expect(text("hybrid-v11-conflict")).toMatch(/Reported, not averaged away/);
  });
  it("missing evidence is listed, including VO₂ and heart-rate streams, and confidence is never presented as validation", () => {
    panelOnly({ raceDate: OLD, strong: improved });
    expect(text("hybrid-v11-missing")).toMatch(/VO₂ max/); expect(text("hybrid-v11-details")).not.toMatch(/validated for your individual accuracy/);
    expect(q("hybrid-v11-estimate")!.textContent).not.toMatch(/confidence interval of|95%/);
  });
  it("the estimate-details dialog carries the v1.1 methodology, families, missing information and assumptions", () => {
    panelOnly({ raceDate: OLD, strong: improved });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="view-estimate-details"]')!.click());
    const method = document.querySelector('[data-testid="estimate-details-dialog"] [data-testid="hybrid-methodology"]')!;
    expect(method.textContent).toContain("Hybrid Performance Model v1.1 (experimental)");
    for (const f of ["Demonstrated performance", "Physiological trend", "Race history", "Endurance preparation"]) expect(method.textContent).toContain(f);
    expect(method.querySelector('[data-testid="hybrid-v11-missing"]')?.textContent).toMatch(/VO₂|heart-rate streams|Weather/);
    expect(method.textContent).toContain("No calibrated confidence interval"); expect(method.textContent).toContain("experimental-hybrid-hm-v1.1");
    expect(method.textContent).toMatch(/training-load, fatigue and intensity-distribution metrics add no numerical term/);
  });
});

describe("rollback and gating", () => {
  it("DISABLE_HYBRID_V11 keeps v1 in advanced comparisons and restores the v1 forecast", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_V11", "true");
    expect(isExperimentalHybridV11Enabled()).toBe(false); expect(isPhysiologyHydrationEnabled()).toBe(false);
    panelOnly({ raceDate: OLD, strong: improved });
    expect(q("hybrid-v11-estimate")).toBeNull(); expect(q("hybrid-estimate")).toBeNull(); expect(q("estimate-values")).toBeTruthy();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="view-estimate-details"]')!.click());
    expect(document.querySelector('[data-testid="additional-model-comparisons"] [data-testid="hybrid-estimate"]')).toBeTruthy();
    expect(container.textContent).toMatch(/experimental-raceday-forecast-v1/); expect(container.textContent).not.toMatch(/experimental-raceday-forecast-v2/);
  });
  it("DISABLE_HYBRID_ESTIMATE removes both hybrids; DISABLE_PHYSIOLOGY_HYDRATION removes only the extra reads", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_PHYSIOLOGY_HYDRATION", "true");
    expect(isExperimentalHybridV11Enabled()).toBe(true); expect(isPhysiologyHydrationEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE", "true");
    expect(isExperimentalHybridV11Enabled()).toBe(false);
    panelOnly({ raceDate: OLD, strong: improved });
    expect(q("hybrid-v11-estimate")).toBeNull(); expect(q("hybrid-estimate")).toBeNull(); expect(q("estimate-values")).toBeTruthy();
  });
  it("not enabled outside Production unless the existing explicit opt-in is set", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview"); vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "");
    expect(isExperimentalHybridV11Enabled()).toBe(false);
  });
});
