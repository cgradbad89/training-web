import { type UserSettings } from "@/types/userSettings";

/**
 * Training Load — TRIMP-inspired effort score.
 *
 * Combines duration with heart-rate intensity via 5 HR zones. The user's
 * max HR defaults to 185 bpm; zones are defined as % of max HR with rising
 * multipliers so harder + longer efforts score higher than easy jogs.
 *
 * Zone boundaries with the default max HR of 185:
 *   Zone 1 Recovery   < 60%      < 111 bpm  ×1.0
 *   Zone 2 Aerobic    60–70%   111–129 bpm  ×1.5
 *   Zone 3 Tempo      70–80%   130–148 bpm  ×2.5
 *   Zone 4 Threshold  80–90%   149–166 bpm  ×4.0
 *   Zone 5 Max        ≥ 90%      167+ bpm   ×6.5
 *
 * Formula:    TRIMP = durationMinutes × zoneMultiplier(avgHR)
 *
 * Typical scores:
 *   20-min easy recovery   ≈ 20–30
 *   45-min aerobic run     ≈ 45–70
 *   60-min tempo run       ≈ 100–150
 *   2-hr+ half marathon    ≈ 150–220
 *
 * We only have avgHeartRate (no per-second HR), so the zone is chosen
 * from the whole-run average — the same fallback Strava uses without
 * per-second data.
 */

export const DEFAULT_MAX_HR = 185;
/** @deprecated Use DEFAULT_MAX_HR for fallback behavior or pass a profile max HR. */
export const MAX_HR = DEFAULT_MAX_HR;

export function resolveMaxHr(
  settings: UserSettings | null | undefined
): number {
  return settings?.maxHeartRate ?? DEFAULT_MAX_HR;
}

/** Default resting HR (bpm) when the user hasn't set one — used by the V2
 *  HR-reserve (Banister) load model. Tunable. */
export const DEFAULT_RESTING_HR = 60;

export function resolveRestingHr(
  settings: UserSettings | null | undefined
): number {
  return settings?.restingHeartRate ?? DEFAULT_RESTING_HR;
}

// Minimum thresholds for including an activity in a Training Load *average*.
// Individual badges still render for all activities regardless of these values —
// these only filter out short/aborted activities (warmups, restarts) so they
// don't drag down aggregate averages.
export const MIN_RUN_MILES_FOR_AVG = 1.0;
export const MIN_WORKOUT_SECONDS_FOR_AVG = 15 * 60; // 15 minutes

export interface HRZone {
  zone: number;
  minPct: number; // inclusive
  maxPct: number; // exclusive, except Max which is open-ended
  multiplier: number;
  label: string;
}

export const HR_ZONES: HRZone[] = [
  { zone: 1, minPct: 0,    maxPct: 0.60, multiplier: 1.0, label: "Recovery"  },
  { zone: 2, minPct: 0.60, maxPct: 0.70, multiplier: 1.5, label: "Aerobic"   },
  { zone: 3, minPct: 0.70, maxPct: 0.80, multiplier: 2.5, label: "Tempo"     },
  { zone: 4, minPct: 0.80, maxPct: 0.90, multiplier: 4.0, label: "Threshold" },
  { zone: 5, minPct: 0.90, maxPct: 1.00, multiplier: 6.5, label: "Max"       },
];

// Post-TRIMP scaling factors calibrated against Strava Relative Effort.
// Corrects for TRIMP over-crediting duration at low HR for non-aerobic
// activities. Applied as the final step in computeTrainingLoad, after the
// duration × zone-multiplier product is computed.
//   Running / other aerobic                  → factor 1.0 (no scaling applied)
//   HIIT / OTF                               → factor = session avg HRR (intensity-
//                                              proportional; 0.75 fallback when HRR
//                                              is unavailable — see below)
//   Strength (traditional lifting, cooldown) → factor 0.25
//   Mindful (Pilates, yoga, barre, etc.)     → factor 0.20
//
// Strength lifted to 0.25 — validated against Strava RE. Mindful /
// low-cardiovascular activities stay at 0.20.
//
// HIIT/OTF was a flat 0.75, but an investigation against Strava RE showed a flat
// factor cannot fit: easy HIIT wanted ~0.62, hard ~0.89, tracking the session's
// average HR reserve almost 1:1. So the HIIT factor is now intensity-proportional
// — f_hiit = clamp(avg HRR, 0, 1) — which collapsed mean error vs Strava RE from
// ~15% to ~4% across 6 reference sessions (PARAMETER-FREE fit; SMALL SAMPLE — both
// the relationship and the 0.75 fallback are TUNABLE). HIIT/OTF ONLY: running,
// strength, and mindful factors are unchanged, and the shared bannisterWeight/HRR
// curve is untouched (runs validate at factor 1.0 on that curve).
export const HIIT_LOAD_FACTOR = 0.75;
/** Fallback HIIT/OTF factor, used ONLY when avg HRR is unavailable (missing avgHR
 *  or non-positive HR reserve). The live HIIT factor is the session's avg HRR. */
