import { describe, it, expect } from "vitest";
import { computeLoadIntensity } from "@/utils/loadScale";

describe("computeLoadIntensity", () => {
  it("returns 0 for zero load", () => {
    expect(computeLoadIntensity(0, 270)).toBe(0);
  });

  it("returns 0 for null load", () => {
    expect(computeLoadIntensity(null, 270)).toBe(0);
  });

  it("returns 0 for negative load", () => {
    expect(computeLoadIntensity(-50, 270)).toBe(0);
  });

  it("returns 1.0 when load equals the cap", () => {
    expect(computeLoadIntensity(270, 270)).toBe(1);
  });

  it("clamps to 1.0 when load exceeds the cap", () => {
    expect(computeLoadIntensity(400, 270)).toBe(1);
  });

  it("returns the load/cap ratio for a value below the cap", () => {
    expect(computeLoadIntensity(135, 270)).toBe(0.5);
    expect(computeLoadIntensity(2, 200)).toBe(0.01);
  });

  it("returns 0 for a cap of 0 (no division error)", () => {
    expect(computeLoadIntensity(100, 0)).toBe(0);
  });

  it("returns 0 for a negative or non-finite cap", () => {
    expect(computeLoadIntensity(100, -10)).toBe(0);
    expect(computeLoadIntensity(100, Number.NaN)).toBe(0);
  });
});
