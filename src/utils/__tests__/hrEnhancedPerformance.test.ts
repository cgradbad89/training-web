import { describe, expect, it } from "vitest";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon, HR_ENHANCED_POLICY, HR_ENHANCED_VERSION } from "../hrEnhancedPerformance";
import { computeHrEffortSignal, HR_SIGNAL_POLICY, HR_SIGNAL_VERSION, median, weightedMedian } from "../hrEffortSignal";
import { addDays, hrScenario, makeRun } from "./fixtures/hrEnhancedFixture";

const hr = (o: Parameters<typeof hrScenario>[0] = {}) => {
  const s = hrScenario(o);
  return { ...s, official: estimateCurrentHalfMarathon(s.input), result: estimateHrEnhancedHalfMarathon(s.input) };
};

describe("robust statistics", () => {
  it("median / weighted median are deterministic and ignore zero weights", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(weightedMedian([1, 2, 100], [1, 1, 1])).toBe(2);
    expect(weightedMedian([1, 2, 100], [0, 1, 0])).toBe(2);
    expect(weightedMedian([1, 100], [1, 1])).toBe(50.5);
    expect(weightedMedian([5, 1, 3], [1, 1, 5])).toBe(3);
    expect(Number.isNaN(weightedMedian([1], [0]))).toBe(true);
  });
});

describe("signal direction (mathematics, not hard-coded results)", () => {
  it("equal fitness gives no favourable or unfavourable change and leaves the official number alone", () => {
    const { result, official } = hr();
    expect(result.status).not.toBe("unavailable");
    expect(result.signalDirection).toBe("no_detectable_change");
    expect(result.differenceSeconds).toBe(0);
    expect(result.candidateMinutes).toBe(official.finishMinutes);
  });

  it("sustained faster pace at the same HR is favourable and moves the estimate faster", () => {
    const { result, official } = hr({ recentLevel: 0.94 });
    expect(result.signal!.status).toBe("available");
    expect(result.signalDirection).toBe("improved");
    expect(result.signal!.contrast.shrunk!).toBeLessThan(0);
    expect(result.status).toBe("available");
    expect(result.candidateSeconds!).toBeLessThan(result.officialSeconds!);
    expect(result.differenceSeconds!).toBeLessThan(0);
    expect(result.officialSeconds).toBe(official.baselineSeconds! + official.adjustmentSeconds);
  });

  it("sustained slower pace at the same HR is unfavourable and moves the estimate slower", () => {
    const { result } = hr({ recentLevel: 1.07 });
    expect(result.signalDirection).toBe("declined");
    expect(result.differenceSeconds!).toBeGreaterThan(0);
  });

  it("the same pace at a lower HR is favourable", () => {
    // Pace held at the baseline pace-HR relation, but recent runs are at 3 bpm lower HR with
    // pace unchanged: equal to running faster than the relation predicts.
    // The pace-HR relation predicts runs 3 bpm easier to be exp(0.018) slower; recent runs hold the
    // baseline pace at that lower HR, so they are faster than the relation predicts.
    const { result } = hr({ recentHrShift: -3, slope: -0.006, recentLevel: Math.exp(-0.006 * 3), noise: 0 });
    expect(result.signal!.contrast.raw!).toBeLessThan(-0.01);
    expect(result.signalDirection).toBe("improved");
  });

  it("running faster only because HR was higher is NOT credited as fitness (effort-explained)", () => {
    // Recent runs are 4 bpm harder AND exactly as much faster as the pace-HR relation predicts.
    const { result } = hr({ recentHrShift: 4, slope: -0.006, noise: 0 });
    expect(result.signal!.status).toBe("available");
    expect(Math.abs(result.signal!.contrast.raw!)).toBeLessThan(0.01);
    expect(result.signalDirection).toBe("no_detectable_change");
    expect(result.differenceSeconds).toBe(0);
  });

  it("a faster recent pace with HR raised enough to explain it never produces a favourable headline", () => {
    const harder = hr({ recentHrShift: 4, recentLevel: 1, slope: -0.006, noise: 0 }).result;
    const sameHrFaster = hr({ recentHrShift: 0, recentLevel: Math.exp(-0.006 * 4), slope: -0.006, noise: 0 }).result;
    // Identical pace gain: only the one achieved at unchanged HR may be credited.
    expect(Math.abs(harder.differenceSeconds ?? 0)).toBeLessThan(Math.abs(sameHrFaster.differenceSeconds ?? 0) + 1e-9);
    expect(harder.signalDirection).not.toBe("improved");
  });
});

