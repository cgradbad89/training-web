/**
 * HR effort signal (hr-effort-signal-v1): has the athlete's pace at a comparable
 * heart rate changed since the race anchor?
 *
 * Pure, deterministic, no I/O, no wall clock. Uses only completed parent fields
 * (average HR, duration, distance, date, route/surface, climb, weather) from runs
 * already selected by the v2 selector, so overrides, exclusions, duplicates and
 * as-of availability are inherited, not re-implemented.
 *
 * Method (all thresholds are PROVISIONAL engineering safeguards, not physiology):
 *  1. Steady outdoor runs only; hard-labelled, indoor/no-route, race and implausible runs never count.
 *  2. A baseline period (the 56 days ending 8 days before the anchor race, so taper is excluded)
 *     and a recent period (the last 42 days, ending yesterday).
 *  3. Both periods are compared only inside a HEART-RATE SUPPORT BAND around the pooled median
 *     HR. Nothing outside the band, and no pace outside the observed HR range, is extrapolated.
 *  4. Each run is normalized to the reference HR with a robust within-period slope. Aggregate
 *     average-HR data attenuates that slope, so the contrast is also computed with a doubled slope
 *     and the SMALLER magnitude is kept (zero when the two disagree in sign).
 *  5. Period levels are weighted medians of weekly medians (a single run cannot dominate a week;
 *     recent runs fade out over days 28–42 so the window moves smoothly).
 *  6. The contrast is shrunk by one standard error (a soft threshold; the larger of run-level and
 *     between-week scatter, and at least two-thirds of recent weeks must agree): noisy or sparse evidence
 *     produces less, not a spuriously precise value. Differences in typical HR or run length between
 *     the periods, and thin run/week counts, reduce STRENGTH continuously (no cliff-edge guards); only
 *     extreme mismatches suppress the signal.
 *  7. Heat: if both periods have weather and differ by more than 5 °F the strength fades to zero at
 *     15 °F; if weather coverage is partial the strength is halved. Missing weather is never treated
 *     as equal conditions.
 *
 * Nothing here converts the contrast to a race-time. That transfer is explicit, bounded and applied
 * by `hrEnhancedPerformance.ts`.
 */
import type { ResearchRun } from "@/types/workoutRaceResearch";
import type {
  HrEffortSignal, HrSignalDirection, HrSignalFlag, HrSignalReason,
} from "@/types/hrEnhancedPerformance";
import { shiftPerformanceDate } from "./performanceEvidence";

export const HR_SIGNAL_VERSION = "hr-effort-signal-v1";

export const HR_SIGNAL_POLICY = Object.freeze({
  version: HR_SIGNAL_VERSION,
  baselineStartOffsetDays: 63, baselineEndOffsetDays: 8,
  recentDays: 42, recentFullWeightDays: 28,
  minimumDurationSeconds: 20 * 60, maximumDurationSeconds: 120 * 60,
  minimumPaceSecondsPerMile: 180, maximumPaceSecondsPerMile: 1800, maximumDistanceMiles: 26.3,
  validHrMin: 40, validHrMax: 220,
  supportHalfWidthBpm: 8,
  /** Median-HR difference between periods: full strength up to the first value, linearly to zero at the second (suppressed beyond). */
  fullStrengthHrDifferenceBpm: 2, zeroStrengthHrDifferenceBpm: 8,
  minimumRunsPerPeriod: 5, fullRunsPerPeriod: 10,
  minimumWeeksPerPeriod: 3, fullWeeksPerPeriod: 5,
  /** Median-duration ratio (symmetric): full strength up to the first value, zero at the second (suppressed at/after it). */
  fullStrengthDurationRatio: 1.25, zeroStrengthDurationRatio: 2,
  maximumTerrainDeviationMetersPerMile: 10,
  slopeMinimum: -0.012, slopeMaximum: 0, slopeMinimumRuns: 10, slopeMinimumIqrBpm: 4,
  slopeAttenuationFactor: 2, negligibleHrDifferenceBpm: 1.5,
  noiseFloor: 0.03, noiseMultiplier: 1,
  /** Share of recent weeks that must lie on the same side of the baseline as the contrast (3 of 5 weeks is not enough). */
  consistencyShare: 0.65,
  artifactMadMultiplier: 4,
  weatherMinimumCoverage: 0.5, weatherMinimumRuns: 3, weatherToleranceF: 5, weatherZeroF: 15, weatherPartialFactor: 0.5,
});

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const hardLabel = (label: string) => /tempo|interval|race|fartlek|hill repeat/i.test(label);
const indoorLabel = (label: string) => /treadmill|indoor/i.test(label);
const monday = (date: string) => shiftPerformanceDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/** Plain median (average of the two middle values for even counts). */
export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/** Weighted median; zero-weight values never count; ties broken by value, deterministic. */
export function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const pts = values.map((v, i) => ({ v, w: weights[i] })).filter(p => p.w > 0).sort((a, b) => a.v - b.v);
  if (!pts.length) return NaN;
  const total = pts.reduce((s, p) => s + p.w, 0);
  let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    cum += pts[i].w;
    if (cum > total / 2 + 1e-12) return pts[i].v;
    if (Math.abs(cum - total / 2) <= 1e-12) return i + 1 < pts.length ? (pts[i].v + pts[i + 1].v) / 2 : pts[i].v;
  }
  return pts[pts.length - 1].v;
}
const madSd = (values: readonly number[]) => { const m = median(values); return 1.4826 * median(values.map(v => Math.abs(v - m))); };
function quantile(values: readonly number[], q: number): number {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.floor(q * (a.length - 1))];
}
/** Robust slope of y on x over all pairs with |Δx| ≥ 1. */
function theilSen(points: readonly { x: number; y: number }[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[j].x - points[i].x;
    if (Math.abs(dx) >= 1) slopes.push((points[j].y - points[i].y) / dx);
  }
  return slopes.length ? median(slopes) : null;
}

