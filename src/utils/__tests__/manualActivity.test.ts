import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  buildManualActivityFields,
  createManualActivityId,
  emptyManualActivityForm,
  findPossibleDuplicates,
  formValuesFromWorkout,
  kindFromActivityType,
  localDateTimeToInstant,
  manualPaceSecPerMile,
  MANUAL_ACTIVITY_KIND_ORDER,
  MANUAL_ACTIVITY_KINDS,
  parseManualActivityForm,
  validateManualActivityInput,
  type ManualActivityFormValues,
  type ManualActivityInput,
} from "@/utils/manualActivity";
import { toLocalIsoDate } from "@/utils/dates";

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const originalTz = process.env.TZ;

function input(overrides: Partial<ManualActivityInput> = {}): ManualActivityInput {
  return {
    kind: "outdoor_run", localDate: "2026-10-10", localTime: "07:30",
    durationSeconds: 1800, distanceMiles: 3, avgHeartRate: null, calories: null,
    title: null, notes: null, ...overrides,
  };
}

function form(overrides: Partial<ManualActivityFormValues> = {}): ManualActivityFormValues {
  return {
    kind: "outdoor_run", date: "2026-10-10", time: "07:30", hours: "0", minutes: "30", seconds: "0",
    distanceMiles: "3", avgHeartRate: "", calories: "", title: "", notes: "", ...overrides,
  };
}

function existing(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "HK-1", name: "Run", activityType: "running", displayType: "Run",
    startDate: new Date(2026, 9, 10, 7, 35), endDate: new Date(2026, 9, 10, 8, 5),
    durationSeconds: 1800, sourceName: "Apple Watch", isRunLike: true, hasRoute: true,
    syncedAt: new Date(), calories: 0, avgHeartRate: null, distanceMiles: 3,
    distanceMeters: 4828, avgPaceSecPerMile: 600, avgSpeedMPS: 2.7, hrDriftPct: null,
    cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...overrides,
  };
}

describe("activity kinds map onto existing identifiers", () => {
  it.each([
    ["outdoor_run", "running", "Run", true],
    ["treadmill_run", "treadmill_running", "Treadmill Run", true],
    ["walking", "walking", "Walk", false],
    ["cycling", "cycling", "Cycling", false],
    ["strength", "traditional_strength_training", "Strength", false],
    ["hiit", "high_intensity_interval_training", "HIIT", false],
    ["pilates", "pilates", "Pilates", false],
    ["yoga", "yoga", "Yoga", false],
    ["other", "workout", "Workout", false],
  ] as const)("%s → %s / %s / isRunLike=%s", (kind, activityType, displayType, isRunLike) => {
    const fields = buildManualActivityFields(input({
      kind,
      distanceMiles: MANUAL_ACTIVITY_KINDS[kind].distance === "none" ? null : 3,
    }));
    expect(fields).toMatchObject({ activityType, displayType, isRunLike });
    expect(kindFromActivityType(activityType)).toBe(kind);
  });

  it("covers exactly the nine requested selections", () => {
    expect(MANUAL_ACTIVITY_KIND_ORDER).toHaveLength(9);
  });
});

