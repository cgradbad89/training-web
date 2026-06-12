import { describe, it, expect } from "vitest";
import {
  computeRoutePerformance,
  runPaceSeconds,
  type MatchedRunSummary,
} from "@/utils/routePerformance";

/** Matched-run row with sensible defaults. */
function run(
  runId: string,
  paceSeconds: number,
  date = "2026-01-01",
  distanceMiles = 9.0
): MatchedRunSummary {
  return { runId, date, paceSeconds, distanceMiles, load: null };
}

describe("computeRoutePerformance", () => {
  it("ranks the fastest run 1st and orders bestEfforts ascending by pace", () => {
    const runs = [
      run("slow", 600, "2026-02-01"),
      run("fast", 480, "2026-03-01"),
      run("mid", 540, "2026-04-01"),
      run("slowest", 660, "2026-05-01"),
    ];
    const perf = computeRoutePerformance("fast", runs)!;
    expect(perf.rank).toBe(1);
    expect(perf.matchedCount).toBe(4);
    expect(perf.bestEfforts.map((r) => r.runId)).toEqual([
      "fast",
      "mid",
      "slow",
    ]);
    expect(perf.bestEfforts.map((r) => r.paceSeconds)).toEqual([480, 540, 600]);
  });

  it("ranks a middle run 2nd", () => {
    const runs = [run("a", 480), run("b", 540), run("c", 600)];
    expect(computeRoutePerformance("b", runs)!.rank).toBe(2);
  });

  it("ranks the Nth run correctly in a larger group (top-3 stays top-3)", () => {
    const runs = [
      run("r1", 480),
      run("r2", 500),
      run("r3", 520),
      run("r4", 555),
      run("r5", 590),
    ];
    const perf = computeRoutePerformance("r4", runs)!;
    expect(perf.rank).toBe(4);
    expect(perf.matchedCount).toBe(5);
    // current run is NOT in the top 3
    expect(perf.bestEfforts.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
  });

  it("delta is negative when this run is faster than the route average", () => {
    // avg = (480 + 600) / 2 = 540
    const runs = [run("me", 480), run("other", 600)];
    const perf = computeRoutePerformance("me", runs)!;
    expect(perf.routeAvgPaceSeconds).toBe(540);
    expect(perf.deltaVsAvgSeconds).toBe(-60);
  });

  it("delta is positive when this run is slower than the route average", () => {
    const runs = [run("me", 600), run("other", 480)];
    const perf = computeRoutePerformance("me", runs)!;
    expect(perf.deltaVsAvgSeconds).toBe(60);
  });

  it("includes distance-mismatched runs in the ranking (no distance filter)", () => {
    // A 13.4 mi race clustered onto a 9 mi route still ranks by pace.
    const runs = [
      run("nine-a", 540, "2026-01-01", 9.0),
      run("race", 500, "2026-02-01", 13.4),
      run("nine-b", 560, "2026-03-01", 9.1),
    ];
    const perf = computeRoutePerformance("nine-a", runs)!;
    expect(perf.rank).toBe(2); // the race outranks it
    expect(perf.bestEfforts[0].runId).toBe("race");
  });

  it("breaks pace ties by date (earlier run keeps the better rank)", () => {
    const runs = [run("later", 540, "2026-03-01"), run("earlier", 540, "2026-01-01")];
    expect(computeRoutePerformance("earlier", runs)!.rank).toBe(1);
    expect(computeRoutePerformance("later", runs)!.rank).toBe(2);
  });

  it("returns null when the group has fewer than 2 runs", () => {
    expect(computeRoutePerformance("only", [run("only", 540)])).toBeNull();
    expect(computeRoutePerformance("x", [])).toBeNull();
  });

  it("returns null when the current run is not in the group", () => {
    const runs = [run("a", 480), run("b", 540)];
    expect(computeRoutePerformance("not-here", runs)).toBeNull();
  });
});

describe("runPaceSeconds", () => {
  it("prefers the stored avgPaceSecPerMile", () => {
    expect(
      runPaceSeconds({
        avgPaceSecPerMile: 540,
        durationSeconds: 6000,
        distanceMiles: 10,
      })
    ).toBe(540);
  });

  it("falls back to duration/distance when the stored pace is null", () => {
    expect(
      runPaceSeconds({
        avgPaceSecPerMile: null,
        durationSeconds: 5400,
        distanceMiles: 10,
      })
    ).toBe(540);
  });

  it("returns null when nothing is derivable", () => {
    expect(
      runPaceSeconds({
        avgPaceSecPerMile: null,
        durationSeconds: 0,
        distanceMiles: 0,
      })
    ).toBeNull();
  });
});
