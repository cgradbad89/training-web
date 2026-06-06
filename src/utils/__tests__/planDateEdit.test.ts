import { describe, expect, it } from "vitest";
import {
  snapToMonday,
  derivePlanEndDate,
  endDateForWeeks,
  endsAfterRace,
  upcomingMonday,
  weeksForSpan,
  slideStartDate,
  resizeToEndDate,
  droppedWeeksWithEntries,
  copyPlanWithNewStart,
} from "@/utils/planDateEdit";
import {
  type RunningPlan,
  type WorkoutPlan,
  type PlannedRunEntry,
  type PlannedWorkoutEntry,
  isWorkoutPlan,
} from "@/types/plan";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function runEntry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  id: string,
  runType: PlannedRunEntry["runType"] = "outdoor"
): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType,
  };
}

function workoutEntry(
  weekIndex: number,
  weekday: number,
  id: string,
  opts: Partial<PlannedWorkoutEntry> = {}
): PlannedWorkoutEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    type: "workout",
    exercises: [],
    ...opts,
  };
}

// 3-week running plan starting Mon 2026-01-19.
function makeRunningPlan(): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      { weekNumber: 1, entries: [runEntry(0, 1, 5, "w1-mon")] },
      { weekNumber: 2, entries: [runEntry(1, 1, 6, "w2-mon")] },
      { weekNumber: 3, entries: [runEntry(2, 1, 7, "w3-mon")] },
    ],
  };
}

// 3-week workout plan starting Mon 2026-01-19, with some completed entries.
function makeWorkoutPlan(): WorkoutPlan {
  return {
    id: "wplan1",
    name: "Strength",
    planType: "workout",
    startDate: "2026-01-19",
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          workoutEntry(0, 1, "w1-mon", {
            completed: true,
            completedAt: "2026-01-19T18:00:00.000Z",
          }),
        ],
      },
      {
        weekNumber: 2,
        entries: [
          workoutEntry(1, 3, "w2-wed", {
            completed: true,
            completedAt: "2026-01-28T18:00:00.000Z",
          }),
        ],
      },
      { weekNumber: 3, entries: [workoutEntry(2, 5, "w3-fri")] },
    ],
  };
}

/** Re-derive an entry's calendar date the same way plannedEntryDate does. */
function derivedEntryISO(startIso: string, weekIndex: number, weekday: number): string {
  const [y, m, d] = startIso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + weekIndex * 7 + (weekday - 1));
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─── snapToMonday ──────────────────────────────────────────────────────────────

describe("snapToMonday", () => {
  it("returns a Monday unchanged", () => {
    expect(snapToMonday("2026-01-19")).toBe("2026-01-19"); // Mon
  });

  it("snaps a mid-week date back to its Monday", () => {
    expect(snapToMonday("2026-01-22")).toBe("2026-01-19"); // Thu → Mon
  });

  it("snaps Sunday to the Monday 6 days prior", () => {
    expect(snapToMonday("2026-01-25")).toBe("2026-01-19"); // Sun → prev Mon
  });

  it("snaps across a month boundary", () => {
    // Wed 2026-04-01 → Mon 2026-03-30
    expect(snapToMonday("2026-04-01")).toBe("2026-03-30");
  });

  it("snaps across a year boundary", () => {
    // Thu 2027-01-01 → Mon 2026-12-28
    expect(snapToMonday("2027-01-01")).toBe("2026-12-28");
  });

  it("uses local-date parsing (no UTC off-by-one drift)", () => {
    // 2026-03-02 is a Monday; under a naive UTC parse in a negative-offset
    // timezone this could read as Sunday and snap a week early. Local parse
    // keeps it on its own Monday.
    expect(snapToMonday("2026-03-02")).toBe("2026-03-02");
  });
});

// ─── derivePlanEndDate / weeksForSpan round-trip ──────────────────────────────