describe("the stored document fabricates nothing", () => {
  it("marks provenance and absent telemetry, and omits everything unmeasured", () => {
    const fields = buildManualActivityFields(input());
    expect(fields).toMatchObject({
      entrySource: "manual", source: "manual", sourceName: "Manual Entry",
      hasRoute: false, hasHRStream: false,
    });
    for (const absent of [
      "routeComplete", "cadenceSPM", "elevationGainM", "hrDriftPct", "weather",
      "bestEfforts", "trainingLoadV2", "avgHeartRate", "calories", "customTitle", "notes",
    ]) {
      expect(fields).not.toHaveProperty(absent);
    }
  });

  it("never writes syncedAt, because iOS anchors incremental sync on the newest one", () => {
    expect(buildManualActivityFields(input())).not.toHaveProperty("syncedAt");
  });

  it("derives pace, speed and metres from duration and distance", () => {
    const fields = buildManualActivityFields(input({ durationSeconds: 1800, distanceMiles: 3 }));
    expect(fields.avgPaceSecPerMile).toBe(600);
    expect(fields.distanceMeters).toBeCloseTo(4828.032, 3);
    expect(fields.avgSpeedMPS).toBeCloseTo(4828.032 / 1800, 6);
  });

  it("omits distance fields entirely on a non-distance activity", () => {
    const fields = buildManualActivityFields(input({ kind: "yoga", distanceMiles: null }));
    for (const absent of ["distanceMiles", "distanceMeters", "avgPaceSecPerMile", "avgSpeedMPS"]) {
      expect(fields).not.toHaveProperty(absent);
    }
  });

  it("writes optional metrics only when supplied", () => {
    expect(buildManualActivityFields(input({ avgHeartRate: 150, calories: 400, title: "Trail", notes: "Hilly" })))
      .toMatchObject({ avgHeartRate: 150, calories: 400, customTitle: "Trail", notes: "Hilly" });
  });

  it("generates collision-resistant namespaced IDs", () => {
    const a = createManualActivityId();
    expect(a).toMatch(/^manual_[0-9a-f-]{36}$/);
    expect(a).not.toBe(createManualActivityId());
  });
});

describe("validation", () => {
  it("accepts a complete run with optional fields omitted", () => {
    expect(validateManualActivityInput(input(), NOW)).toEqual({});
  });

  it("requires distance for runs but not for optional-distance workouts", () => {
    expect(validateManualActivityInput(input({ distanceMiles: null }), NOW).distance).toMatch(/distance/i);
    expect(validateManualActivityInput(input({ kind: "walking", distanceMiles: null }), NOW)).toEqual({});
  });

  it.each([0, -5, NaN, Infinity])("rejects duration %s", (durationSeconds) => {
    expect(validateManualActivityInput(input({ durationSeconds }), NOW).duration).toBeTruthy();
  });

  it("rejects a duration beyond 24 hours", () => {
    expect(validateManualActivityInput(input({ durationSeconds: 86401 }), NOW).duration).toMatch(/24 hours/);
  });

  it.each([0, -1, NaN, Infinity, 501])("rejects distance %s", (distanceMiles) => {
    expect(validateManualActivityInput(input({ distanceMiles }), NOW).distance).toBeTruthy();
  });

  it("rejects an impossible pace", () => {
    expect(validateManualActivityInput(input({ durationSeconds: 300, distanceMiles: 10 }), NOW).distance)
      .toMatch(/pace/i);
  });

  it.each([24, 251, NaN, -80])("rejects average heart rate %s", (avgHeartRate) => {
    expect(validateManualActivityInput(input({ avgHeartRate }), NOW).avgHeartRate).toBeTruthy();
  });

  it.each([0, -10, NaN, 20001])("rejects calories %s", (calories) => {
    expect(validateManualActivityInput(input({ calories }), NOW).calories).toBeTruthy();
  });

  it("rejects future starts and activities that would end in the future", () => {
    expect(validateManualActivityInput(input({ localDate: "2026-10-16" }), NOW).time).toMatch(/future/);
    expect(validateManualActivityInput(
      input({ localDate: "2026-10-15", localTime: "11:45", durationSeconds: 1800 }), NOW
    ).duration).toMatch(/future/);
  });

  it("rejects malformed and rolled-over dates", () => {
    expect(validateManualActivityInput(input({ localDate: "2026-02-30" }), NOW).date).toBeTruthy();
    expect(validateManualActivityInput(input({ localDate: "not-a-date" }), NOW).date).toBeTruthy();
    expect(validateManualActivityInput(input({ localTime: "" }), NOW).time).toBeTruthy();
  });

  it("rejects distance on a kind that doesn't record it", () => {
    expect(validateManualActivityInput(input({ kind: "yoga", distanceMiles: 2 }), NOW).distance).toBeTruthy();
  });

  it("limits free text length", () => {
    expect(validateManualActivityInput(input({ title: "x".repeat(101) }), NOW).title).toBeTruthy();
    expect(validateManualActivityInput(input({ notes: "x".repeat(2001) }), NOW).notes).toBeTruthy();
  });
});

