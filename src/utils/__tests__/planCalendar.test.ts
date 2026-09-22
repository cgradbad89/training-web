import { describe, expect, it } from "vitest";
import { buildCalendarEvents } from "@/utils/planCalendar";
import {
  type RunningPlan,
  type WorkoutPlan,
  type PlannedRunEntry,
  type PlannedWorkoutEntry,
} from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

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

// Plan starting Mon 2026-01-19 — single week with 3 Monday-adjacent entries
// on different weekdays so each gets an isolated match window.
function makeRunningPlan(entries: PlannedRunEntry[]): RunningPlan {
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

function workoutEntry(
  weekIndex: number,
  weekday: number,
  id: string,
  completed: boolean
): PlannedWorkoutEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    type: "workout",
    label: "Strength",
    completed,
  };
}

function makeWorkoutPlan(entries: PlannedWorkoutEntry[]): WorkoutPlan {
  return {
    id: "wplan1",
    name: "Test Workout Plan",
    planType: "workout",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [{ weekNumber: 1, entries }],
  };
}

// Minimal HealthWorkout — only the fields the matcher reads. Pinned to LOCAL
// noon on `startISO`'s date so the calendar day is stable in every timezone
// (matchPlanToActual keys workouts by their LOCAL day, so a literal 12:00Z
// instant would land on the next calendar day at UTC+12 and beyond).
function run(startISO: string, distanceMiles: number, id?: string): HealthWorkout {
  const [y, m, d] = startISO.slice(0, 10).split("-").map(Number);
  return {
    workoutId: id ?? `run-${startISO}`,
    activityType: "running",
    displayType: "Run",
    isRunLike: true,
    startDate: new Date(y, m - 1, d, 12, 0, 0),
    distanceMiles,
    durationSeconds: distanceMiles * 600,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
}

function nonRun(id: string, hour = 9): HealthWorkout {
  return {
    workoutId: id,
    isRunLike: false,
    activityType: "traditional_strength_training",
    displayType: "Workout",
    startDate: new Date(2026, 0, 19, hour),
    distanceMiles: 0,
  } as HealthWorkout;
}

describe("buildCalendarEvents — running events carry the 4-state status", () => {
  it("a >=85% matched run → status 'met', completed true, activity attached", () => {
    const plan = makeRunningPlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const w = run("2026-01-19T12:00:00Z", 9); // 90% >= 85%
    const [event] = buildCalendarEvents([plan], [w]);
    expect(event.status).toBe("met");
    expect(event.completed).toBe(true);
    expect(event.activity?.workoutId).toBe(w.workoutId);
  });

  it("a <85% matched run → status 'partial', completed STILL true (unchanged semantics)", () => {
    const plan = makeRunningPlan([runEntry(0, 1, 10, "w1-mon")]);
    const w = run("2026-01-19T12:00:00Z", 3); // 30% < 85%, still day-matched
    const [event] = buildCalendarEvents([plan], [w]);
    expect(event.status).toBe("partial");
    expect(event.completed).toBe(true); // "any match" semantics preserved
    expect(event.activity?.workoutId).toBe(w.workoutId);
  });

  it("no run within ±1 day of a past entry → status 'missed', completed false", () => {
    const plan = makeRunningPlan([runEntry(0, 1, 10, "w1-mon")]); // Mon 2026-01-19
    const [event] = buildCalendarEvents([plan], []);
    expect(event.status).toBe("missed");
    expect(event.completed).toBe(false);
    expect(event.activity).toBeNull();
  });

  it("no run for a future entry → status 'upcoming', completed false", () => {
    // Plan start is far in the future (well beyond any real test-run date) so
    // the entry is unambiguously "not yet due" regardless of when this runs.
    const plan: RunningPlan = {
      ...makeRunningPlan([runEntry(0, 1, 10, "w-future-mon")]),
      startDate: "2099-01-05", // a Monday
    };
    const [event] = buildCalendarEvents([plan], []);
    expect(event.status).toBe("upcoming");
    expect(event.completed).toBe(false);
  });
});

describe("buildCalendarEvents — CalendarEvent.completed now routed through isPlanEntryCompleted (Phase 3 regression)", () => {
  it("completed matches isPlanEntryCompleted(status) for every state in one mixed week — output unchanged from the old 'match != null' check", () => {
    const plan = makeRunningPlan([
      runEntry(0, 1, 10, "met-mon"),      // Mon — full match
      runEntry(0, 2, 10, "partial-tue"),  // Tue — partial match
      runEntry(0, 3, 10, "missed-wed"),   // Wed — no match, past
    ]);
    const runs = [
      run("2026-01-19T12:00:00Z", 9),  // Mon, 90% — met
      run("2026-01-20T12:00:00Z", 3),  // Tue, 30% — partial
      // Wed: no run.
    ];
    const events = buildCalendarEvents([plan], runs);
    const byId = Object.fromEntries(events.map((e) => [e.entryId, e]));

    expect(byId["met-mon"].status).toBe("met");
    expect(byId["met-mon"].completed).toBe(true);
    expect(byId["partial-tue"].status).toBe("partial");
    expect(byId["partial-tue"].completed).toBe(true);
    expect(byId["missed-wed"].status).toBe("missed");
    expect(byId["missed-wed"].completed).toBe(false);
  });
});

describe("buildCalendarEvents — workout events are unaffected (no status concept)", () => {
  it("leaves `status` undefined and preserves the existing `completed` boolean semantics", () => {
    const plan = makeWorkoutPlan([
      workoutEntry(0, 1, "w1-strength-done", true),
      workoutEntry(0, 2, "w1-strength-todo", false),
    ]);
    const events = buildCalendarEvents([plan], []);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.status).toBeUndefined();
      expect(e.activity).toBeUndefined();
    }
    expect(events.find((e) => e.entryId === "w1-strength-done")?.completed).toBe(true);
    expect(events.find((e) => e.entryId === "w1-strength-todo")?.completed).toBe(false);
  });
});

