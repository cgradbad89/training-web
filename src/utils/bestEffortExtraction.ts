/**
 * HR-gated best-effort extraction for race prediction.
 *
 * The base Riegel fit (see riegelFit.ts) is dominated by easy training runs, so
 * its half-marathon prediction reflects *easy-run* pace, not *race-effort* pace.
 * This module surfaces the genuine race-gear efforts hiding in the data — runs
 * (and continuous segments within long runs) actually executed at a hard heart
 * rate — and feeds them into the same fit as high-weight efforts, so the
 * prediction reflects what the athlete can sustain *at race effort*.
 *
 * Three effort sources (see {@link extractBestEfforts}):
 *   • full-run        — whole run pace from recorded distance/duration (no GPS
 *                       bias), gated on the run-level avg HR.
 *   • continuous-segment — the fastest continuous N-mile window inside a run,
 *                       paced from the GPS route (the only per-mile pace source —
 *                       the mileSplits subcollection stores HR, not pace) and
 *                       gated on that window's per-mile avg HR.
 *   • fast-finish     — the longest contiguous stretch of miles that EACH clear
 *                       the gate individually (see {@link bestFastFinishSegment}).
 *                       Rescues an easy-start / hard-finish run whose whole-run
 *                       avg HR fails the gate but whose finishing miles pass it;
 *                       has its own short floor ({@link FAST_FINISH_MIN_SEGMENT_MILES})
 *                       so a 2–3 mile finish is not thrown away with the 5-mile
 *                       ceiling that governs the other two sources.
 *
 * GPS reconciliation: GPS-haversine under-counts true distance (corner-cutting),
 * which biases route-derived pace ~3% slow. Each segment's GPS distance is
 * rescaled by recordedDistanceMiles / totalGpsDistanceMiles so extracted paces
 * share the same basis as the rest of the model (which uses recorded distance).
 *
 * HR anchors are AUTHORITATIVE and injected via config (read from
 * users/{uid}/settings/prefs — never hardcoded). HRR = (HR − rest) / (max − rest).
 *
 * Pure + synchronous: continuous-segment extraction consumes the transient
 * `HealthWorkout.mileSplits` hydration (route-derived pace + per-mile HR);
 * callers attach it before invoking. No Firestore access here.
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import { type EffortPoint, type EffortTier } from "@/utils/riegelFit";
import { parseLocalDate } from "@/utils/dates";

export interface BestEffortSegment {
  sourceWorkoutId: string;
  /** YYYY-MM-DD (local) of the source run — drives recency decay in the fit. */
  date: string;
  /** Reconciled to recorded distance (see module docs). */
  distanceMiles: number;
  paceSecPerMile: number;
  /** Segment avg HR as %HRR, 0–1. */
  avgHrrPercent: number;
  segmentType: "full-run" | "continuous-segment" | "fast-finish";
}

export interface BestEffortConfig {
  /** Min %HRR (0–1) to qualify as a race-gear effort. */
  hrrGateThreshold: number;
  /** Continuous-segment window lengths in miles, e.g. [3, 5, 8]. */
  segmentWindowsMiles: number[];
  /** Authoritative max HR (bpm) — from settings/prefs, never hardcoded. */
  maxHr: number;
  /** Authoritative resting HR (bpm) — from settings/prefs, never hardcoded. */
  restingHr: number;
  /** Min length (mi) for a contiguous fast-finish segment. Defaults to
   *  {@link FAST_FINISH_MIN_SEGMENT_MILES}; distinct from the 5-mile ceiling. */
  fastFinishMinSegmentMiles?: number;
}

// ─── Race-effort projection ──────────────────────────────────────────────────
//
// The best sustained LONG segments were typically run sub-maximally (~72–75%
// HRR — a training long run, not a race). To make the projection reflect race-
// DAY effort rather than sub-threshold training effort, a qualifying segment's
// pace is nudged faster in proportion to how far below race-effort HRR it was
// run. This is the ONE design assumption in this feature (it is not a fact from
// the data — see the session report's "unverifiable items").

