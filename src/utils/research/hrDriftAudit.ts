/**
 * Phase 3L — RESEARCH-ONLY heart-rate drift audit.
 *
 * `hrDriftPct` is NOT computed in this repository: the iOS app writes it from raw
 * HealthKit samples (see src/utils/metrics.ts). The web only reads and displays
 * it. This module (a) states and tests a deterministic, time-weighted definition
 * that reproduces the iOS value on real data, (b) exposes the quality diagnostics
 * the stored value lacks, and (c) offers a warm-up-trimmed variant as a research
 * alternative. It is never imported by live code (enforced by a test) and changes
 * no displayed or persisted number.
 *
 * Definition reproduced (observed on the 2026-09-22 export, 105 runs with samples):
 *   drift% = (meanHR(second half) − meanHR(first half)) / meanHR(first half) × 100
 * halves split at the temporal midpoint of the window. Recomputed values fall
 * within 1 percentage point of the stored value for 86/105 runs (median |Δ| 0.5).
 * The residual disagreement concentrates in runs whose HR stream has multi-minute
 * holes (8–16 min gaps, 42–61 samples), where any half-split is arbitrary.
 */

export interface HrSample {
  /** Epoch seconds. */
  t: number;
  hr: number;
}

export interface HrDriftOptions {
  /** Window in epoch seconds. Default: first→last sample. */
  startSec?: number;
  endSec?: number;
  /** Seconds trimmed from the START of the window (research variant; default 0). */
  warmupSec?: number;
  /** Below this window length no drift is reported (device contract: ≥ 20 min). */
  minDurationSec?: number;
  minSamples?: number;
  /** A sample is held at most this long; longer holes are excluded, not bridged. */
  maxGapSec?: number;
  /** Minimum share of the window actually covered by held samples. */
  minCoverage?: number;
  plausibleHr?: { min: number; max: number };
}

export type HrDriftStatus =
  | "ok"
  | "no_window"
  | "insufficient_duration"
  | "insufficient_samples"
  | "gap_dominated";

export interface HrDriftResult {
  status: HrDriftStatus;
  driftPct: number | null;
  firstHalfAvg: number | null;
  secondHalfAvg: number | null;
  /** Share of the analysed window covered by held samples (0–1). */
  coverage: number;
  maxGapSec: number;
  artifactSamples: number;
  usedSamples: number;
  windowSec: number;
}

const DEFAULTS = { minDurationSec: 1200, minSamples: 60, maxGapSec: 120, minCoverage: 0.8 };
const PLAUSIBLE = { min: 40, max: 220 };

function weightedMean(samples: readonly HrSample[], lo: number, hi: number, maxGap: number): { mean: number | null; covered: number } {
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i].t;
    const next = i + 1 < samples.length ? samples[i + 1].t : start + maxGap;
    const end = Math.min(next, start + maxGap);
    const a = Math.max(start, lo);
    const b = Math.min(end, hi);
    if (b > a) {
      sum += samples[i].hr * (b - a);
      covered += b - a;
    }
  }
  return { mean: covered > 0 ? sum / covered : null, covered };
}

export function computeHrDrift(input: readonly HrSample[], options: HrDriftOptions = {}): HrDriftResult {
  const plausible = options.plausibleHr ?? PLAUSIBLE;
  const maxGapSec = options.maxGapSec ?? DEFAULTS.maxGapSec;
  const empty = (status: HrDriftStatus, extra: Partial<HrDriftResult> = {}): HrDriftResult => ({
    status, driftPct: null, firstHalfAvg: null, secondHalfAvg: null, coverage: 0, maxGapSec: 0,
    artifactSamples: 0, usedSamples: 0, windowSec: 0, ...extra,
  });

  const finite = input.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.hr));
  const clean = finite.filter((s) => s.hr >= plausible.min && s.hr <= plausible.max).sort((a, b) => a.t - b.t);
  const artifactSamples = input.length - clean.length;
  if (clean.length === 0) return empty("insufficient_samples", { artifactSamples });

  const start = (options.startSec ?? clean[0].t) + (options.warmupSec ?? 0);
  const end = options.endSec ?? clean[clean.length - 1].t;
  const windowSec = end - start;
  if (!(windowSec > 0)) return empty("no_window", { artifactSamples });

  const inWindow = clean.filter((s) => s.t >= start && s.t <= end);
  let largestGap = 0;
  for (let i = 1; i < inWindow.length; i++) largestGap = Math.max(largestGap, inWindow[i].t - inWindow[i - 1].t);
  const common = { artifactSamples, usedSamples: inWindow.length, windowSec, maxGapSec: largestGap };

  if (windowSec < (options.minDurationSec ?? DEFAULTS.minDurationSec)) return empty("insufficient_duration", common);
  if (inWindow.length < (options.minSamples ?? DEFAULTS.minSamples)) return empty("insufficient_samples", common);

  // Hold from the last sample before the window so the first interval is covered.
  const priorIdx = clean.findLastIndex((s) => s.t < start);
  const series = priorIdx >= 0 ? [clean[priorIdx], ...inWindow] : inWindow;
  const mid = start + windowSec / 2;
  const first = weightedMean(series, start, mid, maxGapSec);
  const second = weightedMean(series, mid, end, maxGapSec);
  const coverage = (first.covered + second.covered) / windowSec;
  if (first.mean === null || second.mean === null || coverage < (options.minCoverage ?? DEFAULTS.minCoverage)) {
    return empty("gap_dominated", { ...common, coverage });
  }
  return {
    status: "ok",
    driftPct: ((second.mean - first.mean) / first.mean) * 100,
    firstHalfAvg: first.mean,
    secondHalfAvg: second.mean,
    coverage,
    ...common,
  };
}

/* ------------------- parent-level screening of the stored value ------------------- */

export type StoredDriftFlag =
  | "below_device_minimum"
  | "implausible_magnitude"
  | "negative_beyond_noise"
  | "warmup_dominated";

export interface StoredDriftAssessment {
  present: boolean;
  /** False when a flag shows the value should not be read as physiological drift. */
  usable: boolean;
  flags: StoredDriftFlag[];
}

/** Engineering screens, not physiology: thresholds are labelled provisional. */
export const STORED_DRIFT_SCREEN = { implausibleAbsPct: 25, negativeNoisePct: -5, warmupDominatedBelowSec: 2400 } as const;

export function assessStoredHrDrift(parent: {
  hrDriftPct: number | null | undefined;
  durationSeconds: number;
  distanceMiles?: number | null;
}): StoredDriftAssessment {
  const drift = parent.hrDriftPct;
  if (drift == null || !Number.isFinite(drift)) return { present: false, usable: false, flags: [] };
  const flags: StoredDriftFlag[] = [];
  // Device contract (metrics.ts): needs ≥ 20 min OR ≥ 2.0 mi.
  if (parent.durationSeconds < 1200 && (parent.distanceMiles ?? 0) < 2) flags.push("below_device_minimum");
  if (Math.abs(drift) > STORED_DRIFT_SCREEN.implausibleAbsPct) flags.push("implausible_magnitude");
  if (drift < STORED_DRIFT_SCREEN.negativeNoisePct) flags.push("negative_beyond_noise");
  if (parent.durationSeconds < STORED_DRIFT_SCREEN.warmupDominatedBelowSec) flags.push("warmup_dominated");
  const hard = flags.some((f) => f === "below_device_minimum" || f === "implausible_magnitude");
  return { present: true, usable: !hard, flags };
}
