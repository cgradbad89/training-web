import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WeatherSnapshot } from "@/types/weather";
import {
  EMPTY_WEATHER_LEDGER,
  WEATHER_AUTO_LOOKBACK_DAYS,
  WEATHER_LEDGER_MAX_ENTRIES,
  WEATHER_RATE_LIMIT_PAUSE_MS,
  WEATHER_SETTLE_MS,
  claimWeatherWork,
  clearWeatherFailure,
  isUsableStartCoordinate,
  parseWeatherLedger,
  pauseWeatherProvider,
  planWeatherRecovery,
  recordWeatherFailure,
  releaseWeatherWork,
  selectWeatherCandidates,
  weatherEligibility,
} from "../weatherBackfill";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-07T15:00:00Z");

const WEATHER: WeatherSnapshot = {
  tempF: 50, feelsLikeF: 48, humidity: 70, windMph: 5, dewPointF: 40,
  conditionCode: 1, conditionText: "Mainly clear", fetchedAt: "2026-11-01T12:00:00.000Z",
};

function run(id: string, startMs: number, overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: id, name: "Run", activityType: "HKWorkoutActivityTypeRunning", displayType: "Run",
    startDate: new Date(startMs), endDate: new Date(startMs + 45 * 60_000), durationSeconds: 2700,
    sourceName: "Watch", isRunLike: true, hasRoute: true, syncedAt: new Date(startMs), calories: 400,
    avgHeartRate: 150, distanceMiles: 5, distanceMeters: 8047, avgPaceSecPerMile: 540, avgSpeedMPS: 3,
    hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...overrides,
  } as HealthWorkout;
}

const old = NOW - 2 * DAY;

describe("weatherEligibility", () => {
  const options = { now: NOW, lookbackDays: WEATHER_AUTO_LOOKBACK_DAYS };

  it("accepts an outdoor GPS run with no weather", () => {
    expect(weatherEligibility(run("a", old), options)).toEqual({ eligible: true });
  });

  it("preserves existing weather (any stored snapshot blocks acquisition)", () => {
    expect(weatherEligibility(run("a", old, { weather: WEATHER }), options)).toEqual({ eligible: false, reason: "has-weather" });
  });

  it("treats explicit null as missing", () => {
    expect(weatherEligibility(run("a", old, { weather: null }), options).eligible).toBe(true);
  });

  it.each([
    ["not-run", { isRunLike: false }],
    ["manual-entry", { entrySource: "manual" as const }],
    ["no-route", { hasRoute: false }],
    ["indoor", { displayType: "Treadmill Run" }],
    ["indoor", { displayType: "Indoor Run" }],
  ])("skips %s", (reason, patch) => {
    expect(weatherEligibility(run("a", old, patch as Partial<HealthWorkout>), options)).toEqual({ eligible: false, reason });
  });

  it("honors the owner's run-type override in both directions", () => {
    const treadmillByType = run("a", old, { displayType: "Run" });
    expect(weatherEligibility(treadmillByType, { ...options, override: { isExcluded: false, runTypeOverride: "treadmill" } })).toEqual({ eligible: false, reason: "indoor" });
    const outdoorByOverride = run("b", old, { displayType: "Treadmill Run" });
    expect(weatherEligibility(outdoorByOverride, { ...options, override: { isExcluded: false, runTypeOverride: "outdoor" } }).eligible).toBe(true);
  });

  it("skips excluded workouts", () => {
    expect(weatherEligibility(run("a", old), { ...options, override: { isExcluded: true, runTypeOverride: null } })).toEqual({ eligible: false, reason: "excluded" });
  });

  it("waits for the settle delay after the run ends", () => {
    const justFinished = run("a", NOW - 50 * 60_000); // ended 5 minutes ago
    expect(weatherEligibility(justFinished, options)).toEqual({ eligible: false, reason: "too-recent" });
    const settled = run("b", NOW - WEATHER_SETTLE_MS - 46 * 60_000);
    expect(weatherEligibility(settled, options).eligible).toBe(true);
  });

  it("rejects invalid dates without throwing", () => {
    expect(weatherEligibility(run("a", old, { startDate: new Date(NaN) }), options)).toEqual({ eligible: false, reason: "invalid-dates" });
    expect(weatherEligibility(run("a", old, { endDate: new Date(old - HOUR) }), options)).toEqual({ eligible: false, reason: "invalid-dates" });
  });

  it("applies the automatic window but not for recovery planning", () => {
    const ancient = run("a", NOW - (WEATHER_AUTO_LOOKBACK_DAYS + 1) * DAY);
    expect(weatherEligibility(ancient, options)).toEqual({ eligible: false, reason: "outside-window" });
    expect(weatherEligibility(ancient, { ...options, lookbackDays: null }).eligible).toBe(true);
  });

  it("is deterministic across a DST transition (instants, not local days)", () => {
    // 2026-11-01 05:30Z is the ambiguous 1:30 AM hour in US Eastern. Eligibility
    // depends only on instants, so the answer is identical in any time zone.
    const dstRun = run("dst", Date.parse("2026-11-01T05:30:00Z"));
    expect(weatherEligibility(dstRun, options).eligible).toBe(true);
  });
});

