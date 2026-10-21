import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "@/hooks/useAuth";
import type { AppDataContextValue } from "@/contexts/AppDataContext";
import type { AggregatedStatsDoc } from "@/utils/aggregatedStats";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reference { path: string }
interface Constraint { kind: string; args: unknown[] }
interface SyntheticQuery extends Reference { constraints: Constraint[] }
interface Operation {
  kind: "server-document" | "server-query" | "write";
  path: string;
  documents: number;
  constraints?: Constraint[];
  stack?: string;
}
const h = vi.hoisted(() => ({
  auth: {} as AuthState,
  appData: {} as AppDataContextValue,
  params: new URLSearchParams(),
  aggregate: null as AggregatedStatsDoc | null,
  operations: [] as Operation[],
  parents: [] as Array<{ id: string; data: Record<string, unknown> }>,
  getToken: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/personal-insights",
  useSearchParams: () => h.params,
}));
// Exercise the actual panel; chart chunks are presentation-only boundaries.
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => String(loader).includes("PerformanceAnalysisPanel")
    ? function ActualPerformancePanel() { return <PerformanceAnalysisPanel />; }
    : () => null,
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => h.auth }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => h.appData }));
vi.mock("@/lib/firebase", () => ({
  db: { synthetic: true },
  auth: { get currentUser() { return h.auth.user; } },
}));
vi.mock("firebase/auth", async importOriginal => ({
  ...await importOriginal<typeof import("firebase/auth")>(),
  getIdTokenResult: h.getToken,
}));
vi.mock("firebase/firestore", async importOriginal => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  const reference = (_db: unknown, ...segments: string[]): Reference => ({ path: segments.join("/") });
  const constraint = (kind: string) => (...args: unknown[]): Constraint => ({ kind, args });
  const snapshot = (id: string, data: unknown) => ({ id, exists: () => data !== null, data: () => data });
  const readDocument = async (ref: Reference) => {
    h.operations.push({ kind: "server-document", path: ref.path, documents: 1 });
    if (ref.path.endsWith("/insights/aggregatedStats")) return snapshot("aggregatedStats", h.aggregate);
    if (ref.path.endsWith("/performanceState/current") || ref.path.includes("/performanceFeatures/")) return snapshot("missing", null);
    throw new Error(`Unexpected synthetic document read: ${ref.path}`);
  };
  const readQuery = async (query: SyntheticQuery) => {
    // Every collection request is recorded before dispatch, including a forbidden request.
    const event: Operation = { kind: "server-query", path: query.path, constraints: query.constraints, documents: 0,
      stack: new Error("Synthetic query initiation").stack };
    h.operations.push(event);
    let documents: Array<{ id: string; data: Record<string, unknown> }>;
    if (query.path.endsWith("/healthMetrics")) {
      const recent = [
        { id: "2026-10-20", data: { date: "2026-10-20", vo2_max: 45 } },
        { id: "2026-10-19", data: { date: "2026-10-19", steps: 1000 } },
      ];
      documents = query.constraints.some(c => c.kind === "limit") ? recent
        : [...recent, { id: "2026-10-18", data: { date: "2026-10-18", vo2_max: 44 } }];
    } else if (query.path.endsWith("/mileSplits")) {
      documents = [1, 2].map(mile => ({ id: String(mile), data: { mile, distanceMiles: 1, avgBpm: 140 } }));
    } else if (query.path.endsWith("/healthWorkouts")) documents = h.parents;
    else if (query.path.endsWith("/workoutOverrides")) documents = [];
    else throw new Error(`Unexpected synthetic query: ${query.path}`);
    event.documents = documents.length;
    const docs = documents.map(d => snapshot(d.id, d.data));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };
  return {
    ...actual,
    doc: reference, collection: reference,
    query: (ref: Reference, ...constraints: Constraint[]) => ({ ...ref, constraints }),
    orderBy: constraint("orderBy"), where: constraint("where"), limit: constraint("limit"),
    getDoc: vi.fn(readDocument), getDocFromServer: vi.fn(readDocument),
    getDocFromCache: vi.fn(async () => { throw new Error("Synthetic local-cache miss"); }),
    getDocs: vi.fn(readQuery), getDocsFromServer: vi.fn(readQuery),
    setDoc: vi.fn(async (ref: Reference, data: AggregatedStatsDoc) => {
      h.operations.push({ kind: "write", path: ref.path, documents: 1, stack: new Error("Synthetic write initiation").stack });
      if (!ref.path.endsWith("/insights/aggregatedStats")) throw new Error(`Unexpected synthetic write: ${ref.path}`);
      h.aggregate = data;
    }),
    updateDoc: vi.fn(async (ref: Reference) => { throw new Error(`Unexpected synthetic update: ${ref.path}`); }),
    runTransaction: vi.fn(async () => { throw new Error("Unexpected performance transaction before analysis confirmation"); }),
    writeBatch: vi.fn(() => { throw new Error("Unexpected batch before analysis confirmation"); }),
  };
});

