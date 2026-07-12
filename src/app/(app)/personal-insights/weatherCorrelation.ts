import { type HealthWorkout } from "@/types/healthWorkout";

/**
 * Weather-impact correlation data for the Personal Insights "Weather impact"
 * section. Pure, presentation-agnostic transforms over the already-fetched
 * `workouts` array (AppDataContext) — no Firestore reads.
 *
 * Pace uses the page's established per-workout formula (durationSeconds /
 * distanceMiles, seconds-per-mile) — the same one PR/pace sections use — never
 * a new formula. Temperature comes from the persisted `weather.tempF`
 * snapshot. Running-type workouts only (isRunLike).
 */
export interface WeatherCorrelationPoint {
  workoutId: string;
  tempF: number;
  paceSecPerMile: number;
  avgHeartRate: number | null;
  date: string; // YYYY-MM-DD (local)
}

/** Local YYYY-MM-DD (avoids the UTC shift of Date.toISOString on local dates). */
function toLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Build the scatter-point set for the weather charts:
 *  - running-type workouts only (isRunLike)
 *  - startDate within the last `rangeDays` (inclusive) relative to `now`
 *  - a non-null, finite `weather.tempF`
 *  - a computable pace (distanceMiles > 0, durationSeconds > 0, finite)
 *
 * `avgHeartRate` is passed through as-is (may be null). Points with a null HR
 * are still returned here — the pace chart uses every point; the HR chart
 * filters null HR out at its own layer (see hrPoints in WeatherImpactSection).
 *
 * `now` is injectable for deterministic tests; defaults to the current time.
 */
export function buildWeatherCorrelationData(
  workouts: HealthWorkout[],
  rangeDays: 180 | 365,
  now: Date = new Date(),
): WeatherCorrelationPoint[] {
  const cutoff = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  const points: WeatherCorrelationPoint[] = [];
  for (const w of workouts) {
    if (!w.isRunLike) continue;
    if (w.startDate < cutoff || w.startDate > now) continue;

    const tempF = w.weather?.tempF;
    if (typeof tempF !== "number" || !isFinite(tempF)) continue;

    // Established per-workout pace: seconds per mile.
    if (!(w.distanceMiles > 0) || !(w.durationSeconds > 0)) continue;
    const paceSecPerMile = w.durationSeconds / w.distanceMiles;
    if (!isFinite(paceSecPerMile) || paceSecPerMile <= 0) continue;

    points.push({
      workoutId: w.workoutId,
      tempF,
      paceSecPerMile,
      avgHeartRate: w.avgHeartRate,
      date: toLocalYMD(w.startDate),
    });
  }
  return points;
}

/**
 * Ordinary least-squares linear fit over {x, y} points.
 * Returns { slope, intercept } for y = slope·x + intercept, or null when there
 * are fewer than 2 points (or the x-values have zero variance, which would
 * divide by zero) so callers can skip drawing a trend line.
 */
export function computeLinearTrend(
  points: { x: number; y: number }[],
): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null; // all x equal — vertical/undefined slope

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}