describe("failure ledger", () => {
  it("backs off transient failures on an escalating ladder", () => {
    let ledger = EMPTY_WEATHER_LEDGER;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      ledger = recordWeatherFailure(ledger, "a", "transient", NOW);
      delays.push(ledger.entries.a.nextAttemptAt - NOW);
    }
    expect(delays.slice(0, 5)).toEqual([HOUR, 6 * HOUR, 24 * HOUR, 3 * DAY, 7 * DAY]);
    expect(delays[5]).toBe(7 * DAY); // capped
    expect(ledger.entries.a.failures).toBe(7);
  });

  it("backs off a missing start point much more slowly", () => {
    const ledger = recordWeatherFailure(EMPTY_WEATHER_LEDGER, "a", "no-start-point", NOW);
    expect(ledger.entries.a.nextAttemptAt - NOW).toBe(12 * HOUR);
  });

  it("keeps a cooling-down workout out of selection until the cooldown expires", () => {
    const ledger = recordWeatherFailure(EMPTY_WEATHER_LEDGER, "a", "transient", NOW);
    const workouts = [run("a", old)];
    expect(selectWeatherCandidates(workouts, { now: NOW + 30 * 60_000, ledger })).toEqual([]);
    expect(selectWeatherCandidates(workouts, { now: NOW + HOUR + 1, ledger })).toEqual(["a"]);
  });

  it("clears an entry on success and does not mutate the input", () => {
    const failed = recordWeatherFailure(EMPTY_WEATHER_LEDGER, "a", "transient", NOW);
    const cleared = clearWeatherFailure(failed, "a");
    expect(cleared.entries.a).toBeUndefined();
    expect(failed.entries.a).toBeDefined();
    expect(clearWeatherFailure(cleared, "a")).toBe(cleared);
  });

  it("a provider pause blocks every candidate until it expires", () => {
    const paused = pauseWeatherProvider(EMPTY_WEATHER_LEDGER, NOW);
    const workouts = [run("a", old), run("b", old - DAY)];
    expect(selectWeatherCandidates(workouts, { now: NOW + HOUR, ledger: paused })).toEqual([]);
    expect(selectWeatherCandidates(workouts, { now: NOW + WEATHER_RATE_LIMIT_PAUSE_MS + 1, ledger: paused })).toHaveLength(2);
  });

  it("bounds the ledger size", () => {
    let ledger = EMPTY_WEATHER_LEDGER;
    for (let i = 0; i < WEATHER_LEDGER_MAX_ENTRIES + 25; i++) {
      ledger = recordWeatherFailure(ledger, `w${i}`, "transient", NOW + i);
    }
    expect(Object.keys(ledger.entries)).toHaveLength(WEATHER_LEDGER_MAX_ENTRIES);
    expect(ledger.entries[`w${WEATHER_LEDGER_MAX_ENTRIES + 24}`]).toBeDefined();
  });

  it("parses persisted state defensively", () => {
    const good = recordWeatherFailure(EMPTY_WEATHER_LEDGER, "a", "transient", NOW);
    expect(parseWeatherLedger(JSON.stringify(good)).entries.a.failures).toBe(1);
    for (const bad of [null, "", "{", "[]", JSON.stringify({ version: 2 }), 42]) {
      expect(parseWeatherLedger(bad)).toEqual(EMPTY_WEATHER_LEDGER);
    }
    const mixed = parseWeatherLedger({ version: 1, pausedUntil: "x", entries: { ok: { failures: 1, nextAttemptAt: 5, kind: "transient" }, bad: { failures: "1" } } });
    expect(Object.keys(mixed.entries)).toEqual(["ok"]);
    expect(mixed.pausedUntil).toBe(0);
  });
});

