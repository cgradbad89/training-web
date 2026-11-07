/**
 * Phase 3R.1 — HR-stream quality screening and warm-up-trimmed heart rate (hr-stream-quality-v1).
 *
 * Pure functions over an already-loaded sample array. NOTHING here reads Firestore: the Plan Insights page
 * does not load HR streams (bounded reads only); an offline evaluation or a future bounded hydration may
 * pass summaries in. The stored `hrDriftPct` is deliberately NOT used: it includes the warm-up and is
 * duration-dependent (Phase 3L).
 *
 * What it does (every threshold is an engineering safeguard, not physiology):
 *  - removes invalid samples (outside 40–220 bpm, non-finite, duplicate times) and isolated spikes;
 *  - measures sampling coverage and gaps and refuses sparse streams;
 *  - detects the end of the warm-up/HR-lag period (smoothed HR reaches 92 % of the later sustained median,
 *    clamped to 2–12 min) and reports the warm-up-trimmed mean HR;
 *  - finds the longest stable post-warm-up segment and the HR slope inside it (bpm / 10 min);
 *  - flags interval-like structure (high variability / short stable share), where drift and trimmed means
 *    must not be read as steady-state evidence.
 * The post-warm-up slope is cardiac drift ONLY IF pace was constant; a stream alone cannot establish that,
 * so it is reported as an HR slope, not as a fitness measure.
 */
import type { HrSample, HrStreamSummary } from "@/types/hybridPerformance";

export const HR_STREAM_POLICY = Object.freeze({
  version: "hr-stream-quality-v1" as const,
  validMin: 40, validMax: 220,
  minimumSamples: 120,
  maximumGapSeconds: 60,
  goodCoverage: 0.85, minimumCoverage: 0.6,
  spikeBpm: 25, spikeWindow: 5,
  binSeconds: 10, smoothingBins: 6,
  warmupFraction: 0.92, warmupMinSeconds: 120, warmupMaxSeconds: 720,
  stableToleranceBpm: 6, minimumStableSeconds: 600,
  intervalCoefficient: 0.09, intervalStableShare: 0.6,
  minimumPostWarmupSeconds: 300,
});

