import { afterEach, describe, expect, it, vi } from "vitest";
import { isExperimentalCurrentEstimateEnabled, isOwnerRaceConfirmationProductionEnabled, isRacePerformanceDisplayEnabled, isRaceConfirmationEnabled, isRacePerformanceResearchEnabled } from "../racePerformanceGate";

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

describe("experimental hybrid estimate and race-day forecast gates (independent rollback paths)", () => {
  it("both follow the official current-estimate gate and are on by default in Production", async () => {
    const g = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    expect(g.isExperimentalHybridEstimateEnabled()).toBe(true); expect(g.isExperimentalRaceDayForecastEnabled()).toBe(true);
  });
  it("each kill switch removes only its own display; only the exact value \"true\" disables", async () => {
    const g = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST", "true");
    expect(g.isExperimentalRaceDayForecastEnabled()).toBe(false); expect(g.isExperimentalHybridEstimateEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST", undefined);
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE", "true");
    expect(g.isExperimentalHybridEstimateEnabled()).toBe(false); expect(g.isExperimentalRaceDayForecastEnabled()).toBe(false);
    expect(g.isExperimentalCurrentEstimateEnabled()).toBe(true); expect(g.isExperimentalHrEnhancedEstimateEnabled()).toBe(true);
    for (const v of [undefined, "false", "1", "TRUE", ""]) { vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE", v); expect(g.isExperimentalHybridEstimateEnabled()).toBe(true); }
  });
  it("neither can appear where the official experiment is off, and neither authorizes writes", async () => {
    const g = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", undefined);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    expect(g.isExperimentalHybridEstimateEnabled()).toBe(false); expect(g.isExperimentalRaceDayForecastEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    expect(g.isRaceConfirmationEnabled()).toBe(false); expect(g.isRacePerformanceResearchEnabled()).toBe(false);
  });
});

describe("temporary owner-only Production confirmation gate", () => {
  it("is off by default in Production, whatever the preview opt-in says", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    for (const preview of [undefined, "true"]) {
      vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", preview);
      expect(isOwnerRaceConfirmationProductionEnabled()).toBe(false);
      expect(isRaceConfirmationEnabled()).toBe(false);
    }
  });
  it.each(["false", "1", "TRUE", "yes", ""])("only the exact string 'true' enables it (%s)", flag => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", flag);
    expect(isRaceConfirmationEnabled()).toBe(false);
  });
  it("enables ONLY the confirmation editor in Production, nothing else", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", "true");
    expect(isRaceConfirmationEnabled()).toBe(true);
    expect(isRacePerformanceResearchEnabled()).toBe(false);
  });
  it("is inert outside Production (the variable alone grants nothing in a preview build)", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "false");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", "true");
    expect(isOwnerRaceConfirmationProductionEnabled()).toBe(false);
    expect(isRaceConfirmationEnabled()).toBe(false);
  });
  it("does not affect the demonstrated-race evidence policy, which has its own switch", async () => {
    const { isDemonstratedRaceEvidenceEnabled } = await import("../racePerformanceGate");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", "true");
    expect(isDemonstratedRaceEvidenceEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION", "false");
    expect(isDemonstratedRaceEvidenceEnabled()).toBe(true);
  });
});
