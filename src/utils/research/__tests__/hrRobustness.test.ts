import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCurrentHalfMarathon } from "../../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../../hrEnhancedPerformance";
import { addDays, hrScenario, makeRun, type RunSpec } from "../../__tests__/fixtures/hrEnhancedFixture";
import { researchRace } from "../../__tests__/fixtures/workoutRaceResearchFixture";
import { compareHrCandidates } from "../hrCandidates";
import { dailySeries, leaveOneOut, point, policySensitivity } from "../hrSensitivity";

// Workstream E: behaviour under perturbation. Assertions check RELATIONSHIPS (direction, bounds,
// boundedness of influence), never a hard-coded finish time. A table is emitted when HR_ROBUSTNESS_OUT is set.
const BASE = { recentLevel: 0.95 as number };
const seconds = (o: Parameters<typeof hrScenario>[0]) => {
  const s = hrScenario({ ...BASE, ...o });
  const hr = estimateHrEnhancedHalfMarathon(s.input), off = estimateCurrentHalfMarathon(s.input);
  return { hr, off, input: s.input, official: off.baselineSeconds === null ? null : off.baselineSeconds + off.adjustmentSeconds };
};
const extra = (spec: Partial<RunSpec>) => [makeRun({ id: "new-run", date: "2026-10-08", pace: 600, hr: 150, tempF: 62, climbPerMile: 8, ...spec })];
const table: Record<string, unknown>[] = [];
const record = (name: string, r: ReturnType<typeof seconds>, base: ReturnType<typeof seconds>) => table.push({
  scenario: name, status: r.hr.status, direction: r.hr.signalDirection,
  candidateShiftSeconds: r.hr.candidateSeconds !== null && base.hr.candidateSeconds !== null ? r.hr.candidateSeconds - base.hr.candidateSeconds : null,
  officialShiftSeconds: r.official !== null && base.official !== null ? r.official - base.official : null,
  differenceSeconds: r.hr.differenceSeconds, strength: r.hr.signal?.strength.combined ?? 0 });

describe("single-workout perturbations of an established favourable signal", () => {
  const base = seconds({});
  it("the base scenario has an available favourable signal", () => {
    expect(base.hr.status).toBe("available");
    expect(base.hr.signalDirection).toBe("improved");
  });
  const cases: [string, Partial<RunSpec>][] = [
    ["one new easy run on the pace-HR relation (HR 143)", { hr: 143, pace: 600 * Math.exp(-0.006 * -7) }],
    ["one unusually fast workout (-30 % pace, same HR)", { pace: 420 }],
    ["one run with substantially elevated HR (HR 178)", { hr: 178, pace: 600 * Math.exp(-0.006 * 28) }],
    ["one run with unusually low HR (HR 118)", { hr: 118, pace: 600 * Math.exp(-0.006 * -32) }],
    ["one treadmill run (fast, low HR)", { type: "Treadmill Run", pace: 480, hr: 140, tempF: null }],
    ["one hilly route (60 m/mi, slow)", { climbPerMile: 60, pace: 720 }],
    ["one run with missing weather", { tempF: null }],
    ["one run with erroneous HR (999)", { hr: 999 }],
    ["one run with missing HR", { hr: null }],
    ["one long run (95 min)", { minutes: 95 }],
    ["one short run (22 min)", { minutes: 22 }],
  ];
  for (const [name, spec] of cases) {
    it(`${name}: bounded influence, never a favourable jump on its own`, () => {
      const r = seconds({ extra: extra(spec) });
      record(name, r, base);
      // A single added run can never move the candidate by more than a small fraction of the 1.5 % cap range.
      if (r.hr.candidateSeconds !== null && base.hr.candidateSeconds !== null)
        expect(Math.abs(r.hr.candidateSeconds - base.hr.candidateSeconds)).toBeLessThan(0.006 * base.official!);
      // Never produces a larger favourable shift than the base signal supports.
      if (r.hr.differenceSeconds !== null && base.hr.differenceSeconds !== null)
        expect(r.hr.differenceSeconds).toBeGreaterThanOrEqual(base.hr.differenceSeconds - 0.006 * base.official!);
    });
  }
  it("a faster workout that is faster only because effort was higher is not credited", () => {
    const r = seconds({ extra: extra({ hr: 164, pace: 600 * Math.exp(-0.006 * 14) }) });
    expect(Math.abs(r.hr.candidateSeconds! - base.hr.candidateSeconds!)).toBeLessThan(0.004 * base.official!);
  });
});

