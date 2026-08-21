import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_PERFORMANCE_SCHEMA_VERSION,
  CLIENT_PERFORMANCE_STORAGE_KEY,
  MAX_CLIENT_PERFORMANCE_SAMPLES_PER_ROUTE,
  exportClientPerformance,
  installClientPerformanceDebugExport,
  percentile,
  readClientPerformanceSamples,
  recordClientPerformanceMilestone,
  resetClientPerformanceTrackingForTests,
  startClientNavigationPerformance,
  startClientPagePerformance,
  summarizeClientPerformance,
  type ClientPerformanceSample,
} from "@/utils/clientPerformanceStore";

function addDeploymentMeta(sha = "abcdef1234567890"): void {
  const meta = document.createElement("meta");
  meta.name = "training-deployment-sha";
  meta.content = sha;
  document.head.appendChild(meta);
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function sample(
  overrides: Partial<ClientPerformanceSample> = {}
): ClientPerformanceSample {
  return {
    schemaVersion: CLIENT_PERFORMANCE_SCHEMA_VERSION,
    route: "/health",
    navigation: "cold",
    cacheSource: "server",
    deploymentSha: "abcdef1234567890",
    navigationStartedAt: "2026-08-21T12:00:00.000Z",
    recordedAt: "2026-08-21T12:00:01.000Z",
    shellVisibleMs: 25,
    cacheVisibleMs: null,
    dataReadyMs: 100,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
  window.localStorage.clear();
  resetClientPerformanceTrackingForTests();
  document
    .querySelectorAll('meta[name="training-deployment-sha"]')
    .forEach((element) => element.remove());
  delete window.__TRAINING_PERFORMANCE__;
  vi.restoreAllMocks();
});

describe("clientPerformanceStore", () => {
  it("records navigation, shell, cache, and data-ready milestones", () => {
    addDeploymentMeta();
    let now = 20;
    vi.spyOn(window.performance, "now").mockImplementation(() => now);

    startClientPagePerformance("/personal-insights", "cold");
    recordClientPerformanceMilestone(
      "training:personal-insights:shell-visible"
    );
    now = 60;
    recordClientPerformanceMilestone(
      "training:personal-insights:cache-visible",
      { cacheSource: "local-cache" }
    );
    now = 240;
    recordClientPerformanceMilestone(
      "training:personal-insights:data-ready",
      { cacheSource: "local-cache" }
    );

    expect(readClientPerformanceSamples()).toEqual([
      expect.objectContaining({
        route: "/personal-insights",
        navigation: "cold",
        cacheSource: "local-cache",
        deploymentSha: "abcdef1234567890",
        shellVisibleMs: 20,
        cacheVisibleMs: 60,
        dataReadyMs: 240,
      }),
    ]);
  });

  it("stores no sample until data is ready and ignores late duplicate marks", () => {
    startClientPagePerformance("/health", "cold");
    recordClientPerformanceMilestone("training:health:shell-visible");
    expect(readClientPerformanceSamples()).toEqual([]);

    recordClientPerformanceMilestone("training:health:data-ready", {
      cacheSource: "server",
    });
    recordClientPerformanceMilestone("training:health:data-ready", {
      cacheSource: "server",
    });
    expect(readClientPerformanceSamples()).toHaveLength(1);
  });

  it("starts tracked link navigations as warm and ignores other routes", () => {
    startClientNavigationPerformance("/dashboard");
    recordClientPerformanceMilestone("training:plans:data-ready");
    expect(readClientPerformanceSamples()).toEqual([]);

    startClientNavigationPerformance("/plans");
    recordClientPerformanceMilestone("training:plans:data-ready", {
      cacheSource: "app-data",
    });
    expect(readClientPerformanceSamples()).toEqual([
      expect.objectContaining({ route: "/plans", navigation: "warm" }),
    ]);
  });

  it("keeps a fixed maximum number of samples per route", () => {
    for (
      let index = 0;
      index < MAX_CLIENT_PERFORMANCE_SAMPLES_PER_ROUTE + 5;
      index += 1
    ) {
      startClientPagePerformance("/plans", "warm");
      recordClientPerformanceMilestone("training:plans:data-ready", {
        cacheSource: "app-data",
      });
    }

    const stored = readClientPerformanceSamples();
    expect(stored).toHaveLength(MAX_CLIENT_PERFORMANCE_SAMPLES_PER_ROUTE);
    expect(stored.every((entry) => entry.route === "/plans")).toBe(true);
  });

  it("calculates median, P75, and P95 per route and navigation class", () => {
    const samples = [100, 200, 300, 400].map((dataReadyMs) =>
      sample({ dataReadyMs })
    );
    const healthCold = summarizeClientPerformance(samples).find(
      (entry) => entry.route === "/health" && entry.navigation === "cold"
    );

    expect(healthCold?.dataReady).toEqual({
      count: 4,
      medianMs: 250,
      p75Ms: 325,
      p95Ms: 385,
    });
    expect(percentile([], 0.75)).toBeNull();
  });

  it("recovers from corrupt or incompatible local data", () => {
    window.localStorage.setItem(CLIENT_PERFORMANCE_STORAGE_KEY, "not-json");
    expect(readClientPerformanceSamples()).toEqual([]);

    window.localStorage.setItem(
      CLIENT_PERFORMANCE_STORAGE_KEY,
      JSON.stringify([{ ...sample(), schemaVersion: 99 }, { private: true }])
    );
    expect(readClientPerformanceSamples()).toEqual([]);
  });

  it("never disrupts navigation when local storage rejects writes", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "QuotaExceededError");
    });

    expect(() => {
      startClientPagePerformance("/health", "cold");
      recordClientPerformanceMilestone("training:health:data-ready", {
        cacheSource: "server",
      });
    }).not.toThrow();
    expect(readClientPerformanceSamples()).toEqual([]);
  });

  it("exports only the bounded samples and aggregate summary", () => {
    window.localStorage.setItem(
      CLIENT_PERFORMANCE_STORAGE_KEY,
      JSON.stringify([sample()])
    );
    const exported = exportClientPerformance();
    const parsed = JSON.parse(exported) as Record<string, unknown>;

    expect(parsed.samples).toEqual([sample()]);
    expect(Array.isArray(parsed.summary)).toBe(true);
    expect(exported).not.toContain("uid");
    expect(exported).not.toContain("email");
  });

  it("does not install the debug export outside development", () => {
    installClientPerformanceDebugExport();
    expect(window.__TRAINING_PERFORMANCE__).toBeUndefined();
  });
});