describe("derivePlanEndDate / weeksForSpan", () => {
  it("end date is the Sunday of the final week", () => {
    // 3 weeks from Mon 2026-01-19 → Sun 2026-02-08 (19 + 20 days)
    expect(derivePlanEndDate(makeRunningPlan())).toBe("2026-02-08");
  });

  it("round-trips: derived end fed back yields weeks.length", () => {
    const plan = makeRunningPlan();
    const end = derivePlanEndDate(plan);
    expect(weeksForSpan(plan.startDate, end)).toBe(plan.weeks.length);
  });

  it("round-trips for a 16-week plan", () => {
    const start = "2026-01-19";
    const end = "2026-05-09"; // start + 16*7 - 1 = +111 days
    expect(weeksForSpan(start, end)).toBe(16);
  });

  it("matches the create-modal ceil formula for known spans", () => {
    expect(weeksForSpan("2026-01-19", "2026-01-25")).toBe(1); // 6 days → 1 wk
    expect(weeksForSpan("2026-01-19", "2026-01-26")).toBe(1); // 7 days → 1 wk
    expect(weeksForSpan("2026-01-19", "2026-01-27")).toBe(2); // 8 days → 2 wks
  });

  it("clamps a non-positive span to a minimum of 1 week", () => {
    expect(weeksForSpan("2026-01-19", "2026-01-19")).toBe(1);
    expect(weeksForSpan("2026-01-19", "2026-01-12")).toBe(1);
  });

  it("endDateForWeeks matches the former inline helper", () => {
    // start + weeks*7 - 1 days
    expect(endDateForWeeks("2026-01-19", 13)).toBe("2026-04-19");
    expect(endDateForWeeks("2026-01-19", 1)).toBe("2026-01-25");
    // derivePlanEndDate is endDateForWeeks(startDate, weeks.length)
    const plan = makeRunningPlan();
    expect(derivePlanEndDate(plan)).toBe(
      endDateForWeeks(plan.startDate, plan.weeks.length)
    );
  });
});

// ─── endsAfterRace ─────────────────────────────────────────────────────────────

describe("endsAfterRace", () => {
  it("false when no race date is supplied", () => {
    expect(endsAfterRace(makeRunningPlan())).toBe(false);
    expect(endsAfterRace(makeRunningPlan(), undefined)).toBe(false);
  });

  it("true when the derived end date is strictly after the race date", () => {
    const plan = makeRunningPlan(); // ends 2026-02-08
    expect(endsAfterRace(plan, "2026-02-07")).toBe(true);
  });

  it("false when the plan ends on or before the race date", () => {
    const plan = makeRunningPlan(); // ends 2026-02-08
    expect(endsAfterRace(plan, "2026-02-08")).toBe(false);
    expect(endsAfterRace(plan, "2026-03-01")).toBe(false);
  });
});

// ─── upcomingMonday ────────────────────────────────────────────────────────────

describe("upcomingMonday", () => {
  it("returns today when today is a Monday", () => {
    // 2026-01-19 is a Monday (local).
    expect(upcomingMonday(new Date(2026, 0, 19))).toBe("2026-01-19");
  });

  it("returns the upcoming Monday mid-week", () => {
    // Thu 2026-01-22 → Mon 2026-01-26
    expect(upcomingMonday(new Date(2026, 0, 22))).toBe("2026-01-26");
  });

  it("returns the next day when today is Sunday", () => {
    // Sun 2026-01-25 → Mon 2026-01-26
    expect(upcomingMonday(new Date(2026, 0, 25))).toBe("2026-01-26");
  });

  it("uses local-date components (no UTC drift)", () => {
    // Construct via local Y/M/D; result is a local Monday string.
    expect(upcomingMonday(new Date(2026, 2, 1))).toBe("2026-03-02"); // Sun → Mon
  });
});

// ─── slideStartDate ────────────────────────────────────────────────────────────

describe("slideStartDate — running", () => {
  it("changes startDate (snapped), keeps weeks identical, no mutation", () => {
    const plan = makeRunningPlan();
    const before = JSON.parse(JSON.stringify(plan));
    const slid = slideStartDate(plan, "2026-02-04"); // Wed → snaps to Mon 2026-02-02

    expect(slid.startDate).toBe("2026-02-02");
    expect(slid.weeks).toEqual(plan.weeks); // entries unchanged
    expect(plan).toEqual(before); // input untouched
    expect(slid).not.toBe(plan);
  });

  it("moves a slid entry's derived date by exactly the start delta", () => {
    const plan = makeRunningPlan();
    const newStart = "2026-02-02"; // 2 weeks (14 days) later, already a Monday
    const slid = slideStartDate(plan, newStart);

    const entry = slid.weeks[2].entries[0]; // weekIndex 2, weekday 1
    const before = derivedEntryISO(plan.startDate, entry.weekIndex, entry.weekday);
    const after = derivedEntryISO(slid.startDate, entry.weekIndex, entry.weekday);

    // before: 2026-02-02, after: 2026-02-16 → exactly +14 days
    expect(before).toBe("2026-02-02");
    expect(after).toBe("2026-02-16");
  });
});

