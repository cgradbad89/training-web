import { type HealthWorkout } from "@/types/healthWorkout";
import { selectRuns } from "@/utils/runSelection";

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
  // Defense in depth: PRs are run-only. Callers may pass every workout (the
  // live other-year path does); HIIT/OTF/cycling distance must never win a row.
  const yearRuns = selectRuns(workouts).filter(
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

export interface PrYearOption {
  year: number;
  runCount: number;
}

/**
 * Years offered by the Personal Records year selector: every local calendar
 * year with at least one run, plus the current local year (even when it has no
 * runs yet, e.g. Jan 1), newest first. Pure; computed from already-loaded
 * workouts (non-run workouts are ignored).
 */
export function buildPrYearOptions(
  runs: HealthWorkout[],
  currentYear: number
): PrYearOption[] {
  const counts = new Map<number, number>([[currentYear, 0]]);
  for (const run of runs) {
    if (!run.isRunLike) continue;
    const year = run.startDate.getFullYear();
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return Array.from(counts, ([year, runCount]) => ({ year, runCount })).sort(
    (a, b) => b.year - a.year
  );
}