export const DEFAULT_HIIT_FACTOR = HIIT_LOAD_FACTOR; // 0.75
export const STRENGTH_LOAD_FACTOR = 0.25;   // bumped from 0.20
export const MINDFUL_LOAD_FACTOR = 0.20;    // Pilates, yoga, barre, meditation, tai chi, qigong

// ─── Activity context — running vs strength ─────────────────────────────────
//
// Strength / low-intensity work peaks HR lower than running for the same
// perceived effort, so its zone bands shift downward. Everything else —
// running, OTF, HIIT, dance, cycling, unknown activity types — uses the
// running zone set, because those formats routinely push HR to
// running-equivalent intensity.

export type ActivityContext = "running" | "strength";

export const ACTIVITY_CONTEXT_LABEL: Record<ActivityContext, string> = {
  running: "Running / Cardio",
  strength: "Strength / Low Intensity",
};

/**
 * Map a HealthKit activityType string to a TRIMP zone-set context. Uses an
 * allowlist for strength / low-intensity activities; everything else
 * (including unknown / missing types) defaults to running zones. This avoids
 * the prior bug where HIIT / unrecognised types fell through to strength's
 * lower Zone 5 threshold (148 bpm) and produced inflated scores.
 */
export function getActivityContext(
  activityType: string | null | undefined
): ActivityContext {
  if (!activityType) return "running"; // unknown → running zones (safer default)
  const t = activityType.toLowerCase().trim();

  const isLowIntensity =
    t.includes("strength") ||
    t.includes("yoga") ||
    t.includes("pilates") ||
    t.includes("mindandbody") ||
    t.includes("mind_and_body") ||
    t.includes("stretch") ||
    t.includes("flexibility") ||
    t.includes("cooldown") ||
    t.includes("cool_down") ||
    t.includes("barre") ||
    t.includes("meditation") ||
    t.includes("tai") || // tai chi
    t.includes("qigong");

  const context: ActivityContext = isLowIntensity ? "strength" : "running";

  // Temporary debug logging to verify activityType → context mapping in prod.
  // Remove once HIIT / OTF mappings are confirmed healthy.
  if (typeof console !== "undefined") {
    console.log("[trainingLoad] activityType:", activityType, "→ context:", context);
  }

  return context;
}

/** Per-context zone sets. Only strength shifts the boundaries downward so a
 *  strength session at 120 bpm reads as harder effort than a long run at 120
 *  bpm. Running / cardio / HIIT / OTF all share HR_ZONES. */
export const WORKOUT_ZONES: Record<ActivityContext, HRZone[]> = {
  running: HR_ZONES,
  strength: [
    { zone: 1, minPct: 0,    maxPct: 0.50, multiplier: 1.0, label: "Recovery"  },
    { zone: 2, minPct: 0.50, maxPct: 0.62, multiplier: 1.5, label: "Aerobic"   },
    { zone: 3, minPct: 0.62, maxPct: 0.70, multiplier: 2.5, label: "Tempo"     },
    { zone: 4, minPct: 0.70, maxPct: 0.80, multiplier: 4.0, label: "Threshold" },
    { zone: 5, minPct: 0.80, maxPct: 1.00, multiplier: 6.5, label: "Max"       },
  ],
};

