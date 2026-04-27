/**
 * Run metric calculations — mirrors iOS WorkoutsFeature derived metric logic.
 *
 * NOTE: HR Drift, Run Efficiency, and Cadence are computed from raw HealthKit
 * samples on iPhone. The web app reads pre-computed values from Firestore when
 * available; these utilities support display formatting and threshold lookups.
 */

// Distance buckets (mirrors iOS WorkoutViewHelpers)
export type DistanceBucket = "short" | "medium" | "long";

export function distanceBucket(miles: number): DistanceBucket {
  if (miles < 3) return "short";   // 1–3 mi
  if (miles < 6) return "medium";  // 3–6 mi
  return "long";                   // 6+ mi
}

// ─── HR Drift ────────────────────────────────────────────────────────────────
// Formula: ((secondHalfAvgHR - firstHalfAvgHR) / firstHalfAvgHR) * 100
// Requires minimum 20 min OR 2.0 mi to compute on device.

export type DriftLevel = "good" | "ok" | "high";

const DRIFT_THRESHOLDS: Record<DistanceBucket, { good: number; ok: number }> = {
  short:  { good: 5,  ok: 10 },
  medium: { good: 7,  ok: 12 },
  long:   { good: 10, ok: 15 },
};

export function driftLevel(drift: number, bucket: DistanceBucket): DriftLevel {
  const t = DRIFT_THRESHOLDS[bucket];
  if (drift <= t.good) return "good";
  if (drift <= t.ok) return "ok";
  return "high";
}

// ─── Run Efficiency ──────────────────────────────────────────────────────────
// raw = speed_mps / avgHR_bpm
// score = raw * 1000
// display 1–10 = 1 + ((score - 14) / 6) * 9, clamped [1, 10]

export function efficiencyDisplayScore(speedMps: number, avgHR: number): number {
  if (!speedMps || !avgHR) return 0;
  const raw = speedMps / avgHR;
  const score = raw * 1000;
  const display = 1 + ((score - 14) / 6) * 9;
  return Math.min(10, Math.max(1, display));
}

export type EfficiencyLevel = "good" | "ok" | "low";

/**
 * rawScore = (speed_mps / avgHR) * 1000
 * Expected range ~14–20. This is the pre-normalized value, NOT the 1–10 display scale.
 */
const EFFICIENCY_THRESHOLDS: Record<DistanceBucket, { good: number; ok: number }> = {
  short:  { good: 18.5, ok: 17.0 },
  medium: { good: 17.5, ok: 16.0 },
  long:   { good: 16.5, ok: 15.0 },
};

export function efficiencyLevel(rawScore: number, bucket: DistanceBucket): EfficiencyLevel {
  const t = EFFICIENCY_THRESHOLDS[bucket];
  if (rawScore >= t.good) return "good";
  if (rawScore >= t.ok) return "ok";
  return "low";
}

// ─── Distance-adjusted display tiers ─────────────────────────────────────────
// These operate on the 1–10 display score (not the raw 14–20 score) and are
// used for the badge color + tooltip ranges in the runs list, run detail, and
// dashboard. Longer efforts have lower expected scores because fatigue and
// heat drift are part of the territory.

export interface EfficiencyTier {
  label: string;
  /** Inclusive lower bound on the 1–10 display score. */
  min: number;
  color: "success" | "warning" | "danger";
}

export interface EfficiencyTierSet {
  tierLabel: string;
  tiers: EfficiencyTier[];
}

/** Tiers depend on the distance bucket. < 3 mi short, 3–8 mi medium, 8+ mi long. */
export function getEfficiencyTiers(distanceMiles: number): EfficiencyTierSet {
  if (distanceMiles < 3) {
    return {
      tierLabel: "Short run (< 3 mi)",
      tiers: [
        { label: "Elite",     min: 10.0, color: "success" },
        { label: "Good",      min: 7.0,  color: "success" },
        { label: "Average",   min: 5.0,  color: "warning" },
        { label: "Below avg", min: 3.0,  color: "warning" },
        { label: "Poor",      min: 0,    color: "danger"  },
      ],
    };
  }
  if (distanceMiles < 8) {
    return {
      tierLabel: "Medium run (3–8 mi)",
      tiers: [
        { label: "Elite",     min: 9.0,  color: "success" },
        { label: "Good",      min: 6.5,  color: "success" },
        { label: "Average",   min: 4.5,  color: "warning" },
        { label: "Below avg", min: 2.5,  color: "warning" },
        { label: "Poor",      min: 0,    color: "danger"  },
      ],
    };
  }
  return {
    tierLabel: "Long run (8+ mi)",
    tiers: [
      { label: "Elite",     min: 8.0,  color: "success" },
      { label: "Good",      min: 5.5,  color: "success" },
      { label: "Average",   min: 4.0,  color: "warning" },
      { label: "Below avg", min: 2.0,  color: "warning" },
      { label: "Poor",      min: 0,    color: "danger"  },
    ],
  };
}

/** Map the display score (1–10) to the correct MetricBadge level using the
 *  distance-adjusted tiers. Tier color "success" → good, "warning" → ok,
 *  "danger" → low. */
export function efficiencyTierLevel(
  displayScore: number,
  distanceMiles: number
): EfficiencyLevel {
  const { tiers } = getEfficiencyTiers(distanceMiles);
  for (const tier of tiers) {
    if (displayScore >= tier.min) {
      return tier.color === "success"
        ? "good"
        : tier.color === "warning"
          ? "ok"
          : "low";
    }
  }
  return "low";
}

// ─── Cadence ─────────────────────────────────────────────────────────────────
// Primary: stepCount / (duration_s / 60)
// Fallback: (speed_mps / strideLength_m) * 60

export type CadenceLevel = "good" | "ok" | "low";

const CADENCE_THRESHOLDS: Record<DistanceBucket, { good: number; ok: number }> = {
  short:  { good: 170, ok: 160 },
  medium: { good: 168, ok: 158 },
  long:   { good: 165, ok: 155 },
};

export function cadenceLevel(spm: number, bucket: DistanceBucket): CadenceLevel {
  const t = CADENCE_THRESHOLDS[bucket];
  if (spm >= t.good) return "good";
  if (spm >= t.ok) return "ok";
  return "low";
}

// ─── Training Load ───────────────────────────────────────────────────────────
// Acute: 7-day rolling miles; Chronic: 30-day rolling miles
// Ratio = acute / chronic

export type TrainingLoadLevel = "stable" | "building" | "aggressive" | "deload";

export function trainingLoadLevel(ratio: number): TrainingLoadLevel {
  if (ratio < 0.8) return "deload";
  if (ratio <= 1.1) return "stable";
  if (ratio <= 1.4) return "building";
  return "aggressive";
}
