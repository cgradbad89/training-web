import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutPlan } from "@/types/plan";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { UserSettings } from "@/types/userSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  pathname: "/dashboard",
  search: "",
  retainHealthPage: false,
  tag: "A",
  authObserver: null as ((user: User | null) => void) | null,
  authUnsubscribe: vi.fn(),
  replace: vi.fn(),
  W: vi.fn(), delta: vi.fn(), P: vi.fn(), R: vi.fn(), O: vi.fn(), H: vi.fn(),
  listen: vi.fn(), candidates: vi.fn(), match: vi.fn(),
  healthMetrics: vi.fn(), healthRange: vi.fn(), healthAll: vi.fn(), healthGoals: vi.fn(), ringGoals: vi.fn(),
  computePR: vi.fn(), badgeMap: vi.fn(), batchCommit: vi.fn(),
  listenerStarts: 0, listenerStops: 0, maxListeners: 0,
  listeners: new Set<((workouts: HealthWorkout[]) => void)>(),
  idleStarts: 0, idleStops: 0, nextIdleId: 0,
  idle: new Map<number, () => void>(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useSearchParams: () => new URLSearchParams(h.search),
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("next/dynamic", () => ({
  default: () => (props: { data?: { date: string }[] }) => <span data-testid="chart-dates">{props.data?.map(point => point.date).join(",")}</span>,
}));
vi.mock("@/components/layout/HubBanner", () => ({ HubBanner: () => null }));
vi.mock("@/components/layout/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("@/lib/auth", () => ({
  onAuthChange: (callback: (user: User | null) => void) => { h.authObserver = callback; return h.authUnsubscribe; },
  signOut: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(), writeBatch: () => ({ update: vi.fn(), commit: h.batchCommit }),
}));
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkouts: h.W, fetchHealthWorkoutsInRange: h.delta,
  AUTO_MATCH_CANDIDATE_PAGE_SIZE: 250,
  onHealthWorkoutsSnapshot: h.listen, fetchAutoMatchCandidatesThroughDate: h.candidates,
}));
vi.mock("@/services/plans", () => ({ fetchPlans: h.P }));
vi.mock("@/services/races", () => ({ fetchRaces: h.R }));
vi.mock("@/services/workoutOverrides", () => ({ fetchAllOverrides: h.O }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: h.H }));
vi.mock("@/services/autoMatch", async () => ({
  ...await vi.importActual("@/services/autoMatch"), autoMatchCrossTrainingSessions: h.match,
}));
vi.mock("@/services/healthMetrics", async () => ({
  ...await vi.importActual("@/services/healthMetrics"),
  fetchHealthMetrics: h.healthMetrics, fetchAllHealthMetrics: h.healthAll,
  fetchHealthMetricsRange: h.healthRange, fetchHourlyHeartRate: vi.fn().mockResolvedValue(null),
  fetchHealthGoals: h.healthGoals,
}));
vi.mock("@/services/healthGoals", () => ({ fetchHealthGoals: h.ringGoals }));
vi.mock("@/utils/prComputation", () => ({ computeAllPRs: h.computePR, buildPRBadgeMap: h.badgeMap }));

import AppLayout from "../layout";
import HealthPage from "../health/page";
import { useHealthData } from "@/contexts/HealthDataContext";
import { healthDateStatus, healthRollingRange, metricsInCacheRange } from "@/utils/healthMetricsCache";
import type { HealthMetric } from "@/services/healthMetrics";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAppData, type AppDataContextValue, workoutDeltaStartDate } from "@/contexts/AppDataContext";

