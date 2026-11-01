/**
 * A manual record, as the converter produces it, through the real downstream
 * utilities. No mocks: this is the contract that it "just works" where it has
 * genuine data and contributes nothing where it doesn't.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase", () => ({ db: {}, auth: {} }));

import { applyWorkoutMutations, mergeWorkoutDelta } from "@/contexts/AppDataContext";
import { docToHealthWorkout } from "@/services/healthWorkouts";
import { isManualActivity, type HealthWorkout } from "@/types/healthWorkout";
import { type RunningPlan, type WorkoutPlan } from "@/types/plan";
import { type RunningShoe } from "@/types/shoe";
import { computeWorkoutAggregationRevision } from "@/utils/aggregatedStats";
import { buildManualActivityFields, type ManualActivityInput } from "@/utils/manualActivity";
import { buildCalendarEvents } from "@/utils/planCalendar";
import { isPlanEntryCompleted, matchPlanToActual, statusForRunEntry } from "@/utils/planMatching";
import { computeAllPRs, buildPRBadgeMap } from "@/utils/prComputation";
import { buildCoachContext } from "@/utils/coachContext";
import { computeGoalProgress } from "@/utils/goalProgress";
import { buildWeeklyLoadModel } from "@/utils/weeklyLoad";
import { buildQualifyingEfforts } from "@/utils/riegelFit";
import { computeBestEfforts } from "@/utils/bestEfforts";
import { type RunningGoal } from "@/types/goal";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";
import { shoeAssignedRuns, totalShoeMileage } from "@/utils/shoeMileage";
import { resolveDisplayLoad, shouldEnrichLoad } from "@/utils/trainingLoad";
import { isRouteSyncing } from "@/utils/routeAvailability";
import { matchWorkoutPlanSessions } from "@/utils/workoutPlanMatching";
import { detectDuplicatePairs } from "@/utils/duplicateDetection";
import { toLocalIsoDate } from "@/utils/dates";

const MAX_HR = 185;
const REST_HR = 60;

function manual(id: string, overrides: Partial<ManualActivityInput> = {}): HealthWorkout {
  const input: ManualActivityInput = {
    kind: "outdoor_run", localDate: "2026-10-07", localTime: "07:00", durationSeconds: 1800,
    distanceMiles: 3, avgHeartRate: null, calories: null, title: null, notes: null, ...overrides,
  };
  const now = new Date(2026, 9, 8);
  return docToHealthWorkout(id, {
    ...buildManualActivityFields(input), workoutId: id, createdAt: now, updatedAt: now,
  });
}

const runningPlan: RunningPlan = {
  id: "p1", name: "Plan", planType: "running", startDate: "2026-10-05", status: "active", isActive: true,
  createdAt: "x", updatedAt: "x",
  weeks: [{ weekNumber: 1, entries: [
    { id: "wed", weekIndex: 0, weekday: 3, dayOfWeek: 2, distanceMiles: 4 },
  ] }],
};

describe("converter", () => {
  it("is recognized by provenance, independent of title or type", () => {
    const workout = manual("manual_a", { title: "Apple Watch Run" });
    expect(isManualActivity(workout)).toBe(true);
    expect(workout).toMatchObject({ sourceName: "Manual Entry", hasRoute: false, hasHRStream: false, customTitle: "Apple Watch Run" });
  });

  it("leaves iOS records unmarked and unchanged", () => {
    const hk = docToHealthWorkout("HK", { displayType: "Run", isRunLike: true, syncedAt: new Date(5000), customTitle: "ignored", notes: "ignored" });
    expect(isManualActivity(hk)).toBe(false);
    expect(hk.customTitle).toBeUndefined();
    expect(hk.notes).toBeUndefined();
    expect(hk.syncedAt.getTime()).toBe(5000);
  });

  it("uses updatedAt in place of syncedAt so same-id edits still change revisions", () => {
    const a = manual("manual_a");
    expect(a.syncedAt).toEqual(new Date(2026, 9, 8));
    const edited = { ...a, updatedAt: new Date(2026, 9, 9), syncedAt: new Date(2026, 9, 9) };
    expect(computeWorkoutAggregationRevision([edited])).not.toBe(computeWorkoutAggregationRevision([a]));
  });

  it("reports no route-syncing state", () => {
    expect(isRouteSyncing(manual("manual_a").routeComplete)).toBe(false);
  });
});

describe("title resolution", () => {
  it("prefers the owner's title over a plan label", () => {
    expect(resolveActivityTitle({
      customTitle: "Birthday run", activityType: "Run", distanceMiles: 3,
      matchedPlanEntry: { label: "Long Run" },
    })).toBe("Birthday run");
  });

  it("falls back to existing rules", () => {
    expect(resolveActivityTitle({ customTitle: "  ", activityType: "Run", distanceMiles: 3 })).toBe("3mi Run");
  });
});

describe("training load", () => {
  it("has no load and no enrichment without heart rate", () => {
    const workout = manual("manual_a");
    expect(resolveDisplayLoad(workout, MAX_HR, REST_HR)).toBeNull();
    expect(shouldEnrichLoad(workout, MAX_HR, REST_HR)).toBe(false);
  });

  it("uses the canonical average-HR calculation and qualifies for storing it", () => {
    const workout = manual("manual_a", { avgHeartRate: 150 });
    const load = resolveDisplayLoad(workout, MAX_HR, REST_HR);
    expect(load).toBeGreaterThan(0);
    expect(shouldEnrichLoad(workout, MAX_HR, REST_HR)).toBe(true);
  });

  it("recomputes from new values once an edit has cleared the stored load", () => {
    const stale = { ...manual("manual_a", { avgHeartRate: 170 }), trainingLoadV2: 999 };
    expect(resolveDisplayLoad(stale, MAX_HR, REST_HR)).toBe(999);
    const cleared = manual("manual_a", { avgHeartRate: 120 });
    expect(resolveDisplayLoad(cleared, MAX_HR, REST_HR)).toBeLessThan(999);
    expect(shouldEnrichLoad(cleared, MAX_HR, REST_HR)).toBe(true);
  });

  it("never upgrades to a streamed load: there is no richer basis to wait for", () => {
    const stored = { ...manual("manual_a", { avgHeartRate: 150 }), trainingLoadV2: 80, trainingLoadMethod: "avg-hr-fallback" as const };
    expect(shouldEnrichLoad(stored, MAX_HR, REST_HR)).toBe(false);
  });
});

describe("running plan matching", () => {
  const today = new Date(2026, 9, 8);

  it("gives a run at the 85% threshold a full match", () => {
    const run = manual("manual_a", { distanceMiles: 3.4, durationSeconds: 2040 });
    const matches = matchPlanToActual(runningPlan, [run]);
    const entry = runningPlan.weeks[0].entries[0];
    expect(matches.get("wed")).toMatchObject({ quality: "full", activity: { workoutId: "manual_a" } });
    expect(statusForRunEntry(runningPlan, entry, matches, today)).toBe("met");
  });

  it("preserves partial-match behavior below the threshold", () => {
    const run = manual("manual_a", { distanceMiles: 2, durationSeconds: 1200 });
    const matches = matchPlanToActual(runningPlan, [run]);
    const entry = runningPlan.weeks[0].entries[0];
    expect(matches.get("wed")).toMatchObject({ quality: "partial" });
    expect(statusForRunEntry(runningPlan, entry, matches, today)).toBe("partial");
    expect(isPlanEntryCompleted("partial")).toBe(true);
  });

  it("uses one run for at most one session", () => {
    const plan: RunningPlan = { ...runningPlan, weeks: [{ weekNumber: 1, entries: [
      runningPlan.weeks[0].entries[0],
      { id: "thu", weekIndex: 0, weekday: 4, dayOfWeek: 3, distanceMiles: 3 },
    ] }] };
    const matches = matchPlanToActual(plan, [manual("manual_a")]);
    expect([...matches.values()].filter(Boolean)).toHaveLength(1);
  });
});

describe("workout plan matching", () => {
  const session = (category: string) => ({
    id: "w1", weekIndex: 0, weekday: 3, dayOfWeek: 2, type: "workout", category,
  });
  const workoutPlan = (category: string) => ({
    id: "wp", name: "WP", planType: "workout", startDate: "2026-10-05", status: "active", isActive: true,
    weeks: [{ weekNumber: 1, entries: [session(category)] }],
  }) as unknown as WorkoutPlan;

  it.each([
    ["strength", "strength"],
    ["hiit", "hiit"],
    ["pilates", "pilates"],
    ["yoga", "yoga"],
    ["cycling", "cycling"],
  ] as const)("a manual %s matches a %s session", (kind, category) => {
    const workout = manual("manual_w", { kind, distanceMiles: null });
    const assignments = matchWorkoutPlanSessions([workoutPlan(category)], [workout], new Date(2026, 9, 8));
    expect(assignments.map((a) => a.workout.workoutId)).toEqual(["manual_w"]);
  });

  it("does not match a session of another category", () => {
    const workout = manual("manual_w", { kind: "yoga", distanceMiles: null });
    expect(matchWorkoutPlanSessions([workoutPlan("strength")], [workout], new Date(2026, 9, 8))).toEqual([]);
  });

  it("matches a walking activity to no running session", () => {
    const walk = manual("manual_w", { kind: "walking", distanceMiles: 4, durationSeconds: 3600 });
    expect(matchPlanToActual(runningPlan, [walk]).get("wed")).toBeNull();
  });
});

describe("calendar", () => {
  it("shows an unmatched manual activity on its local day with its title", () => {
    const events = buildCalendarEvents(
      [], [manual("manual_a", { localTime: "23:30", title: "Night run" })], undefined, { includeActualOnly: true }
    );
    const event = events.find((e) => e.kind === "actual-run");
    expect(event?.label).toBe("Night run");
    expect(event?.date.getDate()).toBe(7);
  });

  it("categorizes a manual workout as a workout", () => {
    const events = buildCalendarEvents(
      [], [manual("manual_y", { kind: "yoga", distanceMiles: null })], undefined, { includeActualOnly: true }
    );
    expect(events.find((e) => e.kind === "actual-workout")?.label).toBe("Yoga");
  });
});

describe("calendar, continued", () => {
  it("shows a matched run under its planned session, not twice", () => {
    const events = buildCalendarEvents([runningPlan], [manual("manual_a")], undefined, { includeActualOnly: true });
    expect(events.filter((e) => e.kind === "actual-run")).toEqual([]);
  });

  it("drops an excluded manual activity", () => {
    const overrides = { manual_a: { workoutId: "manual_a", userId: "u", isExcluded: true, excludedAt: null, excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "x" } };
    const effective = selectEffectiveWorkouts([manual("manual_a")], overrides);
    expect(buildCalendarEvents([], effective, overrides, { includeActualOnly: true })).toEqual([]);
  });
});

describe("shoes", () => {
  const shoe = { id: "s1", startMileageOffset: 10 } as RunningShoe;

  it("counts a manual run's miles, follows edits, and drops them on delete", () => {
    const run = manual("manual_a");
    expect(totalShoeMileage(shoe, [run], { manual_a: "s1" })).toBe(13);
    const edited = manual("manual_a", { distanceMiles: 5, durationSeconds: 3000 });
    expect(totalShoeMileage(shoe, [edited], { manual_a: "s1" })).toBe(15);
    expect(totalShoeMileage(shoe, [], { manual_a: "s1" })).toBe(10);
  });

  it("stops counting a run edited into a non-run", () => {
    const walk = manual("manual_a", { kind: "walking" });
    expect(shoeAssignedRuns(shoe, [walk], { manual_a: "s1" })).toEqual([]);
  });
});

describe("personal records", () => {
  it("lets a genuine distance-and-time manual run hold a pace PR", () => {
    const fast = manual("manual_fast", { distanceMiles: 3.1, durationSeconds: 1200 });
    const slow = manual("manual_slow", { distanceMiles: 3.1, durationSeconds: 1800, localDate: "2026-10-06" });
    expect(buildPRBadgeMap(computeAllPRs([fast, slow])).get("manual_fast")?.length).toBeGreaterThan(0);
  });
});

describe("goals and derived statistics", () => {
  const goal = (metric: RunningGoal["metric"], target: number) => ({
    id: "g", name: "G", metric, target, startDate: "2026-10-01", endDate: "2026-10-31",
  }) as unknown as RunningGoal;
  const today = new Date(2026, 9, 15);

  it("counts a qualifying manual run toward distance, time and count goals", () => {
    const run = manual("manual_a");
    expect(computeGoalProgress(goal("distance", 10), [run], today).actual).toBe(3);
    expect(computeGoalProgress(goal("count", 10), [run], today).actual).toBe(1);
    expect(computeGoalProgress(goal("time", 10), [run], today).actual).toBeGreaterThan(0);
  });

  it("stops counting it once deleted", () => {
    expect(computeGoalProgress(goal("distance", 10), [], today).actual).toBe(0);
  });

  it("adds the load of a manual run with HR to its week, and none without", () => {
    const week = (workouts: HealthWorkout[]) => {
      const model = buildWeeklyLoadModel(workouts, MAX_HR, REST_HR, new Date(2026, 9, 8));
      return model.weeks.find((w) => w.activities.some((a) => a.id === "manual_a"));
    };
    expect(week([manual("manual_a", { avgHeartRate: 150 })])?.total).toBeGreaterThan(0);
    expect(week([manual("manual_a")])?.total ?? 0).toBe(0);
  });

  it("changes the stats revision on create, edit and delete", () => {
    const base = docToHealthWorkout("HK", { displayType: "Run", isRunLike: true, startDate: new Date(2026, 8, 1), syncedAt: new Date(1) });
    const before = computeWorkoutAggregationRevision([base]);
    const created = computeWorkoutAggregationRevision([base, manual("manual_a")]);
    const edited = computeWorkoutAggregationRevision([base, manual("manual_a", { distanceMiles: 4, durationSeconds: 2400 })]);
    expect(created).not.toBe(before);
    expect(edited).not.toBe(created);
    expect(computeWorkoutAggregationRevision([base])).toBe(before);
  });
});

describe("race predictions and AI Coach", () => {
  const asOf = new Date(2026, 9, 8);
  const longEnough = () => manual("manual_a", { distanceMiles: 6, durationSeconds: 3000 });

  it("feeds a legitimate manual run into prediction inputs", () => {
    const efforts = buildQualifyingEfforts([longEnough()], { asOf });
    expect(efforts.length).toBe(1);
  });

  it("marks a manual treadmill run as treadmill, as the existing gate requires", () => {
    const treadmill = manual("manual_t", { kind: "treadmill_run", distanceMiles: 6, durationSeconds: 3000 });
    expect(treadmill.activityType).toBe("treadmill_running");
  });

  it("grants no GPS-derived best-effort credit", () => {
    const run = longEnough();
    expect(run.bestEfforts).toBeUndefined();
    expect(run.mileSplits).toBeUndefined();
    expect(computeBestEfforts([])["5k"]).toBeNull();
  });

  it("appears in AI Coach context through the existing path, without inventing load", () => {
    const recent = docToHealthWorkout("manual_c", {
      ...buildManualActivityFields({
        kind: "outdoor_run", localDate: toLocalIsoDate(new Date(Date.now() - 2 * 86400000)), localTime: "07:00",
        durationSeconds: 1800, distanceMiles: 3, avgHeartRate: null, calories: null, title: null, notes: null,
      }),
      workoutId: "manual_c", updatedAt: new Date(),
    });
    const context = JSON.stringify(buildCoachContext([recent], null, null, [], MAX_HR, REST_HR));
    expect(context).toContain('"distance":3');
    expect(context).toContain('"trainingLoad":null');
    expect(context).toContain('"avgHR":null');
  });
});

describe("shared state never double-counts", () => {
  const hk = docToHealthWorkout("HK", { displayType: "Run", isRunLike: true, startDate: new Date(2026, 9, 1), endDate: new Date(2026, 9, 1), durationSeconds: 600, distanceMiles: 1 });

  it("replaces a same-id record on publish", () => {
    const first = manual("manual_a");
    const second = manual("manual_a", { distanceMiles: 4, durationSeconds: 2400 });
    const merged = mergeWorkoutDelta([hk, first], [second]);
    expect(merged.filter((w) => w.workoutId === "manual_a")).toHaveLength(1);
    expect(merged.find((w) => w.workoutId === "manual_a")?.distanceMiles).toBe(4);
  });

  it("keeps newest-first order when a backdated record is inserted", () => {
    const merged = mergeWorkoutDelta([manual("manual_new", { localDate: "2026-10-07" })], [manual("manual_old", { localDate: "2026-09-01" })]);
    expect(merged.map((w) => w.workoutId)).toEqual(["manual_new", "manual_old"]);
  });

  it("a read started before a delete can't resurrect the record", () => {
    const stale = [hk, manual("manual_a")];
    expect(applyWorkoutMutations(stale, new Map([["manual_a", null]])).map((w) => w.workoutId)).toEqual(["HK"]);
  });

  it("a read started before an edit can't restore old values", () => {
    const stale = [manual("manual_a")];
    const saved = manual("manual_a", { distanceMiles: 6, durationSeconds: 3600 });
    const result = applyWorkoutMutations(stale, new Map([["manual_a", saved]]));
    expect(result).toHaveLength(1);
    expect(result[0].distanceMiles).toBe(6);
  });

  it("a read started before a create still includes it", () => {
    const saved = manual("manual_a");
    expect(applyWorkoutMutations([hk], new Map([["manual_a", saved]])).map((w) => w.workoutId))
      .toEqual(expect.arrayContaining(["HK", "manual_a"]));
  });

  it("returns the same array with nothing pending", () => {
    const list = [hk];
    expect(applyWorkoutMutations(list, new Map())).toBe(list);
  });

  it("an excluded manual record leaves every effective list", () => {
    const run = manual("manual_a");
    const overrides = { manual_a: { workoutId: "manual_a", userId: "u", isExcluded: true, excludedAt: null, excludedReason: null, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: "x" } };
    expect(selectEffectiveWorkouts([run, hk], overrides).map((w) => w.workoutId)).toEqual(["HK"]);
  });
});

describe("existing banner compatibility", () => {
  it("still only suggests, never merges, an overlapping OTF-style record", () => {
    const otf = manual("manual_o", { kind: "hiit", distanceMiles: null, durationSeconds: 3600 });
    const hk = docToHealthWorkout("HK", { displayType: "Workout", activityType: "workout", isRunLike: false, startDate: otf.startDate, endDate: otf.endDate, durationSeconds: 3600 });
    expect(detectDuplicatePairs([otf, hk])).toHaveLength(1);
  });
});
