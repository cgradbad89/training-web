/**
 * Offline parent-summary research runner. No Firebase SDK, network, child reads,
 * production mutations, or scheduled work. Run via the env-gated Vitest entry:
 * RACE_EVALUATION_INPUT=<snapshot-or-fixture.json> RACE_EVALUATION_OUTPUT=<report.json>
 * npx vitest run scripts/evaluateRacePerformance.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { HealthWorkout } from "../src/types/healthWorkout";
import type { Race } from "../src/types/race";
import type { WorkoutOverride } from "../src/types/workoutOverride";
import { evaluateRacePerformanceHistory } from "../src/utils/racePerformanceEvaluation";

interface OfflineInput {
  exportedAt?: string;
  asOf?: string;
  timeZone?: string;
  races?: Race[];
  halfMarathonRaces?: { id: string; doc: Omit<Race, "id"> }[];
  workouts?: Record<string, unknown>[];
  healthWorkouts?: { id: string; doc: Record<string, unknown> }[];
  overrides?: Record<string, WorkoutOverride>;
  workoutOverrides?: { id: string; doc: WorkoutOverride }[];
}

function date(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "_seconds" in value) {
    const timestamp = value as { _seconds: number; _nanoseconds?: number };
    return new Date(timestamp._seconds * 1000 + (timestamp._nanoseconds ?? 0) / 1_000_000);
  }
  return new Date(typeof value === "string" || typeof value === "number" ? value : Number.NaN);
}

export function runOfflineRaceEvaluation(inputPath: string, outputPath: string) {
  const contents = readFileSync(inputPath);
  const input = JSON.parse(contents.toString("utf8")) as OfflineInput;
  const asOf = input.asOf ?? input.exportedAt;
  if (!asOf) throw new TypeError("Offline fixture must supply fixed asOf or exportedAt; wall-clock defaults are not reproducible");
  const rows = input.workouts?.map((doc) => ({ id: String(doc.workoutId ?? ""), doc })) ?? input.healthWorkouts ?? [];
  // Access parent docs only. Snapshot route/mileSplits/hrStream members are never
  // inspected or used, even when present in the local archive.
  const workouts = rows.map(({ id, doc }): HealthWorkout => ({
    ...doc, workoutId: String(doc.workoutId ?? id), startDate: date(doc.startDate), endDate: date(doc.endDate), syncedAt: date(doc.syncedAt),
    distanceMiles: typeof doc.distanceMiles === "number" ? doc.distanceMiles : typeof doc.distanceMeters === "number" ? doc.distanceMeters / 1609.344 : 0,
    durationSeconds: typeof doc.durationSeconds === "number" ? doc.durationSeconds : 0,
    activityType: typeof doc.activityType === "string" ? doc.activityType : "unknown",
    displayType: typeof doc.displayType === "string" ? doc.displayType : "Unknown",
    sourceName: typeof doc.sourceName === "string" ? doc.sourceName : "Unknown", isRunLike: doc.isRunLike === true,
  } as HealthWorkout));
  const races = input.races ?? input.halfMarathonRaces?.map(({ id, doc }) => ({ ...doc, id })) ?? [];
  const overrides = input.overrides ?? Object.fromEntries((input.workoutOverrides ?? []).map(({ id, doc }) => [id, doc]));
  const report = evaluateRacePerformanceHistory({ races, workouts, overrides, asOf, timeZone: input.timeZone ?? "America/New_York" });
  const result = {
    source: {
      format: input.healthWorkouts ? "local_firestore_snapshot" : "offline_fixture",
      inputSha256: createHash("sha256").update(contents).digest("hex"),
      exportedAt: input.exportedAt ?? null,
      parentWorkoutCount: workouts.length,
      runningSummaryCount: workouts.filter((workout) => workout.isRunLike).length,
      raceRecordCount: races.length,
      overrideRecordCount: Object.keys(overrides).length,
      missingCollections: [
        ...(!input.races && !input.halfMarathonRaces ? ["halfMarathonRaces"] : []),
        ...(!input.overrides && !input.workoutOverrides ? ["workoutOverrides"] : []),
      ],
      childCollectionsUsed: [],
      completeness: "Only supplied records were evaluated. Missing race identities, verification, exclusions, or revision history were not fabricated.",
    },
    report,
  };
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