interface Prepared {
  date: string; week: string; period: "baseline" | "recent";
  y: number; hr: number; weight: number; duration: number;
  tempF: number | null; climb: number | null;
}

export interface HrSignalInput {
  /** Completed runs after the v2 selector (overrides, exclusions, duplicates, as-of availability). */
  runs: readonly ResearchRun[];
  /** Workout IDs linked to recorded races: anchors, never training evidence. */
  raceWorkoutIds: ReadonlySet<string>;
  anchorDate: string;
  asOfDate: string;
  /** Weather fetched after this instant is treated as absent. */
  asOf: string;
}

function emptySignal(window: HrEffortSignal["window"], reasons: HrSignalReason[], flags: HrSignalFlag[],
  counts: HrEffortSignal["counts"], extra: Partial<HrEffortSignal> = {}): HrEffortSignal {
  return {
    version: HR_SIGNAL_VERSION, status: "suppressed", reasons, flags, window,
    referenceHr: null, supportBand: null, counts, medianHr: null, medianDurationRatio: null,
    slope: { estimated: null, sensitivity: [] },
    contrast: { raw: null, conservative: null, standardError: null, shrunk: null, shrunkPercent: null, rawPercent: null },
    consistency: null,
    weather: { status: "not_evaluated", coverage: null, medianTempF: null, deltaF: null, factor: 0 },
    strength: { runFactor: 0, weekFactor: 0, weatherFactor: 0, effortFactor: 0, durationFactor: 0, combined: 0 },
    direction: "unavailable", ...extra,
  };
}

