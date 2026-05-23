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

// ─── Activity context — running vs OTF vs strength ──────────────────────────
//
// Strength work peaks HR lower than running for the same perceived effort,
// and OTF (mixed treadmill + floor) sits between. We shift the zone bands
// for these contexts so the Load score reads similarly across activities:
// 120 bpm on a strength session shouldn't read "Recovery" the way 120 bpm
// on a long run does.

export type ActivityContext = "running" | "otf" | "strength";

export const ACTIVITY_CONTEXT_LABEL: Record<ActivityContext, string> = {
  running: "Running",
  // OTF + HIIT use the running zone set — treadmill intervals routinely push
  // HR to running-equivalent intensity, so the same bands score them fairly.
  otf: "OTF / High Intensity",
  strength: "Strength",
};

/**
 * Map a HealthKit activityType string to a TRIMP zone-set context. Defaults
 * to "strength" when the activityType is missing — Load shouldn't read as a
 * run if the source data is unclear, and strength's lower boundaries are
 * the conservative pick.
 *
 * "otf" is the catch-all bucket for high-intensity interval / mixed-cardio
 * formats; it now shares the running zone set so a 60-min OTF at 145 bpm
 * scores the same as a 60-min run at 145 bpm rather than being inflated.
 */
export function getActivityContext(
  activityType: string | null | undefined
): ActivityContext {
  if (!activityType) return "strength";
  const t = activityType.toLowerCase().trim();

  // OTF + every HIIT / mixed-cardio family that peaks at running-equivalent
  // intensity. All of these route to the running zone set via WORKOUT_ZONES.
  if (
    t.includes("orangetheory") ||
    t.includes("orange_theory") ||
    t.includes("highintensityintervaltraining") ||
    t.includes("high_intensity_interval_training") ||
    t.includes("hiit") ||
    t.includes("intervaltraining") ||
    t.includes("interval_training") ||
    t.includes("cardio") ||              // mixedCardio, cardioTraining, etc.
    t.includes("kickboxing") ||
    t.includes("boxing") ||
    t.includes("crossfit") ||
    t.includes("cross_fit") ||
    t.includes("bootcamp") ||
    t.includes("boot_camp") ||
    t.includes("rowing") ||              // rowing machine = cardio intensity
    t.includes("elliptical") ||
    t.includes("stairclimbing") ||
    t.includes("stair_climbing") ||
    t.includes("jumpingrope") ||
    t.includes("jump_rope")
  ) {
    return "otf";
  }

  // Continuous-cardio family — running, walking, hiking, cycling, swimming.
  // These share the running zone set because HR responds in a similar
  // steady-state way to sustained aerobic work.
  if (
    t.includes("run") ||
    t.includes("walk") ||
    t.includes("hike") ||
    t.includes("cycling") ||
    t.includes("ride") ||
    t.includes("swim")
  ) {
    return "running";
  }

  // Everything else (strength, core, yoga, pilates, dance, etc.) — HR peaks
  // lower per unit of effort.
  return "strength";
}

/** Per-context zone sets. Running and OTF share the same bands because
 *  treadmill intervals reach running-equivalent intensity; only strength
 *  shifts the boundaries downward so a strength session at 120 bpm reads
 *  as harder effort than a long run at 120 bpm. */
export const WORKOUT_ZONES: Record<ActivityContext, HRZone[]> = {
  running: HR_ZONES,
  // OTF / HIIT / cardio formats route here and reuse the running zones.
  otf: HR_ZONES,
  strength: [
    { zone: 1, minPct: 0,    maxPct: 0.50, multiplier: 1.0, label: "Recovery"  },
    { zone: 2, minPct: 0.50, maxPct: 0.62, multiplier: 1.5, label: "Aerobic"   },
    { zone: 3, minPct: 0.62, maxPct: 0.70, multiplier: 2.5, label: "Tempo"     },
    { zone: 4, minPct: 0.70, maxPct: 0.80, multiplier: 4.0, label: "Threshold" },
    { zone: 5, minPct: 0.80, maxPct: 1.00, multiplier: 6.5, label: "Max"       },
  ],
};

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
 * Compute Training Load. Returns null when HR or duration is missing/invalid,
 * matching the existing "—" behaviour of the efficiency score it replaces.
 *
 * `activityType` is optional; when provided, zone bands shift per the
 * WORKOUT_ZONES table (running / otf / strength). When omitted, falls back
 * to the running zone set so existing call sites keep their behaviour.
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
  return Math.round(durationMinutes * zone.multiplier);
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
