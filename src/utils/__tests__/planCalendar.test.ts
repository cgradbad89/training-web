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

// Minimal HealthWorkout — only the fields the matcher reads. UTC-noon
// timestamps keep the calendar day stable regardless of the runner's timezone.
function run(startISO: string, distanceMiles: number, id?: string): HealthWorkout {
  return {
    workoutId: id ?? `run-${startISO}`,
    isRunLike: true,
    startDate: new Date(startISO),
    distanceMiles,
    durationSeconds: distanceMiles * 600,
    avgHeartRate: null,
    trainingLoadV2: null,
  } as unknown as HealthWorkout;
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
