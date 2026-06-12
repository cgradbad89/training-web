import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetchWeatherForRun, wmoCodeToText } from "./weather";

/**
 * A well-formed Open-Meteo archive hourly body. Times are naive UTC strings —
 * the API's default when no `timezone` param is sent — and every hourly array
 * is index-parallel. Index 1 is the 06:00 slot.
 */
function archiveBody(
  overrides: Record<string, unknown[]> = {}
): { hourly: Record<string, unknown[]> } {
  return {
    hourly: {
      time: ["2026-06-07T05:00", "2026-06-07T06:00", "2026-06-07T07:00"],
      temperature_2m: [50, 60, 70],
      apparent_temperature: [48, 58, 68],
      relative_humidity_2m: [80, 70, 60],
      dew_point_2m: [44, 49, 54],
      wind_speed_10m: [5, 8, 11],
      weather_code: [0, 3, 61],
      ...overrides,
    },
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe("fetchWeatherForRun", () => {
  // 6:42 AM UTC falls inside the 06:00 hourly slot (index 1 of archiveBody).
  const runAt642 = new Date("2026-06-07T06:42:00Z");

  it("returns a valid WeatherSnapshot from a well-formed response", async () => {
    mockFetch.mockResolvedValue(okResponse(archiveBody()));

    const snap = await fetchWeatherForRun(40.7, -74.0, runAt642);

    expect(snap).not.toBeNull();
    expect(snap).toMatchObject({
      tempF: 60,
      feelsLikeF: 58,
      humidity: 70,
      windMph: 8,
      dewPointF: 49,
      conditionCode: 3,
      conditionText: "Overcast",
    });
    // fetchedAt is a parseable ISO timestamp string.
    expect(snap?.fetchedAt).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(snap?.fetchedAt ?? ""))).toBe(false);

    // Requested the archive API with the °F + mph unit params.
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("archive-api.open-meteo.com/v1/archive");
    expect(url).toContain("temperature_unit=fahrenheit");
    expect(url).toContain("wind_speed_unit=mph");
  });

  it("matches the slot containing the run start (6:42 → 6:00, not the nearer 7:00)", async () => {
    mockFetch.mockResolvedValue(okResponse(archiveBody()));

    const snap = await fetchWeatherForRun(40.7, -74.0, runAt642);

    // Index 1 (06:00) values — NOT index 2 (07:00), even though 6:42 is fewer
    // minutes from 7:00. Floor-to-containing-hour, not round-to-nearest.
    expect(snap?.tempF).toBe(60);
    expect(snap?.conditionCode).toBe(3);
  });

  it("returns null on a network error (fetch rejects)", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    expect(await fetchWeatherForRun(40.7, -74.0, runAt642)).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    expect(await fetchWeatherForRun(40.7, -74.0, runAt642)).toBeNull();
  });

  it("returns null on a malformed response (no hourly data)", async () => {
    mockFetch.mockResolvedValue(okResponse({ error: true, reason: "bad" }));
    expect(await fetchWeatherForRun(40.7, -74.0, runAt642)).toBeNull();
  });

  it("returns null when the matched hourly slot has missing values", async () => {
    // temperature_2m is null at the matched index → snapshot can't be built.
    mockFetch.mockResolvedValue(
      okResponse(archiveBody({ temperature_2m: [50, null, 70] }))
    );
    expect(await fetchWeatherForRun(40.7, -74.0, runAt642)).toBeNull();
  });
});

describe("wmoCodeToText", () => {
  it.each<[number, string]>([
    [0, "Clear sky"],
    [3, "Overcast"],
    [61, "Slight rain"],
    [80, "Slight rain showers"],
    [95, "Thunderstorm"],
  ])("maps WMO code %i to '%s'", (code, text) => {
    expect(wmoCodeToText(code)).toBe(text);
  });
});
