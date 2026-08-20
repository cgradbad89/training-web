import { describe, expect, it } from "vitest";
import {
  matchPlanToActual,
  statusForRunEntry,
  isPlanEntryCompleted,
} from "@/utils/planMatching";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { applyOverride, type WorkoutOverride } from "@/types/workoutOverride";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function runEntry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  id: string
): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType: "outdoor",
  };
}

// Single-week plan starting Mon 2026-01-19 with one Monday entry.
function makePlan(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [{ weekNumber: 1, entries }],
  };
}

// Minimal HealthWorkout — only the fields the matcher reads.
//
// `startISO`'s DATE part is what these fixtures care about; the run is pinned
// to LOCAL noon on that day so its calendar day is stable in every timezone.
// (Storing the literal UTC instant instead was stable only while the matcher
// keyed workouts by their UTC day — now that it keys by the local day, a
// 12:00Z fixture would land on the next calendar day at UTC+12 and beyond.)
// Time-of-day is irrelevant to the matcher: it compares day keys only.
function run(startISO: string, distanceMiles: number, id?: string): HealthWorkout {
  const [y, m, d] = startISO.slice(0, 10).split("-").map(Number);
  return {
    workoutId: id ?? `run-${startISO}`,
    isRunLike: true,
    startDate: new Date(y, m - 1, d, 12, 0, 0),
    distanceMiles,
    durationSeconds: distanceMiles * 600,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

// Reference "now" — used only where status derivation (missed/upcoming) matters.
const NOW = new Date(2026, 0, 24, 12, 0, 0); // Sat 2026-01-24 local

describe("matchPlanToActual — completion threshold (85%)", () => {
  it("a run at exactly 85% of planned distance matches with quality 'full'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // planned 10mi
    const w = run("2026-01-19T12:00:00Z", 8.5); // 8.5/10 = 85% exactly
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "full" });
  });

  it("a run just below 85% still matches (day proximity is the only match gate), quality 'partial'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // planned 10mi
    const w = run("2026-01-19T12:00:00Z", 8.4); // 84% — below threshold
    const matchMap = matchPlanToActual(plan, [w]);
    const match = matchMap.get("w1-mon");
    expect(match).not.toBeNull();
    expect(match).toMatchObject({ quality: "partial" });
  });

  it("a run more than 3mi short of planned (previously excluded entirely) now matches as partial", () => {
    // Under the old DISTANCE_SHORTFALL_THRESHOLD rule this run (4mi vs 8mi
    // planned, a 4mi shortfall) would never match at all. It should now match
    // same-day, graded "partial" since 4/8 = 50% < 85%.
    const plan = makePlan([runEntry(0, 1, 8, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 4);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });

  it("a run within ±1 day but below 85% still matches as partial (day-proximity structure unchanged)", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const w = run("2026-01-20T12:00:00Z", 5); // Tue, 1 day off, 50%
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });

  it("no actual run within ±1 day of the planned entry leaves it unmatched (missed/upcoming, not partial)", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const w = run("2026-01-22T12:00:00Z", 10); // Thu — 3 days off, out of window
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toBeNull();
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "missed"
    );
  });

  it("zero planned distance is treated as trivially met (meetsCompletionThreshold's <= 0 guard)", () => {
    const plan = makePlan([runEntry(0, 1, 0, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 2);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "full" });
  });

  it("zero actual distance against a nonzero plan matches as partial (0% completion)", () => {
    const plan = makePlan([runEntry(0, 1, 6, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 0);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(matchMap.get("w1-mon")).toMatchObject({ quality: "partial" });
  });
});

