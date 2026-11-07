/**
 * Phase 3R.2/3R.3 — multiweek aerobic-efficiency trend (aerobic-trend-v1).
 *
 * Question: has this athlete's pace at a given heart rate, run length, terrain and (when estimable)
 * temperature changed steadily over the last ~16 weeks? One robust regression, not a two-window contrast:
 *
 *   ln(pace) = a + b·(HR − HR₀) + c·ln(duration/45 min) + d·climb + e·temp + g·t
 *
 * with t in 28-day units. g is the fractional pace change per 28 days (negative = faster). Fitting HR,
 * duration, climb and temperature together separates a genuine trend from a run mix that merely drifted hotter,
 * hillier, longer or harder. Estimation is Huber-IRLS (a single odd workout cannot dominate); artifacts beyond
 * four robust SDs are removed; the slope must clear a t-statistic and survive dropping any calendar week.
 *
 * Complements, never duplicates, `hr-effort-signal-v1` (a two-window contrast used by the HR-enhanced estimate);
 * the hybrid model treats both as ONE physiological family and does not add them.
 *
 * Never invents weather: temperature enters only when ≥60 % of runs have it; otherwise the covariate is dropped,
 * the standard error is inflated ×1.5 and `weather_unadjusted` is flagged. Treadmill/indoor and route-less runs,
 * hard-labelled sessions, races, and runs outside 20–120 min are excluded and counted. Training fatigue,
 * sleep, caffeine, shoes and sensor error are NOT measurable here and are listed as unsupported interpretations.
 * Apple Health VO₂ max is only corroboration (device estimate, not a laboratory value, never converted to time).
 *
 * All thresholds are engineering safeguards, not published constants.
 */
import type { AerobicTrendEvidence, HrStreamSummary } from "@/types/hybridPerformance";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { isPerformanceInstant, shiftPerformanceDate } from "@/utils/performanceEvidence";
import type { Vo2Entry } from "@/utils/vo2History";
import { VO2_DISCONTINUITY_ML, VO2_PLAUSIBLE_RANGE } from "@/utils/vo2Trend";

export const AEROBIC_TREND_POLICY = Object.freeze({
  version: "aerobic-trend-v1" as const,
  windowDays: 112,
  minimumRuns: 20, minimumWeeks: 6,
  minimumDurationSeconds: 20 * 60, maximumDurationSeconds: 120 * 60,
  minimumPaceSecondsPerMile: 180, maximumPaceSecondsPerMile: 1800, maximumDistanceMiles: 26.3,
  validHrMin: 40, validHrMax: 220,
  minimumWeatherCoverage: 0.6, minimumElevationCoverage: 0.8,
  huberK: 1.345, maximumIterations: 25, scaleFloor: 0.02, artifactScales: 4,
  tThreshold: 2, maximumAbsSlopePer28d: 0.08, noWeatherSeInflation: 1.5, seCorrection: 1.1,
  stableRangeFloor: 0.01,
  streamUseShare: 0.6,
  vo2WindowDays: 28, vo2MinimumReadings: 3, vo2DirectionMl: 1,
  /** Calibrated policy: streamed runs needed before a (trimmed − parent) offset is applied to unstreamed runs. */
  calibrationMinimumStreams: 5,
});

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const median = (v: readonly number[]) => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monday = (date: string) => shiftPerformanceDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const hardLabel = (s: string) => /tempo|interval|race|fartlek|hill repeat/i.test(s);
const indoorLabel = (s: string) => /treadmill|indoor/i.test(s);

/** Weighted least squares: returns coefficients and the inverse of X'WX. */
function wls(X: number[][], y: number[], w: number[]): { beta: number[]; inv: number[][] } | null {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0)), b = new Array<number>(p).fill(0);
  X.forEach((row, i) => { for (let j = 0; j < p; j++) { b[j] += w[i] * row[j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += w[i] * row[j] * row[k]; } });
  const M = A.map((r, i) => [...r, ...Array.from({ length: p }, (_, k) => (k === i ? 1 : 0))]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * p; k++) M[c][k] /= d;
    for (let r = 0; r < p; r++) if (r !== c) { const f = M[r][c]; if (f !== 0) for (let k = 0; k < 2 * p; k++) M[r][k] -= f * M[c][k]; }
  }
  const inv = M.map(r => r.slice(p));
  return { beta: inv.map(row => row.reduce((s, v, j) => s + v * b[j], 0)), inv };
}

