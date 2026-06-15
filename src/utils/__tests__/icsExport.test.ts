import { describe, expect, it } from "vitest";
import {
  buildRunDate,
  buildEventTitle,
  generateIcs,
} from "@/utils/icsExport";
import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function entry(partial: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id: partial.id ?? "e1",
    weekIndex: partial.weekIndex ?? 0,
    weekday: partial.weekday ?? 1,
    dayOfWeek: (partial.weekday ?? 1) - 1,
    distanceMiles: partial.distanceMiles ?? 5,
    runType: partial.runType,
    workoutType: partial.workoutType,
    description: partial.description,
    scheduledTime: partial.scheduledTime,
  };
}

function plan(entries: PlannedRunEntry[], startDate = "2026-06-01"): RunningPlan {
  // group entries by weekIndex into weeks
  const maxWeek = entries.reduce((m, e) => Math.max(m, e.weekIndex), 0);
  const weeks = Array.from({ length: maxWeek + 1 }, (_, i) => ({
    weekNumber: i + 1,
    entries: entries.filter((e) => e.weekIndex === i),
  }));
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate,
    weeks,
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function veventCount(ics: string): number {
  return (ics.match(/BEGIN:VEVENT/g) ?? []).length;
}

// ─── Happy path ────────────────────────────────────────────────────────────────

describe("generateIcs — happy path", () => {
  it("produces a VCALENDAR with one VEVENT per non-rest entry", () => {
    const ics = generateIcs({
      plan: plan([
        entry({ id: "a", weekday: 1, runType: "outdoor", distanceMiles: 5 }),
        entry({ id: "b", weekday: 3, workoutType: "tempo", distanceMiles: 6 }),
        entry({ id: "c", weekday: 6, runType: "longRun", distanceMiles: 12 }),
      ]),
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:");
    expect(ics).toContain("END:VCALENDAR");
    expect(veventCount(ics)).toBe(3);
  });

  it("gives each VEVENT a stable plan/entry-scoped UID", () => {
    const ics = generateIcs({ plan: plan([entry({ id: "a", runType: "outdoor" })]) });
    expect(ics).toContain("UID:plan1-a@training-web");
  });
});

// ─── Rest-day exclusion ────────────────────────────────────────────────────────

describe("generateIcs — rest days skipped", () => {
  it("excludes entries with runType 'rest' and workoutType 'rest'", () => {
    const ics = generateIcs({
      plan: plan([
        entry({ id: "a", runType: "outdoor", weekday: 1 }),
        entry({ id: "rest1", runType: "rest", weekday: 2 }),
        entry({ id: "rest2", workoutType: "rest", weekday: 3 }),
      ]),
    });
    expect(veventCount(ics)).toBe(1);
    expect(ics).toContain("UID:plan1-a@training-web");
    expect(ics).not.toContain("plan1-rest1");
    expect(ics).not.toContain("plan1-rest2");
  });
});

// ─── Time precedence ───────────────────────────────────────────────────────────

describe("generateIcs — time precedence", () => {
  it("uses the entry's stored scheduledTime over defaultTime", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor", scheduledTime: "07:30" })]),
      defaultTime: "18:00",
    });
    // startDate 2026-06-01, weekIndex0/weekday1 → 2026-06-01 at 07:30
    expect(ics).toContain("DTSTART:20260601T073000");
    expect(ics).not.toContain("DTSTART;VALUE=DATE");
  });

  it("falls back to defaultTime when no scheduledTime is set", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor" })]),
      defaultTime: "18:00",
    });
    expect(ics).toContain("DTSTART:20260601T180000");
  });

  it("falls back to an all-day VALUE=DATE event when neither time is set", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor" })]),
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260601");
    expect(ics).not.toContain("DTSTART:20260601T");
  });

  it("ends timed events default 60 minutes after start", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor", scheduledTime: "07:00" })]),
    });
    expect(ics).toContain("DTSTART:20260601T070000");
    expect(ics).toContain("DTEND:20260601T080000");
  });

  it("honors a custom eventDurationMinutes", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor", scheduledTime: "07:00" })]),
      eventDurationMinutes: 90,
    });
    expect(ics).toContain("DTSTART:20260601T070000");
    expect(ics).toContain("DTEND:20260601T083000");
  });
});

// ─── Date derivation ───────────────────────────────────────────────────────────

describe("buildRunDate — date derivation", () => {
  it("weekIndex 0 / weekday 1 lands on plan.startDate", () => {
    const p = plan([entry({ id: "a", weekIndex: 0, weekday: 1 })]);
    const d = buildRunDate(p, p.weeks[0].entries[0]);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June (0-based)
    expect(d.getDate()).toBe(1);
  });

  it("weekIndex 1 / weekday 3 lands on the correct offset date", () => {
    // 2026-06-01 + 1*7 + (3-1) = +9 days → 2026-06-10
    const e = entry({ id: "a", weekIndex: 1, weekday: 3 });
    const p = plan([e]);
    const d = buildRunDate(p, e);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(10);
  });

  it("emits the derived offset date in the VEVENT", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", weekIndex: 1, weekday: 3, runType: "outdoor" })]),
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260610");
  });
});

// ─── Title building ────────────────────────────────────────────────────────────

describe("buildEventTitle", () => {
  it("formats distance and a human label from workoutType", () => {
    expect(buildEventTitle(entry({ workoutType: "easy", distanceMiles: 5 }))).toBe(
      "5.0 mi Easy Run"
    );
    expect(buildEventTitle(entry({ workoutType: "long", distanceMiles: 12 }))).toBe(
      "12.0 mi Long Run"
    );
  });

  it("derives the label from runType when workoutType is absent", () => {
    expect(buildEventTitle(entry({ runType: "treadmill", distanceMiles: 3 }))).toBe(
      "3.0 mi Treadmill Run"
    );
    expect(buildEventTitle(entry({ runType: "otf", distanceMiles: 4 }))).toBe(
      "4.0 mi OTF"
    );
  });

  it("falls back to a plain 'Run' label for unknown types", () => {
    expect(buildEventTitle(entry({ runType: "outdoor", distanceMiles: 7 }))).toBe(
      "7.0 mi Run"
    );
  });
});

// ─── Text escaping ─────────────────────────────────────────────────────────────

describe("generateIcs — RFC 5545 text escaping", () => {
  it("escapes commas and semicolons in the description", () => {
    const ics = generateIcs({
      plan: plan([
        entry({
          id: "a",
          runType: "outdoor",
          description: "Run 5 miles, then stretch; cool down",
        }),
      ]),
    });
    expect(ics).toContain(
      "DESCRIPTION:Run 5 miles\\, then stretch\\; cool down"
    );
  });

  it("omits DESCRIPTION when the entry has none", () => {
    const ics = generateIcs({
      plan: plan([entry({ id: "a", runType: "outdoor" })]),
    });
    expect(ics).not.toContain("DESCRIPTION:");
  });
});