let root: Root;
let container: HTMLDivElement;
let latest: AppDataContextValue;
let latestHealth: ReturnType<typeof useHealthData>;
let healthRenders: { route: string; data: ReturnType<typeof useHealthData> }[];
let renders: { route: string; data: AppDataContextValue }[];
function Probe() {
  const health = useHealthData();
  React.useLayoutEffect(() => { latestHealth = health; healthRenders.push({ route: h.pathname, data: health }); });
  const value = useAppData();
  React.useLayoutEffect(() => { latest = value; renders.push({ route: h.pathname, data: value }); });
  const loading = value.workoutsLoading || value.plansLoading || value.racesLoading || value.overridesLoading || value.settingsLoading;
  return <div data-testid="canonical-page">{loading ? "cold-loading" : value.workouts.map(w => w.workoutId).join(",")}</div>;
}
function Tree() {
  return <AuthProvider><AppLayout><Probe />{(h.pathname.startsWith("/health") || h.retainHealthPage) && <HealthPage />}</AppLayout></AuthProvider>;
}
function user(uid = "A"): User {
  return { uid, email: "folstromjohn@gmail.com", emailVerified: true } as User;
}
function data(tag = h.tag) {
  return {
    W: [{ workoutId: `${tag}-workout`, isRunLike: false, activityType: "traditionalStrengthTraining", startDate: new Date(2026, 9, 5, 10) }] as HealthWorkout[],
    P: [{ id: `${tag}-plan`, planType: "workout", name: "Workout plan", startDate: "2026-10-05", status: "active", isActive: true,
      createdAt: "2026-10-05", updatedAt: "2026-10-05",
      weeks: [{ weekNumber: 1, entries: [{ id: "entry", weekIndex: 0, weekday: 1, dayOfWeek: 0, type: "workout", category: "strength" }] }],
    }] as WorkoutPlan[],
    R: [{ id: `${tag}-race` }] as Race[],
    O: { [`${tag}-workout`]: { workoutId: `${tag}-workout`, isExcluded: false } } as Record<string, WorkoutOverride>,
    H: { maxHeartRate: tag === "A" ? 180 : 190 } as UserSettings,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function pendingReturn(full = false) {
  const p = { W: deferred<HealthWorkout[]>(), P: deferred<WorkoutPlan[]>(), R: deferred<Race[]>(), O: deferred<Record<string, WorkoutOverride>>(), H: deferred<UserSettings>() };
  (full ? h.W : h.delta).mockReturnValueOnce(p.W.promise);
  for (const name of ["P", "R", "O", "H"] as const) h[name].mockReturnValueOnce(p[name].promise);
  return p;
}
async function finish(p: ReturnType<typeof pendingReturn>, tag = h.tag) {
  const values = data(tag);
  await act(async () => { p.W.resolve(values.W); p.P.resolve(values.P); p.R.resolve(values.R); p.O.resolve(values.O); p.H.resolve(values.H); });
}
async function mount(path = "/dashboard", strict = false) {
  h.pathname = path;
  await act(async () => root.render(strict ? <React.StrictMode><Tree /></React.StrictMode> : <Tree />));
  await act(async () => h.authObserver?.(user()));
}
async function navigate(path: string, strict = false) {
  h.pathname = path;
  await act(async () => root.render(strict ? <React.StrictMode><Tree /></React.StrictMode> : <Tree />));
}
async function visible() {
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}
async function runIdle() {
  await act(async () => {
    for (const [id, callback] of [...h.idle]) { h.idle.delete(id); callback(); }
  });
}
function loaders(expected: number) {
  for (const fn of [h.W, h.P, h.R, h.O, h.H]) expect(fn).toHaveBeenCalledTimes(expected);
}
function residentRefs() {
  return [latest.workouts, latest.plans, latest.races, latest.overrides, latest.userSettings];
}
function expectResident(refs: unknown[]) {
  residentRefs().forEach((value, i) => expect(value).toBe(refs[i]));
  expect(latest).toMatchObject({ workoutsLoading: false, plansLoading: false, racesLoading: false, overridesLoading: false, settingsLoading: false });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 12));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(console, "error").mockImplementation(() => {});
  renders = []; healthRenders = []; h.pathname = "/dashboard"; h.tag = "A"; h.search = ""; h.retainHealthPage = false;
  h.authUnsubscribe.mockReset(); h.replace.mockReset();
  for (const name of ["W", "P", "R", "O", "H"] as const) h[name].mockReset().mockImplementation(async () => data()[name]);
  h.delta.mockReset().mockResolvedValue([]);
  h.healthMetrics.mockReset().mockResolvedValue([]);
  h.healthRange.mockReset().mockResolvedValue([]);
  h.healthAll.mockReset().mockResolvedValue([]);
  h.healthGoals.mockReset().mockResolvedValue(null);
  h.ringGoals.mockReset().mockResolvedValue([]);
  h.candidates.mockReset().mockImplementation(async (_uid, _date, opts) => opts.initialCandidates);
  h.match.mockReset().mockResolvedValue({ plans: [], result: { matched: 0, updatedPlanIds: [] } });
  h.listeners.clear(); h.listenerStarts = 0; h.listenerStops = 0; h.maxListeners = 0;
  h.listen.mockReset().mockImplementation((_uid, _opts, callback) => {
    h.listenerStarts++; h.listeners.add(callback); h.maxListeners = Math.max(h.maxListeners, h.listeners.size);
    return () => { h.listenerStops++; h.listeners.delete(callback); };
  });
  h.idle.clear(); h.idleStarts = 0; h.idleStops = 0; h.nextIdleId = 0;
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => {
    h.idleStarts++; const id = ++h.nextIdleId; h.idle.set(id, callback); return id;
  }));
  vi.stubGlobal("cancelIdleCallback", vi.fn((id: number) => { h.idleStops++; h.idle.delete(id); }));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: vi.fn((k: string) => storage.get(k) ?? null), setItem: vi.fn((k: string, v: string) => storage.set(k, v)) });
  h.computePR.mockReset().mockReturnValue([]); h.badgeMap.mockReset().mockReturnValue(new Map());
  h.batchCommit.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  expect(h.listeners.size).toBe(0);
  expect(h.maxListeners).toBeLessThanOrEqual(1);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Phase 2A authenticated training session lifecycle", () => {
  it.each(["/health", "/health/trends"])("cold %s has W/P/R/O/H/AutoMatch/PR/focus = 0 and preserves Health reads", async path => {
    await mount(path);
    loaders(0); expect(h.delta).not.toHaveBeenCalled();
    expect(h.listen).not.toHaveBeenCalled(); expect(h.idleStarts).toBe(0); expect(h.computePR).not.toHaveBeenCalled();
    expect(latest.trainingActivated).toBe(false);
    expect(h.healthRange).toHaveBeenCalledWith("A", "2026-07-07", "2026-10-05");
    expect(h.healthGoals).toHaveBeenCalledWith("A"); expect(h.ringGoals).toHaveBeenCalledWith("A");
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await visible();
    loaders(0); expect(h.delta).not.toHaveBeenCalled(); expect(h.healthRange).toHaveBeenCalledTimes(2);
  });

  it("first training activation initializes all canonical sources once and eligible runners start", async () => {
    await mount("/health");
    const before = renders.length;
    await navigate("/dashboard");
    expect(renders[before].data).toMatchObject({ workoutsLoading: true, plansLoading: true, racesLoading: true, overridesLoading: true, settingsLoading: true });
    loaders(1); expect(h.delta).not.toHaveBeenCalled();
    expect(latest.trainingActivated).toBe(true); expect(latest.workouts).toEqual(data().W);
    expect(h.W).toHaveBeenCalledWith("A", { limitCount: 1000 });
    expect(h.listenerStarts).toBe(1); expect(h.idleStarts).toBe(1);
    await runIdle(); expect(h.computePR).toHaveBeenCalledTimes(1);
  });

  it("training route navigation preserves state without reinitialization or runner restart", async () => {
    await mount(); const refs = residentRefs();
    await navigate("/plans"); await navigate("/routes");
    loaders(1); expectResident(refs); expect(h.delta).not.toHaveBeenCalled();
    expect(h.listenerStarts).toBe(1); expect(h.listenerStops).toBe(0); expect(h.idleStarts).toBe(1);
  });

  it("Health retains canonical arrays, disposes runners and does no training visibility/return reads", async () => {
    await mount(); const refs = residentRefs(); const retiredIdle = [...h.idle.values()];
    await navigate("/health"); expectResident(refs); expect(latest.trainingActive).toBe(false);
    expect(h.listenerStarts).toBe(1); expect(h.listenerStops).toBe(1); expect(h.idle.size).toBe(0);
    await act(async () => retiredIdle.forEach(callback => callback()));
    vi.setSystemTime(new Date(2026, 9, 6, 12)); await visible();
    loaders(1); expect(h.delta).not.toHaveBeenCalled(); expect(h.computePR).not.toHaveBeenCalled();
    expect(h.healthRange).toHaveBeenCalledTimes(2);
  });

  it("same-day Dashboard → Health → Dashboard exposes resident data first and performs one delta plus P/R/O/H", async () => {
    await mount(); const refs = residentRefs(); await runIdle();
    await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); const before = renders.length;
    await navigate("/dashboard");
    const first = renders.slice(before).find(r => r.route === "/dashboard")!.data;
    expect(first.workouts).toBe(refs[0]); expect(first.plans).toBe(refs[1]); expect(first.races).toBe(refs[2]);
    expect(first.overrides).toBe(refs[3]); expect(first.userSettings).toBe(refs[4]);
    expectResident(refs); expect(container.textContent).not.toContain("cold-loading");
    expect(latest).toMatchObject({ workoutsRefreshing: true, plansRefreshing: true, racesRefreshing: true, overridesRefreshing: true, settingsRefreshing: true });
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).toHaveBeenCalledTimes(1);
    expect(h.delta).toHaveBeenCalledWith("A", workoutDeltaStartDate(data().W[0].startDate));
    for (const fn of [h.P, h.R, h.O, h.H]) expect(fn).toHaveBeenCalledTimes(2);
    await visible(); expect(h.delta).toHaveBeenCalledTimes(1);
    await finish(pending); await visible(); expect(h.delta).toHaveBeenCalledTimes(1);
    expect(h.listenerStarts).toBe(2); expect(h.listenerStops).toBe(1); expect(h.listeners.size).toBe(1);
    expect(h.idleStarts).toBe(1); expect(h.computePR).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ workoutsRefreshing: false, plansRefreshing: false, racesRefreshing: false, overridesRefreshing: false, settingsRefreshing: false });
    expect(latest.workoutsFullReconciliationVersion).toBe(1);
  });

  it("return with identical source objects settles the plan eligibility barrier", async () => {
    const original = data();
    for (const name of ["W", "P", "R", "O", "H"] as const) h[name].mockResolvedValue(original[name]);
    await mount(); await navigate("/health"); await navigate("/dashboard");
    expect(latest.plansResolution).toBe("success"); expect(h.listeners.size).toBe(1);
    expect(latest.plans).toBe(original.P);
  });

  it("successful empty sources and missing settings remain resident during return revalidation", async () => {
    h.W.mockResolvedValue([]); h.P.mockResolvedValue([]); h.R.mockResolvedValue([]); h.O.mockResolvedValue({}); h.H.mockResolvedValue(null);
    await mount(); const refs = residentRefs(); await navigate("/health");
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); const pending = pendingReturn(); await navigate("/dashboard");
    expectResident(refs); expect(latest.maxHr).toBe(185);
    expect(latest).toMatchObject({ workoutsRefreshing: true, plansRefreshing: true, racesRefreshing: true, overridesRefreshing: true, settingsRefreshing: true });
    await act(async () => { pending.W.resolve([]); pending.P.resolve([]); pending.R.resolve([]); pending.O.resolve({}); pending.H.resolve(null as unknown as UserSettings); });
    expect(latest.settingsResolution).toBe("success"); expect(latest.workoutsResolution).toBe("success");
    expect(latest.userSettings).toBeNull(); expect(h.listen).not.toHaveBeenCalled();
  });

  it("same-day rapid return respects the 30-second floor while P/R/O/H still revalidate", async () => {
    await mount(); await navigate("/health"); await navigate("/dashboard");
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).not.toHaveBeenCalled();
    for (const fn of [h.P, h.R, h.O, h.H]) expect(fn).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 31)); await visible();
    expect(h.delta).toHaveBeenCalledTimes(1);
  });

  it("later-local-day return keeps resident data and uses only one full reconciliation", async () => {
    await mount(); const refs = residentRefs(); await navigate("/health");
    vi.setSystemTime(new Date(2026, 9, 6, 12)); const pending = pendingReturn(true);
    await navigate("/dashboard"); expectResident(refs); expect(latest.workoutsFullReconciliationVersion).toBe(1);
    loaders(2); expect(h.delta).not.toHaveBeenCalled(); await visible(); loaders(2);
    await finish(pending); expect(latest.workoutsFullReconciliationVersion).toBe(2);
    expect(h.delta).not.toHaveBeenCalled(); await visible(); expect(h.W).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(2026, 9, 6, 12, 1)); await visible();
    expect(h.delta).toHaveBeenCalledTimes(1); expect(h.W).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("failed return (later day = %s) preserves W/P/R/O/H and retries without cold loading", async laterDay => {
    await mount(); const refs = residentRefs(); await navigate("/health");
    vi.setSystemTime(new Date(2026, 9, laterDay ? 6 : 5, 12, 1)); const pending = pendingReturn(laterDay);
    await navigate("/dashboard");
    await act(async () => { for (const source of Object.values(pending)) source.reject(new Error("refresh failed")); });
    expectResident(refs);
    expect(latest).toMatchObject({ workoutsResolution: "error", plansResolution: "error", racesResolution: "error", overridesResolution: "error", settingsResolution: "error",
      workoutsRefreshing: false, plansRefreshing: false, racesRefreshing: false, overridesRefreshing: false, settingsRefreshing: false });
    expect(latest.workoutsFullReconciliationVersion).toBe(1);
    await navigate("/health"); vi.setSystemTime(new Date(2026, 9, laterDay ? 6 : 5, 12, 2)); await navigate("/dashboard");
    expect(latest).toMatchObject({ workoutsResolution: "success", plansResolution: "success", racesResolution: "success", overridesResolution: "success", settingsResolution: "success" });
    expect(h.W).toHaveBeenCalledTimes(laterDay ? 3 : 1); expect(h.delta).toHaveBeenCalledTimes(laterDay ? 0 : 2);
    for (const fn of [h.P, h.R, h.O, h.H]) expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rapid Health/training transitions reuse pending W/P/R/O/H without orphan listeners", async () => {
    await mount(); const refs = residentRefs(); await navigate("/health");
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); const pending = pendingReturn();
    await navigate("/dashboard"); await navigate("/health"); await navigate("/dashboard");
    expectResident(refs); expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).toHaveBeenCalledTimes(1);
    for (const fn of [h.P, h.R, h.O, h.H]) expect(fn).toHaveBeenCalledTimes(2);
    let promises!: Promise<void>[];
    act(() => { promises = [latest.refreshPlans(), latest.refreshPlans(), latest.refreshRaces(), latest.refreshRaces(), latest.refreshOverrides(), latest.refreshOverrides(), latest.refreshSettings(), latest.refreshSettings()]; });
    for (let i = 0; i < promises.length; i += 2) expect(promises[i]).toBe(promises[i + 1]);
    await finish(pending); await act(async () => { await Promise.all(promises); });
    expect(h.listenerStarts).toBe(2); expect(h.listenerStops).toBe(1); expect(h.listeners.size).toBe(1);
    expect(latest.workouts.map(w => w.workoutId)).toEqual(["A-workout"]);
  });

  it("later-day return promotes one full behind an existing delta and reuses it for visibility/manual callers", async () => {
    await mount(); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const delta = deferred<HealthWorkout[]>(); h.delta.mockReturnValueOnce(delta.promise); await visible();
    await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 6, 12)); const full = deferred<HealthWorkout[]>(); h.W.mockReturnValueOnce(full.promise);
    await navigate("/dashboard"); let manual!: Promise<void>; act(() => { manual = latest.refreshWorkouts(); }); await visible();
    expect(h.W).toHaveBeenCalledTimes(1);
    await act(async () => delta.resolve([])); expect(h.W).toHaveBeenCalledTimes(2);
    await act(async () => { full.resolve(data().W); await manual; });
    expect(h.delta).toHaveBeenCalledTimes(1); expect(latest.workoutsFullReconciliationVersion).toBe(2);
  });

  it("initial loads pending across Health return are reused and remain true cold loads", async () => {
    const pending = pendingReturn(true); await mount(); await navigate("/health"); await navigate("/dashboard");
    loaders(1); expect(h.delta).not.toHaveBeenCalled(); expect(latest.workoutsLoading).toBe(true);
    await finish(pending); expect(latest.workoutsLoading).toBe(false); expect(h.listenerStarts).toBe(1);
  });

  it("an initial source failure can retry on return without masquerading as resident success", async () => {
    h.P.mockRejectedValueOnce(new Error("initial plans failed")); await mount();
    expect(latest.plansResolution).toBe("error"); expect(latest.plans).toEqual([]);
    await navigate("/health"); const pending = deferred<WorkoutPlan[]>(); h.P.mockReturnValueOnce(pending.promise);
    await navigate("/dashboard"); expect(latest.plansLoading).toBe(true); expect(latest.plansRefreshing).toBe(false);
    await act(async () => pending.resolve(data().P)); expect(latest.plansResolution).toBe("success");
  });

  it("manual workout refresh remains full and concurrent source refreshes stay coordinated", async () => {
    await mount(); const pending = pendingReturn(true); let requests!: Promise<void>[];
    act(() => { requests = [latest.refreshWorkouts(), latest.refreshWorkouts(), latest.refreshPlans(), latest.refreshRaces(), latest.refreshOverrides(), latest.refreshSettings()]; });
    expect(requests[0]).toBe(requests[1]); loaders(2); expect(h.delta).not.toHaveBeenCalled();
    await finish(pending); await act(async () => { await Promise.all(requests); });
    expect(latest.workoutsFullReconciliationVersion).toBe(2);
  });

  it.each(["A", "B"])("batched logout/login to UID %s retires resident state, pending return reads and callbacks", async nextUid => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); await navigate("/dashboard"); const retired = latest;
    await navigate("/health"); h.tag = "B"; const updater = vi.fn(prev => prev);
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user(nextUid)); retired.patchRaces(updater); });
    expect(updater).not.toHaveBeenCalled();
    expect(latest.workouts).toEqual([]); expect(latest.trainingActivated).toBe(false);
    const before = renders.length; await navigate("/dashboard");
    expect(latest.workouts).toEqual(data("B").W); await finish(pending, "A");
    await act(async () => { retired.patchPlan(data("A").P[0]); retired.patchOverrides(updater); retired.patchTrainingLoad("B-workout", { trainingLoadV2: 999 }); });
    expect(latest.workouts).toEqual(data("B").W); expect(latest.plans).toEqual(data("B").P);
    expect(latest.races).toEqual(data("B").R); expect(latest.overrides).toEqual(data("B").O); expect(latest.userSettings).toEqual(data("B").H);
    expect(updater).not.toHaveBeenCalled();
    for (const r of renders.slice(before)) expect(r.data.workouts.some(w => w.workoutId === "A-workout")).toBe(false);
  });

  it("post-write plans/settings refreshes queue fresh reads behind return revalidation", async () => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); await navigate("/dashboard");
    h.tag = "B"; let firstP!: Promise<void>; let secondP!: Promise<void>; let settings!: Promise<void>;
    act(() => {
      firstP = latest.refreshPlans({ afterMutation: true });
      secondP = latest.refreshPlans({ afterMutation: true });
      settings = latest.refreshSettings({ afterMutation: true });
    });
    expect(firstP).toBe(secondP); expect(h.P).toHaveBeenCalledTimes(2); expect(h.H).toHaveBeenCalledTimes(2);
    await finish(pending, "A"); await act(async () => { await Promise.all([firstP, settings]); });
    expect(h.P).toHaveBeenCalledTimes(3); expect(h.H).toHaveBeenCalledTimes(3);
    expect(latest.plans).toEqual(data("B").P); expect(latest.userSettings).toEqual(data("B").H);
  });

  it("persisted plan/race/override publications cannot be overwritten by pre-mutation return reads", async () => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); await navigate("/dashboard");
    const freshP = deferred<WorkoutPlan[]>(), freshR = deferred<Race[]>(), freshO = deferred<Record<string, WorkoutOverride>>();
    h.P.mockReturnValueOnce(freshP.promise); h.R.mockReturnValueOnce(freshR.promise); h.O.mockReturnValueOnce(freshO.promise);
    const savedPlan = { ...data().P[0], name: "Saved" };
    const savedRace = { ...data().R[0], name: "Saved race" };
    const savedOverrides = { ...data().O, "A-workout": { ...data().O["A-workout"], isExcluded: true } };
    await act(async () => {
      latest.patchPlan(savedPlan); latest.patchRaces(() => [savedRace]); latest.patchOverrides(() => savedOverrides);
    });
    await finish(pending);
    expect(latest.plans).toEqual([savedPlan]); expect(latest.races).toEqual([savedRace]); expect(latest.overrides).toEqual(savedOverrides);
    for (const fn of [h.P, h.R, h.O]) expect(fn).toHaveBeenCalledTimes(3);
    await act(async () => { freshP.resolve([savedPlan]); freshR.resolve([savedRace]); freshO.resolve(savedOverrides); });
    expect(latest.plansResolution).toBe("success");
  });

  it.each([false, true])("pending return W (full = %s) preserves a later successful training-load patch", async full => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, full ? 6 : 5, 12, 1));
    const pending = pendingReturn(full); await navigate("/dashboard");
    await act(async () => latest.patchTrainingLoad("A-workout", { trainingLoadV2: 97, trainingLoadMethod: "streamed", trainingLoadBasisComplete: true }));
    await finish(pending);
    expect(latest.workouts[0]).toMatchObject({ trainingLoadV2: 97, trainingLoadMethod: "streamed", trainingLoadBasisComplete: true });
    expect(h.W).toHaveBeenCalledTimes(full ? 2 : 1); expect(h.delta).toHaveBeenCalledTimes(full ? 0 : 1);
  });

  it("post-write queued refreshes retire with the authenticated session", async () => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); await navigate("/dashboard"); let queued!: Promise<void>[];
    act(() => { queued = [latest.refreshPlans({ afterMutation: true }), latest.refreshSettings({ afterMutation: true })]; });
    await act(async () => h.authObserver?.(null)); h.tag = "B";
    await act(async () => h.authObserver?.(user("B")));
    await finish(pending, "A"); await act(async () => { await Promise.all(queued); });
    expect(h.P).toHaveBeenCalledTimes(3); expect(h.H).toHaveBeenCalledTimes(3);
    expect(latest.plans).toEqual(data("B").P); expect(latest.userSettings).toEqual(data("B").H);
  });

  it("pending initial W/P/R/O/H cannot publish through logout and new identity", async () => {
    const pending = pendingReturn(true); await mount(); await navigate("/health"); h.tag = "B";
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user("B")); });
    await navigate("/dashboard"); await finish(pending, "A");
    expect(latest.workouts).toEqual(data("B").W); expect(latest.plans).toEqual(data("B").P);
    expect(latest.races).toEqual(data("B").R); expect(latest.overrides).toEqual(data("B").O); expect(latest.userSettings).toEqual(data("B").H);
  });

  it("genuine unmount retires retained return reads and a same-UID remount starts empty", async () => {
    await mount(); await navigate("/health"); vi.setSystemTime(new Date(2026, 9, 5, 12, 1));
    const pending = pendingReturn(); await navigate("/dashboard"); const retired = latest;
    await act(async () => root.render(null)); h.tag = "B"; await mount(); await finish(pending, "A");
    await act(async () => retired.patchPlan(data("A").P[0]));
    expect(latest.workouts).toEqual(data("B").W); expect(latest.plans).toEqual(data("B").P);
  });

  it("Strict Mode cold Health remains lazy through later activation and return", async () => {
    await mount("/health", true); loaders(0); expect(h.idleStarts).toBe(0);
    const retired = pendingReturn(true); await navigate("/dashboard", true);
    // This owner was already mounted on Health, so activation has one setup.
    loaders(1); await finish(retired); expect(latest.workoutsResolution).toBe("success");
    await navigate("/health", true); await navigate("/dashboard", true);
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.maxListeners).toBe(1);
  });

  it("Strict Mode on cold training settles all sources and leaves one listener", async () => {
    const retired = pendingReturn(true); await mount("/dashboard", true);
    loaders(2); expect(latest.workouts).toEqual(data().W); await finish(retired, "retired");
    expect(latest.workouts).toEqual(data().W); expect(latest.workoutsFullReconciliationVersion).toBe(1);
    expect(h.listeners.size).toBe(1);
  });

  it("Health-return delta still merges/deduplicates and bounds the canonical snapshot to 1000", async () => {
    const original = Array.from({ length: 1000 }, (_, i) => ({ ...data().W[0], workoutId: `w${i}`, startDate: new Date(new Date(2026, 9, 5, 10).getTime() - i * 60000) }));
    h.W.mockResolvedValueOnce(original); await mount(); await navigate("/health");
    const newest = { ...original[0], workoutId: "newest", startDate: new Date(2026, 9, 5, 11) };
    h.delta.mockResolvedValueOnce([newest, { ...original[0], name: "Edited" }]);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await navigate("/dashboard");
    expect(latest.workouts).toHaveLength(1000); expect(latest.workouts[0].workoutId).toBe("newest");
    expect(latest.workouts[1]).toMatchObject({ workoutId: "w0", name: "Edited" });
    expect(new Set(latest.workouts.map(w => w.workoutId)).size).toBe(1000);
    expect(latest.workouts.some(w => w.workoutId === "w999")).toBe(false);
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).toHaveBeenCalledTimes(1);
  });

  it("late AutoMatch fresh-plan retrieval cannot match or publish through identity replacement", async () => {
    await mount(); const oldPlans = deferred<WorkoutPlan[]>(); h.P.mockReturnValueOnce(oldPlans.promise);
    await act(async () => { for (const callback of h.listeners) callback(data().W); });
    expect(h.P).toHaveBeenCalledTimes(2); h.tag = "B";
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user("B")); });
    await act(async () => oldPlans.resolve(data("A").P));
    expect(h.match).not.toHaveBeenCalled(); expect(latest.plans).toEqual(data("B").P);
    expect(h.listeners.size).toBe(1);
  });

  it("late PR all-time retrieval cannot compute or update the persisted throttle through identity replacement", async () => {
    const original = Array.from({ length: 1000 }, (_, i) => ({ ...data().W[0], workoutId: `w${i}` }));
    h.W.mockResolvedValueOnce(original); await mount();
    const oldWorkouts = deferred<HealthWorkout[]>(); h.W.mockReturnValueOnce(oldWorkouts.promise); await runIdle();
    expect(h.W).toHaveBeenLastCalledWith("A", {}); h.tag = "B";
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user("B")); });
    await act(async () => oldWorkouts.resolve(data("A").W));
    expect(h.computePR).not.toHaveBeenCalled(); expect(localStorage.getItem("pr_last_computed")).toBeNull();
    expect(latest.workouts).toEqual(data("B").W);
  });

  it("late AutoMatch candidate work cannot start a matching pass after Health pause", async () => {
    await mount(); const candidates = deferred<HealthWorkout[]>(); h.candidates.mockReturnValueOnce(candidates.promise);
    await act(async () => { for (const callback of h.listeners) callback(data().W); });
    await navigate("/health"); await act(async () => candidates.resolve(data().W));
    expect(h.match).not.toHaveBeenCalled(); expect(h.P).toHaveBeenCalledTimes(1);
  });

  it("late AutoMatch persistence completion cannot refresh plans after pause or publish into resumed state", async () => {
    await mount(); const matching = deferred<{ plans: WorkoutPlan[]; result: { matched: number; updatedPlanIds: string[] } }>();
    h.match.mockReturnValueOnce(matching.promise);
    await act(async () => { for (const callback of h.listeners) callback(data().W); });
    expect(h.match).toHaveBeenCalledTimes(1); await navigate("/health"); await navigate("/dashboard");
    await act(async () => matching.resolve({ plans: data().P, result: { matched: 1, updatedPlanIds: ["A-plan"] } }));
    expect(h.P).toHaveBeenCalledTimes(3); // initialization + fresh-before-write + explicit return
    expect(h.listeners.size).toBe(1);
  });
});

