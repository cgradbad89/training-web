import type { HealthWorkout } from "../../src/types/healthWorkout";
import type { Race } from "../../src/types/race";
import type { WorkoutOverride } from "../../src/types/workoutOverride";
import { derivePlanStatus, isActiveFromStatus, type RunningPlan } from "../../src/types/plan";
import { toDate } from "../../src/utils/dates";

/** Developer-only parent-document scopes. A cap never implies complete history. */
export const ACCEPTANCE_CAPS = { healthWorkouts: 1000, halfMarathonRaces: 100, workoutOverrides: 1000, activePlans: 20, linkedPlans: 20, linkedWorkouts: 100 } as const;
export type AcceptanceCollection = "healthWorkouts" | "halfMarathonRaces" | "workoutOverrides" | "activePlans";
export interface ParentRecord { id: string; data: Record<string, unknown> }
export interface ParentRead {
  records: ParentRecord[];
  cap: number;
  capped: boolean;
  fromServer: true;
  readStartedAt: string;
  readCompletedAt: string;
}
/** Only plain parent records cross this interface; SDK references stay private. */
export interface AcceptanceReader {
  collection(source: AcceptanceCollection, cap: number): Promise<ParentRead>;
  plan(id: string): Promise<ParentRead>;
  workout(id: string): Promise<ParentRead>;
}
export interface SourceDiagnostic {
  source: string;
  path: string;
  status: "complete" | "truncated" | "error" | "invalid";
  count: number;
  cap: number;
  fromServer: boolean;
  readStartedAt: string | null;
  readCompletedAt: string | null;
  messages: string[];
  coverage?: { oldestStartDate: string | null; newestStartDate: string | null; scope: string };
}
export interface AcceptanceSources {
  uid: string;
  loadedAt: string;
  races: Race[];
  workouts: HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plans: RunningPlan[];
  sourcesReady: boolean;
  diagnostics: SourceDiagnostic[];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function validDate(value: unknown, field: string): Date {
  const result = toDate(value);
  if (value == null || !Number.isFinite(result.getTime())) throw new Error(`Missing or invalid ${field}`);
  return result;
}
function dateOnly(value: unknown, field: string): string {
  return validDate(value, field).toISOString().split("T")[0];
}
function timestamp(value: unknown): string {
  // The canonical services use toDate(undefined) -> epoch for legacy metadata.
  const result = toDate(value);
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid metadata timestamp");
  return result.toISOString();
}

/** Same canonical parent-summary fields/date conversion, without service imports. */
export function parseAcceptanceWorkout(record: ParentRecord): HealthWorkout {
  const data = record.data;
  const displayType = typeof data.displayType === "string" ? data.displayType : "Workout";
  const isRunLike = data.isRunLike === true;
  if (isRunLike && (finite(data.durationSeconds) === null || finite(data.distanceMiles) === null)) {
    throw new Error("Running parent has missing or invalid duration/distance; unavailable values cannot become zero");
  }
  if (data.workoutId != null && data.workoutId !== record.id) throw new Error("Workout ID conflicts with its parent document ID");
  return {
    workoutId: record.id, name: displayType, activityType: typeof data.activityType === "string" ? data.activityType : "",
    displayType, startDate: validDate(data.startDate, "startDate"), endDate: validDate(data.endDate, "endDate"),
    syncedAt: validDate(data.syncedAt, "syncedAt"), durationSeconds: finite(data.durationSeconds) ?? 0,
    sourceName: typeof data.sourceName === "string" ? data.sourceName : "Apple Watch",
    isRunLike, hasRoute: data.hasRoute === true, hasHRStream: data.hasHRStream === true,
    routeComplete: typeof data.routeComplete === "boolean" ? data.routeComplete : undefined,
    calories: finite(data.calories) ?? 0, distanceMiles: finite(data.distanceMiles) ?? 0,
    distanceMeters: finite(data.distanceMeters), avgPaceSecPerMile: finite(data.avgPaceSecPerMile),
    avgHeartRate: finite(data.avgHeartRate), avgSpeedMPS: finite(data.avgSpeedMPS), hrDriftPct: finite(data.hrDriftPct),
    cadenceSPM: finite(data.cadenceSPM), efficiencyRaw: finite(data.efficiencyRaw), efficiencyScore: finite(data.efficiencyScore),
    elevationGainM: finite(data.elevationGainM),
  };
}

export function parseAcceptanceRace(record: ParentRecord): Race {
  const data = record.data;
  if (typeof data.name !== "string" || !["5K", "10K", "halfMarathon", "marathon", "custom"].includes(String(data.raceDistance))) {
    throw new Error("Missing race name or valid race distance");
  }
  return { ...data, id: record.id, raceDate: dateOnly(data.raceDate, "raceDate"), createdAt: timestamp(data.createdAt) } as unknown as Race;
}

export function parseAcceptancePlan(record: ParentRecord): RunningPlan | null {
  const data = record.data;
  const planType = data.planType ?? "running";
  if (planType !== "running") return null;
  if (typeof data.name !== "string" || !Array.isArray(data.weeks)
    || !data.weeks.every(week => week && typeof week === "object" && Array.isArray(week.entries)
      && week.entries.every((entry: unknown) => entry && typeof entry === "object"
        && typeof (entry as Record<string, unknown>).id === "string"
        && Number.isInteger((entry as Record<string, unknown>).weekIndex)
        && Number.isInteger((entry as Record<string, unknown>).weekday)
        && finite((entry as Record<string, unknown>).distanceMiles) !== null))) {
    throw new Error("Malformed running plan name/weeks/entries");
  }
  const status = derivePlanStatus(data);
  return { ...data, id: record.id, planType: "running", status, isActive: isActiveFromStatus(status),
    startDate: dateOnly(data.startDate, "startDate"), createdAt: timestamp(data.createdAt) } as RunningPlan;
}

export function parseAcceptanceOverride(record: ParentRecord, uid: string): WorkoutOverride {
  const data = record.data;
  if ((data.userId != null && data.userId !== uid) || (data.workoutId != null && data.workoutId !== record.id)) {
    throw new Error("Override owner or workout ID conflicts with the parent path");
  }
  for (const field of ["distanceMilesOverride", "durationSecondsOverride"] as const) {
    if (data[field] != null && finite(data[field]) === null) throw new Error(`Invalid ${field}`);
  }
  if (typeof data.isExcluded !== "boolean" || typeof data.updatedAt !== "string" || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error("Override exclusion state or revision time is missing/invalid");
  }
  return { ...data, workoutId: record.id, userId: uid } as unknown as WorkoutOverride;
}

export async function loadAcceptanceSources(reader: AcceptanceReader, uid: string): Promise<AcceptanceSources> {
  if (!uid || uid.includes("/")) throw new Error("Invalid owner UID");
  const diagnostics: SourceDiagnostic[] = [];
  async function read(source: string, path: string, cap: number, operation: () => Promise<ParentRead>): Promise<{ records: ParentRecord[]; diagnostic: SourceDiagnostic }> {
    try {
      const result = await operation();
      if (result.fromServer !== true || result.cap !== cap || result.records.length > cap) throw new Error("Unproven server provenance or invalid read bound");
      const diagnostic: SourceDiagnostic = { source, path, status: result.capped ? "truncated" : "complete", count: result.records.length, cap,
        fromServer: true, readStartedAt: result.readStartedAt, readCompletedAt: result.readCompletedAt,
        messages: result.capped ? ["Read cap reached; missing history is not confirmed absence. Panel acceptance is withheld."] : [] };
      diagnostics.push(diagnostic);
      return { records: result.records, diagnostic };
    } catch (error) {
      const diagnostic: SourceDiagnostic = { source, path, status: "error", count: 0, cap, fromServer: false,
        readStartedAt: null, readCompletedAt: null, messages: [error instanceof Error ? error.message : "Source read failed"] };
      diagnostics.push(diagnostic);
      return { records: [], diagnostic };
    }
  }
  function parse<T>(records: ParentRecord[], diagnostic: SourceDiagnostic, convert: (record: ParentRecord) => T): T[] {
    return records.flatMap(record => {
      try { return [convert(record)]; }
      catch (error) {
        diagnostic.status = "invalid";
        diagnostic.messages.push(`${record.id}: ${error instanceof Error ? error.message : "Invalid parent record"}`);
        return [];
      }
    });
  }
  const names = ["healthWorkouts", "halfMarathonRaces", "workoutOverrides", "activePlans"] as const;
  const [workoutRead, raceRead, overrideRead, activePlanRead] = await Promise.all(names.map(source =>
    read(source, `users/${uid}/${source === "activePlans" ? "plans (active status or legacy active mirror)" : source}`,
      ACCEPTANCE_CAPS[source], () => reader.collection(source, ACCEPTANCE_CAPS[source]))));
  const workouts = parse(workoutRead.records, workoutRead.diagnostic, parseAcceptanceWorkout);
  const workoutDates = workouts.map(workout => workout.startDate.toISOString()).sort();
  workoutRead.diagnostic.coverage = { oldestStartDate: workoutDates[0] ?? null,
    newestStartDate: workoutDates.at(-1) ?? null,
    scope: "Newest 1,000 parent documents ordered by startDate; documents lacking startDate are outside this canonical query. Individual linked race parents are also read. No child streams are queried." };
  const races = parse(raceRead.records, raceRead.diagnostic, parseAcceptanceRace);
  const overrides = Object.fromEntries(parse(overrideRead.records, overrideRead.diagnostic,
    record => [record.id, parseAcceptanceOverride(record, uid)] as const));
  const plans = new Map(parse(activePlanRead.records, activePlanRead.diagnostic, parseAcceptancePlan)
    .filter((plan): plan is RunningPlan => plan !== null && plan.status === "active").map(plan => [plan.id, plan]));
  const loadedWorkoutIds = new Set(workouts.map(workout => workout.workoutId));
  const linkedWorkoutIds = [...new Set(races.map(race => race.actualRunId)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !loadedWorkoutIds.has(id)))].sort();
  if (linkedWorkoutIds.length > ACCEPTANCE_CAPS.linkedWorkouts) {
    diagnostics.push({ source: "linkedWorkouts", path: `users/${uid}/healthWorkouts/{race.actualRunId}`, status: "truncated", count: 0,
      cap: ACCEPTANCE_CAPS.linkedWorkouts, fromServer: false, readStartedAt: null, readCompletedAt: null,
      messages: ["Too many linked workout parents; acceptance is withheld."] });
  } else {
    const linkedReads = await Promise.all(linkedWorkoutIds.map(async id => {
      const result = await read(`linkedWorkout:${id}`, `users/${uid}/healthWorkouts/${id}`, 1, () => {
        if (id.includes("/")) throw new Error("Invalid linked parent workout ID");
        return reader.workout(id);
      });
      if (result.diagnostic.status === "complete" && result.records.length === 0) result.diagnostic.messages.push("Linked workout parent is confirmed absent on the server.");
      return parse(result.records, result.diagnostic, parseAcceptanceWorkout);
    }));
    workouts.push(...linkedReads.flat());
  }
  const linkedIds = [...new Set(races.map(race => race.linkedPlanId).filter((id): id is string => typeof id === "string" && id.length > 0))].sort();
  if (linkedIds.length > ACCEPTANCE_CAPS.linkedPlans) {
    diagnostics.push({ source: "linkedPlans", path: `users/${uid}/plans/{race.linkedPlanId}`, status: "truncated", count: 0,
      cap: ACCEPTANCE_CAPS.linkedPlans, fromServer: false, readStartedAt: null, readCompletedAt: null,
      messages: ["Too many linked plans; acceptance is withheld rather than silently dropping links."] });
  } else {
    const linkedReads = await Promise.all(linkedIds.filter(id => !plans.has(id)).map(async id => {
      const result = await read(`linkedPlan:${id}`, `users/${uid}/plans/${id}`, 1, () => {
        if (id.includes("/")) throw new Error("Invalid linked parent plan ID");
        return reader.plan(id);
      });
      if (result.diagnostic.status === "complete" && result.records.length === 0) result.diagnostic.messages.push("Linked plan is confirmed absent on the server.");
      return parse(result.records, result.diagnostic, parseAcceptancePlan);
    }));
    for (const plan of linkedReads.flat()) if (plan) plans.set(plan.id, plan);
  }
  return { uid, loadedAt: new Date().toISOString(), races, workouts, overrides, plans: [...plans.values()],
    sourcesReady: diagnostics.every(item => item.status === "complete"),
    diagnostics: diagnostics.sort((a, b) => a.source.localeCompare(b.source)) };
}