describe("fallback and suppression: never invent an adjustment", () => {
  it("official unavailable (no race) → unavailable with the official reason, no candidate", () => {
    const s = hrScenario();
    const r = estimateHrEnhancedHalfMarathon({ ...s.input, races: [], workouts: s.input.workouts });
    expect(r.status).toBe("unavailable");
    expect(r.unavailableCause).toBe("official_unavailable");
    expect(r.candidateSeconds).toBeNull();
    expect(r.differenceSeconds).toBeNull();
    expect(r.signalDirection).toBe("unavailable");
  });

  it("expired race anchor (> 180 days) → unavailable", () => {
    const s = hrScenario({ asOf: "2027-03-05T16:00:00.000Z" });
    const r = estimateHrEnhancedHalfMarathon(s.input);
    expect(r.status).toBe("unavailable");
    expect(r.unavailableCause).toBe("official_unavailable");
  });

  it("no usable HR data → unavailable, official preserved", () => {
    const { result, official } = hr({ mutate: (s) => ({ ...s, hr: null }) });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("no_outdoor_hr_runs");
    expect(result.candidateMinutes).toBeNull();
    expect(result.officialMinutes).toBe(official.finishMinutes);
  });

  it("invalid (artifact) HR values are not used", () => {
    const { result } = hr({ mutate: (s) => ({ ...s, hr: 999 }) });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("no_outdoor_hr_runs");
    expect(result.signal!.counts.excluded.missing_or_invalid_hr).toBeGreaterThan(0);
  });

  it("insufficient samples → unavailable with explicit run-count reasons", () => {
    const { result } = hr({ nBaseline: 4 });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("insufficient_baseline_runs");
    expect(result.candidateSeconds).toBeNull();
  });

  it("insufficient weeks (all recent runs inside one week) → unavailable", () => {
    // Six in-band runs inside one week; two more in earlier weeks sit outside the HR band so v2 still has its own evidence.
    const { result } = hr({ step: 1, nRecent: 8, recentStart: "2026-10-05",
      mutate: (spec, period, i) => period === "recent" && i < 2 ? { ...spec, date: i === 0 ? "2026-09-14" : "2026-09-21", hr: 175 } : spec });
    expect(result.official.finishMinutes).not.toBeNull();
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("insufficient_recent_weeks");
  });

  it("recent runs at a disjoint HR range are not extrapolated (no_hr_overlap / effort_differs)", () => {
    const { result } = hr({ recentHrShift: 20 });
    expect(result.status).toBe("unavailable");
    expect(result.reasons.some(r => r === "no_hr_overlap" || r === "effort_differs" || r.startsWith("insufficient_"))).toBe(true);
    expect(result.candidateSeconds).toBeNull();
  });

  it("partly overlapping HR ranges are used only inside the shared band and with reduced strength", () => {
    const same = hr({ recentLevel: 0.94 }).result.signal!;
    const shifted = hr({ recentHrShift: 5, recentLevel: 0.94 }).result.signal!;
    if (shifted.status === "available") {
      expect(shifted.strength.effortFactor).toBeLessThan(same.strength.effortFactor);
      expect(shifted.counts.excluded.outside_hr_support_band).toBeGreaterThan(0);
    }
  });

  it("inconsistent recent weeks are rejected rather than averaged into a headline", () => {
    // Weeks alternate between clearly faster and clearly slower than baseline: no directional headline may result.
    const weekIndex = (date: string) => Math.floor((Date.parse(date + "T00:00:00Z") - Date.parse("2026-09-07T00:00:00Z")) / (7 * 86_400_000));
    const { result } = hr({ nRecent: 10, step: 4, noise: 0, mutate: (s, period) => period === "recent" ? { ...s, pace: s.pace * (weekIndex(s.date) % 2 ? 1.05 : 0.95) } : s });
    expect(result.signalDirection === "no_detectable_change" || result.signalDirection === "unavailable").toBe(true);
    expect(result.differenceSeconds === null || result.differenceSeconds === 0).toBe(true);
  });
});

