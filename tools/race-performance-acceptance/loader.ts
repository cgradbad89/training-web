import type { HealthWorkout } from "../../src/types/healthWorkout";
import type { Race } from "../../src/types/race";
import type { WorkoutOverride } from "../../src/types/workoutOverride";
import { derivePlanStatus, isActiveFromStatus, type RunningPlan } from "../../src/types/plan";
import { toDate } from "../../src/utils/dates";
import { isPerformanceDate, performanceLocalDate, shiftPerformanceDate } from "../../src/utils/performanceEvidence";
import { selectEffectiveWorkouts } from "../../src/utils/selectActiveWorkouts";

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
  readCapped?: boolean;
  coverage?: { oldestStartDate: string | null; newestStartDate: string | null; scope: string };
}
export type NumericFieldClass = "absent" | "null" | "nonnumeric" | "nonfinite" | "finite";
export interface InvalidAcceptanceWorkout {
  record: ParentRecord;
  source: string;
  error: string;
  numericFields: Record<"durationSeconds" | "distanceMiles" | "distanceMeters", NumericFieldClass>;
}
export interface AcceptanceReportingScope {
  accepted: boolean;
  fullHistoryComplete: false;
  periods: { asOf: string; localDate: string; chartStart: string; recentStart: string; priorStart: string; priorEnd: string; consistencyEnd: string }[];
  earliestPlanMatchingDate: string | null;
  excludedWorkouts: { id: string; localDate: string; startDate: string; endDate: string; syncedAt: string; reasons: string[] }[];
  blockers: string[];
  limitations: string[];
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
  invalidWorkouts: InvalidAcceptanceWorkout[];
  reportingScope?: AcceptanceReportingScope;
}