/**
 * Assumed sustainable race HRR over the half — the projection target, and THE
 * design assumption of this feature (see the session report's unverifiable
 * items). 0.90 = "raced at 90% HRR avg," a realistic race-day effort for a
 * trained half and above this athlete's *demonstrated* 80–84% on hard long
 * efforts — so the resulting time is a race-effort PROJECTION, not a time the
 * training has yet shown. (User-confirmed: 0.85 → ~2:14, 0.90 → ~2:11; chosen
 * 0.90 to land at the conservative edge of the goal range.) Re-tune here.
 */
export const RACE_EFFORT_HRR_TARGET = 0.9;
/** Hard ceiling on the per-segment speed-up, so a low-HR segment can't run away. */
export const MAX_PACE_ADJUSTMENT_PCT = 0.06;
/** Min %HRR (0–1) for a segment to count as a race-gear effort. */
export const HRR_GATE_THRESHOLD = 0.8;
/**
 * Minimum length (miles) of a contiguous per-mile "fast finish" segment for it
 * to earn best-effort credit. Deliberately SEPARATE from — and much shorter
 * than — the 5-mile ceiling floor used by {@link selectCeilingEfforts} for
 * full-run / fixed-window efforts: a genuine fast finish (e.g. the last 2–3
 * miles of an otherwise-easy long run) is exactly the shape the 5-mile floor
 * throws away. The two floors serve different paths and must not be conflated —
 * see {@link bestFastFinishSegment} and {@link buildBestEffortSegments}.
 */
export const FAST_FINISH_MIN_SEGMENT_MILES = 2;
/**
 * Per rounded-distance bucket, how many qualifying fast-finish segments
 * {@link buildBestEffortSegments} keeps (fastest first) instead of only the
 * single fastest. A run whose fast finish genuinely clears every gate
 * shouldn't be shut out of the ceiling just because another run's fast finish
 * at the same rounded distance happens to be marginally faster — both are
 * legitimate race-gear evidence and deserve their own weighted point in the
 * fit. Full-run and fixed-window continuous segments are NOT affected — they
 * keep {@link selectCeilingEfforts}'s single-winner-per-bucket selection.
 * JUDGMENT CALL, not derived — tune from production QA.
 */
export const FAST_FINISH_CEILING_TOP_N = 3;
/**
 * Recency window (days) for best-effort CANDIDATES. Best efforts should reflect
 * CURRENT race gear, so extraction is bounded to recent runs (matches the base
 * fit's ordinary `daysBack` and the investigation's fit-eligible window). Without
 * this, ceiling selection would pick stale all-time PRs that recency decay then
 * zeroes out — moving the prediction not at all.
 */
export const BEST_EFFORT_RECENCY_DAYS = 56;
/**
 * Extra fit weight given to each best-effort segment so the race-gear efforts
 * are the PRIMARY signal and the ordinary training runs act as corroboration
 * (the Riegel fit normalizes weights to mean 1 and caps each at 5×, so an
 * ordinary tier weight of 3.0 could never outvote ~20 base runs). Calibrated so
 * the current dataset's half prediction lands ~2:09–2:10; see the projection
 * notes and the session report's "unverifiable items".
 */
export const BEST_EFFORT_WEIGHT_MULTIPLIER = 6;

/**
 * Adjust a sub-maximal segment pace toward race effort, proportional to the HRR
 * shortfall (target − segmentHRR), clamped at {@link MAX_PACE_ADJUSTMENT_PCT}.
 * A segment already at/above the target is returned unchanged. One HRR point of
 * shortfall ≈ one percent of pace, which the gate (≥0.80 HRR) keeps well inside
 * the clamp in normal use — the clamp is a safety rail, not a routine path.
 */
