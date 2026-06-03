import { type HealthWorkout } from "@/types/healthWorkout";
import {
  BEST_EFFORT_DISTANCES_M,
  EMPTY_BEST_EFFORTS,
  METERS_PER_MILE,
  type BestEffortKey,
} from "@/utils/bestEfforts";

export interface BestEffortRecord {
  distanceKey: BestEffortKey;
  timeSeconds: number;
  paceSecPerMile: number;
  workoutId: string;
  date: string; // ISO date of the source run
  isRecent: boolean; // set within the last RECENT_PR_DAYS
}

export const RECENT_PR_DAYS = 30;

const BEST_EFFORT_KEYS = Object.keys(EMPTY_BEST_EFFORTS) as BestEffortKey[];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeBestEffortRecords(
  runs: HealthWorkout[],
  today: Date
): Record<BestEffortKey, BestEffortRecord | null> {
  const records = Object.fromEntries(
    BEST_EFFORT_KEYS.map((key) => [key, null])
  ) as Record<BestEffortKey, BestEffortRecord | null>;
  const todayMs = today.getTime();

  for (const run of runs) {
    const startMs = run.startDate.getTime();
    if (!Number.isFinite(startMs)) continue;

    for (const key of BEST_EFFORT_KEYS) {
      const timeSeconds = run.bestEfforts?.[key];
      if (timeSeconds == null || !Number.isFinite(timeSeconds) || timeSeconds <= 0) {
        continue;
      }

      const existing = records[key];
      // Ties keep the earliest source date: the PR was first achieved then.
      if (
        existing &&
        (timeSeconds > existing.timeSeconds ||
          (timeSeconds === existing.timeSeconds && startMs >= Date.parse(existing.date)))
      ) {
        continue;
      }

      const daysSince = (todayMs - startMs) / MS_PER_DAY;
      records[key] = {
        distanceKey: key,
        timeSeconds,
        paceSecPerMile:
          timeSeconds / (BEST_EFFORT_DISTANCES_M[key] / METERS_PER_MILE),
        workoutId: run.workoutId,
        date: run.startDate.toISOString(),
        isRecent: daysSince >= 0 && daysSince <= RECENT_PR_DAYS,
      };
    }
  }

  return records;
}
