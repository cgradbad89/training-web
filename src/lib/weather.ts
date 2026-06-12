import { type WeatherSnapshot } from "@/types/weather";

/**
 * Open-Meteo historical weather (free, no API key). We fetch the conditions at
 * a run's start location + time and persist them on the workout document.
 *
 * Docs: https://open-meteo.com/en/docs/historical-weather-api
 */
const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";

const HOURLY_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "wind_speed_10m",
  "weather_code",
] as const;

/**
 * Canonical WMO weather-code → text mapping (Open-Meteo's documented table).
 * Covers the codes the archive API emits; anything unmapped resolves to
 * "Unknown" via wmoCodeToText().
 */
const WMO_CODE_TEXT: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

/** Map a WMO weather code to human-readable text; unknown codes → "Unknown". */
export function wmoCodeToText(code: number): string {
  return WMO_CODE_TEXT[code] ?? "Unknown";
}

/**
 * Map a WMO weather code to a condition emoji, using the same category
 * boundaries as wmoCodeToText so the icon always agrees with the text.
 * Consumed by WeatherTile.
 */
export function wmoCodeToEmoji(code: number): string {
  if (code === 0 || code === 1) return "☀️"; // clear / mainly clear
  if (code === 2) return "⛅"; // partly cloudy
  if (code === 3) return "☁️"; // overcast
  if (code === 45 || code === 48) return "🌫️"; // fog
  if (code >= 51 && code <= 57) return "🌦️"; // drizzle
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "🌧️"; // rain
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "❄️"; // snow
  if (code >= 95) return "⛈️"; // thunderstorm
  return "☁️"; // neutral fallback
}

/** Format a Date as the UTC YYYY-MM-DD calendar date for the archive query. */
function toUTCDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Read a finite number at index `i` of a possibly-malformed array, else null. */
function numAt(arr: unknown, i: number): number | null {
  if (!Array.isArray(arr)) return null;
  const v = arr[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Fetch historical weather at a run's start location + time from the Open-Meteo
 * archive API. Returns null on ANY failure (network error, non-2xx, malformed
 * body, or a missing/empty hourly slot) — never throws.
 *
 * Hour-matching: the archive API returns one entry per clock hour in UTC (we
 * pass no `timezone` param, so the default is GMT). We select the slot that
 * CONTAINS the run's start instant — i.e. floor to the hour — so a 6:42 run
 * resolves to the 6:00 slot, the weather during the hour the run began.
 */
export async function fetchWeatherForRun(
  lat: number,
  lng: number,
  startTimestamp: Date
): Promise<WeatherSnapshot | null> {
  try {
    const date = toUTCDate(startTimestamp);
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      start_date: date,
      end_date: date,
      hourly: HOURLY_FIELDS.join(","),
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
    });

    const res = await fetch(`${ARCHIVE_API}?${params.toString()}`);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      hourly?: {
        time?: unknown;
        temperature_2m?: unknown;
        apparent_temperature?: unknown;
        relative_humidity_2m?: unknown;
        dew_point_2m?: unknown;
        wind_speed_10m?: unknown;
        weather_code?: unknown;
      };
    };

    const hourly = data?.hourly;
    const times = hourly?.time;
    if (!hourly || !Array.isArray(times) || times.length === 0) return null;

    // Floor to the hourly slot containing the run's start (UTC frame). Open-Meteo
    // returns naive UTC strings ("2026-06-07T06:00"); parse as UTC by suffixing Z.
    const runMs = startTimestamp.getTime();
    let idx = -1;
    let bestMs = -Infinity;
    let earliestIdx = -1;
    let earliestMs = Infinity;
    for (let i = 0; i < times.length; i++) {
      const slotMs = Date.parse(`${String(times[i])}Z`);
      if (Number.isNaN(slotMs)) continue;
      if (slotMs < earliestMs) {
        earliestMs = slotMs;
        earliestIdx = i;
      }
      if (slotMs <= runMs && slotMs > bestMs) {
        bestMs = slotMs;
        idx = i;
      }
    }
    // Run precedes every available slot → fall back to the earliest hour.
    if (idx === -1) idx = earliestIdx;
    if (idx === -1) return null;

    const tempF = numAt(hourly.temperature_2m, idx);
    const feelsLikeF = numAt(hourly.apparent_temperature, idx);
    const humidity = numAt(hourly.relative_humidity_2m, idx);
    const windMph = numAt(hourly.wind_speed_10m, idx);
    const dewPointF = numAt(hourly.dew_point_2m, idx);
    const conditionCode = numAt(hourly.weather_code, idx);

    if (
      tempF === null ||
      feelsLikeF === null ||
      humidity === null ||
      windMph === null ||
      dewPointF === null ||
      conditionCode === null
    ) {
      return null;
    }

    return {
      tempF,
      feelsLikeF,
      humidity,
      windMph,
      dewPointF,
      conditionCode,
      conditionText: wmoCodeToText(conditionCode),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