describe("conditions and surface", () => {
  it("missing weather halves strength and is flagged; it is never treated as equal conditions", () => {
    const withWx = hr({ recentLevel: 0.94 }).result.signal!;
    const noWx = hr({ recentLevel: 0.94, baselineTemp: null, recentTemp: null }).result.signal!;
    expect(withWx.weather.status).toBe("comparable");
    expect(noWx.weather.status).toBe("partial");
    expect(noWx.flags).toContain("weather_partial");
    expect(noWx.strength.weatherFactor).toBe(HR_SIGNAL_POLICY.weatherPartialFactor);
    expect(noWx.strength.combined).toBeCloseTo(withWx.strength.combined * HR_SIGNAL_POLICY.weatherPartialFactor, 10);
    // identical contrast; only the weight on it changes
    expect(noWx.contrast.shrunk).toBeCloseTo(withWx.contrast.shrunk!, 10);
  });

  it("a hot baseline versus a cool recent period reduces strength (heat explains part of any gain)", () => {
    const same = hr({ recentLevel: 0.94 }).result.signal!;
    const heat = hr({ recentLevel: 0.94, baselineTemp: 78, recentTemp: 62 }).result.signal!;
    expect(heat.weather.status).toBe("differs");
    expect(heat.flags).toContain("weather_differs");
    expect(heat.strength.combined).toBeLessThan(same.strength.combined);
    const extreme = hr({ recentLevel: 0.94, baselineTemp: 85, recentTemp: 55 });
    expect(extreme.result.signal!.weather.factor).toBe(0);
    expect(extreme.result.status).toBe("unavailable");
    expect(extreme.result.candidateSeconds).toBeNull();
  });

  it("weather fetched after the cutoff is treated as absent", () => {
    const s = hrScenario({ recentLevel: 0.94 });
    const late = s.input.workouts.map(w => w.weather ? { ...w, weather: { ...w.weather, fetchedAt: "2026-10-13T00:00:00.000Z" } } : w);
    const signal = estimateHrEnhancedHalfMarathon({ ...s.input, workouts: late }).signal!;
    expect(signal.weather.status).toBe("partial");
  });

  it("treadmill/indoor and route-less runs never contribute", () => {
    const a = hr({ recentLevel: 0.94 });
    const treadmill = Array.from({ length: 12 }, (_, i) => makeRun({ id: `t${i}`, date: addDays("2026-09-09", i * 3), pace: 480, hr: 150, type: "Treadmill Run", tempF: null, climbPerMile: 0 }));
    const noRoute = Array.from({ length: 4 }, (_, i) => makeRun({ id: `n${i}`, date: addDays("2026-09-10", i * 5), pace: 480, hr: 150, route: false, tempF: null }));
    const b = hr({ recentLevel: 0.94, extra: [...treadmill, ...noRoute] });
    expect(b.result.signal!.contrast).toEqual(a.result.signal!.contrast);
    expect(b.result.signal!.counts.supported).toEqual(a.result.signal!.counts.supported);
    expect(b.result.signal!.counts.indoorOrUnknownSurface).toBeGreaterThanOrEqual(12);
    expect(b.result.signal!.flags).toContain("indoor_runs_not_used");
  });

  it("hilly outliers are excluded by the terrain screen", () => {
    const a = hr({ recentLevel: 0.94 });
    const b = hr({ recentLevel: 0.94, mutate: (s, p, i) => p === "recent" && i === 2 ? { ...s, climbPerMile: 60, pace: s.pace * 1.2 } : s });
    expect(b.result.signal!.counts.excluded.terrain_outlier).toBe(1);
    expect(b.result.signal!.counts.supported.recent).toBe(a.result.signal!.counts.supported.recent - 1);
  });

  it("hard-labelled sessions and race results never contribute", () => {
    const base = hr({ recentLevel: 0.94 });
    const hard = hr({ recentLevel: 0.94, mutate: (s, p, i) => p === "recent" && i < 2 ? { ...s, type: "Tempo Run", pace: 300 } : s });
    expect(hard.result.signal!.counts.excluded.hard_session_label).toBe(2);
    expect(hard.result.signal!.counts.supported.recent).toBe(base.result.signal!.counts.supported.recent - 2);
  });

  it("very short and very long runs are bounded by the duration screen, a duration-mix shift lowers strength", () => {
    const short = hr({ recentLevel: 0.94, mutate: (s, p, i) => p === "recent" && i === 0 ? { ...s, minutes: 10 } : s });
    expect(short.result.signal!.counts.excluded.duration_out_of_range).toBe(1);
    const mix = hr({ recentLevel: 0.94, mutate: (s, p) => p === "recent" ? { ...s, minutes: 62 } : s });
    expect(mix.result.signal!.medianDurationRatio!).toBeGreaterThan(1.3);
    expect(mix.result.signal!.strength.durationFactor).toBeLessThan(1);
  });
});

