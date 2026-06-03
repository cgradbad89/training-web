import { DEFAULT_MAX_HR } from "@/utils/trainingLoad";

/**
 * Heart-rate and pace zone bucketing for a single run.
 *
 * HR zones are the standard 5-zone model as a percentage of max HR
 * (maxHR = 220 − age). Pace zones are based on the user's threshold pace:
 * the faster the pace relative to threshold, the higher the zone.
 */

export interface ZoneBucket {
  /** 1..5 */
  zone: number;
  label: string;
  /** Seconds spent in this zone */
  seconds: number;
  /** Percent of total time, 0..100 */
  pct: number;
}

/**
 * Used when the user's age is unknown (no age/DOB field exists in the app).
 * Aligned to the Training Load default so HR-zone math is consistent across
 * the app.
 */
export const FALLBACK_MAX_HR = DEFAULT_MAX_HR;

/** HR zone boundaries as fractions of max HR (standard 5-zone model). */
export const HR_ZONE_BOUNDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const;

const HR_ZONE_LABELS = [
  "Z1 50–60%",
  "Z2 60–70%",
  "Z3 70–80%",
  "Z4 80–90%",
  "Z5 90–100%",
];

export type PaceZoneNumber = 1 | 2 | 3 | 4 | 5;

export interface PaceZoneResult {
  zone: PaceZoneNumber;
  label: "Recovery" | "Easy" | "Threshold" | "Interval" | "Repetition";
  secondsInZone: number;
  percent: number;
}

export interface PaceZoneRange {
  zone: PaceZoneNumber;
  label: PaceZoneResult["label"];
  /** Faster edge of the range. Null means open-ended faster than this band. */
  minPaceSecPerMile: number | null;
  /** Slower edge of the range. Null means open-ended slower than this band. */
  maxPaceSecPerMile: number | null;
}

/**
 * Threshold-pace zone bands expressed as pace / threshold pace.
 *
 * ratio > 1 means slower than threshold pace. These are standard-style
 * threshold-pace approximations for run intensity: easy running is much slower
 * than threshold, while interval/repetition work is faster than threshold.
 * A ratio of exactly 1.0 (pace equals threshold pace) is Z3 Threshold.
 */
export const PACE_ZONE_RATIO_BOUNDS = {
  recoveryMin: 1.2, // Z1 Recovery: ratio >= 1.20
  easyMin: 1.1, // Z2 Easy: 1.10 <= ratio < 1.20
  thresholdMin: 0.97, // Z3 Threshold: 0.97 <= ratio < 1.10
  intervalMin: 0.9, // Z4 Interval: 0.90 <= ratio < 0.97
  // Z5 Repetition: ratio < 0.90
} as const;

export const PACE_ZONE_LABELS: PaceZoneResult["label"][] = [
  "Recovery",
  "Easy",
  "Threshold",
  "Interval",
  "Repetition",
];

/** Actual-pace anomaly filter shared in intent with RunOverlayChart. */
export const MAX_VALID_PACE_SEC_PER_MILE = 1800;

/** maxHR = 220 − age, or FALLBACK_MAX_HR when age is unavailable. */
export function maxHRForAge(age: number | null): number {
  return age && age > 0 ? 220 - age : FALLBACK_MAX_HR;
}

/** Map a bpm value to a 1..5 HR zone given max HR. */
export function hrZoneIndex(bpm: number, maxHR: number): number {
  const frac = bpm / maxHR;
  if (frac < 0.6) return 1; // <60% (incl. <50% recovery) counts as Z1
  if (frac < 0.7) return 2;
  if (frac < 0.8) return 3;
  if (frac < 0.9) return 4;
  return 5;
}

function finalizeBuckets(
  seconds: number[],
  labels: string[]
): ZoneBucket[] {
  const total = seconds.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return seconds.map((s, i) => ({
    zone: i + 1,
    label: labels[i],
    seconds: s,
    pct: (s / total) * 100,
  }));
}

/**
 * Time-in-zone from per-sample HR. Each sample carries the duration attributed
 * to it (time until the next route point). Returns [] when no valid HR data.
 */