export function classifyNumericField(data: Record<string, unknown>, field: string): NumericFieldClass {
  if (!Object.prototype.hasOwnProperty.call(data, field)) return "absent";
  if (data[field] === null) return "null";
  if (typeof data[field] !== "number") return "nonnumeric";
  return Number.isFinite(data[field]) ? "finite" : "nonfinite";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
const RUNNING_NUMBER_ERROR = "Running parent has missing or invalid duration/distance; unavailable values cannot become zero";
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
    throw new Error(RUNNING_NUMBER_ERROR);
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
  const invalidWorkouts: InvalidAcceptanceWorkout[] = [];
  async function read(source: string, path: string, cap: number, operation: () => Promise<ParentRead>): Promise<{ records: ParentRecord[]; diagnostic: SourceDiagnostic }> {
    try {
      const result = await operation();
      if (result.fromServer !== true || result.cap !== cap || result.records.length > cap) throw new Error("Unproven server provenance or invalid read bound");
      const diagnostic: SourceDiagnostic = { source, path, status: result.capped ? "truncated" : "complete", count: result.records.length, cap,
        fromServer: true, readStartedAt: result.readStartedAt, readCompletedAt: result.readCompletedAt,
        readCapped: result.capped,
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
  function parse<T>(records: ParentRecord[], diagnostic: SourceDiagnostic, convert: (record: ParentRecord) => T,
    onRejected?: (record: ParentRecord, error: string) => void): T[] {
    return records.flatMap(record => {
      try { return [convert(record)]; }
      catch (error) {
        diagnostic.status = "invalid";
        const message = error instanceof Error ? error.message : "Invalid parent record";
        diagnostic.messages.push(`${record.id}: ${message}`);
        onRejected?.(record, message);
        return [];
      }
    });
  }
  function retainInvalidWorkout(source: string) {
    return (record: ParentRecord, error: string) => invalidWorkouts.push({ record, source, error,
      numericFields: { durationSeconds: classifyNumericField(record.data, "durationSeconds"),
        distanceMiles: classifyNumericField(record.data, "distanceMiles"), distanceMeters: classifyNumericField(record.data, "distanceMeters") } });
  }
  const names = ["healthWorkouts", "halfMarathonRaces", "workoutOverrides", "activePlans"] as const;
  const [workoutRead, raceRead, overrideRead, activePlanRead] = await Promise.all(names.map(source =>
    read(source, `users/${uid}/${source === "activePlans" ? "plans (active status or legacy active mirror)" : source}`,
      ACCEPTANCE_CAPS[source], () => reader.collection(source, ACCEPTANCE_CAPS[source]))));
  const workouts = parse(workoutRead.records, workoutRead.diagnostic, parseAcceptanceWorkout, retainInvalidWorkout("healthWorkouts"));
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
      return parse(result.records, result.diagnostic, parseAcceptanceWorkout, retainInvalidWorkout(result.diagnostic.source));
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
    invalidWorkouts,
    diagnostics: diagnostics.sort((a, b) => a.source.localeCompare(b.source)) };
}

// Explicitly authorized diagnostic exceptions. Dates and dependencies are still
// re-proven from every fresh server snapshot; these IDs alone grant nothing.
const SCOPABLE_DISTANCELESS_IDS = new Set([
  "8A6341A4-D510-4E2B-906B-C0692248FE1F",
  "CA25BADB-53CA-424F-8062-EA0C871E49D9",
]);

/**
 * Developer-only acceptance decision, never a source repair. Raw rejections
 * and the invalid source status remain visible. Unknown mileage is omitted
 * outside proven dependencies, never replaced with zero or inferred distance.
 */
export function scopeAcceptanceSources(sources: AcceptanceSources, options: { asOfs: Date[]; timeZone: string }): AcceptanceSources {
  const proof: AcceptanceReportingScope = { accepted: false, fullHistoryComplete: false, periods: [], earliestPlanMatchingDate: null,
    excludedWorkouts: [], blockers: [], limitations: [
      "Scope approval covers only declared reporting periods and loaded race/plan dependencies, not complete lifetime workout history.",
      "Rejected source records retain unknown mileage and their original invalid diagnostics; no source values are corrected or reconstructed.",
      "The canonical bounded startDate query cannot establish completeness for documents without startDate or records absent from this source.",
    ] };
  const fail = (message: string) => proof.blockers.push(message);
  try {
    if (options.asOfs.length === 0) throw new Error("At least one explicit reporting clock is required");
    for (const asOf of options.asOfs) {
      if (!Number.isFinite(asOf.getTime())) throw new Error("Invalid reporting clock");
      const localDate = performanceLocalDate(asOf.toISOString(), options.timeZone);
      const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
      const monday = shiftPerformanceDate(localDate, -((weekday + 6) % 7));
      proof.periods.push({ asOf: asOf.toISOString(), localDate, chartStart: shiftPerformanceDate(monday, -49),
        recentStart: shiftPerformanceDate(localDate, -27), priorStart: shiftPerformanceDate(localDate, -55),
        priorEnd: shiftPerformanceDate(localDate, -28), consistencyEnd: shiftPerformanceDate(monday, -1) });
    }
    const required = ["healthWorkouts", "halfMarathonRaces", "workoutOverrides", "activePlans"];
    for (const source of required) {
      if (sources.diagnostics.filter(item => item.source === source).length !== 1) fail(`Missing or duplicate required source diagnostic: ${source}`);
    }
    const rejected = sources.invalidWorkouts ?? [];
    for (const diagnostic of sources.diagnostics) {
      const ownRejections = rejected.filter(item => item.source === diagnostic.source);
      const retainedWorkoutErrors = diagnostic.source === "healthWorkouts" && diagnostic.status === "invalid"
        && ownRejections.length > 0 && diagnostic.messages.length === ownRejections.length;
      if ((!retainedWorkoutErrors && diagnostic.status !== "complete") || diagnostic.fromServer !== true
        || diagnostic.readCapped !== false || !diagnostic.readStartedAt || !diagnostic.readCompletedAt) {
        fail(`Source completeness or provenance is unproven: ${diagnostic.source}`);
      }
    }
    if (new Set(rejected.map(item => item.record.id)).size !== rejected.length) fail("Repeated rejected workout identities require reconciliation");
    const earliestReportingDate = proof.periods.flatMap(period => [period.chartStart, period.priorStart]).sort()[0];
    const latestReportingDate = proof.periods.map(period => period.localDate).sort().at(-1)!;
    const planMatchingDates: string[] = [];
    for (const race of sources.races) {
      if (race.linkedPlanId && !sources.plans.some(plan => plan.id === race.linkedPlanId)) fail(`Linked running plan is unavailable: ${race.linkedPlanId}`);
    }
    for (const plan of sources.plans) {
      if (!isPerformanceDate(plan.startDate)) throw new Error(`Invalid plan start date: ${plan.id}`);
      if (plan.status === "draft") continue;
      for (const week of plan.weeks) for (const entry of week.entries) {
        if (!Number.isSafeInteger(entry.weekIndex) || entry.weekIndex < 0 || !Number.isSafeInteger(entry.weekday)
          || entry.weekday < 1 || entry.weekday > 7) throw new Error(`Invalid plan entry calendar: ${plan.id}`);
        if (entry.runType === "rest" || entry.workoutType === "rest") continue;
        const entryDate = shiftPerformanceDate(plan.startDate, entry.weekIndex * 7 + entry.weekday - 1);
        if (entryDate <= latestReportingDate) planMatchingDates.push(shiftPerformanceDate(entryDate, -1));
      }
    }
    proof.earliestPlanMatchingDate = planMatchingDates.sort()[0] ?? null;
    if (rejected.length > 0) {
      // Canonical consistency has a lifetime runs.length>0 guard. Establish
      // that dropping unknown historical mileage cannot change that branch.
      for (const asOf of options.asOfs) {
        const available = sources.workouts.filter(workout => {
          const override = sources.overrides[workout.workoutId];
          return Number.isFinite(workout.syncedAt.getTime()) && workout.syncedAt <= asOf
            && (!override || Number.isFinite(Date.parse(override.updatedAt)) && Date.parse(override.updatedAt) <= asOf.getTime());
        });
        if (!selectEffectiveWorkouts(available, sources.overrides).some(workout => workout.isRunLike
          && Number.isFinite(workout.startDate.getTime()) && Number.isFinite(workout.endDate.getTime())
          && workout.endDate > workout.startDate && workout.endDate <= asOf
          && Number.isFinite(workout.distanceMiles) && workout.distanceMiles > 0
          && Number.isFinite(workout.durationSeconds) && workout.durationSeconds > 0)) {
          fail(`Running consistency presence cannot be proven at ${asOf.toISOString()}`);
        }
      }
    }
    for (const rejectedWorkout of rejected) {
      const { record } = rejectedWorkout;
      try {
        if (!SCOPABLE_DISTANCELESS_IDS.has(record.id) || rejectedWorkout.source !== "healthWorkouts") throw new Error("Workout is outside the two authorized diagnostic identities");
        if (rejectedWorkout.error !== RUNNING_NUMBER_ERROR) throw new Error("A non-distance parser error requires separate review");
        const data = record.data;
        if (data.workoutId !== record.id || data.isRunLike !== true || data.source !== "healthkit"
          || typeof data.activityType !== "string" || !data.activityType || typeof data.sourceName !== "string" || !data.sourceName) {
          throw new Error("Workout identity, running type or source metadata is unproven");
        }
        if (classifyNumericField(data, "distanceMiles") !== "absent" || classifyNumericField(data, "distanceMeters") !== "absent"
          || finite(data.durationSeconds) === null || (data.durationSeconds as number) <= 0) {
          throw new Error("Only absent distanceMiles and distanceMeters with a valid duration are covered");
        }
        const start = validDate(data.startDate, "startDate");
        const end = validDate(data.endDate, "endDate");
        const synced = validDate(data.syncedAt, "syncedAt");
        if (end <= start || options.asOfs.some(asOf => end > asOf || synced > asOf)) throw new Error("Completed dates or source availability are unproven for every reporting clock");
        const localDate = performanceLocalDate(start.toISOString(), options.timeZone);
        if (localDate >= earliestReportingDate) throw new Error(`Workout can affect reporting periods beginning ${earliestReportingDate}`);
        if (proof.earliestPlanMatchingDate && localDate >= proof.earliestPlanMatchingDate) {
          throw new Error(`Workout can enter canonical plan matching from ${proof.earliestPlanMatchingDate}; historical matching displacement is unproven`);
        }
        if (Object.prototype.hasOwnProperty.call(sources.overrides, record.id)) throw new Error("An existing override requires separate effective-value review");
        if (JSON.stringify(sources.races).includes(record.id) || JSON.stringify(sources.plans).includes(record.id)) throw new Error("A race or plan record references this workout identity");
        proof.excludedWorkouts.push({ id: record.id, localDate, startDate: start.toISOString(), endDate: end.toISOString(), syncedAt: synced.toISOString(),
          reasons: [`Before every reporting period (earliest ${earliestReportingDate})`,
            proof.earliestPlanMatchingDate ? `Before the earliest due-entry minus one day across all loaded selectable plans (${proof.earliestPlanMatchingDate})` : "No due running-plan entry can match",
            "No override or loaded race/plan identity reference; known valid running evidence preserves consistency presence", "Both distance fields remain absent; parent excluded without numeric substitution"] });
      } catch (error) { fail(`${record.id}: ${error instanceof Error ? error.message : "Unknown exclusion proof failure"}`); }
    }
    proof.accepted = proof.blockers.length === 0;
  } catch (error) { fail(error instanceof Error ? error.message : "Unknown reporting scope failure"); }
  return { ...sources, sourcesReady: proof.accepted, reportingScope: proof };
}