// HIIT / OTF allowlist. These formats share running HR zone bands (their HR
// reaches running-equivalent intensity), but TRIMP still over-credits them by
// ~30% vs. Strava Relative Effort, so we apply HIIT_LOAD_FACTOR. Strength /
// low-intensity is detected via getActivityContext's existing allowlist —
// not duplicated here.
export function isHiitLikeActivity(activityType: string): boolean {
  const t = activityType.toLowerCase().trim();
  return (
    t.includes("hiit") ||
    t.includes("orangetheory") ||
    t.includes("otf") ||
    t.includes("highintensityinterval") ||
    t.includes("high_intensity_interval") ||
    t.includes("crossfit") ||
    t.includes("bootcamp") ||
    t.includes("boot_camp") ||
    t.includes("kickbox") ||
    t.includes("workout")
  );
}

// Mindful / low-cardiovascular subset of the strength allowlist. These
// activities (Pilates, yoga, barre, meditation, tai chi, qigong, stretching)
// still use the strength zone bands via getActivityContext, but get the lower
// MINDFUL_LOAD_FACTOR in the post-TRIMP scaling step. Traditional strength
// lifting and cooldown sessions stay in the strength bucket (×0.25).
export function isMindfulActivity(activityType: string): boolean {
  const t = activityType.toLowerCase().trim();
  return (
    t.includes("pilates") ||
    t.includes("yoga") ||
    t.includes("barre") ||
    t.includes("meditation") ||
    t.includes("tai") || // tai chi
    t.includes("qigong") ||
    t.includes("mindandbody") ||
    t.includes("mind_and_body") ||
    t.includes("stretch") ||
    t.includes("flexibility")
  );
}

/** Inclusive-min, exclusive-max bpm bounds for a specific zone in a context. */
export function zoneBoundsBpmForActivity(
  z: HRZone,
  context: ActivityContext,
  maxHr: number = DEFAULT_MAX_HR
): { min: number; maxLabel: string } {
  const zones = WORKOUT_ZONES[context];
  const idx = zones.findIndex((x) => x.zone === z.zone);
  const min = Math.ceil(z.minPct * maxHr);
  const maxLabel =
    idx === zones.length - 1
      ? `${Math.ceil(z.minPct * maxHr)}+`
      : `${Math.floor(z.maxPct * maxHr)}`;
  return { min, maxLabel };
}

/** Pick the zone for an avg HR inside a given activity context. */
export function getHRZoneForActivity(
  bpm: number,
  context: ActivityContext,
  maxHr: number = DEFAULT_MAX_HR
): HRZone {
  const zones = WORKOUT_ZONES[context];
  const pct = bpm / maxHr;
  return zones.find((z) => pct < z.maxPct) ?? zones[zones.length - 1];
}

/** Inclusive-min, exclusive-max bpm bounds (Zone 5 is open-ended). */
export function zoneBoundsBpm(
  z: HRZone,
  maxHr: number = DEFAULT_MAX_HR
): { min: number; maxLabel: string } {
  const min = Math.ceil(z.minPct * maxHr);
  const maxLabel =
    z.zone === HR_ZONES.length
      ? `${Math.ceil(z.minPct * maxHr)}+`
      : `${Math.floor(z.maxPct * maxHr)}`;
  return { min, maxLabel };
}

/** Pick the zone for an avg HR. Falls back to the Max zone for HRs ≥ 90%. */
export function getHRZone(
  bpm: number,
  maxHr: number = DEFAULT_MAX_HR
): HRZone {
  const pct = bpm / maxHr;
  return HR_ZONES.find((z) => pct < z.maxPct) ?? HR_ZONES[HR_ZONES.length - 1];
}

/**
 * Narrow-typed zone classifier for callers that only need the zone number
 * (1–5) and want it as a union. Delegates to the running-context thresholds
 * in HR_ZONES — does not duplicate any boundary constants.
 */
export type HRZoneNumber = 1 | 2 | 3 | 4 | 5;

export function classifyHrZone(
  bpm: number,
  maxHr: number = DEFAULT_MAX_HR
): HRZoneNumber {
  const z = getHRZone(bpm, maxHr).zone;
  // HR_ZONES is fixed at 5 entries with zones 1..5, so this narrowing is safe.
  return Math.min(5, Math.max(1, z)) as HRZoneNumber;
}

