/**
 * WeatherSnapshot — historical weather conditions at the start of a run,
 * fetched from the Open-Meteo archive API and persisted on the
 * users/{uid}/healthWorkouts/{workoutId} document under the `weather` field.
 *
 * All numeric fields are stored at full API precision; rounding for display
 * (e.g. integer mph / °F) happens at render time in WeatherTile.
 */
export interface WeatherSnapshot {
  /** Air temperature, °F */
  tempF: number;
  /** Apparent ("feels like") temperature, °F */
  feelsLikeF: number;
  /** Relative humidity, 0–100 percent */
  humidity: number;
  /** Wind speed, mph */
  windMph: number;
  /** Dew point, °F */
  dewPointF: number;
  /** Human-readable condition, e.g. "Partly cloudy" (derived from conditionCode) */
  conditionText: string;
  /** Raw WMO weather code from Open-Meteo (0–99) */
  conditionCode: number;
  /** ISO-8601 timestamp of when this snapshot was fetched */
  fetchedAt: string;
}
