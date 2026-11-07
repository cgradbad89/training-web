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

describe("experimental HR-enhanced estimate gate (rollback path)", () => {
  it("follows the official current-estimate gate in Production and is on by default", async () => {
    const { isExperimentalHrEnhancedEstimateEnabled } = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    expect(isExperimentalHrEnhancedEstimateEnabled()).toBe(true);
  });
  it("is removed by the dedicated kill switch without disabling the official estimate", async () => {
    const { isExperimentalHrEnhancedEstimateEnabled } = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE", "true");
    expect(isExperimentalHrEnhancedEstimateEnabled()).toBe(false);
    expect(isExperimentalCurrentEstimateEnabled()).toBe(true);
  });
  it("only the exact value \"true\" disables it, and it can never appear where the official estimate is off", async () => {
    const { isExperimentalHrEnhancedEstimateEnabled } = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    for (const v of [undefined, "false", "1", "TRUE", ""]) { vi.stubEnv("NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE", v); expect(isExperimentalHrEnhancedEstimateEnabled()).toBe(true); }
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE", undefined);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", undefined);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    expect(isExperimentalCurrentEstimateEnabled()).toBe(false);
    expect(isExperimentalHrEnhancedEstimateEnabled()).toBe(false);
  });
});