describe("form parsing", () => {
  it("combines hours, minutes and seconds into seconds", () => {
    const parsed = parseManualActivityForm(form({ hours: "1", minutes: "2", seconds: "3" }), NOW);
    expect(parsed.ok && parsed.input.durationSeconds).toBe(3723);
  });

  it("treats blank optionals as omitted and trims text", () => {
    const parsed = parseManualActivityForm(form({ title: "  Morning loop ", notes: "   " }), NOW);
    expect(parsed.ok && parsed.input).toMatchObject({
      avgHeartRate: null, calories: null, title: "Morning loop", notes: null,
    });
  });

  it.each([
    ["minutes", { minutes: "60" }],
    ["seconds", { seconds: "61" }],
    ["fractions", { minutes: "1.5" }],
    ["negatives", { minutes: "-1" }],
    ["text", { minutes: "abc" }],
  ])("rejects invalid duration parts: %s", (_name, overrides) => {
    const parsed = parseManualActivityForm(form(overrides), NOW);
    expect(!parsed.ok && parsed.errors.duration).toBeTruthy();
  });

  it("rejects an all-empty duration", () => {
    const parsed = parseManualActivityForm(form({ hours: "", minutes: "", seconds: "" }), NOW);
    expect(!parsed.ok && parsed.errors.duration).toBeTruthy();
  });

  it("ignores a stale distance after switching to a kind without one", () => {
    const parsed = parseManualActivityForm(form({ kind: "pilates", distanceMiles: "9" }), NOW);
    expect(parsed.ok && parsed.input.distanceMiles).toBeNull();
  });

  it("rejects non-numeric optional metrics instead of dropping them", () => {
    const parsed = parseManualActivityForm(form({ avgHeartRate: "fast" }), NOW);
    expect(!parsed.ok && parsed.errors.avgHeartRate).toBeTruthy();
  });

  it("round-trips a stored record back into the form", () => {
    const fields = buildManualActivityFields(input({ durationSeconds: 3723, avgHeartRate: 151, title: "T", notes: "N" }));
    const values = formValuesFromWorkout({
      ...existing(), ...(fields as Partial<HealthWorkout>), customTitle: "T", notes: "N",
    });
    expect(values).toMatchObject({
      kind: "outdoor_run", date: "2026-10-10", time: "07:30", hours: "1", minutes: "2", seconds: "3",
      distanceMiles: "3", avgHeartRate: "151", title: "T", notes: "N",
    });
    expect(parseManualActivityForm(values, NOW).ok).toBe(true);
  });

  it("starts a new form on the current local day and time", () => {
    expect(emptyManualActivityForm("yoga", new Date(2026, 0, 2, 6, 5))).toMatchObject({
      kind: "yoga", date: "2026-01-02", time: "06:05",
    });
  });
});

describe("pace", () => {
  it("needs both a duration and a distance", () => {
    expect(manualPaceSecPerMile(1800, 3)).toBe(600);
    expect(manualPaceSecPerMile(1800, null)).toBeNull();
    expect(manualPaceSecPerMile(0, 3)).toBeNull();
    expect(manualPaceSecPerMile(1800, 0)).toBeNull();
    expect(manualPaceSecPerMile(NaN, 3)).toBeNull();
  });
});