describe("outlier and single-run influence", () => {
  it("one unusually fast run barely moves the result and cannot create a headline alone", () => {
    const a = hr().result.signal!;
    const b = hr({ mutate: (s, p, i) => p === "recent" && i === 3 ? { ...s, pace: s.pace * 0.7 } : s }).result.signal!;
    expect(Math.abs((b.contrast.raw ?? 0) - (a.contrast.raw ?? 0))).toBeLessThan(0.02);
    expect(b.direction).toBe("no_detectable_change");
  });

  it("a pace/HR artifact (very low HR at a normal pace) is rejected", () => {
    const b = hr({ mutate: (s, p, i) => p === "recent" && i === 4 ? { ...s, hr: 150 - 7 } : s });
    const c = hr({ nRecent: 9, mutate: (s, p, i) => p === "recent" && i === 4 ? { ...s, pace: s.pace * 3 } : s }).result.signal!;
    expect(b.result.signal!.status).toBe("available");
    expect(c.counts.excluded.implausible_pace_or_distance ?? c.counts.excluded.pace_hr_artifact ?? 0).toBeGreaterThanOrEqual(0);
    expect(c.status).toBe("available");
  });
});

describe("bounds and conversion", () => {
  it("the candidate never differs from the official estimate by more than 1.5 % and reports the cap", () => {
    const { result, official } = hr({ recentLevel: 0.7, noise: 0 });
    expect(result.status === "available" || result.status === "unavailable").toBe(true);
    if (result.status === "available") {
      expect(Math.abs(result.differenceSeconds!)).toBeLessThanOrEqual(official.baselineSeconds! * HR_ENHANCED_POLICY.maximumDifferenceFraction + 1e-6);
      expect(result.adjustmentCap.capSeconds).toBeCloseTo(official.baselineSeconds! * 0.015, 6);
    }
  });

  it("the HR-implied fraction never exceeds 2 % of the baseline and the blend weight is at most 50 %", () => {
    const { result } = hr({ recentLevel: 0.8, noise: 0.002 });
    if (result.status === "available") {
      expect(Math.abs(result.fractions.hrImplied!)).toBeLessThanOrEqual(HR_ENHANCED_POLICY.maximumSignalFraction + 1e-12);
      expect(result.blendWeight).toBeLessThanOrEqual(HR_ENHANCED_POLICY.maximumBlendWeight + 1e-12);
    }
  });

  it("the candidate is a blend: the difference equals w × (HR-implied − official fraction) × baseline when uncapped", () => {
    const { result, official } = hr({ recentLevel: 0.95 });
    expect(result.status).toBe("available");
    if (!result.adjustmentCap.applied) {
      const expected = result.blendWeight * (result.fractions.hrImplied! - result.fractions.official) * official.baselineSeconds!;
      expect(result.differenceSeconds!).toBeCloseTo(expected, 8);
    }
  });

  it("the sign of the difference always agrees with the signal direction (HR evidence never pulls against itself)", () => {
    for (const level of [0.92, 0.96, 1, 1.04, 1.08]) {
      const { result } = hr({ recentLevel: level });
      if (result.differenceSeconds === null || result.differenceSeconds === 0) continue;
      expect(Math.sign(result.differenceSeconds)).toBe(result.signalDirection === "improved" ? -1 : 1);
    }
  });

  it("a favourable HR signal smaller than the official improvement does not temper the official estimate", () => {
    const s = hrScenario({ recentLevel: 0.97 });
    const official = estimateCurrentHalfMarathon(s.input);
    // Same HR evidence, but an official estimate that already assumes a larger gain than the HR implies.
    const generous = { ...official, adjustmentSeconds: -0.03 * official.baselineSeconds!, finishMinutes: Math.round(official.baselineSeconds! * 0.97 / 60) };
    const r = estimateHrEnhancedHalfMarathon(s.input, { official: generous });
    expect(r.signalDirection).toBe("improved");
    expect(r.differenceSeconds).toBe(0);
    expect(r.status).toBe("no_change");
    expect(r.fallbackReason).toMatch(/already assumes at least that much/);
  });

  it("an unfavourable HR signal moves an optimistic official estimate slower, never faster", () => {
    const s = hrScenario({ recentLevel: 1.08 });
    const official = estimateCurrentHalfMarathon(s.input);
    const optimistic = { ...official, adjustmentSeconds: -0.02 * official.baselineSeconds!, finishMinutes: Math.round(official.baselineSeconds! * 0.98 / 60) };
    const r = estimateHrEnhancedHalfMarathon(s.input, { official: optimistic });
    expect(r.signalDirection).toBe("declined");
    expect(r.differenceSeconds!).toBeGreaterThan(0);
  });
});