const median = (v: readonly number[]) => { const a = [...v].sort((x, y) => x - y), m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
const mean = (v: readonly number[]) => v.reduce((s, x) => s + x, 0) / v.length;

function slopePer10Min(bins: { t: number; v: number }[]): number | null {
  if (bins.length < 3) return null;
  const mt = mean(bins.map(b => b.t)), mv = mean(bins.map(b => b.v));
  const sxx = bins.reduce((s, b) => s + (b.t - mt) ** 2, 0);
  if (sxx <= 0) return null;
  return bins.reduce((s, b) => s + (b.t - mt) * (b.v - mv), 0) / sxx * 600;
}

const unusable = (flags: string[], extra: Partial<HrStreamSummary> = {}): HrStreamSummary => ({
  version: HR_STREAM_POLICY.version, quality: "unusable", flags, samples: 0, medianGapSeconds: null, coverageFraction: 0,
  warmupSeconds: null, trimmedAvgHr: null, rawAvgHr: null, stableSegmentSeconds: 0, postWarmupSlopeBpmPer10Min: null, intervalLike: false, ...extra });

export function summarizeHrStream(input: readonly HrSample[]): HrStreamSummary {
  const P = HR_STREAM_POLICY, flags: string[] = [];
  const valid = input.filter(s => Number.isFinite(s.t) && Number.isFinite(s.bpm) && s.t >= 0 && s.bpm >= P.validMin && s.bpm <= P.validMax)
    .sort((a, b) => a.t - b.t).filter((s, i, a) => i === 0 || s.t > a[i - 1].t);
  if (valid.length < input.length) flags.push("invalid_samples_removed");
  if (valid.length < P.minimumSamples) return unusable([...flags, "too_few_samples"], { samples: valid.length });
  // Isolated spikes (strap/optical artifacts): far from the local median of neighbours.
  const half = P.spikeWindow >> 1;
  const clean = valid.filter((s, i) => {
    const nb = valid.slice(Math.max(0, i - half), i + half + 1).map(x => x.bpm);
    return Math.abs(s.bpm - median(nb)) <= P.spikeBpm;
  });
  if (clean.length < valid.length) flags.push("spikes_removed");
  const span = clean.at(-1)!.t - clean[0].t;
  if (span < P.minimumPostWarmupSeconds + P.warmupMinSeconds) return unusable([...flags, "stream_too_short"], { samples: clean.length });
  const gaps = clean.slice(1).map((s, i) => s.t - clean[i].t);
  const medianGap = median(gaps);
  const covered = gaps.filter(g => g <= P.maximumGapSeconds).reduce((s, g) => s + g, 0);
  const coverage = span > 0 ? covered / span : 0;
  if (gaps.some(g => g > P.maximumGapSeconds)) flags.push("sampling_gaps");
  if (coverage < P.minimumCoverage) return unusable([...flags, "sparse_coverage"], { samples: clean.length, medianGapSeconds: medianGap, coverageFraction: coverage });

  // 10-second median bins, with bins inside a gap left empty (never interpolated across holes).
  const bins: { t: number; v: number }[] = [];
  const start = clean[0].t;
  let bucket: number[] = [], bucketIndex = 0;
  for (const s of clean) {
    const idx = Math.floor((s.t - start) / P.binSeconds);
    if (idx !== bucketIndex && bucket.length) { bins.push({ t: start + bucketIndex * P.binSeconds + P.binSeconds / 2, v: median(bucket) }); bucket = []; }
    bucketIndex = idx; bucket.push(s.bpm);
  }
  if (bucket.length) bins.push({ t: start + bucketIndex * P.binSeconds + P.binSeconds / 2, v: median(bucket) });
  const smooth = bins.map((b, i) => ({ t: b.t, v: median(bins.slice(Math.max(0, i - (P.smoothingBins >> 1)), i + (P.smoothingBins >> 1) + 1).map(x => x.v)) }));

  const sustained = median(smooth.filter(b => b.t - start >= span / 2).map(b => b.v));
  const reached = smooth.find(b => b.v >= P.warmupFraction * sustained);
  const warmupSeconds = Math.min(P.warmupMaxSeconds, Math.max(P.warmupMinSeconds, reached ? reached.t - start : P.warmupMaxSeconds));
  const post = smooth.filter(b => b.t - start >= warmupSeconds);
  const postSeconds = post.length * P.binSeconds;
  if (postSeconds < P.minimumPostWarmupSeconds) return unusable([...flags, "no_post_warmup_segment"], { samples: clean.length, medianGapSeconds: medianGap, coverageFraction: coverage, warmupSeconds });

  // Longest contiguous window whose bins stay within ±tolerance of the window median.
  let best: { from: number; to: number } = { from: 0, to: 0 };
  for (let i = 0; i < post.length; i++) {
    let lo = post[i].v, hi = post[i].v;
    for (let j = i; j < post.length; j++) {
      lo = Math.min(lo, post[j].v); hi = Math.max(hi, post[j].v);
      if (hi - lo > 2 * P.stableToleranceBpm) break;
      if (j - i > best.to - best.from) best = { from: i, to: j };
    }
  }
  const stable = post.slice(best.from, best.to + 1);
  const stableSeconds = stable.length * P.binSeconds;
  const mv = mean(post.map(b => b.v)), sd = Math.sqrt(mean(post.map(b => (b.v - mv) ** 2)));
  const intervalLike = sd / mv > P.intervalCoefficient || stableSeconds / postSeconds < P.intervalStableShare;
  if (intervalLike) flags.push("interval_like_structure");
  if (stableSeconds < P.minimumStableSeconds) flags.push("short_stable_segment");
  const rawAvg = mean(clean.map(s => s.bpm)), trimmed = mean(clean.filter(s => s.t - start >= warmupSeconds).map(s => s.bpm));
  const limited = coverage < P.goodCoverage || intervalLike || stableSeconds < P.minimumStableSeconds || clean.length < valid.length * 0.95;
  return { version: P.version, quality: limited ? "limited" : "good", flags, samples: clean.length, medianGapSeconds: medianGap, coverageFraction: coverage,
    warmupSeconds, trimmedAvgHr: trimmed, rawAvgHr: rawAvg, stableSegmentSeconds: stableSeconds,
    postWarmupSlopeBpmPer10Min: intervalLike ? null : slopePer10Min(stable), intervalLike };
}
