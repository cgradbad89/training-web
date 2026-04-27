import { type RunningPlan, type PlannedRunEntry, type PlanRunType } from "@/types";
import { createPlan } from "@/services/plans";
import { fetchRaces, createRace, updateRace } from "@/services/races";

function entry(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  runType: PlanRunType,
  paceTarget?: string,
  description?: string
): PlannedRunEntry {
  return {
    id: `seed-w${weekIndex}-d${weekday}`,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType,
    ...(paceTarget !== undefined ? { paceTarget } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

// 14-week half marathon training plan (mirrored from iOS SampleTrainingPlan.swift)
// startDate: 2026-01-19 (Monday), race day: 2026-04-25 (Saturday, week 14 day 6)
// weekday encoding: 1=Mon, 3=Wed, 5=Fri, 6=Sat

const SEED_WEEKS = [
  // Week 1: 1/19
  [
    entry(0, 1, 1.5,  "treadmill", "11:00"),
    entry(0, 3, 4.0,  "outdoor",   "10:20"),
    entry(0, 5, 1.5,  "otf"),
    entry(0, 6, 3.0,  "longRun",   "10:45"),
  ],
  // Week 2: 1/26
  [
    entry(1, 1, 2.0,  "treadmill", "10:50"),
    entry(1, 3, 3.0,  "outdoor",   "10:20"),
    entry(1, 5, 1.75, "otf"),
    entry(1, 6, 4.0,  "longRun",   "10:45"),
  ],
  // Week 3: 2/2
  [
    entry(2, 1, 2.1,  "treadmill", "11:00"),
    entry(2, 3, 4.0,  "outdoor",   undefined, "Tempo"),
    entry(2, 5, 1.75, "otf"),
    entry(2, 6, 5.0,  "longRun",   "10:40"),
  ],
  // Week 4: 2/9
  [
    entry(3, 1, 2.1,  "treadmill", "10:45"),
    entry(3, 3, 4.0,  "outdoor",   "10:15"),
    entry(3, 5, 1.75, "otf"),
    entry(3, 6, 6.0,  "longRun",   "10:40"),
  ],
  // Week 5: 2/16
  [
    entry(4, 1, 2.2,  "treadmill", "10:45"),
    entry(4, 3, 5.0,  "outdoor",   undefined, "Tempo"),
    entry(4, 5, 1.75, "otf"),
    entry(4, 6, 6.5,  "longRun",   "10:35"),
  ],
  // Week 6: 2/23
  [
    entry(5, 1, 2.2,  "treadmill", "11:00"),
    entry(5, 3, 5.0,  "outdoor",   "10:10"),
    entry(5, 5, 1.75, "otf"),
    entry(5, 6, 7.0,  "longRun",   "10:30"),
  ],
  // Week 7: 3/2
  [
    entry(6, 1, 2.3,  "treadmill", "10:45"),
    entry(6, 3, 5.0,  "outdoor",   undefined, "Tempo"),
    entry(6, 5, 1.75, "otf"),
    entry(6, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 8: 3/9
  [
    entry(7, 1, 2.3,  "treadmill", "11:00"),
    entry(7, 3, 5.5,  "outdoor",   "10:05"),
    entry(7, 5, 1.75, "otf"),
    entry(7, 6, 9.0,  "longRun",   "10:30"),
  ],
  // Week 9: 3/16
  [
    entry(8, 1, 2.2,  "treadmill", "11:00"),
    entry(8, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(8, 5, 1.8,  "otf"),
    entry(8, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 10: 3/23
  [
    entry(9, 1, 2.2,  "treadmill", "10:45"),
    entry(9, 3, 6.0,  "outdoor"),
    entry(9, 5, 0,    "rest"),
    entry(9, 6, 0,    "rest"),
  ],
  // Week 11: 3/30
  [
    entry(10, 1, 2.0,  "treadmill", "11:00"),
    entry(10, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(10, 5, 1.75, "otf"),
    entry(10, 6, 10.5, "longRun"),
  ],
  // Week 12: 4/6
  [
    entry(11, 1, 2.3,  "treadmill", "11:00"),
    entry(11, 3, 6.0,  "outdoor",   undefined, "Tempo"),
    entry(11, 5, 1.75, "otf"),
    entry(11, 6, 11.0, "longRun"),
  ],
  // Week 13: 4/13
  [
    entry(12, 1, 2.0,  "treadmill", "10:45"),
    entry(12, 3, 4.0,  "outdoor",   undefined, "Tempo"),
    entry(12, 5, 1.75, "otf"),
    entry(12, 6, 8.0,  "longRun",   "10:30"),
  ],
  // Week 14: 4/20 (race week)
  [
    entry(13, 1, 1.8,  "treadmill", "11:00"),
    entry(13, 3, 2.0,  "outdoor",   undefined, "Tempo"),
    entry(13, 5, 0,    "rest"),
    entry(13, 6, 13.1, "outdoor",   undefined, "RACE — Half Marathon"),
  ],
];

export const DEFAULT_HALF_MARATHON_PLAN: Omit<RunningPlan, "id" | "createdAt" | "updatedAt"> = {
  name: "Half Marathon — Spring 2026",
  startDate: "2026-01-19",
  isActive: true,
  isBuiltInDefault: true,
  weeks: SEED_WEEKS.map((entries, i) => ({
    weekNumber: i + 1,
    entries,
  })),
};

// ─── September 2026 Half Marathon Plan ───────────────────────────────────────
//
// 16-week plan targeting a 9:30–9:45 /mi half marathon on 2026-09-06.
// Week 1 begins Monday 2026-05-18.
// Parsed from the training CSV. OFF/rest days are omitted (no entry record).

/** Convert a mm:ss pace string like "11:00" to seconds per mile (660). */
function paceStringToSeconds(mmss: string): number {
  const [mStr, sStr] = mmss.split(":");
  const m = Number(mStr);
  const s = Number(sStr);
  return m * 60 + s;
}

/** Convert seconds-per-mile back to mm:ss string. Rounds to nearest second. */
function secondsToPaceString(total: number): string {
  const rounded = Math.round(total);
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Midpoint of two mm:ss paces, returned as { seconds, mmss }. */
function paceMidpoint(
  a: string,
  b: string
): { seconds: number; mmss: string } {
  const seconds = (paceStringToSeconds(a) + paceStringToSeconds(b)) / 2;
  return { seconds, mmss: secondsToPaceString(seconds) };
}

/** Exact pace from a single mm:ss string. */
function paceExact(a: string): { seconds: number; mmss: string } {
  const seconds = paceStringToSeconds(a);
  return { seconds, mmss: secondsToPaceString(seconds) };
}

function sept(
  weekIndex: number,
  weekday: number,
  distanceMiles: number,
  runType: PlanRunType,
  pace: { seconds: number; mmss: string },
  description: string,
  notes: string | null = null
): PlannedRunEntry {
  return {
    id: `sept-hm-w${weekIndex}-d${weekday}`,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType,
    paceTarget: pace.mmss,
    targetPaceSecondsPerMile: pace.seconds,
    description,
    notes: notes ?? undefined,
    targetHeartRate: null,
  };
}

/**
 * Flat list of all PlannedRunEntry records for the September 2026 half
 * marathon plan. OFF days are intentionally absent.
 */
export const SEPT_HM_PLAN_ENTRIES: PlannedRunEntry[] = [
  // Week 1 (Re-Entry) — starts Mon 2026-05-18, ~16 mi
  sept(0, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(0, 2, 3.5, "outdoor", paceMidpoint("10:15", "10:45"),
    "3.5 miles easy + 4x20s strides"),
  sept(0, 4, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(0, 6, 6.5, "longRun", paceMidpoint("10:10", "10:30"),
    "6.5 miles easy"),

  // Week 2 (Re-Entry) — ~18 mi
  sept(1, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(1, 2, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy + 5x20s strides"),
  sept(1, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(1, 4, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(1, 6, 7.0, "longRun", paceMidpoint("10:05", "10:25"),
    "7 miles easy"),

  // Week 3 (Base Build) — ~21 mi
  sept(2, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(2, 2, 4.5, "outdoor", paceMidpoint("9:40", "9:50"),
    "2 easy + 2.5 @ tempo"),
  sept(2, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(2, 4, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(2, 6, 8.0, "longRun", paceMidpoint("10:05", "10:25"),
    "8 miles"),

  // Week 4 (Base Build) — ~23 mi
  sept(3, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(3, 2, 5.0, "outdoor", paceMidpoint("9:35", "9:45"),
    "2 easy + 3 @ tempo"),
  sept(3, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(3, 4, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(3, 6, 9.0, "longRun", paceMidpoint("10:00", "10:20"),
    "9 miles"),

  // Week 5 (Build) — ~25 mi
  sept(4, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(4, 2, 5.5, "outdoor", paceMidpoint("9:30", "9:40"),
    "2 easy + 3.5 @ tempo"),
  sept(4, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(4, 4, 4.0, "outdoor", paceMidpoint("9:50", "10:05"),
    "4 miles steady"),
  sept(4, 6, 9.5, "longRun", paceMidpoint("10:00", "10:20"),
    "9.5 miles"),

  // Week 6 (Cutback) — ~18 mi
  sept(5, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(5, 2, 4.0, "outdoor", paceExact("9:35"),
    "2 easy + 2 @ tempo"),
  sept(5, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(5, 4, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(5, 6, 7.0, "longRun", paceMidpoint("10:05", "10:25"),
    "7 miles easy"),

  // Week 7 (Build) — ~26 mi
  sept(6, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(6, 2, 5.0, "outdoor", paceMidpoint("9:10", "9:20"),
    "2 easy + 4x6 min hard + 2 min jog"),
  sept(6, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(6, 4, 4.0, "outdoor", paceMidpoint("9:45", "10:00"),
    "4 miles steady"),
  sept(6, 6, 10.0, "longRun", paceMidpoint("10:00", "10:20"),
    "10 miles"),

  // Week 8 (Build) — ~28 mi
  sept(7, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(7, 2, 6.0, "outdoor", paceMidpoint("9:25", "9:35"),
    "2 easy + 4 @ tempo"),
  sept(7, 3, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(7, 4, 5.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "5 miles easy"),
  sept(7, 6, 10.5, "longRun", paceMidpoint("10:00", "10:15"),
    "10.5 miles"),

  // Week 9 (Build) — ~29 mi
  sept(8, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(8, 2, 8.0, "outdoor", paceMidpoint("9:05", "9:15"),
    "2 easy + 3x2 miles hard"),
  sept(8, 3, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(8, 4, 5.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "5 miles easy"),
  sept(8, 6, 10.5, "longRun", paceMidpoint("10:00", "10:15"),
    "10.5 miles (last 2 @ 9:30)", "Last 2 miles @ 9:30"),

  // Week 10 (Cutback) — ~20 mi
  sept(9, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(9, 2, 4.5, "outdoor", paceMidpoint("9:25", "9:35"),
    "2 easy + 2.5 @ tempo"),
  sept(9, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(9, 4, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(9, 6, 8.0, "longRun", paceMidpoint("10:05", "10:25"),
    "8 miles easy"),

  // Week 11 (Peak) — ~31 mi
  sept(10, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(10, 2, 7.0, "outdoor", paceMidpoint("9:15", "9:25"),
    "2 easy + 5 @ tempo"),
  sept(10, 3, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(10, 4, 5.0, "outdoor", paceMidpoint("9:40", "9:55"),
    "5 miles steady"),
  sept(10, 6, 11.0, "longRun", paceMidpoint("10:00", "10:15"),
    "11 miles (last 2 @ 9:20)", "Last 2 miles @ 9:20"),

  // Week 12 (Peak) — ~33 mi
  sept(11, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(11, 2, 6.0, "outdoor", paceMidpoint("9:00", "9:10"),
    "2 easy + 5x5 min hard + 2 min jog"),
  sept(11, 3, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(11, 4, 5.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "5 miles easy"),
  sept(11, 6, 12.0, "longRun", paceMidpoint("10:00", "10:15"),
    "12 miles (last 3 @ 9:20)", "Last 3 miles @ 9:20"),

  // Week 13 (Peak) — ~31 mi
  sept(12, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(12, 2, 7.0, "outdoor", paceMidpoint("9:10", "9:20"),
    "2 easy + 5 @ tempo"),
  sept(12, 3, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(12, 4, 5.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "5 miles easy"),
  sept(12, 6, 12.5, "longRun", paceMidpoint("10:00", "10:15"),
    "12-13 miles (last 3 @ 9:15)", "Last 3 miles @ 9:15"),

  // Week 14 (Sharpen) — ~26 mi
  sept(13, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(13, 2, 6.0, "outdoor", paceMidpoint("9:15", "9:25"),
    "2 easy + 4 @ race pace"),
  sept(13, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(13, 4, 4.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "4 miles easy"),
  sept(13, 6, 10.0, "longRun", paceMidpoint("10:00", "10:15"),
    "10 miles (last 2 @ RP)", "Last 2 miles @ 9:20"),

  // Week 15 (Pre-Taper) — ~20 mi
  sept(14, 1, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(14, 2, 5.0, "outdoor", paceMidpoint("9:15", "9:25"),
    "2 easy + 3 @ race pace"),
  sept(14, 3, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(14, 4, 3.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "3 miles easy"),
  sept(14, 6, 8.0, "longRun", paceMidpoint("10:00", "10:20"),
    "8 miles easy"),

  // Week 16 (Taper + Race) — ~16 + race
  sept(15, 1, 2.5, "outdoor", paceMidpoint("10:15", "10:45"),
    "2.5 miles easy"),
  sept(15, 2, 2.0, "outdoor", paceExact("10:15"),
    "2 miles easy + 4x20s strides"),
  sept(15, 3, 2.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "2 miles easy"),
  sept(15, 4, 2.0, "outdoor", paceMidpoint("10:15", "10:45"),
    "2 miles easy"),
  sept(15, 7, 13.1, "longRun", paceMidpoint("9:15", "9:30"),
    "Half Marathon — 13.1 miles",
    "Primary: sub-9:30 (9:15–9:30/mi) · Stretch: sub-9:15"),
];

/** Group a flat entry list into PlanWeek[] for the given week count. */
function groupEntriesIntoWeeks(
  entries: PlannedRunEntry[],
  numberOfWeeks: number
): { weekNumber: number; entries: PlannedRunEntry[] }[] {
  const weeks: { weekNumber: number; entries: PlannedRunEntry[] }[] = [];
  for (let i = 0; i < numberOfWeeks; i++) {
    weeks.push({ weekNumber: i + 1, entries: [] });
  }
  for (const e of entries) {
    if (e.weekIndex < 0 || e.weekIndex >= numberOfWeeks) continue;
    weeks[e.weekIndex].entries.push(e);
  }
  return weeks;
}

/**
 * Seed the September 2026 half marathon training plan for a user and link
 * it to a matching Race record (created if none exists close to 2026-09-06).
 *
 * - Does NOT mark the plan active (user switches manually after their April race).
 * - Idempotent at the call site: the Plans page checks for an existing plan
 *   named "Sept 2026" before calling this.
 */
export async function seedSeptHMPlan(userId: string): Promise<{
  plan: RunningPlan;
  raceId: string;
  raceCreated: boolean;
}> {
  // ── Race linkage ────────────────────────────────────────────────────────
  const RACE_DATE = "2026-09-06";
  const TARGET_PACE_SECONDS = 555; // 9:15 stretch pace — primary sub-9:30, stretch sub-9:15

  let raceId: string;
  let raceCreated = false;

  const existingRaces = await fetchRaces(userId);
  // Match within ±3 days of the target date, distance = halfMarathon
  const targetDate = new Date(RACE_DATE + "T00:00:00").getTime();
  const THREE_DAYS = 3 * 24 * 3600 * 1000;
  const match = existingRaces.find((r) => {
    if (r.raceDistance !== "halfMarathon") return false;
    const d = new Date(r.raceDate + "T00:00:00").getTime();
    return Math.abs(d - targetDate) <= THREE_DAYS;
  });

  if (match) {
    raceId = match.id;
    // If the existing Sept race has the old target pace (or none), refresh
    // it to the current TARGET_PACE_SECONDS so re-seeding keeps it aligned.
    if (match.targetPaceSecondsPerMile !== TARGET_PACE_SECONDS) {
      await updateRace(userId, match.id, {
        targetPaceSecondsPerMile: TARGET_PACE_SECONDS,
      });
    }
  } else {
    raceId = await createRace(userId, {
      name: "September Half Marathon",
      raceDate: RACE_DATE,
      raceDistance: "halfMarathon",
      targetPaceSecondsPerMile: TARGET_PACE_SECONDS,
      isActive: false,
    });
    raceCreated = true;
  }

  // ── Plan ────────────────────────────────────────────────────────────────
  const numberOfWeeks = 16;
  const plan = await createPlan<RunningPlan>(userId, {
    name: "Half Marathon — Sept 2026 (Sub 9:30)",
    planType: "running",
    startDate: "2026-05-18",
    isActive: false,
    isBuiltInDefault: false,
    linkedRaceId: raceId,
    weeks: groupEntriesIntoWeeks(SEPT_HM_PLAN_ENTRIES, numberOfWeeks),
  });

  return { plan, raceId, raceCreated };
}
