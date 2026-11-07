import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetchWeatherForRun, fetchWeatherForRunDetailed, wmoCodeToText } from "./weather";

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

describe("fetchWeatherForRunDetailed", () => {
  const runAt642 = new Date("2026-06-07T06:42:00Z");

  it("reports ok with the snapshot", async () => {
    mockFetch.mockResolvedValue(okResponse(archiveBody()));
    const result = await fetchWeatherForRunDetailed(40.7, -74, runAt642);
    expect(result.status).toBe("ok");
  });

  it("distinguishes rate limiting (429) from other HTTP errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    expect((await fetchWeatherForRunDetailed(40.7, -74, runAt642)).status).toBe("rate-limited");
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    expect((await fetchWeatherForRunDetailed(40.7, -74, runAt642)).status).toBe("error");
  });

  it("reports unavailable (never a partial snapshot) when the slot has gaps", async () => {
    mockFetch.mockResolvedValue(okResponse(archiveBody({ weather_code: [0, null, 61] })));
    expect((await fetchWeatherForRunDetailed(40.7, -74, runAt642)).status).toBe("unavailable");
    mockFetch.mockResolvedValue(okResponse({ hourly: { time: [] } }));
    expect((await fetchWeatherForRunDetailed(40.7, -74, runAt642)).status).toBe("unavailable");
  });

  it("rejects non-finite coordinates and invalid dates without calling the network", async () => {
    expect((await fetchWeatherForRunDetailed(NaN, -74, runAt642)).status).toBe("unavailable");
    expect((await fetchWeatherForRunDetailed(40, -74, new Date(NaN))).status).toBe("unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps an aborted request to 'aborted' and forwards the signal", async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
      controller.abort();
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return okResponse(archiveBody());
    });
    const result = await fetchWeatherForRunDetailed(40.7, -74, runAt642, { signal: controller.signal });
    expect(result.status).toBe("aborted");
  });

  it("selects the UTC hour containing the start across a DST boundary (US fall-back)", async () => {
    // 2026-11-01 05:30Z = 1:30 AM EDT (first pass) — the slot is chosen purely in UTC.
    mockFetch.mockResolvedValue(okResponse(archiveBody({
      time: ["2026-11-01T04:00", "2026-11-01T05:00", "2026-11-01T06:00"],
      temperature_2m: [41, 42, 43],
    })));
    const result = await fetchWeatherForRunDetailed(40.7, -74, new Date("2026-11-01T05:30:00Z"));
    expect(result.status === "ok" && result.weather.tempF).toBe(42);
    expect(String(mockFetch.mock.calls[0][0])).toContain("start_date=2026-11-01");
  });
});