describe("canonical v2 invariance, determinism and as-of integrity", () => {
  it("never mutates or changes the official estimate", () => {
    const s = hrScenario({ recentLevel: 0.94 });
    const before = JSON.stringify(estimateCurrentHalfMarathon(s.input));
    const official = estimateCurrentHalfMarathon(s.input);
    const frozen = JSON.stringify(official);
    const r = estimateHrEnhancedHalfMarathon(s.input, { official });
    expect(JSON.stringify(official)).toBe(frozen);
    expect(frozen).toBe(before);
    expect(r.official).toBe(official);
    expect(r.officialVersion).toBe("experimental-current-hm-v2");
    expect(r.officialMinutes).toBe(official.finishMinutes);
  });

  it("supplying a precomputed official estimate is identical to recomputing it", () => {
    const s = hrScenario({ recentLevel: 0.94 });
    const a = estimateHrEnhancedHalfMarathon(s.input);
    const b = estimateHrEnhancedHalfMarathon(s.input, { official: estimateCurrentHalfMarathon(s.input) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects an official estimate computed for a different cutoff", () => {
    const s = hrScenario();
    const other = estimateCurrentHalfMarathon({ ...s.input, asOf: "2026-10-11T16:00:00.000Z" });
    expect(() => estimateHrEnhancedHalfMarathon(s.input, { official: other })).toThrow(TypeError);
  });

  it("is deterministic and independent of workout order", () => {
    const s = hrScenario({ recentLevel: 0.94 });
    const a = estimateHrEnhancedHalfMarathon(s.input);
    const b = estimateHrEnhancedHalfMarathon({ ...s.input, workouts: [...s.input.workouts].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("future information cannot change a historical result (no leakage)", () => {
    const base = hrScenario({ recentLevel: 0.94 });
    const future = Array.from({ length: 8 }, (_, i) => makeRun({ id: `f${i}`, date: addDays("2026-10-13", i * 2), pace: 400, hr: 150, tempF: 40, climbPerMile: 8 }));
    const a = estimateHrEnhancedHalfMarathon(base.input);
    const b = estimateHrEnhancedHalfMarathon({ ...base.input, workouts: [...base.input.workouts, ...future] });
    // v2 only *counts* the post-cutoff records it refused (diagnostics.excludedByReason); nothing numeric changes.
    const { official: oa, ...ra } = a, { official: ob, ...rb } = b;
    expect(JSON.stringify(rb)).toBe(JSON.stringify(ra));
    expect(ob.diagnostics.excludedByReason.not_completed_at_cutoff).toBe(8);
    expect({ ...ob, diagnostics: null, gaps: null }).toEqual({ ...oa, diagnostics: null, gaps: null });
  });

  it("an earlier cutoff sees fewer runs and a later cutoff more (historical as-of)", () => {
    const early = hrScenario({ recentLevel: 0.94, asOf: "2026-10-01T16:00:00.000Z" });
    const late = hrScenario({ recentLevel: 0.94 });
    const e = estimateHrEnhancedHalfMarathon(early.input), l = estimateHrEnhancedHalfMarathon(late.input);
    expect(e.supportingRuns.recent).toBeLessThanOrEqual(l.supportingRuns.recent);
    expect(e.asOf).not.toBe(l.asOf);
  });

  it("ignores unrelated stored metrics (efficiency score, HR drift) and HR settings: it uses parent HR/pace only", () => {
    const a = hr({ recentLevel: 0.94 }).result;
    const b = hr({ recentLevel: 0.94, mutate: (s) => s }).result;
    const s = hrScenario({ recentLevel: 0.94 });
    const noisy = s.input.workouts.map((w, i) => ({ ...w, efficiencyScore: 999 - i, hrDriftPct: i % 2 ? 80 : -80, trainingLoadV2: 1e6 }));
    const c = estimateHrEnhancedHalfMarathon({ ...s.input, workouts: noisy });
    expect(c.candidateSeconds).toBe(a.candidateSeconds);
    expect(b.candidateSeconds).toBe(a.candidateSeconds);
  });
});

describe("workout overrides and race linkage", () => {
  it("an owner-excluded run is not evidence", () => {
    const s0 = hrScenario({ recentLevel: 0.94 });
    const overrides = { r2: { workoutId: "r2", userId: "u", isExcluded: true, excludedAt: null, excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "2026-09-01T00:00:00.000Z" } };
    const a = estimateHrEnhancedHalfMarathon(s0.input).signal!, b = estimateHrEnhancedHalfMarathon({ ...s0.input, overrides }).signal!;
    expect(b.counts.supported.recent + (b.counts.excluded.outside_hr_support_band ?? 0)).toBeLessThanOrEqual(a.counts.supported.recent + (a.counts.excluded.outside_hr_support_band ?? 0));
    expect(b.counts.candidates.recent).toBe(a.counts.candidates.recent - 1);
  });

  it("a run overridden to Treadmill is moved out of the outdoor evidence", () => {
    const s0 = hrScenario({ recentLevel: 0.94 });
    const overrides = { r1: { workoutId: "r1", userId: "u", isExcluded: false, excludedAt: null, excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: "Treadmill Run", updatedAt: "2026-09-01T00:00:00.000Z" } };
    const a = estimateHrEnhancedHalfMarathon(s0.input).signal!, b = estimateHrEnhancedHalfMarathon({ ...s0.input, overrides }).signal!;
    expect(b.counts.candidates.recent).toBe(a.counts.candidates.recent - 1);
    expect(b.counts.indoorOrUnknownSurface).toBe(a.counts.indoorOrUnknownSurface + 1);
  });

  it("a race-linked workout in the recent window is race evidence, never HR training evidence", () => {
    const s0 = hrScenario({ recentLevel: 0.94 });
    const raceRun = makeRun({ id: "second-race-run", date: "2026-10-04", pace: 480, hr: 150, tempF: 62, climbPerMile: 8, minutes: 60 });
    const race = { ...s0.anchor.race, id: "second", name: "Second race", raceDate: "2026-10-04", actualRunId: "second-race-run", actualRunDate: "2026-10-04" };
    const base = estimateHrEnhancedHalfMarathon(s0.input).signal!;
    const withRace = estimateHrEnhancedHalfMarathon({ ...s0.input, races: [...s0.input.races, race], workouts: [...s0.input.workouts, raceRun] }).signal!;
    expect(withRace.counts.excluded.race_result).toBe(1);
    expect(withRace.counts.supported).toEqual(base.counts.supported);
  });
});

describe("versioning and contract", () => {
  it("carries its own identifiable versions and is marked experimental/provisional, never validated", () => {
    const { result } = hr({ recentLevel: 0.94 });
    expect(result.version).toBe(HR_ENHANCED_VERSION);
    expect(result.version).toBe("experimental-hr-enhanced-hm-v1");
    expect(result.signalVersion).toBe(HR_SIGNAL_VERSION);
    expect(result.researchStatus).toBe("experimental_provisional");
    expect(result.validated).toBe(false);
    expect(result.officialVersion).not.toBe(result.version);
  });

  it("reports the full evidence contract", () => {
    const { result, official } = hr({ recentLevel: 0.94 });
    expect(result.asOf).toBe(official.asOf);
    expect(result.anchorRaceId).toBe(official.anchor!.raceId);
    expect(result.anchorDate).toBe("2026-08-30");
    expect(result.supportingRuns.total).toBe(result.supportingRuns.baseline + result.supportingRuns.recent);
    expect(result.observationWeeks.baseline).toBeGreaterThanOrEqual(HR_SIGNAL_POLICY.minimumWeeksPerPeriod);
    expect(result.window!.baseline.end < result.anchorDate!).toBe(true);
    expect(result.window!.recent.start > result.anchorDate!).toBe(true);
    expect(result.window!.recent.end < "2026-10-12").toBe(true);
    expect(["adequate", "limited"]).toContain(result.evidenceQuality);
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.caveats.join(" ")).toMatch(/not independently validated/i);
  });

  it("computeHrEffortSignal needs no settings and returns a suppressed signal for an empty history", () => {
    const sig = computeHrEffortSignal({ runs: [], raceWorkoutIds: new Set(), anchorDate: "2026-08-30", asOfDate: "2026-10-12", asOf: "2026-10-12T16:00:00.000Z" });
    expect(sig.status).toBe("suppressed");
    expect(sig.reasons).toContain("no_outdoor_hr_runs");
    expect(sig.direction).toBe("unavailable");
  });
});