export function computeHRZones(
  samples: { bpm: number; seconds: number }[],
  maxHR: number
): ZoneBucket[] {
  const secondsByZone = [0, 0, 0, 0, 0];
  for (const { bpm, seconds } of samples) {
    if (!isFinite(bpm) || bpm < 40 || bpm > 220) continue;
    if (!isFinite(seconds) || seconds <= 0) continue;
    const z = hrZoneIndex(bpm, maxHR);
    secondsByZone[z - 1] += seconds;
  }
  return finalizeBuckets(secondsByZone, HR_ZONE_LABELS);
}

function paceZoneForRatio(ratio: number): PaceZoneNumber {
  if (ratio >= PACE_ZONE_RATIO_BOUNDS.recoveryMin) return 1;
  if (ratio >= PACE_ZONE_RATIO_BOUNDS.easyMin) return 2;
  if (ratio >= PACE_ZONE_RATIO_BOUNDS.thresholdMin) return 3;
  if (ratio >= PACE_ZONE_RATIO_BOUNDS.intervalMin) return 4;
  return 5;
}

export function paceZoneRanges(
  thresholdPaceSecPerMile: number
): PaceZoneRange[] {
  if (!isFinite(thresholdPaceSecPerMile) || thresholdPaceSecPerMile <= 0) {
    return [];
  }

  const t = thresholdPaceSecPerMile;
  const {
    recoveryMin,
    easyMin,
    thresholdMin,
    intervalMin,
  } = PACE_ZONE_RATIO_BOUNDS;

  return [
    {
      zone: 1,
      label: "Recovery",
      minPaceSecPerMile: recoveryMin * t,
      maxPaceSecPerMile: null,
    },
    {
      zone: 2,
      label: "Easy",
      minPaceSecPerMile: easyMin * t,
      maxPaceSecPerMile: recoveryMin * t,
    },
    {
      zone: 3,
      label: "Threshold",
      minPaceSecPerMile: thresholdMin * t,
      maxPaceSecPerMile: easyMin * t,
    },
    {
      zone: 4,
      label: "Interval",
      minPaceSecPerMile: intervalMin * t,
      maxPaceSecPerMile: thresholdMin * t,
    },
    {
      zone: 5,
      label: "Repetition",
      minPaceSecPerMile: null,
      maxPaceSecPerMile: intervalMin * t,
    },
  ];
}

/**
 * Threshold-based pace zones from actual per-point pace.
 *
 * Each segment's elapsed time is attributed to the earlier point's pace, which
 * mirrors the HR-zone time-weighting pattern. GAP is intentionally not used:
 * this is actual pace relative to the user's threshold pace.
 */
export function computePaceZones(
  perPointPaceSecPerMile: (number | null)[],
  perPointTimestampsSec: number[],
  thresholdPaceSecPerMile: number
): PaceZoneResult[] {
  if (
    thresholdPaceSecPerMile <= 0 ||
    !isFinite(thresholdPaceSecPerMile) ||
    perPointPaceSecPerMile.length < 2 ||
    perPointTimestampsSec.length < 2
  ) {
    return [];
  }

  const secondsByZone = [0, 0, 0, 0, 0];
  const n = Math.min(
    perPointPaceSecPerMile.length,
    perPointTimestampsSec.length
  );

  for (let i = 0; i < n - 1; i++) {
    const pace = perPointPaceSecPerMile[i];
    const dt = perPointTimestampsSec[i + 1] - perPointTimestampsSec[i];
    if (!isFinite(dt) || dt <= 0) continue;
    if (
      pace == null ||
      !isFinite(pace) ||
      pace <= 0 ||
      pace > MAX_VALID_PACE_SEC_PER_MILE
    ) {
      continue;
    }

    const ratio = pace / thresholdPaceSecPerMile;
    const zone = paceZoneForRatio(ratio);
    secondsByZone[zone - 1] += dt;
  }

  const total = secondsByZone.reduce((sum, seconds) => sum + seconds, 0);
  if (total <= 0) return [];

  return secondsByZone.map((secondsInZone, i) => ({
    zone: (i + 1) as PaceZoneNumber,
    label: PACE_ZONE_LABELS[i],
    secondsInZone,
    percent: (secondsInZone / total) * 100,
  }));
}
