import { describe, expect, it } from "vitest";
import { computeThresholdPaceSuggestion } from "@/utils/thresholdPaceSuggestion";

describe("computeThresholdPaceSuggestion", () => {
  it("uses predicted 10-mile pace when available", () => {
    expect(computeThresholdPaceSuggestion(4500, 6300)).toEqual({
      paceSecPerMile: 450,
      source: "10mi",
    });
  });

  it("falls back to predicted half-marathon pace when 10-mile is unavailable", () => {
    const suggestion = computeThresholdPaceSuggestion(null, 13.109 * 480);
    expect(suggestion).toEqual({
      paceSecPerMile: 480,
      source: "half",
    });
  });

  it("returns null when no usable prediction exists", () => {
    expect(computeThresholdPaceSuggestion(null, undefined)).toBeNull();
  });
});