/**
 * Post-TRIMP activity scaling factor — single source of truth shared by BOTH
 * the legacy zone-multiplier model (`computeTrainingLoad`) and the V2 Banister
 * model (`computeTrainingLoadV2`) so the two stay in sync. TRIMP over-credits
 * duration at low HR for non-aerobic activities; this corrects it.
 *   Running / other aerobic (incl. unknown) → 1.0
 *   HIIT / OTF                               → clamp(hrr, 0, 1), i.e. the session's
 *                                              AVERAGE HR reserve; DEFAULT_HIIT_FACTOR
 *                                              (0.75) when hrr is not provided/usable
 *   Strength (lifting, cooldown)             → STRENGTH_LOAD_FACTOR (0.25)
 *   Mindful (Pilates, yoga, barre, …)        → MINDFUL_LOAD_FACTOR (0.20)
 *
 * `hrr` is the session's average HR reserve (Karvonen, 0–1). It is consumed ONLY
 * by the HIIT/OTF branch (intensity-proportional factor — see the constants block);
 * running/strength/mindful ignore it and return their existing constants. Passing
 * no hrr (or a non-finite one) leaves HIIT on the 0.75 fallback, so every other
 * call site and the legacy zone model are byte-for-byte unaffected.
 *
 * Precedence matches the historical inline logic exactly: mindful first (the
 * strictest subset of the strength allowlist), then strength context, then
 * HIIT/OTF (which shares running HR bands), else running 1.0.
 */
export function activityLoadFactor(
  activityType?: string | null,
  hrr?: number
): number {
  if (activityType && isMindfulActivity(activityType)) {
    return MINDFUL_LOAD_FACTOR;
  }
  const context = activityType ? getActivityContext(activityType) : "running";
  if (context === "strength") {
    return STRENGTH_LOAD_FACTOR;
  }
  if (activityType && isHiitLikeActivity(activityType)) {
    // Intensity-proportional: f_hiit = avg HRR (clamped). Fall back to the flat
    // DEFAULT_HIIT_FACTOR only when HRR is unavailable (no avgHR / bad reserve).
    return typeof hrr === "number" && Number.isFinite(hrr)
      ? Math.max(0, Math.min(1, hrr))
      : DEFAULT_HIIT_FACTOR;
  }
  return 1.0;
}

/**
 * @deprecated LEGACY zone-multiplier model — RETIRED FROM DISPLAY in Prompt 3.
 * Display/aggregation now use {@link resolveDisplayLoad} (stored V2 → live
 * avg-HR V2). This function is retained unreferenced-by-display for trivial
 * rollback and will be removed in a future cleanup. Do NOT wire it into new
 * display paths.
 *
 * Compute Training Load. Returns null when HR or duration is missing/invalid,
 * matching the existing "—" behaviour of the efficiency score it replaces.
 *
 * `activityType` is optional; when provided, zone bands shift per the
 * WORKOUT_ZONES table (running / strength). When omitted, falls back to the
 * running zone set so existing call sites keep their behaviour.
 */
export function computeTrainingLoad(
  durationSeconds: number,
  avgHeartRate: number | null | undefined,
  activityType?: string | null,
  maxHr: number = DEFAULT_MAX_HR
): number | null {
  if (!avgHeartRate || avgHeartRate <= 0) return null;
  if (!durationSeconds || durationSeconds <= 0) return null;
  if (!isFinite(avgHeartRate) || !isFinite(durationSeconds)) return null;
  const durationMinutes = durationSeconds / 60;
  const context = activityType ? getActivityContext(activityType) : "running";
  const zone = getHRZoneForActivity(avgHeartRate, context, maxHr);
  const trimp = durationMinutes * zone.multiplier;

  return Math.round(trimp * activityLoadFactor(activityType));
}

// ─── Training Load V2 — Banister TRIMP on HR reserve ─────────────────────────
//
// A physiologically-sound TRIMP load using Heart-Rate Reserve (Karvonen) and
// the Banister exponential weighting, so intensity scales with %HRR rather than
// coarse zone bands. This is the UNIVERSAL baseline that will score ALL runs
// from their run-level average HR (a streamed per-second override arrives in a
// later phase). ADDITIVE — it does not change the legacy model above.
//
// Math (sourced; constants are TUNABLE):
//   HRR     = clamp((avgHR − restingHr) / (maxHr − restingHr), 0, 1)
//   weight  = 0.64 · e^(1.92 · HRR)          (Banister male coefficients)
//   rawTrimp= durationMinutes · HRR · weight
//   load    = round(rawTrimp · TRAINING_LOAD_V2_SCALE · activityFactor)
//
// TRAINING_LOAD_V2_SCALE is anchored so validated reference runs land near
// Strava Relative Effort. activityFactor reuses activityLoadFactor() so V2 and
// the legacy model share one scaling source.