export function projectPaceToRaceEffort(
  paceSecPerMile: number,
  avgHrrPercent: number,
  target: number = RACE_EFFORT_HRR_TARGET,
  maxAdjustmentPct: number = MAX_PACE_ADJUSTMENT_PCT
): number {
  const shortfall = Math.max(0, target - avgHrrPercent);
  const adjustmentPct = Math.min(shortfall, maxAdjustmentPct);
  return paceSecPerMile * (1 - adjustmentPct);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hrrFromBpm(bpm: number, maxHr: number, restingHr: number): number {
  const reserve = maxHr - restingHr;
  if (reserve <= 0) return 0;
  const hrr = (bpm - restingHr) / reserve;
  return Math.min(1, Math.max(0, hrr));
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Best (fastest) continuous W-full-mile window inside one run's mile splits,
 * reconciled to recorded distance. Returns null if there is no contiguous
 * window of W full miles with usable per-mile HR.
 */
function bestContinuousWindow(
  workout: HealthWorkout,
  windowMiles: number,
  maxHr: number,
  restingHr: number
): { paceSecPerMile: number; distanceMiles: number; avgHrrPercent: number } | null {
  const splits = workout.mileSplits;
  if (!splits || splits.length === 0) return null;

  const sorted = [...splits].sort((a, b) => a.mile - b.mile);
  const totalGps = sorted.reduce((s, x) => s + x.segmentMiles, 0);
  if (totalGps <= 0) return null;
  // GPS→recorded reconciliation ratio (>1 when GPS under-counts).
  const ratio =
    workout.distanceMiles > 0 ? workout.distanceMiles / totalGps : 1;

  const full = sorted.filter((s) => !s.isPartial && s.segmentMiles >= 0.97);
  const W = Math.round(windowMiles);
  if (full.length < W) return null;

  let best: { paceSecPerMile: number; distanceMiles: number; avgHrrPercent: number } | null =
    null;

  for (let i = 0; i + W <= full.length; i++) {
    const win = full.slice(i, i + W);
    const contiguous = win.every((s, j) => j === 0 || s.mile === win[j - 1].mile + 1);
    if (!contiguous) continue;

    const windowTime = win.reduce((s, x) => s + x.paceSecPerMile * x.segmentMiles, 0);
    const gpsDist = win.reduce((s, x) => s + x.segmentMiles, 0);
    const reconciledDist = gpsDist * ratio;
    if (reconciledDist <= 0) continue;
    const pace = windowTime / reconciledDist;

    const bpms = win
      .map((s) => s.avgBpm)
      .filter((v): v is number => v != null && isFinite(v) && v > 0);
    if (bpms.length === 0) continue; // no usable HR → can't gate this segment
    const avgBpm = bpms.reduce((a, b) => a + b, 0) / bpms.length;
    const hrr = hrrFromBpm(avgBpm, maxHr, restingHr);

    if (!best || pace < best.paceSecPerMile) {
      best = { paceSecPerMile: pace, distanceMiles: reconciledDist, avgHrrPercent: hrr };
    }
  }
  return best;
}

/**
 * Longest contiguous "fast finish" segment inside one run: the longest run of
 * consecutive miles where EVERY mile INDIVIDUALLY clears the HRR gate — unlike
 * {@link bestContinuousWindow}, which finds a fixed-length window gated on the
 * window's AVERAGE HR. A run with an easy start and a hard finish (whole-run avg
 * HR below the gate, but the finishing miles well above it) is credited here and
 * nowhere else.
 *
 * Distance = sum of the qualifying miles' actual (recorded-reconciled) mileage;
 * pace = route-derived time over that same mile range, on the recorded-distance
 * basis (same GPS→recorded reconciliation the fixed-window path uses). Returns
 * null when no contiguous qualifying stretch reaches `minSegmentMiles` — a
 * correct exclusion (e.g. a sub-2-mile surge), not a bug.
 *
 * Requires the transient `mileSplits` hydration (route-derived pace + per-mile
 * avgBpm); runs without it yield null.
 */
function bestFastFinishSegment(
  workout: HealthWorkout,
  hrrGate: number,
  maxHr: number,
  restingHr: number,
  minSegmentMiles: number
): { paceSecPerMile: number; distanceMiles: number; avgHrrPercent: number } | null {
  const splits = workout.mileSplits;
  if (!splits || splits.length === 0) return null;

  const sorted = [...splits].sort((a, b) => a.mile - b.mile);
  const totalGps = sorted.reduce((s, x) => s + x.segmentMiles, 0);
  if (totalGps <= 0) return null;
  // GPS→recorded reconciliation ratio (>1 when GPS under-counts), matching the
  // fixed-window path so extracted paces share the model's recorded-distance basis.
  const ratio = workout.distanceMiles > 0 ? workout.distanceMiles / totalGps : 1;

  // Per-mile qualification: a usable avgBpm whose HRR clears the gate. A mile
  // with no usable HR breaks the contiguous run (we can't vouch for its effort).
  const qualifies = (s: (typeof sorted)[number]): boolean => {
    if (s.avgBpm == null || !isFinite(s.avgBpm) || s.avgBpm <= 0) return false;
    return hrrFromBpm(s.avgBpm, maxHr, restingHr) >= hrrGate;
  };

  // Longest contiguous (consecutive mile-number) run of qualifying miles; tie
  // broken toward the faster stretch so the emitted segment is the ceiling.
  let best: { start: number; end: number } | null = null; // indices into `sorted`
  let i = 0;
  while (i < sorted.length) {
    if (!qualifies(sorted[i])) {
      i++;
      continue;
    }
    let j = i;
    while (
      j + 1 < sorted.length &&
      qualifies(sorted[j + 1]) &&
      sorted[j + 1].mile === sorted[j].mile + 1
    ) {
      j++;
    }
    if (best === null) {
      best = { start: i, end: j };
    } else {
      const bestLen = best.end - best.start;
      const curLen = j - i;
      if (curLen > bestLen) best = { start: i, end: j };
      // (ties keep the earlier stretch — see below for pace tie-break)
    }
    i = j + 1;
  }
  if (best === null) return null;

  const win = sorted.slice(best.start, best.end + 1);
  const gpsDist = win.reduce((s, x) => s + x.segmentMiles, 0);
  const reconciledDist = gpsDist * ratio;
  if (reconciledDist + 1e-9 < minSegmentMiles) return null; // below the fast-finish floor

  const windowTime = win.reduce((s, x) => s + x.paceSecPerMile * x.segmentMiles, 0);
  const paceSecPerMile = windowTime / reconciledDist;

  // Mileage-weighted avg HR over the segment → %HRR (all miles already clear the
  // gate, so this is ≥ gate by construction; kept for the race-effort projection).
  const bpmWeighted =
    win.reduce((s, x) => s + (x.avgBpm as number) * x.segmentMiles, 0) / gpsDist;
  const avgHrrPercent = hrrFromBpm(bpmWeighted, maxHr, restingHr);

  return { paceSecPerMile, distanceMiles: reconciledDist, avgHrrPercent };
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract HR-gated best-effort segments from a set of (candidate) runs.
 *
 * For each run: emits a `full-run` segment when the run-level avg HR clears the
 * gate, the fastest `continuous-segment` at each configured window whose own
 * per-mile avg HR clears the gate, and one `fast-finish` segment for the longest
 * contiguous stretch of miles that each clear the gate (≥ fastFinishMinSegmentMiles).
 * Continuous and fast-finish segments require the transient `mileSplits`
 * hydration; runs without it contribute only their full-run effort.
 *
 * Returns the raw (un-projected) segments — apply {@link bestEffortsToEffortPoints}
 * to project to race effort and convert to fit inputs.
 */
export function extractBestEfforts(
  workouts: HealthWorkout[],
  config: BestEffortConfig
): BestEffortSegment[] {
  const {
    hrrGateThreshold,
    segmentWindowsMiles,
    maxHr,
    restingHr,
    fastFinishMinSegmentMiles = FAST_FINISH_MIN_SEGMENT_MILES,
  } = config;
  const out: BestEffortSegment[] = [];

  for (const w of workouts) {
    if (!w.isRunLike) continue;
    if (!(w.distanceMiles > 0) || !(w.durationSeconds > 0)) continue;
    const date = localDateString(w.startDate);

    // Full-run effort — recorded-basis pace (no GPS bias), run-level HR gate.
    if (w.avgHeartRate != null && isFinite(w.avgHeartRate) && w.avgHeartRate > 0) {
      const hrr = hrrFromBpm(w.avgHeartRate, maxHr, restingHr);
      if (hrr >= hrrGateThreshold) {
        out.push({
          sourceWorkoutId: w.workoutId,
          date,
          distanceMiles: w.distanceMiles,
          paceSecPerMile: w.durationSeconds / w.distanceMiles,
          avgHrrPercent: hrr,
          segmentType: "full-run",
        });
      }
    }

    // Continuous segments — route-derived pace, per-window HR gate.
    if (w.mileSplits && w.mileSplits.length > 0) {
      for (const windowMiles of segmentWindowsMiles) {
        const seg = bestContinuousWindow(w, windowMiles, maxHr, restingHr);
        if (seg && seg.avgHrrPercent >= hrrGateThreshold) {
          out.push({
            sourceWorkoutId: w.workoutId,
            date,
            distanceMiles: seg.distanceMiles,
            paceSecPerMile: seg.paceSecPerMile,
            avgHrrPercent: seg.avgHrrPercent,
            segmentType: "continuous-segment",
          });
        }
      }

      // Fast finish — longest contiguous stretch where EVERY mile clears the
      // gate individually (rescues an easy-start / hard-finish run the whole-run
      // gate rejects). Its own short floor; kept below the 5-mile ceiling in
      // buildBestEffortSegments so it is not thrown away with short surges.
      const ff = bestFastFinishSegment(
        w,
        hrrGateThreshold,
        maxHr,
        restingHr,
        fastFinishMinSegmentMiles
      );
      if (ff) {
        out.push({
          sourceWorkoutId: w.workoutId,
          date,
          distanceMiles: ff.distanceMiles,
          paceSecPerMile: ff.paceSecPerMile,
          avgHrrPercent: ff.avgHrrPercent,
          segmentType: "fast-finish",
        });
      }
    }
  }

  return out;
}

/**
 * Reduce extracted segments to the performance CEILING: the single fastest
 * segment per rounded-distance bucket, dropping anything below `minDistanceMiles`.
 *
 * Why: feeding every gated segment HURTS a half prediction — (1) short fast
 * efforts (3mi) steepen the Riegel exponent k, which *raises* the long-distance
 * extrapolation, and (2) "hard but slow" segments (high HR in heat/hills) are
 * race-gear by HR yet pull pace the wrong way. Keeping only the fastest effort
 * per distance ≥ minDistanceMiles isolates the genuine ceiling. For half+
 * targets minDistanceMiles=5 (short efforts don't inform a half).
 */
export function selectCeilingEfforts(
  segments: BestEffortSegment[],
  minDistanceMiles = 5
): BestEffortSegment[] {
  const byBucket = new Map<number, BestEffortSegment>();
  for (const s of segments) {
    if (s.distanceMiles < minDistanceMiles) continue;
    const bucket = Math.round(s.distanceMiles);
    const cur = byBucket.get(bucket);
    if (!cur || s.paceSecPerMile < cur.paceSecPerMile) byBucket.set(bucket, s);
  }
  return [...byBucket.values()].sort((a, b) => a.distanceMiles - b.distanceMiles);
}

/**
 * The canonical best-effort recipe used by BOTH the Plan Insights dashboard and
 * the Run Detail impact tile, so they can never diverge: bound to the recent
 * window ({@link BEST_EFFORT_RECENCY_DAYS}), extract full-run + continuous +
 * fast-finish efforts at the gate, then reduce to the per-distance ceiling —
 * ≥5mi for full-run/fixed-window (single winner per bucket, via
 * {@link selectCeilingEfforts}), ≥{@link FAST_FINISH_MIN_SEGMENT_MILES} for
 * fast-finish (top {@link FAST_FINISH_CEILING_TOP_N} per bucket by pace, so a
 * genuinely qualifying fast finish isn't shut out by one marginally-faster
 * run at the same distance). Pure; no Firestore. Callers gate on target
 * distance (half+ only) before invoking.
 * `asOf` sets the recency cutoff (pass the same reference used for the fit).
 */
export function buildBestEffortSegments(
  runs: HealthWorkout[],
  asOf: Date,
  maxHr: number,
  restingHr: number
): BestEffortSegment[] {
  const cutoffMs = asOf.getTime() - BEST_EFFORT_RECENCY_DAYS * 86400000;
  const recentRuns = runs.filter((w) => w.startDate.getTime() >= cutoffMs);
  const raw = extractBestEfforts(recentRuns, {
    hrrGateThreshold: HRR_GATE_THRESHOLD,
    segmentWindowsMiles: [3, 5, 8],
    maxHr,
    restingHr,
    fastFinishMinSegmentMiles: FAST_FINISH_MIN_SEGMENT_MILES,
  });

  // Two floors, one ceiling: full-run / fixed-window efforts keep the 5-mile
  // floor (short fast efforts steepen the Riegel exponent and bias the half
  // slow); fast-finish segments use their own shorter floor so a genuine 2–3
  // mile hard finish survives. Merge into buckets by rounded distance, then
  // keep only the top FAST_FINISH_CEILING_TOP_N per bucket by pace — top-N,
  // not winner-take-all, so a fast-finish and a full-run at the same distance
  // still can't ALL double-count, but multiple runs with genuinely qualifying
  // same-distance fast finishes aren't shut out by a single winner.
  const strong = selectCeilingEfforts(
    raw.filter((s) => s.segmentType !== "fast-finish"),
    5
  );
  const fastCandidates = raw.filter(
    (s) =>
      s.segmentType === "fast-finish" &&
      s.distanceMiles >= FAST_FINISH_MIN_SEGMENT_MILES
  );

  const byBucket = new Map<number, BestEffortSegment[]>();
  for (const s of [...strong, ...fastCandidates]) {
    const bucket = Math.round(s.distanceMiles);
    const arr = byBucket.get(bucket);
    if (arr) arr.push(s);
    else byBucket.set(bucket, [s]);
  }

  const out: BestEffortSegment[] = [];
  for (const arr of byBucket.values()) {
    arr.sort((a, b) => a.paceSecPerMile - b.paceSecPerMile);
    out.push(...arr.slice(0, FAST_FINISH_CEILING_TOP_N));
  }
  return out.sort((a, b) => a.distanceMiles - b.distanceMiles);
}

/**
 * Convert extracted segments into Riegel {@link EffortPoint}s — applying the
 * race-effort pace projection and tagging them at `tier` (a high-weight tier so
 * they pull the fit toward race effort; the base runs stay in as corroboration).
 * `ageDays` comes from the source date so the fit's recency decay still applies.
 */
export function bestEffortsToEffortPoints(
  segments: BestEffortSegment[],
  now: Date = new Date(),
  tier: EffortTier = "QUALITY",
  weightMultiplier: number = BEST_EFFORT_WEIGHT_MULTIPLIER,
  target: number = RACE_EFFORT_HRR_TARGET,
  maxAdjustmentPct: number = MAX_PACE_ADJUSTMENT_PCT
): EffortPoint[] {
  const nowMs = now.getTime();
  return segments.map((s) => {
    const projectedPace = projectPaceToRaceEffort(
      s.paceSecPerMile,
      s.avgHrrPercent,
      target,
      maxAdjustmentPct
    );
    const ageDays = Math.max(0, (nowMs - parseLocalDate(s.date).getTime()) / 86400000);
    return {
      distanceMiles: s.distanceMiles,
      timeSeconds: projectedPace * s.distanceMiles,
      ageDays,
      isTreadmill: false,
      tier,
      weightMultiplier,
    };
  });
}
