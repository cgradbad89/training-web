import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPerformanceUpdateEnabled, isPerformanceUpdateEnabled } from "../performanceGate";
afterEach(() => vi.unstubAllEnvs());
describe("manual performance build gate", () => {
  it.each([undefined, "false", "1", "TRUE", ""])('defaults disabled for flag %s', flag => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", flag);
    expect(isPerformanceUpdateEnabled()).toBe(false);
    expect(() => assertPerformanceUpdateEnabled()).toThrow("disabled");
  });
  it("requires the exact owner-authorized build opt-in", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE", "true");
    expect(isPerformanceUpdateEnabled()).toBe(true);
  });
});
