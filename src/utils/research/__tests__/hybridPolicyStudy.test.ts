/**
 * Synthetic tests for the "keep Hybrid v1.2 simple" policy study. Invented data only (never owner data). Every scenario calls the SHIPPED
 * estimators unchanged; nothing here asserts that a production number should change. Decision criteria are in docs/hybrid-v1.2-policy-study.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRun } from "../../__tests__/fixtures/hrEnhancedFixture";
import { cadenceRuns, halfRace, strongEffort, POLICY_TZ, type EffortAttestation } from "../../__tests__/fixtures/policyStudyFixture";
import { estimateHybridHalfMarathonV11 } from "../../performance/hybridPerformanceV11";
import { dailySeries, dateRange, estimateWithPolicy, nonmaximalRaceIds, precisionRetained, stepProfile, type StudyInput } from "../hybridPolicyStudy";

type Race = ReturnType<typeof halfRace>;
const steady = (end: string) => cadenceRuns({ start: "2025-08-04", end, gaps: [2, 2, 3], miles: [5, 6, 5, 8] });
const study = (races: Race[], asOfDate: string, extra: ReturnType<typeof strongEffort>[] = []): StudyInput => ({
  races: races.map(r => r.race), workouts: [...steady(addDay(asOfDate, -1)), ...races.map(r => r.workout), ...extra], overrides: {}, timeZone: POLICY_TZ, asOf: `${asOfDate}T12:00:00Z` });
function addDay(d: string, n: number) { return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }

describe("current behaviour: an honest effort attestation removes the race from the hybrid evidence", () => {
  const at = (attest: EffortAttestation) => estimateWithPolicy(study([halfRace("hm", "2026-09-20", 8130, attest)], "2026-10-10"), "strict_maximal");
  it("the same race, same time: unconfirmed and maximal count; nonmaximal and effort-unknown confirmations do not", () => {
    expect(at("none").status).toBe("provisional");       // recorded, unverified: counted at low confidence
    expect(at("maximal").status).toBe("available");
    expect(at("nonmaximal").status).toBe("unavailable");  // MORE information (a confirmation that says "not maximal") => LESS evidence used
    expect(at("unknown").status).toBe("unavailable");
    expect(at("none").seconds).toBeCloseTo(at("maximal").seconds!, 0);
  });
});

describe("the single alternative: nonmaximal_lower_bound", { timeout: 60_000 }, () => {
  it("identity: with no nonmaximal-attested race the result equals the strict estimate exactly (several athletes)", () => {
    const cases: StudyInput[] = [
      study([halfRace("a", "2026-07-01", 8000, "maximal")], "2026-09-25", [strongEffort("e", "2026-08-15", 575)]),
      study([halfRace("b", "2026-07-01", 8000, "none")], "2026-09-25"),
      study([], "2026-09-25"),
      study([halfRace("c", "2026-07-01", 8000, "unknown")], "2026-09-25"),
    ];
    for (const c of cases) {
      const s = estimateWithPolicy(c, "strict_maximal"), n = estimateWithPolicy(c, "nonmaximal_lower_bound");
      expect([n.status, n.seconds, n.confidence, n.lowerBoundOnly]).toEqual([s.status, s.seconds, s.confidence, false]);
      expect(n.nonmaximalRaces).toBe(0);
    }
  });

  it("a lone nonmaximal race becomes a labelled lower-bound estimate whose NUMBER equals the shipped model's treatment of that race (no discount, no effort scaling)", () => {
    for (const asOf of ["2026-04-27", "2026-06-01", "2026-07-24", "2026-09-20", "2026-10-22"]) {
      const nm = estimateWithPolicy(study([halfRace("apr", "2026-04-26", 8130, "nonmaximal")], asOf), "nonmaximal_lower_bound");
      const strict = estimateWithPolicy(study([halfRace("apr", "2026-04-26", 8130, "nonmaximal")], asOf), "strict_maximal");
      const asMaximal = estimateHybridHalfMarathonV11(study([halfRace("apr", "2026-04-26", 8130, "maximal")], asOf));
      expect(strict.status).toBe("unavailable");
      expect(nm).toMatchObject({ status: "provisional", confidence: "low", lowerBoundOnly: true, source: "nonmaximal_race" });
      expect(nm.seconds).toBeCloseTo(asMaximal.seconds!, 1);
    }
  });

  it("it inherits the unchanged 180-day currency limit: no new age rule", () => {
    const old = estimateWithPolicy(study([halfRace("apr", "2026-04-26", 8130, "nonmaximal")], "2026-10-24"), "nonmaximal_lower_bound");
    expect(old.status).toBe("unavailable");
    expect(old.lowerBoundOnly).toBe(false);
  });

  it("a nonmaximal race can never make the estimate SLOWER: a slower one is ignored exactly", () => {
    const input = study([halfRace("strict", "2026-07-01", 8000, "maximal"), halfRace("nm", "2026-09-10", 8300, "nonmaximal")], "2026-09-25");
    const s = estimateWithPolicy(input, "strict_maximal"), n = estimateWithPolicy(input, "nonmaximal_lower_bound");
    expect(n.seconds).toBe(s.seconds);
    expect(n.lowerBoundOnly).toBe(false);
  });

  it("a faster nonmaximal race moves a stale estimate faster, continuously and monotonically, never past the strict estimate", () => {
    const sweep: number[] = [];
    for (let t = 7800; t <= 8700; t += 50) {
      const input = study([halfRace("strict", "2026-04-20", 8400, "maximal"), halfRace("nm", "2026-09-10", t, "nonmaximal")], "2026-09-25");
      const n = estimateWithPolicy(input, "nonmaximal_lower_bound");
      expect(n.seconds!).toBeLessThanOrEqual(n.strictSeconds! + 1e-9);
      sweep.push(n.seconds!);
    }
    for (let i = 1; i < sweep.length; i++) {
      expect(sweep[i]).toBeGreaterThanOrEqual(sweep[i - 1] - 1e-9);          // slower race => never a faster estimate
      expect(sweep[i] - sweep[i - 1]).toBeLessThanOrEqual(50 + 1e-6);        // Lipschitz <= 1: no jump
    }
    expect(sweep.at(-1)).toBe(sweep.at(-3));                                 // slower than the stale strict estimate: flat
    expect(sweep[0]).toBeLessThan(sweep.at(-1)! - 100);                      // a much faster race does move it
  });

  it("generative check (truth is simulation-only): with no other evidence the error is the unknown effort gap, never negative", () => {
    const truth = 8000;
    for (const gap of [0, 0.01, 0.02, 0.03, 0.05]) {
      const observed = Math.round(truth * (1 + gap));
      const r = estimateWithPolicy(study([halfRace("x", "2026-09-10", observed, "nonmaximal")], "2026-09-25"), "nonmaximal_lower_bound");
      expect(r.lowerBoundOnly).toBe(true);
      expect(r.seconds! - truth).toBeGreaterThanOrEqual(-1);                 // never optimistic relative to the true maximal time
      expect((r.seconds! - truth) / truth).toBeCloseTo(gap, 2);              // and the error is exactly what the owner could not measure
    }
  });

  it("effort descriptions are historical information only: 'about 80 %', 'about 90 %' and 'easy' give identical output", () => {
    const run = (conditions: string) => {
      const r = halfRace("x", "2026-09-10", 7871, "nonmaximal");
      r.race.performanceEvidence = { ...r.race.performanceEvidence!, conditions };
      return estimateWithPolicy(study([r], "2026-11-08"), "nonmaximal_lower_bound");
    };
    const a = run("Owner-described effort about 80 % (subjective)"), b = run("Owner-described effort about 90 % (subjective)"), c = run("Easy long-run pace");
    expect(a).toEqual(b); expect(b).toEqual(c);
    const source = readFileSync("src/utils/research/hybridPolicyStudy.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source).not.toMatch(/\d\s?%|slider|discount|effortPercent|effortScale|effortCoefficient|conditions/i);
  });

  it("owner-shaped history (two nonmaximal half marathons, as of 2026-11-08): strict has nothing; the alternative returns the demonstrated September level, labelled", () => {
    const input = study([halfRace("apr", "2026-04-26", 8130, "nonmaximal"), halfRace("sep", "2026-09-20", 7871, "nonmaximal")], "2026-11-08");
    expect(nonmaximalRaceIds(input)).toHaveLength(2);
    const s = estimateWithPolicy(input, "strict_maximal"), n = estimateWithPolicy(input, "nonmaximal_lower_bound");
    expect(s.status).toBe("unavailable");
    expect(n).toMatchObject({ status: "provisional", confidence: "low", lowerBoundOnly: true });
    expect(n.seconds!).toBeGreaterThanOrEqual(7871 - 1);        // the April race (196 days) is expired and carries nothing
    expect(n.seconds!).toBeLessThan(7871 * 1.01);
  });
});

describe("180-day expiry", () => {
  const scenario = (effortPace: number | null) => {
    const race = halfRace("hm", "2026-03-15", 8130, "maximal");
    const runs = cadenceRuns({ start: "2025-08-04", end: "2026-10-31", gaps: [2, 2, 3] });
    return { races: [race.race], workouts: [...runs, race.workout, ...(effortPace ? [strongEffort("eff", "2026-02-10", effortPace)] : [])], overrides: {}, timeZone: POLICY_TZ };
  };
  it("the step when a non-race effort passes 180 days equals its remaining evidence share times its gap to the rest, and it is a one-day step", () => {
    const steps = [590, 575, 560].map(p => {
      const rows = dailySeries(scenario(p), dateRange("2026-08-05", "2026-08-14"));
      const before = rows.find(r => r.date === "2026-08-09")!, after = rows.find(r => r.date === "2026-08-10")!;
      return { pace: p, step: Math.abs(after.seconds! - before.seconds!), expired: [before.expiredEvidence, after.expiredEvidence], profile: stepProfile(rows) };
    });
    expect(steps[0].expired).toEqual([0, 0]);                          // the 590 s/mi effort is not "strong" for this athlete: it never became evidence
    expect(steps.slice(1).every(s => s.expired[0] === 0 && s.expired[1] === 1)).toBe(true);
    expect(steps[2].step).toBeGreaterThan(30);                         // a 1.9 % faster effort (7,975 s vs 8,130 s) holding ~24 % of the base
    expect(steps[2].step).toBeLessThan(45);
    expect(steps[1].step).toBeLessThan(5);                             // a 0.7 % slower one (8,189 s) holds ~3 %
    expect(steps[0].step).toBeLessThan(1);
    expect(steps[2].profile.maxStepDate).toBe("2026-08-10");
    expect(steps[2].profile.stepsOver30s).toBe(1);                     // every other day moves < 30 s
  });
  it("a lone race goes from an estimate to no estimate between day 180 and day 181", () => {
    const rows = dailySeries(scenario(null), dateRange("2026-09-09", "2026-09-14"));
    expect(rows.map(r => r.status === "unavailable")).toEqual([false, false, false, true, true, true]);
    expect(rows[3].date).toBe("2026-09-12");
    expect(stepProfile(rows).availabilityFlips).toBe(1);
  });
  it("why 'just remove the cutoff' is not defensible: age alone leaves old evidence with substantial precision", () => {
    const keep = (age: number, sigma: number) => precisionRetained(age, sigma);
    expect(keep(180, 0.03)).toBeGreaterThan(0.55);                     // a whole-run effort still holds ~60 % of its precision at the cutoff
    expect(keep(180, 0.01)).toBeLessThan(0.2);                         // a confirmed race holds ~14 %
    expect(keep(400, 0.03)).toBeGreaterThan(0.35);                     // and ~40 % at 400 days — stale evidence would keep pulling
  });
});

describe("20-run minimum for the aerobic trend", () => {
  const improving = (gaps: number[], end = "2026-09-10") => {
    const race = halfRace("hm", "2026-03-15", 8130, "maximal");
    const runs = cadenceRuns({ start: "2025-11-01", end, gaps, trendPer28d: -0.015, noise: 0.012 });
    return { races: [race.race], workouts: [...runs, race.workout], overrides: {}, timeZone: POLICY_TZ };
  };
  it("a steady runner near 1.3 runs/week sees the whole physiology term switch on and off with a single run (up to the 2 % cap), on an unchanged athlete", { timeout: 120000 }, () => {
    const rows = dailySeries(improving([5, 7, 4, 6, 5, 6, 7, 4, 5, 6, 5, 7]), dateRange("2026-05-01", "2026-09-10"));
    const p = stepProfile(rows);
    const flips = rows.slice(1).filter((r, i) => (r.trendStatus === "available") !== (rows[i].trendStatus === "available")).length;
    expect(flips).toBeGreaterThanOrEqual(6);
    expect(p.maxStepSeconds).toBeGreaterThan(150);                     // 2 % of 8,130 s = 162.6 s
    expect(p.maxStepSeconds).toBeLessThanOrEqual(0.02 * 8130 + 1);
    expect(p.stepsOver60s).toBeGreaterThanOrEqual(5);
    const worst = rows.find(r => r.date === p.maxStepDate)!;
    expect(worst.trendRuns).toBe(19);                                  // the day the eligible count fell below 20
  });
  it("a runner comfortably above the minimum has no step above 10 s over the same months", { timeout: 120000 }, () => {
    const p = stepProfile(dailySeries(improving([3, 4]), dateRange("2026-05-01", "2026-09-10")));
    expect(p.maxStepSeconds).toBeLessThan(10);
  });
  it("just above the gate the term is already ~80 % of its full size and no spurious trend appears: the 20-run cliff is much steeper than the precision it protects", { timeout: 280000 }, () => {
    const at = (gaps: number[], trend: number, seed: number) => {
      const race = halfRace("hm", "2026-03-15", 8130, "maximal");
      const runs = cadenceRuns({ start: "2026-02-01", end: "2026-07-14", gaps, trendPer28d: trend, noise: 0.012, seed });
      return estimateHybridHalfMarathonV11({ races: [race.race], workouts: [...runs, race.workout], overrides: {}, timeZone: POLICY_TZ, asOf: "2026-07-15T12:00:00Z" });
    };
    const cadences: [string, number[]][] = [["~21", [5, 5, 6]], ["~25", [4, 5]], ["~32", [3, 4]], ["~42", [2, 3, 3]]];
    const mean: Record<string, number> = {}, n: Record<string, number> = {};
    for (const [name, gaps] of cadences) {
      const improvingSeconds: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const flat = at(gaps, 0, seed);
        expect(flat.physiology?.classification === "observed_improvement" || flat.physiology?.classification === "observed_decline").toBe(false); // no false positives
        const e = at(gaps, -0.01, seed);
        expect(e.physiology?.status).toBe("available");
        improvingSeconds.push(e.influence.physiologyAdjustmentSeconds); n[name] = e.physiology!.runs!;
      }
      mean[name] = improvingSeconds.reduce((a, b) => a + b, 0) / improvingSeconds.length;
    }
    expect(n["~21"]).toBeGreaterThanOrEqual(20); expect(n["~21"]).toBeLessThanOrEqual(22);
    // Precision already attenuates the term gradually as runs thin out (about -102 s at 21 runs vs -125 s at 42 for a true -1 %/28 d)...
    for (const k of ["~25", "~32", "~42"]) expect(mean["~21"] / mean[k]).toBeGreaterThan(0.75);
    expect(mean["~21"]).toBeLessThan(-90);
    // ...yet one run fewer switches the whole ~100 s off (previous test): the hard minimum is a second, much steeper, attenuation.
  });
});

describe("taper and endurance readiness", () => {
  const enduranceAtRace = (miles: number[], gaps: number[], taper: { from: string; factor: number }[]) => {
    const race = halfRace("hm", "2026-07-12", 8130, "maximal");
    const runs = cadenceRuns({ start: "2026-02-01", end: "2026-10-03", gaps, miles, volume: taper });
    return estimateHybridHalfMarathonV11({ races: [race.race], workouts: [...runs, race.workout], overrides: {}, timeZone: POLICY_TZ, asOf: "2026-10-04T12:00:00Z" });
  };
  it("an ordinary two-week taper (volume x0.75/x0.5/x0.3 for 14 days) moves the endurance term by < 10 s across a spread of athletes; it is bounded by the 1.5 % cap regardless", { timeout: 280000 }, () => {
    let worst = 0;
    for (const miles of [[3, 4, 3, 6], [5, 6, 5, 8], [6, 8, 6, 10]]) for (const gaps of [[2, 2, 3], [2, 2, 1, 2]]) {
      const steadySec = enduranceAtRace(miles, gaps, []).influence.enduranceAdjustmentSeconds;
      for (const factor of [0.75, 0.5, 0.3]) {
        const t = enduranceAtRace(miles, gaps, [{ from: "2026-09-20", factor }]);
        worst = Math.max(worst, Math.abs(t.influence.enduranceAdjustmentSeconds - steadySec));
        expect(Math.abs(t.influence.enduranceAdjustmentSeconds)).toBeLessThanOrEqual(0.015 * 8130 + 1e-6);
      }
    }
    expect(worst).toBeLessThan(10);
  });
  it("what moves the term in the last weeks is the run composition leaving the 8-week window, not the taper: a good block rolling off swings it >3x more", { timeout: 120000 }, () => {
    const race = halfRace("hm", "2026-04-26", 8130, "maximal");
    const runs = cadenceRuns({ start: "2025-12-01", end: "2026-09-20", gaps: [2, 2, 3], miles: [4, 5, 4, 6] });
    const peak = makeRun({ id: "peak", date: "2026-07-11", pace: 640, hr: 150, minutes: 10.2 * 640 / 60, tempF: 62, climbPerMile: 8 });
    const rows = dailySeries({ races: [race.race], workouts: [...runs, race.workout, peak], overrides: {}, timeZone: POLICY_TZ }, dateRange("2026-08-20", "2026-09-20"));
    const swing = Math.max(...rows.map(r => r.enduranceSeconds)) - Math.min(...rows.map(r => r.enduranceSeconds));
    expect(swing).toBeGreaterThan(25);
    expect(Math.abs(rows.at(-1)!.enduranceSeconds)).toBeLessThan(1e-9);
    expect(swing).toBeGreaterThan(3 * 8.4);
  });
  it("a 'taper-neutral' readiness (max of now and 14 days earlier, fed through the existing scenario override) removes the taper term but also hides 14 days of genuine detraining", { timeout: 120000 }, () => {
    const race = halfRace("hm", "2026-07-12", 8130, "maximal");
    const build = (volume: { from: string; factor: number }[]) => ({ races: [race.race], workouts: [...cadenceRuns({ start: "2026-02-01", end: "2026-10-03", gaps: [2, 2, 3], miles: [4, 5, 4, 7], volume }), race.workout], overrides: {}, timeZone: POLICY_TZ });
    const neutral = (input: ReturnType<typeof build>, day: string) => {
      const now = estimateHybridHalfMarathonV11({ ...input, asOf: `${day}T12:00:00Z` }), then = estimateHybridHalfMarathonV11({ ...input, asOf: `${addDay(day, -14)}T12:00:00Z` });
      const eff = Math.max(now.readiness!.score!, then.readiness!.score!);
      return { prod: now.influence.enduranceAdjustmentSeconds, candidate: estimateHybridHalfMarathonV11({ ...input, asOf: `${day}T12:00:00Z` }, { readinessOverride: eff }).influence.enduranceAdjustmentSeconds };
    };
    const taper = neutral(build([{ from: "2026-09-20", factor: 0.5 }]), "2026-10-04");
    const loss = neutral(build([{ from: "2026-09-13", factor: 0.25 }]), "2026-10-04");
    expect(taper.prod).toBeGreaterThan(taper.candidate);               // the taper contribution disappears...
    expect(Math.abs(taper.candidate)).toBeLessThan(1e-9);
    expect(loss.prod).toBeGreaterThan(loss.candidate);                 // ...but so does part of a genuine, longer loss of training
  });
});

describe("research isolation", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "__tests__" || f === "research" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  it("no live source imports the policy-study toolkit", () => {
    expect(walk("src").filter(f => /research\/hybridPolicyStudy/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
  it("the toolkit never writes: no Firestore, fs or network client is imported", () => {
    expect(readFileSync("src/utils/research/hybridPolicyStudy.ts", "utf8")).not.toMatch(/from "(firebase|firebase-admin|node:fs|fs)/);
  });
});
