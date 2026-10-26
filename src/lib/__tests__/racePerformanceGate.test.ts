import { afterEach, describe, expect, it, vi } from "vitest";
import { isExperimentalCurrentEstimateEnabled, isRacePerformanceDisplayEnabled, isRaceConfirmationEnabled, isRacePerformanceResearchEnabled } from "../racePerformanceGate";

afterEach(() => vi.unstubAllEnvs());

describe("independent race-performance capabilities", () => {
  it.each([undefined, "false", "1", "TRUE", "", "true"])("Production enables only read-only display with flag %s", flag => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", flag);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    expect(isRacePerformanceDisplayEnabled()).toBe(true);
    expect(isExperimentalCurrentEstimateEnabled()).toBe(true);
    expect(isRaceConfirmationEnabled()).toBe(false);
    expect(isRacePerformanceResearchEnabled()).toBe(false);
  });
  it.each([undefined, "development", "preview"])("preserves opted-in developer capabilities for %s", deployment => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    expect(isRacePerformanceDisplayEnabled()).toBe(true);
    expect(isRaceConfirmationEnabled()).toBe(true);
    expect(isRacePerformanceResearchEnabled()).toBe(true);
  });
  it.each([undefined, "false", "1", "TRUE", ""])("keeps preview capabilities off without exact opt-in %s", flag => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", flag);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    expect(isRacePerformanceDisplayEnabled()).toBe(false);
    expect(isRaceConfirmationEnabled()).toBe(false);
    expect(isRacePerformanceResearchEnabled()).toBe(false);
  });
});