describe("slideStartDate — workout", () => {
  it("clears completed/completedAt on every entry, keeps other fields", () => {
    const plan = makeWorkoutPlan();
    const slid = slideStartDate(plan, "2026-02-02") as WorkoutPlan;

    expect(isWorkoutPlan(slid)).toBe(true);
    for (const week of slid.weeks) {
      for (const e of week.entries) {
        expect(e.completed).toBe(false);
        expect("completedAt" in e).toBe(false);
      }
    }
    // Non-completion fields preserved (ids, weekday, type).
    expect(slid.weeks[0].entries[0].id).toBe("w1-mon");
    expect(slid.weeks[1].entries[0].weekday).toBe(3);
    expect(slid.startDate).toBe("2026-02-02");
  });

  it("does not mutate the source plan's completion state", () => {
    const plan = makeWorkoutPlan();
    slideStartDate(plan, "2026-02-02");
    expect(plan.weeks[0].entries[0].completed).toBe(true);
    expect(plan.weeks[0].entries[0].completedAt).toBe("2026-01-19T18:00:00.000Z");
  });

  it("running slide leaves entries with no completion fields introduced", () => {
    const slid = slideStartDate(makeRunningPlan(), "2026-02-02") as RunningPlan;
    for (const week of slid.weeks) {
      for (const e of week.entries) {
        expect("completed" in e).toBe(false);
        expect("completedAt" in e).toBe(false);
      }
    }
  });
});

// ─── resizeToEndDate ───────────────────────────────────────────────────────────

describe("resizeToEndDate", () => {
  it("lengthens by appending correctly-numbered empty weeks", () => {
    const plan = makeRunningPlan(); // 3 weeks, start Mon 2026-01-19
    // 5 weeks → end = start + 5*7 - 1 = 2026-02-22
    const resized = resizeToEndDate(plan, "2026-02-22");

    expect(resized.weeks.length).toBe(5);
    expect(resized.weeks[3]).toEqual({ weekNumber: 4, entries: [] });
    expect(resized.weeks[4]).toEqual({ weekNumber: 5, entries: [] });
    // Original weeks untouched.
    expect(resized.weeks[0]).toEqual(plan.weeks[0]);
    expect(resized.weeks[2]).toEqual(plan.weeks[2]);
  });

  it("shortens by slicing trailing weeks", () => {
    const plan = makeRunningPlan();
    // 2 weeks → end = 2026-02-01
    const resized = resizeToEndDate(plan, "2026-02-01");

    expect(resized.weeks.length).toBe(2);
    expect(resized.weeks.map((w) => w.weekNumber)).toEqual([1, 2]);
    expect(resized.weeks[0].entries).toEqual(plan.weeks[0].entries);
  });

  it("clamps newWeeks below 1 to a single week", () => {
    const plan = makeRunningPlan();
    const resized = resizeToEndDate(plan, "2026-01-12"); // before start → clamp
    expect(resized.weeks.length).toBe(1);
    expect(resized.weeks[0].weekNumber).toBe(1);
  });

  it("is a no-op for an equal span and does not mutate input", () => {
    const plan = makeRunningPlan();
    const before = JSON.parse(JSON.stringify(plan));
    const resized = resizeToEndDate(plan, derivePlanEndDate(plan));

    expect(resized.weeks.length).toBe(3);
    expect(resized.weeks).toEqual(plan.weeks);
    expect(plan).toEqual(before);
    expect(resized).not.toBe(plan);
  });

  it("works for workout plans too", () => {
    const plan = makeWorkoutPlan();
    const resized = resizeToEndDate(plan, "2026-02-22") as WorkoutPlan; // 5 weeks
    expect(resized.weeks.length).toBe(5);
    expect(resized.weeks[4]).toEqual({ weekNumber: 5, entries: [] });
    expect(isWorkoutPlan(resized)).toBe(true);
  });
});