function seedHealth(docs: HealthMetric[] = [{ date: "2026-10-05", steps: 200 }]) {
  h.healthRange.mockImplementation(async (_uid: string, start: string, end: string) => docs.filter(doc => doc.date >= start && doc.date <= end));
}
async function healthClick(text: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent?.trim() === text);
  if (!button) throw new Error(`Missing Health button: ${text}`);
  await act(async () => button.click());
}
async function healthRefresh() {
  const button = container.querySelector<HTMLButtonElement>("button[aria-label='Refresh metrics']");
  if (!button) throw new Error("Missing Health Refresh");
  await act(async () => button.click());
}
function stepsValue() {
  return container.querySelector("button[aria-label='Steps — open trends'] p")?.textContent;
}
function trainingRemainsCold() {
  loaders(0); expect(h.delta).not.toHaveBeenCalled(); expect(h.listen).not.toHaveBeenCalled();
  expect(h.idleStarts).toBe(0); expect(h.computePR).not.toHaveBeenCalled();
}

describe("Phase 2B Health correctness and authenticated retention", () => {
  it("cold training navigation never initializes the Health cache or metric sources", async () => {
    await mount(); await navigate("/plans"); await navigate("/routes");
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await visible();
    expect(latestHealth.cache).toBeNull(); expect(latestHealth.hasLoadedRolling).toBe(false);
    expect(h.healthRange).not.toHaveBeenCalled(); expect(h.healthMetrics).not.toHaveBeenCalled();
    expect(h.healthAll).not.toHaveBeenCalled(); expect(h.healthGoals).not.toHaveBeenCalled(); expect(h.ringGoals).not.toHaveBeenCalled();
  });

  it("first Health entry populates one bounded range with explicit empty dates and zero training work", async () => {
    seedHealth(); await mount("/health"); trainingRemainsCold();
    expect(h.healthRange.mock.calls).toEqual([["A", "2026-07-07", "2026-10-05"]]);
    expect(latestHealth.hasLoadedRolling).toBe(true);
    expect(latestHealth.cache?.coveredRanges).toEqual([healthRollingRange("2026-10-05")]);
    expect(healthDateStatus(latestHealth.cache!, "2026-10-04", Date.now())).toBe("covered-empty");
    expect(healthDateStatus(latestHealth.cache!, "2026-10-06", Date.now())).toBe("never-requested");
    expect(stepsValue()).toBe("200");
  });

  it("Health → Training → Health retains resident data, has zero inactive reads and zero fresh return reads", async () => {
    seedHealth(); await mount("/health"); const entries = latestHealth.cache?.entries;
    await navigate("/dashboard"); expect(latestHealth.cache?.entries).toBe(entries);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 10)); await visible();
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(h.healthAll).not.toHaveBeenCalled();
    const before = healthRenders.length; await navigate("/health");
    const first = healthRenders.slice(before).find(render => render.route === "/health")!.data;
    expect(first.cache?.entries).toBe(entries); expect(first.hasLoadedRolling).toBe(true);
    expect(container.querySelector("[aria-label='Loading health']")).toBeNull(); expect(stepsValue()).toBe("200");
    expect(h.healthRange).toHaveBeenCalledTimes(1);
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).not.toHaveBeenCalled();
  });

  it("stale return retains resident first render and starts exactly one stale range despite visibility", async () => {
    seedHealth(); await mount("/health"); await navigate("/dashboard");
    const work = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(work.promise);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await visible();
    expect(h.healthRange).toHaveBeenCalledTimes(1);
    const before = healthRenders.length; await navigate("/health");
    expect(healthRenders[before].data.hasLoadedRolling).toBe(true);
    expect(stepsValue()).toBe("200"); expect(container.querySelector("[aria-label='Loading health']")).toBeNull();
    expect(latestHealth.pendingRanges).toEqual([healthRollingRange("2026-10-05")]);
    expect(h.healthRange).toHaveBeenCalledTimes(2); await visible(); expect(h.healthRange).toHaveBeenCalledTimes(2);
    await act(async () => work.resolve([{ date: "2026-10-05", steps: 300 }])); await visible();
    expect(stepsValue()).toBe("300"); expect(h.healthRange).toHaveBeenCalledTimes(2);
  });

  it.each(["changed", "deleted"])("rolling refresh updates the canonical YTD total when September 15 is %s", async change => {
    const docs = [{ date: "2026-02-05", steps: 50 }, { date: "2026-09-15", steps: 100 }, { date: "2026-10-05", steps: 200 }];
    seedHealth(docs); await mount("/health"); await healthClick("YTD");
    expect(stepsValue()).toBe("350"); expect(h.healthRange).toHaveBeenCalledTimes(2);
    seedHealth(change === "changed" ? [docs[0], { ...docs[1], steps: 500 }, docs[2]] : [docs[0], docs[2]]);
    await healthRefresh();
    expect(stepsValue()).toBe(change === "changed" ? "750" : "250");
    expect(h.healthRange).toHaveBeenCalledTimes(3);
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-07-07", "2026-10-05"]);
    expect(latestHealth.cache?.entries.has("2026-09-15")).toBe(change === "changed");
    expect(latestHealth.cache?.entries.has("2026-02-05")).toBe(true); trainingRemainsCold();
  });

  it("parallel initial rolling and deep-linked YTD join overlapping requests without premature cold settlement", async () => {
    window.localStorage.setItem("health_time_range", "ytd");
    h.search = "tab=trends";
    const rolling = deferred<HealthMetric[]>(); const ytd = deferred<HealthMetric[]>();
    h.healthRange.mockReturnValueOnce(rolling.promise).mockReturnValueOnce(ytd.promise);
    await mount("/health");
    expect(h.healthRange.mock.calls).toEqual([["A", "2026-07-07", "2026-10-05"], ["A", "2026-01-01", "2026-07-06"]]);
    await act(async () => ytd.resolve([{ date: "2026-02-05", steps: 50 }]));
    expect(latestHealth.hasLoadedRolling).toBe(false); expect(container.querySelector("[aria-label='Loading health']")).toBeTruthy();
    await act(async () => rolling.resolve([{ date: "2026-10-05", steps: 200 }]));
    expect(latestHealth.hasLoadedRolling).toBe(true); expect(container.querySelector("[aria-label='Loading health']")).toBeNull();
  });

  it("entirely empty success remains resident across re-entry without another bounded read", async () => {
    await mount("/health"); expect(container.textContent).toContain("No health data yet");
    expect(latestHealth.hasLoadedRolling).toBe(true);
    await navigate("/dashboard"); await navigate("/health");
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(container.querySelector("[aria-label='Loading health']")).toBeNull();
    expect(healthDateStatus(latestHealth.cache!, "2026-10-05", Date.now())).toBe("covered-empty");
  });

  it("resident refresh failure is visible in metadata/log, keeps values and retries on activation", async () => {
    seedHealth(); await mount("/health"); await navigate("/dashboard");
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); h.healthRange.mockRejectedValueOnce(new Error("offline"));
    await navigate("/health");
    expect(stepsValue()).toBe("200"); expect(container.textContent).not.toContain("Error loading health data");
    expect(latestHealth.error).toBe("offline"); expect(latestHealth.pendingRanges).toEqual([]);
    expect(healthDateStatus(latestHealth.cache!, "2026-10-05", Date.now())).toBe("error");
    await navigate("/dashboard"); await navigate("/health");
    expect(h.healthRange).toHaveBeenCalledTimes(3); expect(latestHealth.error).toBeNull(); expect(stepsValue()).toBe("200");
  });

  it("initial failure preserves the cold error contract and re-entry can retry", async () => {
    h.healthRange.mockRejectedValueOnce(new Error("offline")); await mount("/health");
    expect(container.textContent).toContain("Error loading health data: offline");
    expect(latestHealth.cache?.coveredRanges).toEqual([]); expect(latestHealth.hasLoadedRolling).toBe(false);
    seedHealth(); await navigate("/dashboard"); await navigate("/health");
    expect(stepsValue()).toBe("200"); expect(h.healthRange).toHaveBeenCalledTimes(2);
  });

  it("failed new-day extension retains old values and does not claim current-day coverage", async () => {
    vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 59)); seedHealth(); await mount("/health");
    vi.setSystemTime(new Date(2026, 9, 6, 0, 0, 1)); h.healthRange.mockRejectedValueOnce(new Error("new day offline"));
    await visible();
    expect(latestHealth.cache?.entries.has("2026-10-05")).toBe(true);
    expect(latestHealth.cache?.coverage.get("2026-10-06")).toEqual({ lastSuccessAt: null, error: "new day offline" });
    expect(container.querySelector("[aria-label='Loading health']")).toBeNull();
    seedHealth([{ date: "2026-10-06", steps: 300 }]); await visible();
    expect(stepsValue()).toBe("300"); expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-10-06", "2026-10-06"]);
  });

  it.each(["visible", "re-entry"])("local-day rollover on %s fetches only the new day and follows today's anchor", async trigger => {
    vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 59)); seedHealth(); await mount("/health");
    if (trigger === "re-entry") await navigate("/dashboard");
    vi.setSystemTime(new Date(2026, 9, 6, 0, 0, 1)); seedHealth([{ date: "2026-10-06", steps: 300 }]);
    if (trigger === "re-entry") await navigate("/health"); else await visible();
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-10-06", "2026-10-06"]);
    expect(h.healthRange).toHaveBeenCalledTimes(2); expect(stepsValue()).toBe("300");
    expect(latestHealth.cache?.entries.has("2026-10-05")).toBe(true);
    expect(latestHealth.cache?.coverage.has("2026-10-05")).toBe(true);
  });

  it("mounted Health recognizes local midnight with one boundary timer and cancels it on exit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 59)); seedHealth(); await mount("/health");
    seedHealth([{ date: "2026-10-06", steps: 300 }]);
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-10-06", "2026-10-06"]);
    expect(stepsValue()).toBe("300"); const calls = h.healthRange.mock.calls.length;
    await navigate("/dashboard"); await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000));
    expect(h.healthRange).toHaveBeenCalledTimes(calls);
  });

  it("December 31 → January 1 derives a new YTD without leaking prior-year totals or resetting history", async () => {
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59)); seedHealth([{ date: "2026-12-31", steps: 100 }]);
    await mount("/health"); await healthClick("YTD"); expect(stepsValue()).toBe("100");
    vi.setSystemTime(new Date(2027, 0, 1, 0, 0, 1)); seedHealth([{ date: "2027-01-01", steps: 300 }]); await visible();
    expect(stepsValue()).toBe("300"); expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2027-01-01", "2027-01-01"]);
    expect(latestHealth.cache?.entries.has("2026-12-31")).toBe(true);
    expect(metricsInCacheRange(latestHealth.cache, { start: "2027-01-01", end: "2027-01-01" })).toEqual([{ date: "2027-01-01", steps: 300 }]);
  });

  it("January's day navigator can still derive and load the prior anchor year's YTD", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12)); seedHealth([{ date: "2027-01-01", steps: 300 }, { date: "2026-12-31", steps: 100 }, { date: "2026-02-01", steps: 50 }]);
    await mount("/health");
    const previous = container.querySelector<HTMLButtonElement>("button[aria-label='Previous day']")!;
    await act(async () => previous.click()); await healthClick("YTD");
    expect(stepsValue()).toBe("150");
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-01-01", "2026-10-02"]);
    expect(latestHealth.cache?.entries.has("2026-02-01")).toBe(true);
  });

  it.each(["A", "B"])("logout then UID %s synchronously rejects late old initial data and isolates replacement pending work", async uid => {
    const old = deferred<HealthMetric[]>(); const fresh = deferred<HealthMetric[]>();
    h.healthRange.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await mount("/health");
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user(uid)); old.resolve([{ date: "2026-10-05", steps: 999 }]); });
    expect(latestHealth.cache?.entries.size).toBe(0); expect(latestHealth.cache?.coveredRanges).toEqual([]);
    expect(latestHealth.pendingRanges).toEqual([healthRollingRange("2026-10-05")]); expect(latestHealth.error).toBeNull();
    expect(h.healthRange.mock.calls.map(call => call[0])).toEqual(["A", uid]);
    await act(async () => fresh.resolve([{ date: "2026-10-05", steps: 300 }]));
    expect(stepsValue()).toBe("300"); expect(latestHealth.pendingRanges).toEqual([]); trainingRemainsCold();
  });

  it.each(["A", "B"])("late pending-refresh failure cannot change UID %s replacement errors, freshness or resident data", async uid => {
    seedHealth(); await mount("/health"); const old = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(old.promise);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await visible();
    seedHealth([{ date: "2026-10-05", steps: 300 }]);
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user(uid)); });
    const snapshot = latestHealth.cache;
    await act(async () => old.reject(new Error("retired offline")));
    expect(latestHealth.cache).toBe(snapshot); expect(latestHealth.error).toBeNull(); expect(stepsValue()).toBe("300");
    expect(latestHealth.pendingRanges).toEqual([]); trainingRemainsCold();
  });

  it("a direct UID A → B transition rejects old initial data without requiring an intervening logout render", async () => {
    const old = deferred<HealthMetric[]>(); const fresh = deferred<HealthMetric[]>();
    h.healthRange.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await mount("/health"); await act(async () => h.authObserver?.(user("B")));
    await act(async () => old.resolve([{ date: "2026-10-05", steps: 999 }]));
    expect(latestHealth.cache?.coveredRanges).toEqual([]);
    expect(latestHealth.pendingRanges).toEqual([healthRollingRange("2026-10-05")]);
    await act(async () => fresh.resolve([{ date: "2026-10-05", steps: 300 }]));
    expect(stepsValue()).toBe("300"); trainingRemainsCold();
  });

  it.each(["A", "B"])("late authoritative omission from old refresh cannot remove UID %s replacement entries or metadata", async uid => {
    seedHealth(); await mount("/health");
    const old = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(old.promise);
    vi.setSystemTime(new Date(2026, 9, 5, 12, 1)); await visible();
    seedHealth([{ date: "2026-10-05", steps: 300 }]);
    await act(async () => { h.authObserver?.(null); h.authObserver?.(user(uid)); });
    const currentCache = latestHealth.cache;
    await act(async () => old.resolve([]));
    expect(latestHealth.cache).toBe(currentCache); expect(stepsValue()).toBe("300");
    expect(latestHealth.error).toBeNull(); expect(latestHealth.pendingRanges).toEqual([]);
  });

  it("logout destroys accessibility to resident Health and same-UID login starts cold", async () => {
    seedHealth(); await mount("/health");
    await act(async () => h.authObserver?.(null));
    expect(container.textContent).not.toContain("Health"); expect(container.querySelector("button[aria-label='Refresh metrics']")).toBeNull();
    const fresh = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(fresh.promise);
    await act(async () => h.authObserver?.(user()));
    expect(latestHealth.hasLoadedRolling).toBe(false); expect(latestHealth.cache?.coveredRanges).toEqual([]);
    expect(container.querySelector("[aria-label='Loading health']")).toBeTruthy();
    await act(async () => fresh.resolve([{ date: "2026-10-05", steps: 300 }])); expect(stepsValue()).toBe("300");
  });

  it("genuine auth/layout unmount cannot retain Health data into a fresh same-UID mount", async () => {
    seedHealth(); await mount("/health"); await act(async () => root.unmount());
    root = createRoot(container); const fresh = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(fresh.promise);
    await mount("/health");
    expect(latestHealth.hasLoadedRolling).toBe(false); expect(latestHealth.cache?.coveredRanges).toEqual([]);
    await act(async () => fresh.resolve([{ date: "2026-10-05", steps: 300 }])); expect(h.healthRange).toHaveBeenCalledTimes(2);
  });

  it("rapid Health exits/re-entries join the pending range and publish once into the same session", async () => {
    const pending = deferred<HealthMetric[]>(); h.healthRange.mockReturnValueOnce(pending.promise);
    await mount("/health"); await navigate("/dashboard"); await navigate("/health"); await navigate("/dashboard"); await navigate("/health");
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(latestHealth.pendingRanges).toHaveLength(1);
    await act(async () => pending.resolve([{ date: "2026-10-05", steps: 200 }]));
    expect(stepsValue()).toBe("200"); expect(latestHealth.pendingRanges).toEqual([]);
    expect(h.W).toHaveBeenCalledTimes(1); expect(h.delta).not.toHaveBeenCalled();
  });

  it("Strict Mode replay loads one current Health range, keeps cold training zero and retains warm return", async () => {
    seedHealth(); await mount("/health", true); trainingRemainsCold();
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(stepsValue()).toBe("200");
    await navigate("/dashboard", true); await navigate("/health", true);
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(latestHealth.pendingRanges).toEqual([]); expect(stepsValue()).toBe("200");
  });

  it("All-time remains demand-only, page-local and never seeds bounded entries or coverage", async () => {
    seedHealth(); h.healthAll.mockResolvedValue([{ date: "2000-01-01", steps: 10 }, { date: "2026-10-05", steps: 999 }]);
    window.localStorage.setItem("health_time_range", "all"); await mount("/health"); expect(h.healthAll).not.toHaveBeenCalled();
    await healthClick("Trends"); expect(h.healthAll).toHaveBeenCalledTimes(1);
    expect(latestHealth.cache?.entries.has("2000-01-01")).toBe(false);
    expect(latestHealth.cache?.entries.get("2026-10-05")?.metrics.steps).toBe(200);
    expect(healthDateStatus(latestHealth.cache!, "2000-01-01", Date.now())).toBe("never-requested");
    await navigate("/dashboard"); await visible(); expect(h.healthAll).toHaveBeenCalledTimes(1);
    await navigate("/health"); expect(h.healthAll).toHaveBeenCalledTimes(1); await healthClick("Trends");
    expect(h.healthAll).toHaveBeenCalledTimes(2); expect(h.healthRange).toHaveBeenCalledTimes(1);
  });

  it("late All-time results after rapid re-entry cannot publish into the replacement page or bounded cache", async () => {
    seedHealth(); window.localStorage.setItem("health_time_range", "all");
    const old = deferred<HealthMetric[]>(); const fresh = deferred<HealthMetric[]>();
    h.healthAll.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await mount("/health"); await healthClick("Trends"); await navigate("/dashboard"); await navigate("/health"); await healthClick("Trends");
    await act(async () => old.resolve([{ date: "2000-01-01", steps: 999 }]));
    expect(container.textContent).not.toContain("2000-01-01"); expect(latestHealth.cache?.entries.has("2000-01-01")).toBe(false);
    await act(async () => fresh.resolve([{ date: "1999-01-01", steps: 10 }]));
    expect(container.querySelector('[data-testid="chart-dates"]')?.textContent).toContain("1999-01-01");
    expect(container.textContent).not.toContain("2000-01-01"); expect(h.healthAll).toHaveBeenCalledTimes(2);
  });

  it("older Calendar months remain page-local and are fetched again after leaving Health", async () => {
    // April's bound starts January 1: December is fully outside it and needs
    // only four month transitions, keeping this lifecycle check focused.
    vi.setSystemTime(new Date(2026, 3, 1, 12));
    seedHealth([{ date: "2026-04-01", steps: 200 }, { date: "2025-12-15", steps: 10 }]);
    await mount("/health"); await healthClick("Calendar"); await healthClick("Month");
    async function previousMonths() {
      for (let i = 0; i < 4; i++) {
        const button = container.querySelector<HTMLButtonElement>("button[aria-label='Previous month']")!;
        await act(async () => button.click());
      }
    }
    await previousMonths();
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2025-12-01", "2025-12-31"]);
    expect(latestHealth.cache?.entries.has("2025-12-15")).toBe(false);
    expect(healthDateStatus(latestHealth.cache!, "2025-12-15", Date.now())).toBe("never-requested");
    await navigate("/dashboard"); await navigate("/health"); await healthClick("Calendar"); await healthClick("Month"); await previousMonths();
    expect(h.healthRange.mock.calls.filter(call => call[1] === "2025-12-01")).toHaveLength(2);
    expect(latestHealth.cache?.coverage.has("2025-12-15")).toBe(false);
  });
});

