import { type HealthWorkout } from "@/types/healthWorkout";

export interface PrResult {
  pace: number;
  miles: number;
  date: Date;
}

export interface SpecificPrResult extends PrResult {
  totalSeconds: number;
}

export interface PersonalRecordsByYear {
  prs: (PrResult | null)[];
  specificPrs: (SpecificPrResult | null)[];
}

const prBuckets = [
  { label: "1–3 mi", filter: (m: number) => m >= 1.0 && m < 3.0 },
  { label: "3–6 mi", filter: (m: number) => m >= 3.0 && m < 6.0 },
  { label: "6–7 mi", filter: (m: number) => m >= 6.0 && m < 7.0 },
  { label: "7–10 mi", filter: (m: number) => m >= 7.0 && m < 10.0 },
  { label: "10+ mi", filter: (m: number) => m >= 10.0 },
];

const specificDistances = [
  { label: "5K", targetMiles: 3.107, tolerance: 0.3 },
  { label: "5 Miles", targetMiles: 5.0, tolerance: 0.5 },
  { label: "10K", targetMiles: 6.214, tolerance: 0.5 },
  { label: "15K", targetMiles: 9.321, tolerance: 0.75 },
  { label: "10 Miles", targetMiles: 10.0, tolerance: 0.75 },
  { label: "Half Marathon", targetMiles: 13.109, tolerance: 1.0 },
];

export function buildPersonalRecordsByYear(
  workouts: HealthWorkout[],
  selectedYear: number
): PersonalRecordsByYear {
  const yearRuns = workouts.filter(
    (r) => r.startDate.getFullYear() === selectedYear
  );

  const prs = prBuckets.map((bucket) => {
    const qualifying = yearRuns
      .filter((r) => r.distanceMiles > 0 && bucket.filter(r.distanceMiles))
      .map((r) => {
        const pace = r.durationSeconds / r.distanceMiles;
        return { pace, miles: r.distanceMiles, date: r.startDate };
      })
      .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

    if (qualifying.length === 0) return null;
    return qualifying.reduce((best, cur) =>
      cur.pace < best.pace ? cur : best
    );
  });

  const specificPrs = specificDistances.map((dist) => {
    const candidates = yearRuns
      .filter(
        (r) =>
          r.distanceMiles >= dist.targetMiles - dist.tolerance &&
          r.distanceMiles <= dist.targetMiles + dist.tolerance &&
          r.durationSeconds > 0
      )
      .map((r) => ({
        pace: r.durationSeconds / r.distanceMiles,
        totalSeconds: r.durationSeconds,
        miles: r.distanceMiles,
        date: r.startDate,
      }))
      .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

    if (candidates.length === 0) return null;
    return candidates.reduce((best, cur) =>
      cur.pace < best.pace ? cur : best
    );
  });

  return { prs, specificPrs };
}
