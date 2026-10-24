import { afterEach, describe, expect, it, vi } from "vitest";
import { isRacePerformanceEnabled } from "../racePerformanceGate";

afterEach(() => vi.unstubAllEnvs());

describe("race-performance preview build gate", () => {
  it.each([undefined, "false", "1", "TRUE", ""])("defaults off for %s", (flag) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", flag);
    expect(isRacePerformanceEnabled()).toBe(false);
  });

  it.each([undefined, "development", "preview"])("allows exact opt-in for %s", (deployment) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    expect(isRacePerformanceEnabled()).toBe(true);
  });

  it("keeps Production off even when the opt-in is accidentally set", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    expect(isRacePerformanceEnabled()).toBe(false);
  });
});