/** Global anchor so V2 reference runs ≈ Strava Relative Effort. TUNABLE. */
export const TRAINING_LOAD_V2_SCALE = 1.14;

/** Banister exponential HR-reserve weighting (male coefficients). The
 *  (0.64, 1.92) pair is a documented, TUNABLE constant pair. */
function bannisterWeight(hrr: number): number {
  return 0.64 * Math.exp(1.92 * hrr);
}

/**
 * Training Load V2 — Banister TRIMP from run-level average HR.
 *
 * Returns null (NEVER 0) when the inputs can't yield a meaningful score, so
 * callers render "—":
 *   - avgHeartRate missing / non-finite / ≤ 0
 *   - durationSeconds ≤ 0 / non-finite
 *   - (maxHr − restingHr) ≤ 0   (guards divide-by-zero / negative reserve)
 *
 * Pure in-memory — no Firestore writes.
 */
export function computeTrainingLoadV2(
  durationSeconds: number,
  avgHeartRate: number | null | undefined,
  maxHr: number,
  restingHr: number,
  activityType?: string
): number | null {
  if (!avgHeartRate || avgHeartRate <= 0 || !isFinite(avgHeartRate)) return null;
  if (!durationSeconds || durationSeconds <= 0 || !isFinite(durationSeconds)) {
    return null;
  }
  const reserve = maxHr - restingHr;
  if (!isFinite(reserve) || reserve <= 0) return null;

  // HR reserve (Karvonen), clamped to [0, 1] so an avgHR above maxHr (or below
  // restingHr) can't overflow / go negative.
  const hrr = Math.max(0, Math.min(1, (avgHeartRate - restingHr) / reserve));

  const durationMinutes = durationSeconds / 60;
  const rawTrimp = durationMinutes * hrr * bannisterWeight(hrr);

  // HIIT/OTF factor is the session's avg HRR (this same `hrr`); other activity
  // types ignore it. The Banister base (rawTrimp) is unchanged.
  return Math.round(
    rawTrimp * TRAINING_LOAD_V2_SCALE * activityLoadFactor(activityType, hrr)
  );
}

/**
 * Single display/aggregation resolver for Training Load V2. Every load consumer
 * goes through this so the fallback logic lives in ONE place.
 *
 *  - Stored `trainingLoadV2` (a finite number) WINS — it may be a streamed
 *    refinement that a live recompute can't reproduce.
 *  - Otherwise live-compute the avg-HR V2 baseline. NB: the live fallback is
 *    ALWAYS avg-HR (never legacy, never streamed); streamed only ever comes
 *    from the stored field. This is intentional.
 *  - null when there's no stored value AND no usable avg HR → caller renders "—".
 */
export function resolveDisplayLoad(
  workout: {
    trainingLoadV2?: number | null;
    avgHeartRate?: number | null;
    durationSeconds: number;
    activityType?: string;
  },
  maxHr: number,
  restingHr: number
): number | null {
  if (
    typeof workout.trainingLoadV2 === "number" &&
    Number.isFinite(workout.trainingLoadV2)
  ) {
    return workout.trainingLoadV2;
  }
  return computeTrainingLoadV2(
    workout.durationSeconds,
    workout.avgHeartRate,
    maxHr,
    restingHr,
    workout.activityType
  );
}

// ─── Load-score tooltip explainer (pure, testable) ──────────────────────────

export interface LoadExplainerInputs {
  /** Stored method, if any. Absent → treated as a live avg-HR estimate. */
  trainingLoadMethod?: "streamed" | "avg-hr-fallback" | null;
  score: number | null;
  avgHeartRate?: number | null;
  durationSeconds?: number | null;
  maxHr?: number | null;
  restingHr?: number | null;
}

export interface LoadExplainer {
  /** When false, the tooltip omits the explainer section (insufficient inputs). */
  show: boolean;
  isStreamed: boolean;
  /** True when there was no stored method (score came from a live recompute). */
  isLiveEstimate: boolean;
  /** One-sentence description of how the score was derived. */
  methodLabel: string;
  /** HR reserve used, 0–100 (rounded), or null when HR anchors are unusable. */
  hrrPct: number | null;
  avgHeartRate: number | null;
  maxHr: number | null;
  restingHr: number | null;
  durationSeconds: number | null;
  score: number | null;
}

