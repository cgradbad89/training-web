export const CLIENT_PERFORMANCE_STORAGE_KEY =
  "training:client-performance:v1";
export const CLIENT_PERFORMANCE_SCHEMA_VERSION = 1;
export const MAX_CLIENT_PERFORMANCE_SAMPLES_PER_ROUTE = 80;

export const TRACKED_PERFORMANCE_ROUTES = [
  "/health",
  "/personal-insights",
  "/plans",
] as const;

export type TrackedPerformanceRoute =
  (typeof TRACKED_PERFORMANCE_ROUTES)[number];
export type PageNavigationClass = "cold" | "warm";
export type PageCacheSource =
  | "app-data"
  | "local-cache"
  | "server"
  | "not-applicable"
  | "unknown";

export interface ClientPerformanceSample {
  schemaVersion: typeof CLIENT_PERFORMANCE_SCHEMA_VERSION;
  route: TrackedPerformanceRoute;
  navigation: PageNavigationClass;
  cacheSource: PageCacheSource;
  deploymentSha: string;
  navigationStartedAt: string;
  recordedAt: string;
  shellVisibleMs: number | null;
  cacheVisibleMs: number | null;
  dataReadyMs: number;
}

export interface ClientPerformanceStageSummary {
  count: number;
  medianMs: number | null;
  p75Ms: number | null;
  p95Ms: number | null;
}

export interface ClientPerformanceRouteSummary {
  route: TrackedPerformanceRoute;
  navigation: PageNavigationClass;
  shellVisible: ClientPerformanceStageSummary;
  cacheVisible: ClientPerformanceStageSummary;
  dataReady: ClientPerformanceStageSummary;
}

interface ActivePagePerformance {
  route: TrackedPerformanceRoute;
  navigation: PageNavigationClass;
  cacheSource: PageCacheSource;
  deploymentSha: string;
  startedAtPerformanceMs: number;
  navigationStartedAt: string;
  shellVisibleMs: number | null;
  cacheVisibleMs: number | null;
}

interface PerformanceDebugApi {
  export: () => string;
  samples: () => ClientPerformanceSample[];
  summary: () => ClientPerformanceRouteSummary[];
}

declare global {
  interface Window {
    __TRAINING_PERFORMANCE__?: PerformanceDebugApi;
  }
}

const initialDocumentPath =
  typeof window === "undefined" ? null : window.location.pathname;
const activePages = new Map<TrackedPerformanceRoute, ActivePagePerformance>();
const claimedInitialRoutes = new Set<TrackedPerformanceRoute>();

function isTrackedRoute(pathname: string): pathname is TrackedPerformanceRoute {
  return TRACKED_PERFORMANCE_ROUTES.includes(
    pathname as TrackedPerformanceRoute
  );
}

function roundDuration(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readClientPerformanceSamples(
  storage: Storage | null = safeStorage()
): ClientPerformanceSample[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CLIENT_PERFORMANCE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isClientPerformanceSample);
  } catch {
    return [];
  }
}

function isClientPerformanceSample(
  value: unknown
): value is ClientPerformanceSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<ClientPerformanceSample>;
  return (
    sample.schemaVersion === CLIENT_PERFORMANCE_SCHEMA_VERSION &&
    typeof sample.route === "string" &&
    isTrackedRoute(sample.route) &&
    (sample.navigation === "cold" || sample.navigation === "warm") &&
    typeof sample.cacheSource === "string" &&
    isCacheSource(sample.cacheSource) &&
    typeof sample.deploymentSha === "string" &&
    typeof sample.navigationStartedAt === "string" &&
    typeof sample.recordedAt === "string" &&
    (sample.shellVisibleMs === null ||
      typeof sample.shellVisibleMs === "number") &&
    (sample.cacheVisibleMs === null ||
      typeof sample.cacheVisibleMs === "number") &&
    typeof sample.dataReadyMs === "number"
  );
}

function persistSample(
  sample: ClientPerformanceSample,
  storage: Storage | null = safeStorage()
): void {
  if (!storage) return;
  try {
    const current = readClientPerformanceSamples(storage);
    const withoutOverflow = TRACKED_PERFORMANCE_ROUTES.flatMap((route) => {
      const routeSamples = current.filter((item) => item.route === route);
      return (route === sample.route ? [...routeSamples, sample] : routeSamples)
        .slice(-MAX_CLIENT_PERFORMANCE_SAMPLES_PER_ROUTE);
    });
    storage.setItem(
      CLIENT_PERFORMANCE_STORAGE_KEY,
      JSON.stringify(withoutOverflow)
    );
  } catch {
    // Performance instrumentation must never affect the product flow.
  }
}

function deploymentSha(): string {
  if (typeof document === "undefined") return "unknown";
  const value = document
    .querySelector<HTMLMetaElement>('meta[name="training-deployment-sha"]')
    ?.content.trim();
  return value && /^[a-f0-9]{7,40}$/i.test(value) ? value : "local";
}

