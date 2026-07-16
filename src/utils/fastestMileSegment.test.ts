import { describe, it, expect } from "vitest";
import { fastestMileSegment, findBestFastestMileAcrossRuns } from "./fastestMileSegment";
import { type RoutePoint } from "@/services/routes";

describe("fastestMileSegment", () => {
  it("handles empty points array", () => {
    expect(fastestMileSegment([])).toBeNull();
  });

  it("handles single point", () => {
    expect(fastestMileSegment([{ lat: 0, lng: 0, timestamp: "2024-01-01T10:00:00Z" }])).toBeNull();
  });

  it("handles normal case and returns best seconds", () => {
    const points: RoutePoint[] = [
      { lat: 40.0, lng: -73.0, timestamp: "2024-01-01T10:00:00Z" },
      { lat: 40.0, lng: -73.0189, timestamp: "2024-01-01T10:08:00Z" }, // About 1 mile away, 8 mins later
      { lat: 40.0, lng: -73.0378, timestamp: "2024-01-01T10:15:00Z" }, // Another 1 mile, 7 mins later (fastest)
    ];
    const best = fastestMileSegment(points);
    expect(best).not.toBeNull();
    expect(best).toBeLessThan(480); // Should pick up the 7 minute pace
  });

  it("regression test: produces identical output to previous inline logic", () => {
    const points: RoutePoint[] = [
      { lat: 0, lng: 0, timestamp: "2024-01-01T10:00:00Z" },
      // 1 degree longitude at equator is ~69.172 miles
      // 1/69.172 = 0.0144567 degrees for 1 mile
      { lat: 0, lng: 0.015, timestamp: "2024-01-01T10:10:00Z" }, // 10 minutes = 600 seconds
    ];
    const best = fastestMileSegment(points);
    expect(best).not.toBeNull();
    // Allow slight floating point variations
    expect(Math.abs(best! - 600)).toBeLessThan(50);
  });
});

describe("findBestFastestMileAcrossRuns", () => {
  it("handles empty results", () => {
    expect(findBestFastestMileAcrossRuns([])).toBeNull();
  });

  it("handles tie handling", () => {
    const results = [
      { seconds: 400, date: new Date("2024-01-01T10:00:00Z") },
      { seconds: 400, date: new Date("2024-01-02T10:00:00Z") },
      null,
    ];
    const best = findBestFastestMileAcrossRuns(results);
    expect(best?.seconds).toBe(400);
  });

  it("regression test: produces identical output to previous inline logic", () => {
    const results = [
      null,
      { seconds: 450, date: new Date("2024-01-01T10:00:00Z") },
      { seconds: 400, date: new Date("2024-01-02T10:00:00Z") },
      { seconds: 100, date: new Date("2024-01-03T10:00:00Z") }, // Invalid < 180
      { seconds: 1300, date: new Date("2024-01-04T10:00:00Z") }, // Invalid > 1200
    ];
    const best = findBestFastestMileAcrossRuns(results);
    expect(best).toEqual({ seconds: 400, date: new Date("2024-01-02T10:00:00Z") });
  });
});