describe("multi-week scenarios", () => {
  const base = seconds({});
  it("several weeks of genuine improvement are favourable and bounded by the 1.5 % cap", () => {
    const r = seconds({ recentLevel: 0.9 });
    record("several weeks of genuine improvement (-10 %)", r, base);
    expect(r.hr.differenceSeconds!).toBeLessThan(0);
    expect(Math.abs(r.hr.differenceSeconds!)).toBeLessThanOrEqual(0.015 * r.off.baselineSeconds! + 1e-6);
  });
  it("several weeks of decline are unfavourable", () => {
    const r = seconds({ recentLevel: 1.1 });
    record("several weeks of decline (+10 %)", r, base);
    expect(r.hr.differenceSeconds!).toBeGreaterThan(0);
  });
  it("monotone: more improvement never yields a slower candidate", () => {
    const levels = [1.08, 1.04, 1, 0.96, 0.92];
    const sec = levels.map(l => { const r = seconds({ recentLevel: l }); return r.hr.candidateSeconds ?? r.official!; });
    for (let i = 1; i < sec.length; i++) expect(sec[i]).toBeLessThanOrEqual(sec[i - 1] + 1e-9);
  });
  it("an implausible 20 % same-HR gain is rejected as an artifact, not rewarded", () => {
    const r = seconds({ recentLevel: 0.8 });
    record("implausible +20 % same-HR gain", r, seconds({}));
    expect(r.hr.signal?.flags.includes("artifacts_rejected") || r.hr.status === "unavailable").toBe(true);
    expect(Math.abs(r.hr.differenceSeconds ?? 0)).toBeLessThanOrEqual(0.015 * r.off.baselineSeconds! + 1e-6);
  });
  it("hot baseline / cool recent and the reverse: heat cannot manufacture a headline", () => {
    const hot = seconds({ baselineTemp: 82, recentTemp: 56 }), cool = seconds({ baselineTemp: 56, recentTemp: 82 });
    record("hot baseline vs cool recent", hot, base); record("cool baseline vs hot recent", cool, base);
    for (const r of [hot, cool]) expect(r.hr.status === "unavailable" || Math.abs(r.hr.differenceSeconds!) < Math.abs(base.hr.differenceSeconds!)).toBe(true);
  });
  it("missing weather halves rather than removes the evidence", () => {
    const r = seconds({ baselineTemp: null, recentTemp: null });
    record("weather missing everywhere", r, base);
    expect(r.hr.signal!.weather.status).toBe("partial");
    expect(Math.abs(r.hr.differenceSeconds!)).toBeLessThan(Math.abs(base.hr.differenceSeconds!));
    expect(Math.abs(r.hr.differenceSeconds!)).toBeGreaterThan(0);
  });
  it("no usable HR data, an expired anchor and a new anchor all fall back or move the windows, never invent", () => {
    const noHr = seconds({ mutate: s => ({ ...s, hr: null }) });
    record("no usable HR data", noHr, base);
    expect(noHr.hr.candidateSeconds).toBeNull();
    const expired = seconds({ asOf: "2027-03-05T16:00:00.000Z" });
    record("expired race anchor", expired, base);
    expect(expired.hr.candidateSeconds).toBeNull();
    const s = hrScenario({ ...BASE });
    const second = researchRace("second", "2026-10-04", 7700);
    const reAnchored = { ...s.input, races: [...s.input.races, second.race], workouts: [...s.input.workouts, second.workout] };
    const r = estimateHrEnhancedHalfMarathon(reAnchored);
    table.push({ scenario: "new (later) race anchor", status: r.status, direction: r.signalDirection, anchorDate: r.anchorDate });
    expect(r.anchorDate === "2026-10-04" || r.anchorDate === "2026-08-30").toBe(true);
    if (r.anchorDate === "2026-10-04") expect(r.signal?.window.baseline.end).toBe("2026-09-26");
  });
  it("is stable day to day: moving the cutoff one day changes the candidate by less than the cap range", () => {
    const s = hrScenario({ ...BASE });
    const dates = Array.from({ length: 12 }, (_, i) => addDays("2026-10-01", i));
    const series = dailySeries(s.input, dates.map(d => d + "T16:00:00.000Z"));
    table.push({ scenario: "daily series Oct 1–12", availableDays: series.availableDays, directionalDays: series.directionalDays, maxDayToDayStepSeconds: series.maxDayToDayStepSeconds });
    expect(series.maxDayToDayStepSeconds).toBeLessThan(0.01 * seconds({}).official!);
  });
});

