import { type HealthWorkout } from "@/types/healthWorkout";
import { weekStart } from "@/utils/dates";

export interface PaceTrendWeek {
  label: string;
  short: number | null;
  medium: number | null;
  long: number | null;
}

export function buildPaceTrendsByDistanceBucket(
  workouts: HealthWorkout[],
  weeks: number,
  asOf: Date = new Date()
): PaceTrendWeek[] {
  const currentMonday = weekStart(asOf);

  return Array.from({ length: weeks }, (_, i) => {
    const weekDate = new Date(currentMonday);
    weekDate.setDate(weekDate.getDate() - (weeks - 1 - i) * 7);
    const weekEndDate = new Date(weekDate);
    weekEndDate.setDate(weekDate.getDate() + 6);
    weekEndDate.setHours(23, 59, 59, 999);

    const weekRuns = workouts.filter(
      (r) => r.startDate >= weekDate && r.startDate <= weekEndDate
    );

    function avgPace(bucket: HealthWorkout[]): number | null {
      let totalSec = 0,
        totalMi = 0;
      bucket.forEach((r) => {
        if (r.distanceMiles <= 0) return;
        const sec = r.durationSeconds / r.distanceMiles;
        if (!isFinite(sec) || sec <= 0) return;
        totalSec += sec * r.distanceMiles;
        totalMi += r.distanceMiles;
      });
      return totalMi > 0 ? totalSec / totalMi : null;
    }

    const short = weekRuns.filter(
      (r) => r.distanceMiles >= 1 && r.distanceMiles < 3
    );
    const medium = weekRuns.filter(
      (r) => r.distanceMiles >= 3 && r.distanceMiles < 6
    );
    const long = weekRuns.filter((r) => r.distanceMiles >= 6);

    const label = weekDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    return {
      label,
      short: avgPace(short),
      medium: avgPace(medium),
      long: avgPace(long),
    };
  });
}
