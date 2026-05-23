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
 */
export function computeTrainingLoad(
  durationSeconds: number,
  avgHeartRate: number | null | undefined
): number | null {
  if (!avgHeartRate || avgHeartRate <= 0) return null;
  if (!durationSeconds || durationSeconds <= 0) return null;
  if (!isFinite(avgHeartRate) || !isFinite(durationSeconds)) return null;
  const durationMinutes = durationSeconds / 60;
  const zone = getHRZone(avgHeartRate);
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