describe("selectWeatherCandidates", () => {
  it("is newest-first, bounded, idempotent and ignores settled ids", () => {
    const workouts = [run("old", NOW - 20 * DAY), run("new", NOW - 1 * DAY), run("mid", NOW - 5 * DAY), run("has", NOW - 2 * DAY, { weather: WEATHER })];
    expect(selectWeatherCandidates(workouts, { now: NOW, limit: 2 })).toEqual(["new", "mid"]);
    expect(selectWeatherCandidates(workouts, { now: NOW, limit: 2 })).toEqual(["new", "mid"]);
    expect(selectWeatherCandidates(workouts, { now: NOW, limit: 5, exclude: new Set(["new"]) })).toEqual(["mid", "old"]);
    expect(selectWeatherCandidates(workouts, { now: NOW, limit: 0 })).toEqual([]);
  });

  it("breaks start-time ties by id for a stable order", () => {
    const workouts = [run("b", old), run("a", old)];
    expect(selectWeatherCandidates(workouts, { now: NOW })).toEqual(["a", "b"]);
  });
});

describe("isUsableStartCoordinate", () => {
  it.each([
    [40.7, -74, true],
    [0, 0, false],
    [91, 10, false],
    [10, 181, false],
    [NaN, 1, false],
    ["1", 1, false],
    [undefined, undefined, false],
    [0, 12, true],
  ])("(%s, %s) → %s", (lat, lng, expected) => {
    expect(isUsableStartCoordinate(lat, lng)).toBe(expected);
  });
});

describe("in-tab work claims", () => {
  it("allows exactly one owner per workout until released", () => {
    expect(claimWeatherWork("claim-1")).toBe(true);
    expect(claimWeatherWork("claim-1")).toBe(false);
    releaseWeatherWork("claim-1");
    expect(claimWeatherWork("claim-1")).toBe(true);
    releaseWeatherWork("claim-1");
  });
});

describe("planWeatherRecovery", () => {
  it("counts without executing and separates automatic from explicit recovery", () => {
    const workouts = [
      run("have", NOW - 3 * DAY, { weather: WEATHER }),
      run("recent", NOW - 3 * DAY),
      run("ancient1", NOW - 200 * DAY),
      run("ancient2", NOW - 400 * DAY),
      run("indoor", NOW - 3 * DAY, { displayType: "Treadmill Run" }),
      run("nogps", NOW - 3 * DAY, { hasRoute: false }),
      run("fresh", NOW - 10 * 60_000),
      run("strength", NOW - 3 * DAY, { isRunLike: false }),
    ];
    const plan = planWeatherRecovery(workouts, { now: NOW });
    expect(plan).toMatchObject({
      runLike: 7, alreadyHaveWeather: 1, automaticallyRecoverable: 1, requiresExplicitRecovery: 2,
      skippedByReason: { "has-weather": 1, indoor: 1, "no-route": 1, "too-recent": 1 },
      estimate: { weatherApiCalls: 3, routeDocumentReads: 3, workoutDocumentWrites: 3, daysAtDailyApiBudget: 1 },
    });
  });

  it("contains no workout identifiers or coordinates", () => {
    const json = JSON.stringify(planWeatherRecovery([run("secret-id", old)], { now: NOW }));
    expect(json).not.toContain("secret-id");
    expect(json).not.toMatch(/lat|lng/i);
  });
});