interface Fit { beta: number[]; se: number; scale: number; residuals: number[] }
/** Huber IRLS. The LAST column is the time trend. */
function huberFit(X: number[][], y: number[]): Fit | null {
  const P = AEROBIC_TREND_POLICY;
  let w = new Array<number>(y.length).fill(1), last: { beta: number[]; inv: number[][] } | null = null, scale: number = P.scaleFloor;
  let prev: number[] | null = null, residuals: number[] = [];
  for (let it = 0; it < P.maximumIterations; it++) {
    const f = wls(X, y, w);
    if (!f) return null;
    last = f;
    residuals = y.map((yi, i) => yi - X[i].reduce((s, v, j) => s + v * f.beta[j], 0));
    scale = Math.max(P.scaleFloor, 1.4826 * median(residuals.map(Math.abs)));
    w = residuals.map(r => { const z = Math.abs(r / scale); return z <= P.huberK ? 1 : P.huberK / z; });
    if (prev && f.beta.every((v, j) => Math.abs(v - prev![j]) < 1e-9)) break;
    prev = f.beta;
  }
  if (!last) return null;
  const g = last.inv.length - 1;
  return { beta: last.beta, se: scale * Math.sqrt(Math.max(0, last.inv[g][g])) * P.seCorrection, scale, residuals };
}

interface Row { id: string; date: string; week: string; lnPace: number; hr: number; lnDur: number; climb: number | null; temp: number | null; t: number; streamed?: boolean; parentHr?: number }

const unavailableTrend = (reasons: string[], extra: Partial<AerobicTrendEvidence> = {}): AerobicTrendEvidence => ({
  version: AEROBIC_TREND_POLICY.version, status: "unavailable", reasons, flags: [], window: null, runs: 0, weeks: 0, treadmillOrUnknownSurface: 0,
  slopePer28d: null, standardError: null, tStatistic: null, leaveOneWeekOutRange: null, weatherAdjustment: "not_used",
  covariates: { hrSlopePerBpm: null, tempPerF: null, climbPerMeterPerMile: null }, hrSource: "parent_average", classification: "unavailable",
  vo2: { direction: "unavailable", recentMedian: null, priorMedian: null, readings: 0, discontinuity: false }, vo2Corroboration: "unavailable",
  interpretation: { observed: [], plausible: [], notSupported: NOT_SUPPORTED }, ...extra });

const NOT_SUPPORTED = [
  "A race-time change of any size: a pace-at-heart-rate trend is not a measurement of maximal running capacity.",
  "Causation: training fatigue, sleep, caffeine, hydration, shoes and sensor error are not measured and can each move pace at a given heart rate.",
  "Apple Health VO₂ max is a device estimate, not a laboratory measurement, and has no validated conversion to race time.",
];