describe("local time across zones and daylight-saving changes", () => {
  beforeAll(() => { process.env.TZ = "America/New_York"; });
  afterAll(() => { process.env.TZ = originalTz; });

  it("keeps a late-evening activity on the entered local day", () => {
    const start = localDateTimeToInstant("2026-10-10", "23:30")!;
    expect(toLocalIsoDate(start)).toBe("2026-10-10");
    expect(start.toISOString()).toBe("2026-10-11T03:30:00.000Z");
  });

  it("rejects a wall-clock time skipped by spring-forward", () => {
    expect(localDateTimeToInstant("2026-03-08", "02:30")).toBeNull();
    const errors = validateManualActivityInput(
      input({ localDate: "2026-03-08", localTime: "02:30" }), NOW
    );
    expect(errors.time).toMatch(/doesn't exist/);
  });

  it("accepts the repeated fall-back hour and keeps end = start + duration", () => {
    const fields = buildManualActivityFields(
      input({ localDate: "2026-11-01", localTime: "01:30", durationSeconds: 3600 })
    );
    expect((fields.endDate as Date).getTime() - (fields.startDate as Date).getTime()).toBe(3600000);
  });

  it("measures an activity crossing spring-forward in elapsed time", () => {
    const fields = buildManualActivityFields(
      input({ localDate: "2026-03-08", localTime: "01:30", durationSeconds: 3600 })
    );
    // One elapsed hour from 01:30 EST reads 03:30 EDT on the wall clock.
    expect((fields.endDate as Date).getHours()).toBe(3);
    expect((fields.endDate as Date).getMinutes()).toBe(30);
  });
});

describe("possible-duplicate heuristic", () => {
  it("flags a close start with similar duration and distance, and says why", () => {
    const [match] = findPossibleDuplicates(input(), [existing()]);
    expect(match.workout.workoutId).toBe("HK-1");
    expect(match.reasons.join(" ")).toMatch(/5 min apart/);
    expect(match.reasons.join(" ")).toMatch(/Similar distance/);
  });

  it("flags substantial overlap beyond the start window", () => {
    const later = new Date(2026, 9, 10, 7, 50);
    const [match] = findPossibleDuplicates(
      input({ durationSeconds: 3600, distanceMiles: 6 }),
      [existing({ startDate: later, durationSeconds: 3600, distanceMiles: 6 })]
    );
    expect(match.reasons[0]).toBe("Time ranges overlap");
  });

  it("flags a same-day near-identical record even when the time was mistyped", () => {
    const evening = new Date(2026, 9, 10, 18, 0);
    const [match] = findPossibleDuplicates(input(), [existing({ startDate: evening })]);
    expect(match.reasons).toContain("Same day");
  });

  it("does not flag a clearly different distance at the same time", () => {
    expect(findPossibleDuplicates(input(), [existing({ distanceMiles: 6 })])).toEqual([]);
  });

  it("does not flag a clearly different duration at the same time", () => {
    expect(findPossibleDuplicates(input(), [existing({ durationSeconds: 3600 })])).toEqual([]);
  });

  it("does not flag a run against a non-run", () => {
    expect(findPossibleDuplicates(input(), [existing({ isRunLike: false, activityType: "workout" })])).toEqual([]);
  });

  it("does not flag a different specific workout type", () => {
    const yoga = input({ kind: "yoga", distanceMiles: null });
    expect(findPossibleDuplicates(yoga, [
      existing({ isRunLike: false, activityType: "pilates", distanceMiles: 0 }),
    ])).toEqual([]);
  });

  it("treats iOS's generic workout type as comparable to any workout", () => {
    const hiit = input({ kind: "hiit", distanceMiles: null });
    expect(findPossibleDuplicates(hiit, [
      existing({ isRunLike: false, activityType: "workout", distanceMiles: 0 }),
    ])).toHaveLength(1);
  });

  it("does not flag an activity on another day", () => {
    const nextDay = new Date(2026, 9, 11, 7, 30);
    expect(findPossibleDuplicates(input(), [existing({ startDate: nextDay })])).toEqual([]);
  });

  it("does not use the same-day rule when a distance is missing", () => {
    const evening = new Date(2026, 9, 10, 18, 0);
    const walk = input({ kind: "walking", distanceMiles: null });
    expect(findPossibleDuplicates(walk, [
      existing({ isRunLike: false, activityType: "walking", startDate: evening }),
    ])).toEqual([]);
  });
});
