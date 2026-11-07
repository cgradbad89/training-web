/**
 * Phase 3J — one bounded pass of automatic weather acquisition.
 *
 * `runWeatherBackfillPass` is dependency-injected so every branch (success,
 * existing weather, no GPS, rate limit, cancellation, failure backoff) is unit
 * tested without Firestore or the network. The React wrapper is
 * `src/components/WeatherBackfillRunner.tsx`.
 *
 * Cost per attempted workout: 1 route-document read (first point only), 1
 * Open-Meteo request, and on success 1 transactional workout read + 1 write.
 * Never reads the GPS track, the HR stream, or any other collection.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { WeatherFetchResult } from "@/lib/weather";
import {
  WEATHER_CALL_SPACING_MS,
  WEATHER_PASS_LIMIT,
  claimWeatherWork,
  clearWeatherFailure,
  isUsableStartCoordinate,
  pauseWeatherProvider,
  recordWeatherFailure,
  releaseWeatherWork,
  selectWeatherCandidates,
  type WeatherLedger,
} from "@/utils/weatherBackfill";
import type { SaveWeatherOutcome } from "@/services/healthWorkouts";

export interface WeatherPassDeps {
  getStartPoint: (workoutId: string) => Promise<{ lat: number; lng: number } | null>;
  fetchWeather: (lat: number, lng: number, start: Date, signal?: AbortSignal) => Promise<WeatherFetchResult>;
  saveIfAbsent: (workoutId: string, weather: Extract<WeatherFetchResult, { status: "ok" }>["weather"]) => Promise<SaveWeatherOutcome>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface WeatherPassInput {
  workouts: readonly HealthWorkout[];
  overrides?: Record<string, WorkoutOverride>;
  ledger: WeatherLedger;
  /** Ids this session has already finished with (success or preserved). */
  settled: Set<string>;
  limit?: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}

/** Counts only — no coordinates, no timestamps of runs. */
export interface WeatherPassSummary {
  selected: number;
  saved: number;
  preserved: number;
  noStartPoint: number;
  unavailable: number;
  failed: number;
  rateLimited: boolean;
  cancelled: boolean;
}

export interface WeatherPassResult {
  ledger: WeatherLedger;
  summary: WeatherPassSummary;
}

export async function runWeatherBackfillPass(
  input: WeatherPassInput,
  deps: WeatherPassDeps
): Promise<WeatherPassResult> {
  let ledger = input.ledger;
  const summary: WeatherPassSummary = {
    selected: 0, saved: 0, preserved: 0, noStartPoint: 0, unavailable: 0, failed: 0,
    rateLimited: false, cancelled: false,
  };
  const byId = new Map(input.workouts.map((w) => [w.workoutId, w]));
  const ids = selectWeatherCandidates(input.workouts, {
    now: deps.now(),
    limit: input.limit ?? WEATHER_PASS_LIMIT,
    overrides: input.overrides,
    ledger,
    exclude: input.settled,
  });

  let first = true;
  for (const id of ids) {
    if (!input.isCurrent() || input.signal?.aborted) { summary.cancelled = true; break; }
    // Another caller in this tab (Run Detail, a previous pass) already owns it.
    if (!claimWeatherWork(id)) continue;
    try {
      const workout = byId.get(id)!;
      summary.selected += 1;
      if (!first) await deps.sleep(WEATHER_CALL_SPACING_MS);
      first = false;
      if (!input.isCurrent() || input.signal?.aborted) { summary.cancelled = true; break; }

      const start = await deps.getStartPoint(id);
      if (!input.isCurrent()) { summary.cancelled = true; break; }
      if (!start || !isUsableStartCoordinate(start.lat, start.lng)) {
        summary.noStartPoint += 1;
        ledger = recordWeatherFailure(ledger, id, "no-start-point", deps.now());
        continue;
      }

      const result = await deps.fetchWeather(start.lat, start.lng, workout.startDate, input.signal);
      if (!input.isCurrent()) { summary.cancelled = true; break; }
      if (result.status === "aborted") { summary.cancelled = true; break; }
      if (result.status === "rate-limited") {
        summary.rateLimited = true;
        ledger = pauseWeatherProvider(ledger, deps.now());
        break;
      }
      if (result.status === "unavailable") {
        summary.unavailable += 1;
        ledger = recordWeatherFailure(ledger, id, "transient", deps.now());
        continue;
      }
      if (result.status === "error") {
        summary.failed += 1;
        ledger = recordWeatherFailure(ledger, id, "transient", deps.now());
        continue;
      }

      try {
        const outcome = await deps.saveIfAbsent(id, result.weather);
        if (outcome === "saved") summary.saved += 1;
        else if (outcome === "preserved") summary.preserved += 1;
        else summary.failed += 1; // document vanished; nothing to retry meaningfully
        input.settled.add(id);
        ledger = clearWeatherFailure(ledger, id);
      } catch {
        summary.failed += 1;
        ledger = recordWeatherFailure(ledger, id, "transient", deps.now());
      }
    } catch {
      summary.failed += 1;
      ledger = recordWeatherFailure(ledger, id, "transient", deps.now());
    } finally {
      releaseWeatherWork(id);
    }
  }
  return { ledger, summary };
}