describe("leave-one-out and threshold dependence", () => {
  it("no single run moves the HR-attributable part of the estimate by more than 0.3 % of the race time", () => {
    const s = hrScenario({ ...BASE });
    const l = leaveOneOut(s.input);
    table.push({ scenario: "leave-one-out (synthetic base)", ...l });
    expect(l.runsTested).toBeGreaterThan(20);
    expect(l.maxAbsHrAttributableShiftSeconds).toBeLessThan(0.003 * seconds({}).official!);
    // Whatever the official heuristic does to a removed run is its own behaviour, reported for comparison.
    expect(l.maxAbsOfficialShiftSeconds).toBeGreaterThanOrEqual(0);
  });
  it("policy perturbations do not flip the favourable direction on a clear signal", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    const sens = policySensitivity(s.input);
    table.push({ scenario: "policy perturbations (synthetic clear signal)", variants: sens.variants.length,
      availabilityChanges: sens.variants.filter(v => v.availabilityChanged).length, directionChanges: sens.variants.filter(v => v.directionChanged).length });
    expect(sens.variants.every(v => !v.directionChanged)).toBe(true);
  });
  it("candidate comparison reports coverage, and only official/selected yield finish times", () => {
    const s = hrScenario({ ...BASE });
    const c = compareHrCandidates(s.input);
    expect(c.rows.map(r => r.id)).toEqual(["v2-official", "strict-comparable-effort", "similar-hr-band", "same-route-hr-adjusted", "multiweek-efficiency", "hr-enhanced-selected"]);
    for (const r of c.rows) if (!["v2-official", "hr-enhanced-selected"].includes(r.id)) expect(r.finishSeconds).toBeNull();
    expect(c.rows.find(r => r.id === "hr-enhanced-selected")!.status).toBe("available");
    expect(c.rows.find(r => r.id === "similar-hr-band")!.contrastPercent).toBeLessThan(0);
  });
  it("point() summarises one evaluation", () => {
    expect(point(hrScenario({ ...BASE }).input).status).toBe("available");
  });
});

describe("isolation: research modules are never imported by live code", () => {
  it("no non-test source file outside src/utils/research imports them", () => {
    const hits: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f === "node_modules" || f === "__tests__" || p.includes("utils/research")) continue; walk(p); }
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /utils\/research|\.\/research\//.test(readFileSync(p, "utf8"))) hits.push(p); } };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });
});

import { afterAll } from "vitest";
afterAll(() => { if (process.env.HR_ROBUSTNESS_OUT) writeFileSync(process.env.HR_ROBUSTNESS_OUT, JSON.stringify(table, null, 1)); });