export function assessVo2(entries: readonly Vo2Entry[] | undefined, asOfDate: string) {
  const P = AEROBIC_TREND_POLICY;
  const none = { direction: "unavailable" as const, recentMedian: null, priorMedian: null, readings: 0, discontinuity: false };
  if (!entries?.length) return none;
  const good = entries.filter(e => finite(e.value) && e.value >= VO2_PLAUSIBLE_RANGE.min && e.value <= VO2_PLAUSIBLE_RANGE.max && e.date <= asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const recent = good.filter(e => dayDiff(e.date, asOfDate) < P.vo2WindowDays);
  const prior = good.filter(e => { const d = dayDiff(e.date, asOfDate); return d >= P.vo2WindowDays && d < 2 * P.vo2WindowDays; });
  const discontinuity = good.slice(1).some((e, i) => dayDiff(good[i].date, asOfDate) < 2 * P.vo2WindowDays && Math.abs(e.value - good[i].value) >= VO2_DISCONTINUITY_ML);
  if (recent.length < P.vo2MinimumReadings || prior.length < P.vo2MinimumReadings)
    return { direction: "unavailable" as const, recentMedian: recent.length ? median(recent.map(e => e.value)) : null, priorMedian: prior.length ? median(prior.map(e => e.value)) : null,
      readings: recent.length + prior.length, discontinuity };
  const rm = median(recent.map(e => e.value)), pm = median(prior.map(e => e.value)), delta = rm - pm;
  const direction = discontinuity ? "inconclusive" as const : delta >= P.vo2DirectionMl ? "improving" as const : delta <= -P.vo2DirectionMl ? "declining" as const : "inconclusive" as const;
  return { direction, recentMedian: rm, priorMedian: pm, readings: recent.length + prior.length, discontinuity };
}

export interface AerobicTrendInput {
  /** Completed runs after the v2 selector (overrides, exclusions, duplicates, as-of availability). */
  runs: readonly ResearchRun[];
  raceWorkoutIds: ReadonlySet<string>;
  asOf: string;
  asOfDate: string;
  /** Optional warm-up-trimmed HR summaries keyed by workout id (offline/bounded hydration only). */
  streamSummaries?: Readonly<Record<string, HrStreamSummary>>;
  vo2Entries?: readonly Vo2Entry[];
  /**
   * "v1" (default, unchanged): a usable stream's trimmed HR replaces the parent average where one exists, the rest keep the parent average.
   * "calibrated" (hybrid v1.1): additionally (a) runs whose stream shows an interval-like structure are excluded from this STEADY-state
   * regression, and (b) runs without a stream are shifted by the median (trimmed − parent) offset measured on the streamed runs, so that
   * hydrating only a subset of runs cannot create or hide a trend (trimmed HR is systematically higher than whole-workout HR).
   */
  streamPolicy?: "v1" | "calibrated";
}

function fitRows(rows: Row[], useClimb: boolean, useTemp: boolean): Fit | null {
  const hr0 = median(rows.map(r => r.hr));
  const X = rows.map(r => [1, r.hr - hr0, r.lnDur, ...(useClimb ? [r.climb!] : []), ...(useTemp ? [r.temp!] : []), r.t]);
  return huberFit(X, rows.map(r => r.lnPace));
}

export function computeAerobicTrend(input: AerobicTrendInput): AerobicTrendEvidence {
  const P = AEROBIC_TREND_POLICY;
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid aerobic-trend cutoff is required");
  const end = shiftPerformanceDate(input.asOfDate, -1), start = shiftPerformanceDate(end, -(P.windowDays - 1));
  const vo2 = assessVo2(input.vo2Entries, input.asOfDate);
  const asOfMs = Date.parse(input.asOf);
  const calibrated = input.streamPolicy === "calibrated";
  let treadmillOrUnknown = 0, streamUsed = 0, withHr = 0, intervalExcluded = 0;
  const base: Row[] = [];
  for (const r of input.runs) {
    const w = r.workout;
    if (r.date < start || r.date > end || input.raceWorkoutIds.has(w.workoutId) || hardLabel(w.displayType ?? "")) continue;
    if (!w.hasRoute || indoorLabel(w.displayType ?? "")) { treadmillOrUnknown++; continue; }
    if (w.durationSeconds < P.minimumDurationSeconds || w.durationSeconds > P.maximumDurationSeconds
      || r.paceSecondsPerMile < P.minimumPaceSecondsPerMile || r.paceSecondsPerMile > P.maximumPaceSecondsPerMile || w.distanceMiles > P.maximumDistanceMiles) continue;
    const stream = input.streamSummaries?.[w.workoutId];
    if (calibrated && stream && stream.quality !== "unusable" && stream.intervalLike) { intervalExcluded++; continue; }
    const streamHr = stream && stream.quality !== "unusable" && stream.trimmedAvgHr !== null ? stream.trimmedAvgHr : null;
    const hr = streamHr ?? w.avgHeartRate;
    if (!finite(hr) || hr < P.validHrMin || hr > P.validHrMax) continue;
    withHr++; if (streamHr !== null) streamUsed++;
    const wx = w.weather, wxOk = wx && isPerformanceInstant(wx.fetchedAt) && Date.parse(wx.fetchedAt) <= asOfMs && finite(wx.tempF);
    base.push({ id: w.workoutId, date: r.date, week: monday(r.date), lnPace: Math.log(r.paceSecondsPerMile), hr, lnDur: Math.log(w.durationSeconds / 2700),
      climb: finite(w.elevationGainM) && w.distanceMiles > 0 ? w.elevationGainM / w.distanceMiles : null, temp: wxOk ? wx.tempF : null, t: dayDiff(end, r.date) / 28,
      streamed: streamHr !== null, parentHr: finite(w.avgHeartRate) ? w.avgHeartRate : undefined });
  }
  let streamsExtra: Partial<AerobicTrendEvidence> = {};
  if (calibrated) {
    const deltas = base.filter(r => r.streamed && r.parentHr !== undefined).map(r => r.hr - r.parentHr!);
    const offset = deltas.length >= P.calibrationMinimumStreams ? median(deltas) : null;
    if (offset !== null) for (const r of base) if (!r.streamed) r.hr += offset;
    streamsExtra = { streams: { used: streamUsed, eligible: withHr + intervalExcluded, excludedIntervalLike: intervalExcluded, calibrationOffsetBpm: offset } };
  }
  base.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)); // order-independent float accumulation
  const flags: string[] = [];
  if (treadmillOrUnknown) flags.push("indoor_or_unknown_surface_not_used");
  const hrSource: AerobicTrendEvidence["hrSource"] = streamUsed === 0 ? "parent_average" : streamUsed >= withHr ? "stream_trimmed" : "stream_trimmed_mixed";
  if (hrSource !== "parent_average" && streamUsed / Math.max(1, withHr) < P.streamUseShare) flags.push("stream_hr_partial");
  const window = { start, end };
  const window0 = { window, treadmillOrUnknownSurface: treadmillOrUnknown, hrSource, vo2, flags, ...streamsExtra };
  if (base.length < P.minimumRuns) return unavailableTrend([`Only ${base.length} eligible steady outdoor runs with heart rate in the last ${P.windowDays} days; at least ${P.minimumRuns} are needed.`], { ...window0, runs: base.length, weeks: new Set(base.map(r => r.week)).size });

  // Covariate availability: never assume weather or terrain that was not observed.
  const climbCoverage = base.filter(r => r.climb !== null).length / base.length;
  let rows = base, useClimb = false, useTemp = false;
  if (climbCoverage >= P.minimumElevationCoverage) { useClimb = true; rows = rows.filter(r => r.climb !== null); } else flags.push("terrain_unadjusted");
  const wxRows = rows.filter(r => r.temp !== null);
  if (wxRows.length / rows.length >= P.minimumWeatherCoverage && wxRows.length >= P.minimumRuns) { useTemp = true; rows = wxRows; } else flags.push("weather_unadjusted");
  const weeksOf = (rs: Row[]) => new Set(rs.map(r => r.week)).size;
  const variance = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length; };
  // A covariate that does not vary cannot be estimated (and constant terrain/temperature cannot confound a trend).
  let tempObservedConstant = false;
  if (useClimb && variance(rows.map(r => r.climb!)) < 1e-6) useClimb = false;
  if (useTemp && variance(rows.map(r => r.temp!)) < 1e-6) { useTemp = false; tempObservedConstant = true; }
  if (rows.length < P.minimumRuns || weeksOf(rows) < P.minimumWeeks)
    return unavailableTrend([`Eligible runs span ${weeksOf(rows)} weeks (${rows.length} runs); at least ${P.minimumWeeks} weeks and ${P.minimumRuns} runs are needed.`], { ...window0, runs: rows.length, weeks: weeksOf(rows) });

  let fit = fitRows(rows, useClimb, useTemp);
  if (!fit) return unavailableTrend(["The regression is degenerate (heart rate, duration or time does not vary enough)."], { ...window0, runs: rows.length, weeks: weeksOf(rows) });
  const tempIndex = useTemp ? 3 + (useClimb ? 1 : 0) : -1;
  if (useTemp && fit.beta[tempIndex] < 0) { // hotter-is-faster is not physiological: do not let it absorb the trend
    flags.push("temperature_coefficient_nonphysiological"); useTemp = false;
    rows = base.filter(r => !useClimb || r.climb !== null); flags.push("weather_unadjusted"); fit = fitRows(rows, useClimb, false) ?? fit;
  }
  // Artifact removal (sensor/GPS errors): > 4 robust SDs, then refit.
  const keep = rows.filter((_, i) => Math.abs(fit!.residuals[i]) <= P.artifactScales * fit!.scale);
  if (keep.length < rows.length && keep.length >= P.minimumRuns) { flags.push("artifacts_rejected"); rows = keep; fit = fitRows(rows, useClimb, useTemp) ?? fit; }
  const weeks = weeksOf(rows);
  if (rows.length < P.minimumRuns || weeks < P.minimumWeeks)
    return unavailableTrend(["After artifact removal too few runs or weeks remain."], { ...window0, flags, runs: rows.length, weeks });
  const weatherAdjusted = useTemp || tempObservedConstant;
  const weatherAdjustment: AerobicTrendEvidence["weatherAdjustment"] = weatherAdjusted ? "estimated" : "insufficient_coverage";
  const hrIdx = 1, g = fit.beta[fit.beta.length - 1];
  const se = fit.se * (weatherAdjusted ? 1 : P.noWeatherSeInflation);
  const iqr = (() => { const a = rows.map(r => r.hr).sort((x, y) => x - y); return a[Math.floor(0.75 * (a.length - 1))] - a[Math.floor(0.25 * (a.length - 1))]; })();
  if (iqr < 4) flags.push("narrow_hr_range");
  if (fit.beta[hrIdx] > 0) flags.push("hr_slope_nonphysiological");
  if (Math.abs(g) > P.maximumAbsSlopePer28d) {
    return unavailableTrend([`The fitted trend (${(g * 100).toFixed(1)}% per 28 days) is implausibly large and is treated as an artifact.`], { ...window0, flags: [...flags, "implausible_trend"], runs: rows.length, weeks });
  }
  // Stability: drop each calendar week in turn.
  const slopes: number[] = [];
  for (const wk of new Set(rows.map(r => r.week))) {
    const sub = rows.filter(r => r.week !== wk);
    if (sub.length >= P.minimumRuns - 3 && weeksOf(sub) >= P.minimumWeeks - 1) { const f = fitRows(sub, useClimb, useTemp); if (f) slopes.push(f.beta[f.beta.length - 1]); }
  }
  const range = slopes.length ? Math.max(...slopes, g) - Math.min(...slopes, g) : null;
  const sameSign = slopes.every(s => Math.sign(s) === Math.sign(g) || s === 0);
  const t = se > 0 ? g / se : 0;
  const stable = range !== null && sameSign && range <= Math.max(P.stableRangeFloor, Math.abs(g));
  const significant = Math.abs(t) >= P.tThreshold && stable;
  const classification: AerobicTrendEvidence["classification"] = !significant ? "no_detectable_change" : g < 0 ? "observed_improvement" : "observed_decline";
  if (Math.abs(t) >= P.tThreshold && !stable) flags.push("trend_unstable_to_single_week");
  const paceDirection = classification === "observed_improvement" ? "improving" : classification === "observed_decline" ? "declining" : null;
  const vo2Corroboration: AerobicTrendEvidence["vo2Corroboration"] = vo2.direction === "unavailable" ? "unavailable"
    : paceDirection === null || vo2.direction === "inconclusive" ? "inconclusive" : vo2.direction === paceDirection ? "agrees" : "disagrees";
  const pct = (x: number) => `${(Math.abs(x) * 100).toFixed(1)}%`;
  const observed = [`Pace at a given heart rate, run length and climb ${significant ? (g < 0 ? "became faster" : "became slower") : "shows no change beyond noise"}: ${g < 0 ? "−" : "+"}${pct(g)} per 28 days (t = ${t.toFixed(1)}) across ${rows.length} runs in ${weeks} weeks.`];
  const plausible: string[] = [];
  if (significant && g < 0) plausible.push(vo2Corroboration === "agrees"
    ? "A plausible improvement in aerobic fitness or running economy; the Apple Health VO₂ max estimate moved the same way (corroboration only)."
    : "A plausible improvement in aerobic fitness or running economy; the device VO₂ max estimate does not independently corroborate it.");
  if (significant && g > 0) plausible.push("Plausibly reduced aerobic fitness, accumulated fatigue, heat or another unmeasured confound.");
  if (vo2Corroboration === "disagrees") plausible.push("The device VO₂ max estimate moved the opposite way, so the pace trend is treated with extra caution.");
  const notSupported = [...NOT_SUPPORTED];
  if (!weatherAdjusted) notSupported.push("Heat correction: too few runs have weather, so temperature is not adjusted and could explain part of the trend.");
  if (climbCoverage < P.minimumElevationCoverage) notSupported.push("Terrain correction: elevation is missing for too many runs.");
  return { version: P.version, status: "available", reasons: [], flags: [...new Set(flags)], window, runs: rows.length, weeks, treadmillOrUnknownSurface: treadmillOrUnknown,
    slopePer28d: g, standardError: se, tStatistic: t, leaveOneWeekOutRange: range, weatherAdjustment,
    covariates: { hrSlopePerBpm: fit.beta[hrIdx], tempPerF: useTemp ? fit.beta[tempIndex] : null, climbPerMeterPerMile: useClimb ? fit.beta[3] : null },
    hrSource, classification, vo2, vo2Corroboration, interpretation: { observed, plausible, notSupported }, ...streamsExtra };
}
