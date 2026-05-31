/**
 * Heart-rate and pace zone bucketing for a single run.
 *
 * HR zones are the standard 5-zone model as a percentage of max HR
 * (maxHR = 220 − age). Pace zones are RUN-RELATIVE: they are derived from the
 * run's own grade-adjusted-pace distribution (quintiles), NOT from a
 * threshold/race-time configuration, because no such config exists in the app.
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

/** Used when the user's age is unknown (no age/DOB field exists in the app). */
export const FALLBACK_MAX_HR = 190;

/** HR zone boundaries as fractions of max HR (standard 5-zone model). */
export const HR_ZONE_BOUNDS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const;

const HR_ZONE_LABELS = [
  "Z1 50–60%",
  "Z2 60–70%",
  "Z3 70–80%",
  "Z4 80–90%",
  "Z5 90–100%",
];

const PACE_ZONE_LABELS = [
  "Z1 Fastest",
  "Z2 Fast",
  "Z3 Moderate",
  "Z4 Easy",
  "Z5 Slowest",
];

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

/**
 * Run-relative pace zones from grade-adjusted-pace samples. Zone boundaries are
 * the 20/40/60/80th percentiles of the run's own GAP values (quintiles), so
 * Z1 = the run's fastest fifth and Z5 = its slowest fifth. Returns [] when no
 * valid samples. NOTE: these are relative to THIS run, not threshold-based.
 */
export function computePaceZones(
  samples: { gapSecPerMile: number; seconds: number }[]
): ZoneBucket[] {
  const valid = samples.filter(
    (s) =>
      isFinite(s.gapSecPerMile) &&
      s.gapSecPerMile > 0 &&
      isFinite(s.seconds) &&
      s.seconds > 0
  );
  if (valid.length === 0) return [];

  const sorted = valid.map((s) => s.gapSecPerMile).sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const t = [pct(0.2), pct(0.4), pct(0.6), pct(0.8)];

  const zoneOf = (gap: number): number => {
    if (gap <= t[0]) return 1;
    if (gap <= t[1]) return 2;
    if (gap <= t[2]) return 3;
    if (gap <= t[3]) return 4;
    return 5;
  };

  const secondsByZone = [0, 0, 0, 0, 0];
  for (const s of valid) {
    secondsByZone[zoneOf(s.gapSecPerMile) - 1] += s.seconds;
  }
  return finalizeBuckets(secondsByZone, PACE_ZONE_LABELS);
}