export function computeHrEffortSignal(input: HrSignalInput): HrEffortSignal {
  const P = HR_SIGNAL_POLICY;
  const window = {
    baseline: { start: shiftPerformanceDate(input.anchorDate, -P.baselineStartOffsetDays), end: shiftPerformanceDate(input.anchorDate, -P.baselineEndOffsetDays) },
    recent: { start: shiftPerformanceDate(input.asOfDate, -P.recentDays), end: shiftPerformanceDate(input.asOfDate, -1) },
  };
  // The recent period never reaches back to the anchor race day or before.
  if (window.recent.start <= input.anchorDate) window.recent.start = shiftPerformanceDate(input.anchorDate, 1);
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const counts: HrEffortSignal["counts"] = {
    candidates: { baseline: 0, recent: 0 }, supported: { baseline: 0, recent: 0 }, weeks: { baseline: 0, recent: 0 },
    excluded, indoorOrUnknownSurface: 0,
  };
  const flags: HrSignalFlag[] = [];
  const cutoff = Date.parse(input.asOf);

  // 1 — eligibility
  const first: (Prepared & { id: string })[] = [];
  for (const r of input.runs) {
    const period = r.date >= window.baseline.start && r.date <= window.baseline.end ? "baseline"
      : r.date >= window.recent.start && r.date <= window.recent.end && window.recent.start <= window.recent.end ? "recent" : null;
    if (!period) continue;
    const w = r.workout, label = w.displayType ?? "";
    if (input.raceWorkoutIds.has(w.workoutId)) { exclude("race_result"); continue; }
    if (hardLabel(label)) { exclude("hard_session_label"); continue; }
    if (!(w.durationSeconds >= P.minimumDurationSeconds && w.durationSeconds <= P.maximumDurationSeconds)) { exclude("duration_out_of_range"); continue; }
    if (!(r.paceSecondsPerMile >= P.minimumPaceSecondsPerMile && r.paceSecondsPerMile <= P.maximumPaceSecondsPerMile && w.distanceMiles <= P.maximumDistanceMiles)) { exclude("implausible_pace_or_distance"); continue; }
    if (indoorLabel(label) || !w.hasRoute) { counts.indoorOrUnknownSurface++; exclude("indoor_or_no_route"); continue; }
    if (!finite(w.avgHeartRate) || w.avgHeartRate < P.validHrMin || w.avgHeartRate > P.validHrMax) { exclude("missing_or_invalid_hr"); continue; }
    counts.candidates[period]++;
    const wx = w.weather, wxOk = !!wx && finite(wx.tempF) && typeof wx.fetchedAt === "string" && Date.parse(wx.fetchedAt) <= cutoff;
    first.push({
      id: w.workoutId, date: r.date, week: monday(r.date), period, y: Math.log(r.paceSecondsPerMile), hr: w.avgHeartRate,
      weight: 1, duration: w.durationSeconds, tempF: wxOk ? wx!.tempF : null,
      climb: finite(w.elevationGainM) && w.distanceMiles > 0 ? w.elevationGainM / w.distanceMiles : null,
    });
  }
  if (counts.indoorOrUnknownSurface > 0) flags.push("indoor_runs_not_used");
  if (window.recent.start > window.recent.end) return emptySignal(window, ["no_recent_window"], flags, counts);
  if (!first.length) return emptySignal(window, ["no_outdoor_hr_runs"], flags, counts);

  // 2 — terrain and artifact screens
  const climbs = first.flatMap(p => p.climb === null ? [] : [p.climb]);
  const medianClimb = climbs.length ? median(climbs) : null;
  const terrainOk = first.filter(p => {
    if (p.climb === null || medianClimb === null) return true;
    if (Math.abs(p.climb - medianClimb) > P.maximumTerrainDeviationMetersPerMile) { exclude("terrain_outlier"); return false; }
    return true;
  });
  const centered = (pts: readonly Prepared[]) => {
    const out: { x: number; y: number }[] = [];
    for (const period of ["baseline", "recent"] as const) {
      const s = pts.filter(p => p.period === period);
      if (!s.length) continue;
      const mh = median(s.map(p => p.hr)), my = median(s.map(p => p.y));
      for (const p of s) out.push({ x: p.hr - mh, y: p.y - my });
    }
    return out;
  };
  let artifactFree = terrainOk;
  if (terrainOk.length >= 8) {
    const slope0 = theilSen(centered(terrainOk));
    const b0 = slope0 === null ? 0 : Math.min(P.slopeMaximum, Math.max(P.slopeMinimum, slope0));
    const refHr = median(terrainOk.map(p => p.hr));
    const resid = terrainOk.map(p => p.y - b0 * (p.hr - refHr));
    const m = median(resid), spread = Math.max(madSd(resid), P.noiseFloor);
    artifactFree = terrainOk.filter((_, i) => {
      if (Math.abs(resid[i] - m) > P.artifactMadMultiplier * spread) { exclude("pace_hr_artifact"); return false; }
      return true;
    });
    if (artifactFree.length < terrainOk.length) flags.push("artifacts_rejected");
  }

  // 3 — HR support band around the pooled median (no extrapolation outside observed overlap)
  if (!artifactFree.length) return emptySignal(window, ["no_outdoor_hr_runs"], flags, counts);
  const referenceHr = median(artifactFree.map(p => p.hr));
  const band = { low: referenceHr - P.supportHalfWidthBpm, high: referenceHr + P.supportHalfWidthBpm };
  const inBand = artifactFree.filter(p => {
    if (p.hr < band.low || p.hr > band.high) { exclude("outside_hr_support_band"); return false; }
    return true;
  });
  const split = (period: "baseline" | "recent") => inBand.filter(p => p.period === period);
  const base = split("baseline"), recent = split("recent");
  counts.supported = { baseline: base.length, recent: recent.length };
  counts.weeks = { baseline: new Set(base.map(p => p.week)).size, recent: new Set(recent.map(p => p.week)).size };
  const reasons: HrSignalReason[] = [];
  if (base.length < P.minimumRunsPerPeriod) reasons.push("insufficient_baseline_runs");
  if (recent.length < P.minimumRunsPerPeriod) reasons.push("insufficient_recent_runs");
  if (counts.weeks.baseline < P.minimumWeeksPerPeriod) reasons.push("insufficient_baseline_weeks");
  if (counts.weeks.recent < P.minimumWeeksPerPeriod) reasons.push("insufficient_recent_weeks");
  const common = { referenceHr, supportBand: band };
  if (reasons.length) {
    // "no_hr_overlap" explains a shortage caused by the two periods occupying different HR ranges.
    const sparse = artifactFree.filter(p => p.period === "baseline").length >= P.minimumRunsPerPeriod
      && artifactFree.filter(p => p.period === "recent").length >= P.minimumRunsPerPeriod;
    return emptySignal(window, sparse ? ["no_hr_overlap", ...reasons] : reasons, flags, counts, common);
  }

  // 4 — effort and duration comparability
  const medianHr = { baseline: median(base.map(p => p.hr)), recent: median(recent.map(p => p.hr)) };
  const deltaHr = medianHr.recent - medianHr.baseline;
  const durationRatio = median(recent.map(p => p.duration)) / median(base.map(p => p.duration));
  const symmetricRatio = Math.max(durationRatio, 1 / durationRatio);
  const effortFactor = Math.min(1, Math.max(0, 1 - (Math.abs(deltaHr) - P.fullStrengthHrDifferenceBpm) / (P.zeroStrengthHrDifferenceBpm - P.fullStrengthHrDifferenceBpm)));
  const durationFactor = Math.min(1, Math.max(0, (P.zeroStrengthDurationRatio - symmetricRatio) / (P.zeroStrengthDurationRatio - P.fullStrengthDurationRatio)));
  const mismatch: HrSignalReason[] = [];
  if (effortFactor === 0) mismatch.push("effort_differs");
  if (durationFactor === 0) mismatch.push("duration_mix_differs");
  if (mismatch.length) return emptySignal(window, mismatch, flags, counts, { ...common, medianHr, medianDurationRatio: durationRatio });

  // 5 — slope (robust, bounded) and the sensitivity set
  const hrSpread = quantile(inBand.map(p => p.hr), 0.75) - quantile(inBand.map(p => p.hr), 0.25);
  const rawSlope = inBand.length >= P.slopeMinimumRuns && hrSpread >= P.slopeMinimumIqrBpm ? theilSen(centered(inBand)) : null;
  let slope: number | null = null;
  if (rawSlope !== null) {
    slope = Math.min(P.slopeMaximum, Math.max(P.slopeMinimum, rawSlope));
    if (rawSlope > P.slopeMaximum) flags.push("slope_nonphysiological");
  }
  if (slope === null && Math.abs(deltaHr) > P.negligibleHrDifferenceBpm)
    return emptySignal(window, ["slope_not_estimable"], flags, counts, { ...common, medianHr, medianDurationRatio: durationRatio });
  const sensitivity = slope === null ? [0] : [slope, Math.max(P.slopeMinimum, slope * P.slopeAttenuationFactor)];

  // 6 — level per period: weighted median of weekly medians
  const age = (p: Prepared) => dayDiff(p.date, input.asOfDate);
  const recencyWeight = (p: Prepared) => p.period === "baseline" ? 1
    : Math.min(1, Math.max(0, (P.recentDays - age(p)) / (P.recentDays - P.recentFullWeightDays)));
  const level = (pts: readonly Prepared[], beta: number) => {
    const byWeek = new Map<string, { z: number[]; w: number[] }>();
    for (const p of pts) {
      const g = byWeek.get(p.week) ?? { z: [], w: [] };
      g.z.push(p.y - beta * (p.hr - referenceHr)); g.w.push(recencyWeight(p));
      byWeek.set(p.week, g);
    }
    const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, g]) => ({
      week, level: median(g.z), weight: Math.min(g.z.length, 3) * (g.w.reduce((s, x) => s + x, 0) / g.w.length),
    }));
    return { weeks, value: weightedMedian(weeks.map(w => w.level), weeks.map(w => w.weight)) };
  };
  const contrasts = sensitivity.map(beta => ({ beta, c: level(recent, beta).value - level(base, beta).value }));
  const primary = contrasts[0];
  const smallest = contrasts.reduce((a, b) => Math.abs(b.c) < Math.abs(a.c) ? b : a);
  const signsAgree = contrasts.every(x => Math.sign(x.c) === Math.sign(primary.c));
  const conservative = signsAgree ? smallest.c : 0;
  if (slope !== null && (!signsAgree || Math.abs(smallest.c) < Math.abs(primary.c) * 0.5)) flags.push("slope_sensitive");

  // 7 — uncertainty and shrinkage
  // Run-level scatter and between-week scatter are both honest uncertainty sources; use the larger.
  const periodSe = (pts: readonly Prepared[], beta: number) => {
    const z = pts.map(p => p.y - beta * (p.hr - referenceHr));
    const weekly = level(pts, beta).weeks.map(w => w.level);
    const runSe = Math.max(madSd(z), P.noiseFloor) / Math.sqrt(Math.max(1, Math.min(pts.length, 2 * weekly.length)));
    const weekSe = Math.max(weekly.length > 1 ? madSd(weekly) : 0, P.noiseFloor) / Math.sqrt(weekly.length);
    return Math.max(runSe, weekSe);
  };
  const beta0 = primary.beta;
  const se = Math.sqrt(periodSe(base, beta0) ** 2 + periodSe(recent, beta0) ** 2);
  const recentWeeks = level(recent, smallest.beta).weeks, baseLevel = level(base, smallest.beta).value;
  const agree = recentWeeks.filter(w => conservative !== 0 && Math.sign(w.level - baseLevel) === Math.sign(conservative)).length;
  const consistent = conservative === 0 || agree / recentWeeks.length >= P.consistencyShare;
  let shrunk = Math.sign(conservative) * Math.max(0, Math.abs(conservative) - P.noiseMultiplier * se);
  const consistencyOut = { weeksAgree: agree, weeksTotal: recentWeeks.length };
  if (!consistent && shrunk !== 0) {
    return emptySignal(window, ["inconsistent_across_weeks"], flags, counts, {
      ...common, medianHr, medianDurationRatio: durationRatio, consistency: consistencyOut,
      slope: { estimated: slope, sensitivity },
      contrast: { raw: primary.c, conservative, standardError: se, shrunk: null, shrunkPercent: null, rawPercent: (Math.exp(primary.c) - 1) * 100 },
    });
  }
  shrunk = shrunk || 0;

  // 8 — heat / weather attenuation
  const wx = (pts: readonly Prepared[]) => pts.flatMap(p => p.tempF === null ? [] : [p.tempF]);
  const cov = { baseline: wx(base).length / base.length, recent: wx(recent).length / recent.length };
  let weather: HrEffortSignal["weather"];
  if (wx(base).length >= P.weatherMinimumRuns && wx(recent).length >= P.weatherMinimumRuns
    && cov.baseline >= P.weatherMinimumCoverage && cov.recent >= P.weatherMinimumCoverage) {
    const t = { baseline: median(wx(base)), recent: median(wx(recent)) }, d = t.recent - t.baseline;
    const factor = Math.min(1, Math.max(0, 1 - (Math.abs(d) - P.weatherToleranceF) / (P.weatherZeroF - P.weatherToleranceF)));
    weather = { status: Math.abs(d) <= P.weatherToleranceF ? "comparable" : "differs", coverage: cov, medianTempF: t, deltaF: d, factor };
    if (weather.status === "differs") flags.push("weather_differs");
  } else {
    weather = { status: "partial", coverage: cov, medianTempF: null, deltaF: null, factor: P.weatherPartialFactor };
    flags.push("weather_partial");
  }

  const runFactor = Math.min(1, Math.max(0, (Math.min(base.length, recent.length) - (P.minimumRunsPerPeriod - 1)) / (P.fullRunsPerPeriod - (P.minimumRunsPerPeriod - 1))));
  const weekFactor = Math.min(1, Math.max(0, (Math.min(counts.weeks.baseline, counts.weeks.recent) - (P.minimumWeeksPerPeriod - 1)) / (P.fullWeeksPerPeriod - (P.minimumWeeksPerPeriod - 1))));
  const direction: HrSignalDirection = shrunk < 0 ? "improved" : shrunk > 0 ? "declined" : "no_detectable_change";
  return {
    version: HR_SIGNAL_VERSION, status: "available", reasons: [], flags: [...new Set(flags)], window, ...common,
    counts, medianHr, medianDurationRatio: durationRatio, slope: { estimated: slope, sensitivity },
    contrast: { raw: primary.c, conservative, standardError: se, shrunk, shrunkPercent: (Math.exp(shrunk) - 1) * 100, rawPercent: (Math.exp(primary.c) - 1) * 100 },
    consistency: consistencyOut, weather,
    strength: { runFactor, weekFactor, weatherFactor: weather.factor, effortFactor, durationFactor, combined: runFactor * weekFactor * weather.factor * effortFactor * durationFactor },
    direction,
  };
}