// ─── droppedWeeksWithEntries ───────────────────────────────────────────────────

describe("droppedWeeksWithEntries", () => {
  it("returns only trailing weeks with non-rest entries", () => {
    const plan = makeRunningPlan(); // weeks 1,2,3 all have a run entry
    const dropped = droppedWeeksWithEntries(plan, 1);
    expect(dropped).toEqual([
      { weekNumber: 2, entryCount: 1 },
      { weekNumber: 3, entryCount: 1 },
    ]);
  });

  it("excludes empty trailing weeks", () => {
    const plan = makeRunningPlan();
    plan.weeks[2] = { weekNumber: 3, entries: [] }; // empty last week
    const dropped = droppedWeeksWithEntries(plan, 1);
    expect(dropped).toEqual([{ weekNumber: 2, entryCount: 1 }]);
  });

  it("excludes rest-only trailing weeks (running)", () => {
    const plan = makeRunningPlan();
    plan.weeks[2] = {
      weekNumber: 3,
      entries: [runEntry(2, 1, 0, "w3-rest", "rest")],
    };
    const dropped = droppedWeeksWithEntries(plan, 2);
    expect(dropped).toEqual([]);
  });

  it("counts only non-rest entries within a dropped week", () => {
    const plan = makeRunningPlan();
    plan.weeks[2] = {
      weekNumber: 3,
      entries: [
        runEntry(2, 1, 0, "w3-rest", "rest"),
        runEntry(2, 3, 5, "w3-run"),
      ],
    };
    expect(droppedWeeksWithEntries(plan, 2)).toEqual([
      { weekNumber: 3, entryCount: 1 },
    ]);
  });

  it("returns empty when nothing is dropped", () => {
    expect(droppedWeeksWithEntries(makeRunningPlan(), 3)).toEqual([]);
    expect(droppedWeeksWithEntries(makeRunningPlan(), 5)).toEqual([]);
  });

  it("handles workout rest entries via the type field", () => {
    const plan = makeWorkoutPlan();
    plan.weeks[2] = {
      weekNumber: 3,
      entries: [workoutEntry(2, 5, "w3-rest", { type: "rest" })],
    };
    expect(droppedWeeksWithEntries(plan, 2)).toEqual([]);
  });
});

// ─── copyPlanWithNewStart ──────────────────────────────────────────────────────

describe("copyPlanWithNewStart", () => {
  it("running: draft/inactive, fresh ids, new Monday-snapped start, name set", () => {
    const plan = makeRunningPlan();
    const payload = copyPlanWithNewStart(plan, "Spring Block", "2026-03-04"); // Wed → Mon 3/2

    expect(payload.name).toBe("Spring Block");
    expect(payload.status).toBe("draft");
    expect(payload.isActive).toBe(false);
    expect(payload.startDate).toBe("2026-03-02");
    expect(payload.planType).toBe("running");

    // Fresh entry ids (not the source ids).
    const copiedEntry = payload.weeks[0].entries[0];
    expect(copiedEntry.id).not.toBe("w1-mon");
    expect(copiedEntry.weekIndex).toBe(0);
    expect(copiedEntry.weekday).toBe(1);
  });

  it("workout: clears completion and sets the new start", () => {
    const plan = makeWorkoutPlan();
    const payload = copyPlanWithNewStart(plan, "Strength Copy", "2026-03-02");

    expect(isWorkoutPlan(payload as WorkoutPlan)).toBe(true);
    expect(payload.startDate).toBe("2026-03-02");
    expect(payload.status).toBe("draft");
    const w = payload as Omit<WorkoutPlan, "id" | "createdAt" | "updatedAt">;
    for (const week of w.weeks) {
      for (const e of week.entries) {
        expect(e.completed).toBe(false);
        expect(e.completedAt).toBeUndefined();
      }
    }
  });

  it("does not mutate the source plan", () => {
    const plan = makeRunningPlan();
    const before = JSON.parse(JSON.stringify(plan));
    copyPlanWithNewStart(plan, "Copy", "2026-03-02");
    expect(plan).toEqual(before);
  });
});
