import { describe, expect, it } from "vitest";
import { computeMaxHrSuggestion } from "@/utils/maxHrSuggestion";

describe("computeMaxHrSuggestion", () => {
  it("returns the rounded 99th percentile of valid HR values", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 100);
    expect(computeMaxHrSuggestion(values)).toBe(198);
  });

  it("filters obvious low and high HR spikes before computing", () => {
    const values = [
      20,
      ...Array.from({ length: 50 }, () => 150),
      ...Array.from({ length: 50 }, () => 180),
      230,
    ];
    expect(computeMaxHrSuggestion(values)).toBe(180);
  });

  it("returns null when there are not enough valid samples", () => {
    const values = Array.from({ length: 49 }, () => 175);
    expect(computeMaxHrSuggestion(values)).toBeNull();
  });

  it("returns null when all values are null or invalid", () => {
    expect(computeMaxHrSuggestion([null, undefined, 0, 300])).toBeNull();
  });
});
