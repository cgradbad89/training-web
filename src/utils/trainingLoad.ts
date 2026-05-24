/**
 * Training Load — TRIMP-inspired effort score.
 *
 * Combines duration with heart-rate intensity via 5 HR zones. The user's
 * max HR is fixed at 185 bpm; zones are defined as % of max HR with rising
 * multipliers so harder + longer efforts score higher than easy jogs.
 *
 * Zone boundaries (% of MAX_HR = 185):
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

export const MAX_HR = 185;

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
//   HIIT / OTF                               → factor 0.75
//   Strength (traditional lifting, cooldown) → factor 0.25
//   Mindful (Pilates, yoga, barre, etc.)     → factor 0.20
//
// Strength lifted to 0.25 — validated against Strava RE. Mindful /
// low-cardiovascular activities stay at 0.20.
export const HIIT_LOAD_FACTOR = 0.75;
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
  context: ActivityContext
): { min: number; maxLabel: string } {
  const zones = WORKOUT_ZONES[context];
  const idx = zones.findIndex((x) => x.zone === z.zone);
  const min = Math.ceil(z.minPct * MAX_HR);
  const maxLabel =
    idx === zones.length - 1
      ? `${Math.ceil(z.minPct * MAX_HR)}+`
      : `${Math.floor(z.maxPct * MAX_HR)}`;
  return { min, maxLabel };
}

/** Pick the zone for an avg HR inside a given activity context. */
export function getHRZoneForActivity(
  bpm: number,
  context: ActivityContext
): HRZone {
  const zones = WORKOUT_ZONES[context];
  const pct = bpm / MAX_HR;
  return zones.find((z) => pct < z.maxPct) ?? zones[zones.length - 1];
}

/** Inclusive-min, exclusive-max bpm bounds (Zone 5 is open-ended). */
export function zoneBoundsBpm(z: HRZone): { min: number; maxLabel: string } {
  const min = Math.ceil(z.minPct * MAX_HR);
  const maxLabel =
    z.zone === HR_ZONES.length
      ? `${Math.ceil(z.minPct * MAX_HR)}+`
      : `${Math.floor(z.maxPct * MAX_HR)}`;
  return { min, maxLabel };
}

/** Pick the zone for an avg HR. Falls back to the Max zone for HRs ≥ 90%. */
export function getHRZone(bpm: number): HRZone {
  const pct = bpm / MAX_HR;
  return HR_ZONES.find((z) => pct < z.maxPct) ?? HR_ZONES[HR_ZONES.length - 1];
}

/**
 * Narrow-typed zone classifier for callers that only need the zone number
 * (1–5) and want it as a union. Delegates to the running-context thresholds
 * in HR_ZONES — does not duplicate any boundary constants.
 */
export type HRZoneNumber = 1 | 2 | 3 | 4 | 5;

export function classifyHrZone(bpm: number): HRZoneNumber {
  const z = getHRZone(bpm).zone;
  // HR_ZONES is fixed at 5 entries with zones 1..5, so this narrowing is safe.
  return Math.min(5, Math.max(1, z)) as HRZoneNumber;
}

/**
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
  activityType?: string | null
): number | null {
  if (!avgHeartRate || avgHeartRate <= 0) return null;
  if (!durationSeconds || durationSeconds <= 0) return null;
  if (!isFinite(avgHeartRate) || !isFinite(durationSeconds)) return null;
  const durationMinutes = durationSeconds / 60;
  const context = activityType ? getActivityContext(activityType) : "running";
  const zone = getHRZoneForActivity(avgHeartRate, context);
  const trimp = durationMinutes * zone.multiplier;

  // Post-TRIMP scaling: TRIMP over-credits duration at low HR for non-aerobic
  // activities. Mindful (Pilates/yoga/etc.) is checked first as the strictest
  // subset of the strength allowlist; remaining strength types (traditional
  // lifting, cooldown) fall through to STRENGTH_LOAD_FACTOR. HIIT/OTF is
  // detected separately because it shares running HR zone bands.
  let factor = 1.0;
  if (activityType && isMindfulActivity(activityType)) {
    factor = MINDFUL_LOAD_FACTOR;
  } else if (context === "strength") {
    factor = STRENGTH_LOAD_FACTOR;
  } else if (activityType && isHiitLikeActivity(activityType)) {
    factor = HIIT_LOAD_FACTOR;
  }
  return Math.round(trimp * factor);
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