describe("retained route-element activity gating", () => {
  it("an inactive Health route element unmounts its local UI, focus/timer and All-time demand even if the router keeps the element", async () => {
    h.retainHealthPage = true;
    seedHealth(); window.localStorage.setItem("health_time_range", "all");
    const all = deferred<HealthMetric[]>(); h.healthAll.mockReturnValueOnce(all.promise);
    await mount("/health"); await healthClick("Trends");
    expect(container.querySelector('[data-testid="chart-dates"]')).toBeTruthy();
    const cache = latestHealth.cache;
    await navigate("/dashboard");
    expect(container.querySelector("button[aria-label='Refresh metrics']")).toBeNull();
    expect(container.querySelector('[data-testid="chart-dates"]')).toBeNull();
    vi.setSystemTime(new Date(2026, 9, 6, 12)); await visible();
    await act(async () => all.resolve([{ date: "2000-01-01", steps: 999 }]));
    expect(h.healthRange).toHaveBeenCalledTimes(1); expect(h.healthAll).toHaveBeenCalledTimes(1);
    expect(latestHealth.cache).toBe(cache); expect(latestHealth.cache?.entries.has("2000-01-01")).toBe(false);
    await navigate("/health");
    expect(h.healthAll).toHaveBeenCalledTimes(1); expect(h.healthRange).toHaveBeenCalledTimes(2);
  });
});

describe("rollover date navigator bounds", () => {
  it("an expired prior-year anchor clamps to the existing 30-day limit before deriving required YTD", async () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    seedHealth([{ date: "2027-01-01", steps: 300 }, { date: "2026-12-31", steps: 100 }]);
    await mount("/health");
    await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label='Previous day']")!.click());
    await healthClick("YTD"); expect(stepsValue()).toBe("100");
    vi.setSystemTime(new Date(2027, 1, 1, 12));
    seedHealth([{ date: "2027-01-01", steps: 300 }, { date: "2027-01-02", steps: 50 }]); await visible();
    expect(stepsValue()).toBe("350");
    expect(h.healthRange.mock.calls.at(-1)).toEqual(["A", "2026-11-03", "2027-02-01"]);
    expect(latestHealth.cache?.entries.has("2026-12-31")).toBe(false);
  });
});