/**
 * Build the per-run load explainer shown in the Training Load tooltip. Pure so
 * it's unit-testable without rendering. `show` is false (section suppressed)
 * unless there's a finite score AND a positive duration — and `hrrPct` is null
 * unless the HR anchors are valid (avgHR>0, maxHr>restingHr), so the UI never
 * renders a "%" with a blank number or a NaN.
 */
export function buildLoadExplainer(inputs: LoadExplainerInputs): LoadExplainer {
  const method = inputs.trainingLoadMethod ?? null;
  const isStreamed = method === "streamed";
  const isLiveEstimate = method == null;

  const score =
    typeof inputs.score === "number" && Number.isFinite(inputs.score)
      ? inputs.score
      : null;
  const durationSeconds =
    typeof inputs.durationSeconds === "number" && inputs.durationSeconds > 0
      ? inputs.durationSeconds
      : null;
  const avgHeartRate =
    typeof inputs.avgHeartRate === "number" && inputs.avgHeartRate > 0
      ? inputs.avgHeartRate
      : null;
  const maxHr =
    typeof inputs.maxHr === "number" && inputs.maxHr > 0 ? inputs.maxHr : null;
  const restingHr =
    typeof inputs.restingHr === "number" && inputs.restingHr >= 0
      ? inputs.restingHr
      : null;

  let hrrPct: number | null = null;
  if (avgHeartRate != null && maxHr != null && restingHr != null && maxHr > restingHr) {
    const hrr = Math.max(
      0,
      Math.min(1, (avgHeartRate - restingHr) / (maxHr - restingHr))
    );
    hrrPct = Math.round(hrr * 100);
  }

  const methodLabel = isStreamed
    ? "Calculated from your second-by-second heart rate."
    : "Calculated from your average heart rate for this run.";

  const show = score != null && durationSeconds != null;

  return {
    show,
    isStreamed,
    isLiveEstimate,
    methodLabel,
    hrrPct,
    avgHeartRate,
    maxHr,
    restingHr,
    durationSeconds,
    score,
  };
}

// ─── Training Load V2 — streamed per-second Banister integral ────────────────
//
// A precision OVERRIDE of the avg-HR baseline for runs with dense per-point HR.
// Instead of one whole-run HRR, it integrates the Banister weighting over every
// consecutive timestamp pair, so time spent at high HR is credited where it
// actually occurred. Falls back to the avg-HR model when HR coverage is sparse.

/** Per-step Δt cap (seconds): pause gaps (lights, watch auto-pause) are clamped
 *  to this so a long gap can't inflate load — the clamped time still counts, the
 *  step is NOT dropped. TUNABLE. */
export const TRAINING_LOAD_DT_CLAMP_SEC = 10;

/** Minimum fraction of points carrying a valid HR for streaming to engage;
 *  below this we fall back to the avg-HR model. TUNABLE. */
export const STREAMED_HR_COVERAGE_MIN = 0.5;

/** Minimum number of hrStream samples required to score a non-route workout
 *  from its streamed HR integral. Below this (or an empty/absent stream despite
 *  the hasHRStream flag) the compute path falls through to the avg-HR baseline.
 *  Matches computeStreamedTrainingLoad's own `< 2` degenerate guard. TUNABLE. */
export const MIN_HRSTREAM_SAMPLES = 2;

export interface StreamedLoadResult {
  load: number | null;
  method: "streamed" | "avg-hr-fallback";
  /** fraction of points carrying a finite hr, 0..1 */
  hrCoverage: number;
}

/**
 * Streamed Banister TRIMP from per-point HR samples. Reuses the SAME
 * `bannisterWeight`, `TRAINING_LOAD_V2_SCALE`, and `activityLoadFactor` as the
 * avg-HR model — single source of truth, no duplicated constants.
 *
 * Behavior:
 *  - hrCoverage = (points with finite hr) / (total points).
 *  - If hrCoverage < STREAMED_HR_COVERAGE_MIN OR points.length < 2 → fall back to
 *    `computeTrainingLoadV2` (method "avg-hr-fallback").
 *  - Otherwise integrate over timestamp-sorted consecutive pairs:
 *      dt = (t[i+1] − t[i]) sec; dt ≤ 0 → skip; dt > clamp → dt = clamp.
 *      hr = hr at point i, carrying forward the last valid hr; skip until one exists.
 *      rawStep = (dt/60) × hrr × bannisterWeight(hrr), hrr clamped to [0,1].
 *    load = round(Σ rawStep × TRAINING_LOAD_V2_SCALE × activityFactor).
 *  - Null guards (method stays "streamed"): maxHr ≤ restingHr → null;
 *    durationSeconds ≤ 0 / non-finite → null.
 *
 * Pure — no Firestore, no fetching.
 */