describe("statusForRunEntry — quality → status mapping unchanged", () => {
  it("full quality → 'met'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 10);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "met"
    );
  });

  it("partial quality → 'partial'", () => {
    const plan = makePlan([runEntry(0, 1, 10, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 3);
    const matchMap = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "partial"
    );
  });

  it("no match, future entry → 'upcoming'", () => {
    const plan = makePlan([runEntry(1, 1, 10, "w2-mon")]); // week 2 Monday — future vs NOW
    const matchMap = matchPlanToActual(plan, []);
    expect(statusForRunEntry(plan, plan.weeks[0].entries[0], matchMap, NOW)).toBe(
      "upcoming"
    );
  });
});

// ─── isPlanEntryCompleted — canonical "any match counts" helper (Phase 1) ────

describe("isPlanEntryCompleted", () => {
  it("'met' (full match) is completed", () => {
    expect(isPlanEntryCompleted("met")).toBe(true);
  });

  it("'partial' (partial match) is completed", () => {
    expect(isPlanEntryCompleted("partial")).toBe(true);
  });

  it("'missed' (no match, past) is NOT completed", () => {
    expect(isPlanEntryCompleted("missed")).toBe(false);
  });

  it("'upcoming' (no match, future) is NOT completed", () => {
    expect(isPlanEntryCompleted("upcoming")).toBe(false);
  });
});

// ─── Override-aware match quality ────────────────────────────────────────────
//
// `distanceMilesOverride` is a user correction to a workout's recorded
// distance. It does NOT move the 85% full/partial threshold — it only changes
// the distance the threshold is applied to. Before this was wired in, a
// corrected distance showed on /runs and /plan-insights but the plan grid on
// /dashboard and /plans still graded the raw HealthKit value.

function override(
  workoutId: string,
  distanceMilesOverride: number | null,
  isExcluded = false
): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded,
    excludedAt: null,
    excludedReason: null,
    distanceMilesOverride,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-01-20T00:00:00.000Z",
  };
}

describe("matchPlanToActual — distanceMilesOverride changes the quality tier", () => {
  // Planned 10 mi → 85% threshold is 8.5 mi.
  const plan = makePlan([runEntry(0, 1, 10, "e1")]);

  it("raw 7.0 mi grades partial; corrected 9.5 mi grades full", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");

    // Before: no overrides → 7.0 / 10 = 0.70 < 0.85
    expect(matchPlanToActual(plan, [w]).get("e1")?.quality).toBe("partial");

    // After: the user corrects the GPS undercount to 9.5 → 0.95 ≥ 0.85
    const after = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(after.get("e1")?.quality).toBe("full");
  });

  it("raw 9.5 mi grades full; corrected 7.0 mi grades partial (inverse)", () => {
    const w = run("2026-01-19T12:00:00Z", 9.5, "w1");

    expect(matchPlanToActual(plan, [w]).get("e1")?.quality).toBe("full");

    const after = matchPlanToActual(plan, [w], { w1: override("w1", 7.0) });
    expect(after.get("e1")?.quality).toBe("partial");
  });

  it("statusForRunEntry follows the corrected tier (partial → met)", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const entry = plan.weeks[0].entries[0];

    const before = matchPlanToActual(plan, [w]);
    expect(statusForRunEntry(plan, entry, before, NOW)).toBe("partial");

    const after = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(statusForRunEntry(plan, entry, after, NOW)).toBe("met");
  });

  it("PlanMatch.activity carries the override-applied distance", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const m = matchPlanToActual(plan, [w], { w1: override("w1", 9.5) });
    expect(m.get("e1")?.activity.distanceMiles).toBe(9.5);
    // Source workout is never mutated.
    expect(w.distanceMiles).toBe(7.0);
  });

  it("an override with a null distanceMilesOverride leaves the tier alone", () => {
    const w = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const m = matchPlanToActual(plan, [w], { w1: override("w1", null) });
    expect(m.get("e1")?.quality).toBe("partial");
    expect(m.get("e1")?.activity.distanceMiles).toBe(7.0);
  });

  it("re-applying the same override to an already-corrected run is idempotent", () => {
    // Callers like /plans pre-apply overrides AND may pass the map through;
    // applyOverride assigns absolute values, so double application is safe.
    const raw = run("2026-01-19T12:00:00Z", 7.0, "w1");
    const pre = applyOverride(raw, override("w1", 9.5));
    const m = matchPlanToActual(plan, [pre], { w1: override("w1", 9.5) });
    expect(m.get("e1")?.quality).toBe("full");
    expect(m.get("e1")?.activity.distanceMiles).toBe(9.5);
  });
});

