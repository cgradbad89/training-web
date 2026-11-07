import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersionsAsOf, leaveOneOutV11, leaveOneWeekOutV11, replayV11, sweepsV11 } from "../hybridV11Evaluation";
import { scoreModelsAgainstOutcomes } from "../hybridEvaluation";
import { athleteV11 } from "../../__tests__/fixtures/hybridV11Fixture";

const eff = (date: string, miles: number, pace: number, hr = 172) => ({ date, miles, pace, hr });
const a = athleteV11({ raceDate: "2026-07-30", strong: [eff("2026-10-02", 6, 548), eff("2026-10-16", 7, 552), eff("2026-10-28", 6, 546)] });
const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse("2026-10-10T17:00:00Z") + i * 86_400_000).toISOString());

describe("research evaluation of v1.1 versus v1, v2 and HR-enhanced", () => {
  it("compares every model at one instant, with no future data and no identifiers in the row", () => {
    const row = compareVersionsAsOf(a, "2026-10-20T17:00:00.000Z");
    expect(row.hybridV1Seconds).not.toBeNull(); expect(row.hybridV11Seconds).not.toBeNull(); expect(row.officialSeconds).not.toBeNull();
    expect(row.leakageExcluded).toBeGreaterThan(0);                                   // workouts after the instant were dropped
    expect(JSON.stringify(row)).not.toMatch(/ord-\d|strong-2026|hm-run/);
  });
  it("replays chronologically: race influence falls as efforts arrive, availability holds, steps stay bounded", () => {
    const r = replayV11(a, days(28));
    expect(r.availability.v11).toBe(28); expect(r.raceShare.last!).toBeLessThan(r.raceShare.first!);
    expect(r.dayToDay!.maxStepFraction).toBeLessThan(0.01);
    expect(r.rows.every(x => x.asOfDate <= x.asOf.slice(0, 10))).toBe(true);
    expect(Object.keys(r.v11Status).length).toBeGreaterThan(0);
    // Timeout: 28 instants × (official v2 + HR-enhanced + hybrid v1 + hybrid v1.1) is ≈ 1.0 s in isolation (measured: 1.02 s, 3 runs ±0.05; 2.2 s inside the full local suite) but the
    // CI quality gate runs 245 files in parallel on a shared runner (243 s of test time in a 156 s wall clock) and it exceeded the 5 s default
    // there once. 30 s keeps real regressions (an order-of-magnitude slowdown) visible without flaking under contention; the replay itself is unchanged.
  }, 30_000);
  it("leave-one-run-out and leave-one-week-out shifts are small and cause no availability flips here", () => {
    const l = leaveOneOutV11(a), w = leaveOneWeekOutV11(a);
    expect(l.runsTested).toBeGreaterThan(10); expect(l.maxShiftFraction!).toBeLessThan(0.02); expect(l.availabilityFlips).toBe(0);
    expect(w.maxShiftFraction!).toBeLessThan(0.03);
  });
  it("sweeps expose how much each assumption matters, without a single quality score", () => {
    const s = sweepsV11(a);
    expect(s.commonModeEfforts.halved!).toBeLessThan(0); expect(s.commonModeEfforts.doubled!).toBeGreaterThan(0);
    expect(s.withoutSustainedSegments).toBe(0);                                      // no segments in this athlete
    expect(s.racesOnly!).toBeGreaterThan(0);
    expect(s.vo2SourceAvailability.withoutVo2DeltaSeconds).toBe(0);
    expect(s.weatherMissingness.flags).toContain("weather_unadjusted");
    expect(s.forecastReadinessResponse[0].deltaSeconds!).toBeGreaterThan(s.forecastReadinessResponse[3].deltaSeconds!);
  });
  it("accuracy stays NOT EVALUABLE below five independent qualified outcomes (threshold unchanged)", () => {
    const rows = replayV11(a, days(3)).rows as never[];
    const s = scoreModelsAgainstOutcomes(rows, [{ raceDate: "2026-11-30", finishSeconds: 7500, qualified: true }, { raceDate: "2026-12-30", finishSeconds: 7500, qualified: false }]);
    expect(s.status).toBe("NOT EVALUABLE");
  });
});

describe("research code is never imported by live code", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
  it("no non-research, non-test source imports utils/research", () => {
    const offenders = walk("src").filter(f => /research\/(hybridEvaluation|hybridV11Evaluation|signalEvaluation|hrCandidates|hrSensitivity|hrDriftAudit)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