export function computeStreamedTrainingLoad(
  points: { timestamp: string; hr: number | null }[],
  durationSeconds: number,
  avgHeartRate: number | null | undefined,
  maxHr: number,
  restingHr: number,
  activityType?: string
): StreamedLoadResult {
  const total = points.length;
  const validHrCount = points.reduce(
    (acc, p) => acc + (p.hr != null && isFinite(p.hr) ? 1 : 0),
    0
  );
  const hrCoverage = total > 0 ? validHrCount / total : 0;

  // Sparse / degenerate → avg-HR baseline.
  if (hrCoverage < STREAMED_HR_COVERAGE_MIN || total < 2) {
    return {
      load: computeTrainingLoadV2(
        durationSeconds,
        avgHeartRate,
        maxHr,
        restingHr,
        activityType
      ),
      method: "avg-hr-fallback",
      hrCoverage,
    };
  }

  // Same null guards as the avg-HR V2 model.
  const reserve = maxHr - restingHr;
  if (!isFinite(reserve) || reserve <= 0) {
    return { load: null, method: "streamed", hrCoverage };
  }
  if (!durationSeconds || durationSeconds <= 0 || !isFinite(durationSeconds)) {
    return { load: null, method: "streamed", hrCoverage };
  }

  // Sort by timestamp ascending; drop points whose timestamp won't parse.
  const seq = points
    .map((p) => ({ tMs: Date.parse(p.timestamp), hr: p.hr }))
    .filter((p) => Number.isFinite(p.tMs))
    .sort((a, b) => a.tMs - b.tMs);

  let rawSum = 0;
  let lastValidHr: number | null = null;
  for (let i = 0; i < seq.length - 1; i++) {
    // Carry-forward hr at point i: update when this point has a valid sample.
    if (seq[i].hr != null && isFinite(seq[i].hr as number)) {
      lastValidHr = seq[i].hr as number;
    }
    if (lastValidHr == null) continue; // no valid hr yet → skip the step

    let dt = (seq[i + 1].tMs - seq[i].tMs) / 1000;
    if (dt <= 0) continue;
    if (dt > TRAINING_LOAD_DT_CLAMP_SEC) dt = TRAINING_LOAD_DT_CLAMP_SEC;

    const hrr = Math.max(0, Math.min(1, (lastValidHr - restingHr) / reserve));
    rawSum += (dt / 60) * hrr * bannisterWeight(hrr);
  }

  // HIIT/OTF factor uses the session's AVERAGE HRR (a single per-session scalar
  // from avgHeartRate), NOT a per-sample factor — the per-sample integral
  // (rawSum) is the base load; only the multiplicative factor changes. When
  // avgHeartRate is unusable, pass undefined so HIIT falls back to 0.75 and
  // non-HIIT types are unaffected.
  const avgHrrForFactor =
    avgHeartRate != null && isFinite(avgHeartRate) && avgHeartRate > 0
      ? Math.max(0, Math.min(1, (avgHeartRate - restingHr) / reserve))
      : undefined;
  const load = Math.round(
    rawSum *
      TRAINING_LOAD_V2_SCALE *
      activityLoadFactor(activityType, avgHrrForFactor)
  );
  return { load, method: "streamed", hrCoverage };
}

export type TrainingLoadStatus = "low" | "moderate" | "hard" | "very-hard";

/** Map a score to a colour bucket for the badge background. */
export function trainingLoadStatus(score: number): TrainingLoadStatus {
  if (score < 40) return "low";
  if (score < 80) return "moderate";
  if (score < 150) return "hard";
  return "very-hard";
}

export const TRAINING_LOAD_STATUS_LABEL: Record<TrainingLoadStatus, string> = {
  low: "easy",
  moderate: "moderate",
  hard: "hard",
  "very-hard": "very hard",
};
