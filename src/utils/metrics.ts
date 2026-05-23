/**
 * Run metric calculations — mirrors iOS WorkoutsFeature derived metric logic.
 *
 * NOTE: HR Drift and Cadence are computed from raw HealthKit samples on
 * iPhone. The web app reads pre-computed values from Firestore when
 * available; these utilities support display formatting and threshold lookups.
 *
 * The historical Run Efficiency score (speed/HR-derived 1–10 metric) was
 * removed and replaced by Training Load (TRIMP) — see src/utils/trainingLoad.ts.
 * The "trainingLoadLevel" function in this file is unrelated: it's the
 * acute/chronic mileage ratio used for the dashboard's load-trend tile.
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