export function startClientPagePerformance(
  route: TrackedPerformanceRoute,
  navigationOverride?: PageNavigationClass
): void {
  if (typeof window === "undefined" || activePages.has(route)) return;

  const isInitialDocumentRoute =
    initialDocumentPath === route && !claimedInitialRoutes.has(route);
  const navigation =
    navigationOverride ?? (isInitialDocumentRoute ? "cold" : "warm");
  if (isInitialDocumentRoute) claimedInitialRoutes.add(route);

  const perf = window.performance;
  const startedAtPerformanceMs =
    navigation === "cold" ? 0 : (perf?.now?.() ?? 0);
  const timeOrigin = perf?.timeOrigin ?? Date.now() - startedAtPerformanceMs;

  activePages.set(route, {
    route,
    navigation,
    cacheSource: "unknown",
    deploymentSha: deploymentSha(),
    startedAtPerformanceMs,
    navigationStartedAt: new Date(
      timeOrigin + startedAtPerformanceMs
    ).toISOString(),
    shellVisibleMs: null,
    cacheVisibleMs: null,
  });
}

export function startClientNavigationPerformance(pathname: string): void {
  if (!isTrackedRoute(pathname)) return;
  startClientPagePerformance(pathname, "warm");
}

const MILESTONES: Record<
  string,
  { route: TrackedPerformanceRoute; stage: "shell" | "cache" | "data" }
> = {
  "training:health:shell-visible": { route: "/health", stage: "shell" },
  "training:health:data-ready": { route: "/health", stage: "data" },
  "training:personal-insights:shell-visible": {
    route: "/personal-insights",
    stage: "shell",
  },
  "training:personal-insights:cache-visible": {
    route: "/personal-insights",
    stage: "cache",
  },
  "training:personal-insights:data-ready": {
    route: "/personal-insights",
    stage: "data",
  },
  "training:plans:shell-visible": { route: "/plans", stage: "shell" },
  "training:plans:data-ready": { route: "/plans", stage: "data" },
};

export function recordClientPerformanceMilestone(
  name: string,
  detail?: Record<string, string | number | boolean | null>
): void {
  if (typeof window === "undefined") return;
  const milestone = MILESTONES[name];
  if (!milestone) return;
  const active = activePages.get(milestone.route);
  if (!active) return;

  const duration = roundDuration(
    (window.performance?.now?.() ?? 0) - active.startedAtPerformanceMs
  );
  const source = detail?.cacheSource;
  if (typeof source === "string" && isCacheSource(source)) {
    active.cacheSource = source;
  }

  if (milestone.stage === "shell") {
    active.shellVisibleMs ??= duration;
    return;
  }
  if (milestone.stage === "cache") {
    active.cacheVisibleMs ??= duration;
    return;
  }

  const sample: ClientPerformanceSample = {
    schemaVersion: CLIENT_PERFORMANCE_SCHEMA_VERSION,
    route: active.route,
    navigation: active.navigation,
    cacheSource: active.cacheSource,
    deploymentSha: active.deploymentSha,
    navigationStartedAt: active.navigationStartedAt,
    recordedAt: new Date().toISOString(),
    shellVisibleMs: active.shellVisibleMs,
    cacheVisibleMs: active.cacheVisibleMs,
    dataReadyMs: duration,
  };
  persistSample(sample);
  console.info(
    "[client-performance] local-sample",
    JSON.stringify(sample)
  );
  activePages.delete(milestone.route);
}

function isCacheSource(value: string): value is PageCacheSource {
  return [
    "app-data",
    "local-cache",
    "server",
    "not-applicable",
    "unknown",
  ].includes(value);
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const interpolated =
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return roundDuration(interpolated);
}

function summarizeStage(
  values: Array<number | null>
): ClientPerformanceStageSummary {
  const present = values.filter((value): value is number => value !== null);
  return {
    count: present.length,
    medianMs: percentile(present, 0.5),
    p75Ms: percentile(present, 0.75),
    p95Ms: percentile(present, 0.95),
  };
}

export function summarizeClientPerformance(
  samples: ClientPerformanceSample[] = readClientPerformanceSamples()
): ClientPerformanceRouteSummary[] {
  return TRACKED_PERFORMANCE_ROUTES.flatMap((route) =>
    (["cold", "warm"] as const).map((navigation) => {
      const matching = samples.filter(
        (sample) =>
          sample.route === route && sample.navigation === navigation
      );
      return {
        route,
        navigation,
        shellVisible: summarizeStage(
          matching.map((sample) => sample.shellVisibleMs)
        ),
        cacheVisible: summarizeStage(
          matching.map((sample) => sample.cacheVisibleMs)
        ),
        dataReady: summarizeStage(
          matching.map((sample) => sample.dataReadyMs)
        ),
      };
    })
  );
}

export function exportClientPerformance(): string {
  const samples = readClientPerformanceSamples();
  return JSON.stringify(
    {
      schemaVersion: CLIENT_PERFORMANCE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      samples,
      summary: summarizeClientPerformance(samples),
    },
    null,
    2
  );
}

export function installClientPerformanceDebugExport(): void {
  if (
    process.env.NODE_ENV !== "development" ||
    typeof window === "undefined" ||
    window.__TRAINING_PERFORMANCE__
  ) {
    return;
  }
  window.__TRAINING_PERFORMANCE__ = {
    export: exportClientPerformance,
    samples: readClientPerformanceSamples,
    summary: summarizeClientPerformance,
  };
}

export function resetClientPerformanceTrackingForTests(): void {
  activePages.clear();
  claimedInitialRoutes.clear();
}