import PersonalInsightsPage from "../page";
import { PerformanceAnalysisPanel } from "@/components/PerformanceAnalysisPanel";
import * as manual from "@/services/manualPerformance";
import * as telemetry from "@/services/performanceTelemetry";
import * as routes from "@/services/routes";
import * as routeCache from "@/utils/routeCache";
import { docToHealthWorkout } from "@/services/healthWorkouts";
import { AGGREGATED_STATS_VERSION, buildAggregatedStats, computeFreshnessFingerprint, computeWorkoutAggregationRevision,
  computeVo2FreshnessKey } from "@/utils/aggregatedStats";

type CacheState = "fresh" | "main-stale" | "vo2-stale" | "missing";
let root: Root | null = null;
let container: HTMLDivElement;
let caseNumber = 0;
const aggregatePath = "users/synthetic-owner/insights/aggregatedStats";

function fixtureAggregate(): AggregatedStatsDoc {
  const fingerprint = computeFreshnessFingerprint({ latestWorkoutId: h.appData.workouts[0].workoutId,
    computationVersion: AGGREGATED_STATS_VERSION, maxHr: 190, restingHr: 50,
    activeRaceId: null, activeRaceDate: null, overrides: {} });
  fingerprint.overridesRevision += `:${computeWorkoutAggregationRevision(h.appData.workouts)}`;
  return buildAggregatedStats({ workouts: h.appData.workouts, maxHr: 190, restingHr: 50, races: [],
    mileSplitsByWorkoutId: {}, healthMetrics: [{ id: "2026-10-20", data: { date: "2026-10-20", vo2_max: 45 } }],
    now: new Date(), freshnessFingerprint: fingerprint, vo2FreshnessKey: computeVo2FreshnessKey("2026-10-20") });
}
function configure(tab: string, enabled: boolean, cache: CacheState) {
  h.params = new URLSearchParams(`tab=${tab}`);
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", String(enabled));
  h.aggregate = fixtureAggregate();
  if (cache === "main-stale") h.aggregate.freshnessFingerprint.maxHr = 180;
  if (cache === "vo2-stale") h.aggregate.latestVo2SampleDate = "2026-10-18";
  if (cache === "missing") h.aggregate = null;
}
async function mount() {
  await act(async () => { root = createRoot(container); root.render(<PersonalInsightsPage />); });
  // The page intentionally leaves its initial skeleton on a zero-delay timer.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  await vi.waitFor(() => expect(container.textContent).toContain("Performance Analysis"));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
function operations(path: string) { return h.operations.filter(operation => operation.path.endsWith(path)); }
function counts() {
  return {
    serverDocuments: h.operations.filter(o => o.kind === "server-document").length,
    queryTargets: h.operations.filter(o => o.kind === "server-query").length,
    returnedQueryDocuments: h.operations.filter(o => o.kind === "server-query").reduce((sum, o) => sum + o.documents, 0),
    writes: h.operations.filter(o => o.kind === "write").length,
  };
}
function expectNoTelemetry() {
  expect(routes.fetchRoutePoints).not.toHaveBeenCalled();
  expect(routeCache.getRoutePoints).not.toHaveBeenCalled();
  expect(telemetry.extractFreshWorkoutPerformance).not.toHaveBeenCalled();
  expect(h.operations.filter(o => /\/(route|hrStream)(\/|$)/.test(o.path))).toEqual([]);
  expect(manual.runManualPerformanceUpdate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.setSystemTime(new Date("2026-10-21T16:00:00Z"));
  h.operations = [];
  h.auth = { user: { uid: "synthetic-owner", email: "folstromjohn@gmail.com", emailVerified: true } as AuthState["user"],
    loading: false, authorizationStatus: "authorized", authorizationError: null, sessionEpoch: 1,
    isSessionCurrent: epoch => epoch === h.auth.sessionEpoch && h.auth.user !== null };
  h.getToken.mockReset().mockResolvedValue({ claims: { sub: "synthetic-owner", email: "folstromjohn@gmail.com", email_verified: true } });
  caseNumber += 1;
  h.parents = [1, 2, 90].map((daysAgo, index) => {
    const startDate = new Date(Date.now() - daysAgo * 86400_000);
    return { id: `synthetic-${caseNumber}-${index}`, data: { startDate,
      endDate: new Date(startDate.getTime() + 2400_000), syncedAt: startDate, displayType: "Run", activityType: "running",
      durationSeconds: 2400, distanceMiles: 4, isRunLike: true, hasRoute: true, hasHRStream: true, routeComplete: true,
      avgHeartRate: 140, avgPaceSecPerMile: 600 } };
  });
  h.appData = { workouts: h.parents.map(parent => docToHealthWorkout(parent.id, parent.data)),
    plans: [], races: [], overrides: {}, maxHr: 190, restingHr: 50, workoutsLoading: false,
    workoutsResolution: "success", settingsResolution: "success", racesResolution: "success", overridesResolution: "success" } as AppDataContextValue;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(manual, "prepareManualPerformanceReview");
  vi.spyOn(manual, "runManualPerformanceUpdate");
  vi.spyOn(telemetry, "extractFreshWorkoutPerformance");
  vi.spyOn(routes, "fetchRoutePoints");
  vi.spyOn(routeCache, "getRoutePoints");
  container = document.createElement("div"); document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount()); root = null; container.remove();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("Personal Insights real page / aggregate / manual service Firestore boundary", () => {
  for (const tab of ["fitness", "performance", "workouts"]) {
    for (const cache of ["fresh", "main-stale", "vo2-stale", "missing"] as const) {
      for (const enabled of [false, true]) {
        it(`${tab}, ${cache}, manual gate ${enabled}: mounts without telemetry and measures legacy maintenance`, async () => {
          configure(tab, enabled, cache); await mount();
          expectNoTelemetry();
          expect(manual.prepareManualPerformanceReview).not.toHaveBeenCalled();
          const updateButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Update Performance")!;
          expect(updateButton.disabled).toBe(!enabled);
          expect(operations("/performanceState/current")).toHaveLength(1);
          if (tab === "workouts") {
            expect(counts()).toEqual({ serverDocuments: 1, queryTargets: 0, returnedQueryDocuments: 0, writes: 0 });
            return;
          }
          const mainStale = cache === "main-stale" || cache === "missing";
          const vo2Stale = cache === "vo2-stale" || cache === "missing";
          expect(counts()).toEqual({ serverDocuments: 2,
            queryTargets: 1 + (mainStale ? 2 : 0) + (vo2Stale ? 1 : 0),
            returnedQueryDocuments: 2 + (mainStale ? 4 : 0) + (vo2Stale ? 3 : 0),
            writes: cache === "fresh" ? 0 : 1 });
          const freshnessRead = operations("/healthMetrics").find(o => o.constraints?.some(c => c.kind === "limit"))!;
          expect(freshnessRead.constraints).toContainEqual({ kind: "limit", args: [14] });
          expect(h.operations.filter(o => o.kind === "write").every(o => o.path === aggregatePath && o.stack?.includes("computeAggregatedStats"))).toBe(true);
          expect(operations("/mileSplits")).toHaveLength(mainStale ? 2 : 0);
        });
      }
    }
  }

  it("opens the actual bounded review only on Update Performance, without acquiring telemetry", async () => {
    configure("fitness", true, "fresh"); await mount(); h.operations = [];
    await click("Update Performance");
    await vi.waitFor(() => expect(container.textContent).toContain("Recorded runs (3)"));
    expect(manual.prepareManualPerformanceReview).toHaveBeenCalledOnce(); expectNoTelemetry();
    expect(operations("/healthWorkouts")[0].constraints).toContainEqual({ kind: "limit", args: [300] });
    expect(counts()).toEqual({ serverDocuments: 4, queryTargets: 2, returnedQueryDocuments: 3, writes: 0 });
    const analyze = [...container.querySelectorAll("button")].find(button => button.textContent === "Analyze 3 selected runs")!;
    expect(analyze.disabled).toBe(true);
  });

  it("caps main-stale mile-split acquisition at forty recent runs and never falls back to routes", async () => {
    const template = h.parents[0];
    h.parents = Array.from({ length: 45 }, (_, index) => ({ id: `synthetic-cap-${caseNumber}-${index}`, data: template.data }));
    h.appData.workouts = h.parents.map(parent => docToHealthWorkout(parent.id, parent.data));
    configure("fitness", false, "missing"); await mount();
    expectNoTelemetry();
    expect(operations("/mileSplits")).toHaveLength(40);
    expect(counts()).toEqual({ serverDocuments: 2, queryTargets: 42, returnedQueryDocuments: 85, writes: 1 });
  });

  it("reuses a newly valid aggregate across tab changes and a fresh page mount", async () => {
    configure("fitness", false, "missing"); await mount();
    expect(h.operations.filter(o => o.kind === "write")).toHaveLength(1);
    await click("Race Readiness"); await click("Workout Trends"); await click("Fitness & Load");
    expectNoTelemetry();
    expect(h.operations.filter(o => o.kind === "write")).toHaveLength(1);
    const mileQueries = operations("/mileSplits").length;
    await act(async () => root!.unmount()); root = null;
    await mount();
    expectNoTelemetry();
    expect(h.operations.filter(o => o.kind === "write")).toHaveLength(1);
    expect(operations("/mileSplits")).toHaveLength(mileQueries);
  });
});