// ─── Local vs UTC day keying ─────────────────────────────────────────────────
//
// A workout's date key is its LOCAL calendar day (utils/planMatching
// `toISODate`, the same getFullYear/getMonth/getDate mechanism
// services/autoMatch.ts uses via `localISODate`, and the same day every
// mileage/stat surface buckets a run under). It used to be the UTC day
// (`startDate.toISOString()`), which rolls a late-evening run forward a day
// west of UTC and an after-midnight run backward a day east of UTC.
//
// These fixtures build their timestamps from LOCAL components
// (`new Date(y, m, d, h, min)`) so "9pm local" is genuinely 9pm wherever the
// suite runs. Under the old UTC keying the evening cases failed in every
// timezone west of UTC and the after-midnight case failed in every timezone
// east of it; at TZ=UTC exactly, local and UTC days coincide and the
// assertions hold either way.

/** The local "YYYY-MM-DD" day key every stat/mileage surface buckets a run by. */
function statCardDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function runAtLocal(
  y: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  distanceMiles: number,
  id: string
): HealthWorkout {
  return {
    workoutId: id,
    isRunLike: true,
    startDate: new Date(y, monthIndex, day, hour, minute, 0),
    distanceMiles,
    durationSeconds: distanceMiles * 600,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

/** Multi-week plan starting Mon 2026-01-19 (week 1 = Jan 19–25, week 2 = Jan 26–Feb 1). */
function makeMultiWeekPlan(weeks: PlannedRunEntry[][]): RunningPlan {
  return {
    ...makePlan([]),
    weeks: weeks.map((entries, i) => ({ weekNumber: i + 1, entries })),
  };
}

describe("matchPlanToActual — local-day keying (was UTC)", () => {
  it("a 9pm local Sunday run matches its own Sunday entry, not next week's Monday", () => {
    const plan = makeMultiWeekPlan([
      [runEntry(0, 7, 6, "w1-sun")], // Sun 2026-01-25
      [runEntry(1, 1, 4, "w2-mon")], // Mon 2026-01-26
    ]);
    const w = runAtLocal(2026, 0, 25, 21, 0, 6, "sun-evening");

    const m = matchPlanToActual(plan, [w]);
    expect(m.get("w1-sun")?.activity.workoutId).toBe("sun-evening");
    expect(m.get("w2-mon")).toBeNull();
  });

  it("the day a late-evening run is keyed under equals the day the stat cards bucket it under", () => {
    const plan = makeMultiWeekPlan([
      [runEntry(0, 7, 6, "w1-sun")],
      [runEntry(1, 1, 4, "w2-mon")],
    ]);
    const w = runAtLocal(2026, 0, 25, 21, 0, 6, "sun-evening");

    // The stat/mileage surfaces bucket this run on Sun 2026-01-25 …
    expect(statCardDayKey(w.startDate)).toBe("2026-01-25");
    // … and the matcher now attributes it to the entry planned for that same
    // local day (Sun = weekday 7 of week 1, i.e. plan start + 6 days).
    const matched = matchPlanToActual(plan, [w]).get("w1-sun");
    expect(matched).not.toBeNull();
    expect(statCardDayKey(matched!.activity.startDate)).toBe("2026-01-25");
  });

  it("a Sunday-evening run and the next Monday-morning run keep their own entries (no swap)", () => {
    // Under UTC keying BOTH runs keyed to 2026-01-26: the Sunday run claimed
    // the Monday entry in pass 1 and the Monday run fell back to the Sunday
    // entry via the ±1-day pass — the two were matched to each other's days.
    const plan = makeMultiWeekPlan([
      [runEntry(0, 7, 6, "w1-sun")],
      [runEntry(1, 1, 4, "w2-mon")],
    ]);
    const sun = runAtLocal(2026, 0, 25, 21, 0, 6, "sun-run");
    const mon = runAtLocal(2026, 0, 26, 7, 0, 4, "mon-run");

    const m = matchPlanToActual(plan, [sun, mon]);
    expect(m.get("w1-sun")?.activity.workoutId).toBe("sun-run");
    expect(m.get("w2-mon")?.activity.workoutId).toBe("mon-run");
  });

  it("a 00:30 local Monday run matches the Monday entry, not the previous day's Sunday entry", () => {
    // Mirror-image case for positive UTC offsets (e.g. Europe/Berlin), where
    // the UTC key rolled an after-midnight run BACK onto the prior day.
    const plan = makeMultiWeekPlan([
      [runEntry(0, 7, 6, "w1-sun")],
      [runEntry(1, 1, 4, "w2-mon")],
    ]);
    const w = runAtLocal(2026, 0, 26, 0, 30, 4, "after-midnight");

    const m = matchPlanToActual(plan, [w]);
    expect(m.get("w2-mon")?.activity.workoutId).toBe("after-midnight");
    expect(m.get("w1-sun")).toBeNull();
  });

  it("a Sunday-evening run with no Sunday entry stays in its own week (±1-day tolerance picks Saturday over next Monday)", () => {
    // Tiebreaker rule 1 ("prefer same/past ISO week") already did this for
    // daytime Sunday runs; keying evening runs locally makes them behave the
    // same instead of jumping a week forward onto the Monday entry.
    const plan = makeMultiWeekPlan([
      [runEntry(0, 6, 6, "w1-sat")], // Sat 2026-01-24
      [runEntry(1, 1, 4, "w2-mon")], // Mon 2026-01-26
    ]);
    const w = runAtLocal(2026, 0, 25, 21, 0, 5, "sun-evening");

    const m = matchPlanToActual(plan, [w]);
    expect(m.get("w1-sat")?.activity.workoutId).toBe("sun-evening");
    expect(m.get("w2-mon")).toBeNull();
  });

  it("regression: typical daytime runs still match their own same-day entries", () => {
    const plan = makeMultiWeekPlan([
      [
        runEntry(0, 2, 5, "w1-tue"), // Tue 2026-01-20
        runEntry(0, 4, 7, "w1-thu"), // Thu 2026-01-22
      ],
    ]);
    const tue = runAtLocal(2026, 0, 20, 18, 0, 5, "tue-run"); // 6pm
    const thu = runAtLocal(2026, 0, 22, 10, 0, 7, "thu-run"); // 10am

    const m = matchPlanToActual(plan, [tue, thu]);
    expect(m.get("w1-tue")?.activity.workoutId).toBe("tue-run");
    expect(m.get("w1-tue")?.quality).toBe("full");
    expect(m.get("w1-thu")?.activity.workoutId).toBe("thu-run");
    expect(m.get("w1-thu")?.quality).toBe("full");
  });

  it("regression: the ±1-day tolerance width is unchanged (1 day off matches, 2 days off does not)", () => {
    const plan = makeMultiWeekPlan([[runEntry(0, 1, 5, "w1-mon")]]); // Mon 2026-01-19

    const oneDayOff = runAtLocal(2026, 0, 20, 12, 0, 5, "tue-run");
    expect(
      matchPlanToActual(plan, [oneDayOff]).get("w1-mon")?.activity.workoutId
    ).toBe("tue-run");

    const twoDaysOff = runAtLocal(2026, 0, 21, 12, 0, 5, "wed-run");
    expect(matchPlanToActual(plan, [twoDaysOff]).get("w1-mon")).toBeNull();
  });
});