const withActual = (plans: (RunningPlan | WorkoutPlan)[], workouts: HealthWorkout[]) =>
  buildCalendarEvents(plans, workouts, undefined, { includeActualOnly: true });

describe("buildCalendarEvents — complete Calendar activity", () => {
  it("defaults to planned-only even when actual workouts are loaded", () => {
    expect(buildCalendarEvents([], [run("2026-01-19", 3)])).toEqual([]);
  });
  it("shows an unmatched run with no active plan", () => {
    const events = withActual([], [run("2026-01-19", 3, "extra")]);
    expect(events).toMatchObject([{ kind: "actual-run", activity: { workoutId: "extra" } }]);
  });
  it("does not duplicate a full matched run", () => {
    const events = withActual([makeRunningPlan([runEntry(0, 1, 10, "e1")])], [run("2026-01-19", 9, "w1")]);
    expect(events.map((event) => event.kind)).toEqual(["planned-running"]);
  });
  it("does not duplicate a partial matched run", () => {
    const events = withActual([makeRunningPlan([runEntry(0, 1, 10, "e1")])], [run("2026-01-19", 2, "w1")]);
    expect(events.map((event) => event.kind)).toEqual(["planned-running"]);
    expect(events[0].status).toBe("partial");
  });
  it("shows an additional same-day run", () => {
    const events = withActual([makeRunningPlan([runEntry(0, 1, 10, "e1")])],
      [run("2026-01-19", 9, "w1"), run("2026-01-19", 3, "w2")]);
    expect(events.map((event) => event.kind)).toEqual(["planned-running", "actual-run"]);
  });
  it("shows multiple unmatched runs on one day", () => {
    expect(withActual([], [run("2026-01-19", 3, "w1"), run("2026-01-19", 4, "w2")])).toHaveLength(2);
  });
  it("shows a non-run outside a plan date span", () => {
    const future = { ...nonRun("w1"), startDate: new Date(2026, 2, 19, 9) };
    const events = withActual([makeWorkoutPlan([workoutEntry(0, 1, "e1", false)])], [future]);
    expect(events[1].kind).toBe("actual-workout");
  });
  it("suppresses a durable matched workout", () => {
    const e = { ...workoutEntry(0, 1, "e1", true), matchedWorkoutId: "w1" };
    const events = withActual([makeWorkoutPlan([e])], [nonRun("w1")]);
    expect(events).toHaveLength(1);
  });
  it("shows an additional non-run workout on a completed planned day", () => {
    const e = { ...workoutEntry(0, 1, "e1", true), matchedWorkoutId: "w1" };
    const events = withActual([makeWorkoutPlan([e])], [nonRun("w1"), nonRun("w2", 10)]);
    expect(events.map((event) => event.kind)).toEqual(["planned-workout", "actual-workout"]);
    expect(events[1].activity?.workoutId).toBe("w2");
  });
  it("leaves an ambiguous legacy workout visible", () => {
    const w = nonRun("w1");
    const e = { ...workoutEntry(0, 1, "e1", true), completedAt: new Date(2026, 0, 19, 11).toISOString() };
    expect(withActual([makeWorkoutPlan([e])], [w]).map((event) => event.kind))
      .toEqual(["planned-workout", "actual-workout"]);
  });
  it("uses local midnight for actual activity dates", () => {
    const w = { ...nonRun("w1"), startDate: new Date(2026, 0, 19, 0, 5) };
    expect(withActual([], [w])[0].date.getDate()).toBe(19);
  });
  it("places planned events before actual events regardless of start time", () => {
    const events = withActual([makeWorkoutPlan([workoutEntry(0, 1, "e1", false)])], [nonRun("w1", 5)]);
    expect(events.map((event) => event.kind)).toEqual(["planned-workout", "actual-workout"]);
  });
  it("orders actual events by local start time then workoutId", () => {
    const events = withActual([], [nonRun("z", 10), nonRun("b", 9), nonRun("a", 10)]);
    expect(events.map((event) => event.activity?.workoutId)).toEqual(["b", "a", "z"]);
  });
  it("uses resolved titles and no fake plan metadata on actual-only events", () => {
    const [event] = withActual([], [run("2026-01-19", 3, "w1")]);
    expect(event.label).toBe("3mi Run");
    expect(event).not.toHaveProperty("planId");
    expect(event).not.toHaveProperty("entryId");
  });
});
