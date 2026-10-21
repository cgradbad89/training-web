import {
  collection, documentId, getDocsFromServer, limit, orderBy, query, startAfter,
  type QueryDocumentSnapshot, type DocumentData, type QueryConstraint, type QuerySnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type {
  EffectivePerformanceWorkout, PerformanceQualityPolicy, PerformanceTelemetryInterval,
  PerformanceVersions, WorkoutPerformanceFeature,
} from "@/types/performanceAnalysis";
import { extractWorkoutPerformanceFeature } from "@/utils/aerobicPerformance";
import { hashPerformanceValue, workoutIsCompletedAsOf } from "@/utils/performanceEvidence";

export const PERFORMANCE_TELEMETRY_PAGE_SIZE = 250;
export const DEFAULT_PERFORMANCE_CHILD_READ_BUDGET = 5_000;
const MAX_HR_SAMPLES = 100_000;

/** One mutable budget belongs to the entire explicit update, including retries of reads. */
export interface PerformanceReadBudget { limit: number; documentsRead: number }

export function createPerformanceReadBudget(limit = DEFAULT_PERFORMANCE_CHILD_READ_BUDGET): PerformanceReadBudget {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new RangeError("Child-document budget must be 1–100,000");
  return { limit, documentsRead: 0 };
}

export class PerformanceReadBudgetExceededError extends Error {
  readonly code = "performance/read-budget-exceeded";
  readonly suggestedLimit: number;
  constructor(readonly workoutId: string, readonly limit: number, readonly documentsRead: number) {
    super(`Stopped before finishing ${workoutId}: the ${limit.toLocaleString("en-US")} child-document read budget was reached. No truncated feature was saved. Explicitly retry selected runs with a higher budget.`);
    this.name = "PerformanceReadBudgetExceededError";
    this.suggestedLimit = Math.min(100_000, Math.max(limit + 250, limit * 2));
  }
}

export interface PerformanceTelemetrySource {
  hasRoute: boolean;
  routeComplete?: boolean;
  hasHRStream?: boolean;
  /** Optional native hint, checked against returned docs; never a child revision. */
  routePointCount?: number | null;
}

export interface FreshWorkoutPerformance {
  workout: EffectivePerformanceWorkout;
  feature: WorkoutPerformanceFeature;
  reads: { routeDocuments: number; hrDocuments: number; totalDocuments: number };
  source: {
    routePointCount: number;
    hrSampleCount: number;
    hrSource: "route" | "hrStream" | "absent";
    measuredTimeCoverageFraction: number | null;
    measuredHrCoverageFraction: number | null;
  };
  limitations: readonly string[];
}

interface Point { index: number; lat: number; lng: number; seconds: number; hr: number | null }
interface HeartRate { seconds: number; hr: number }
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function timestampMillis(value: unknown): number | null {
  try {
    const candidate = value instanceof Date ? value
      : typeof value === "string" ? new Date(value)
      : value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function" ? value.toDate() : null;
    return candidate instanceof Date && Number.isFinite(candidate.getTime()) ? candidate.getTime() : null;
  } catch { return null; }
}

function positionDistance(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2
    + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lng - a.lng) * radians / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Document-ID ordering includes malformed docs missing index/chunkIndex fields.
 * A full final budget page is conservatively unresolved: exhaustion was not proved.
 * Empty queries return zero documents here (Firestore may bill its minimum query charge).
 */
async function readChildren(input: {
  uid: string; workoutId: string; channel: "route" | "hrStream";
  budget: PerformanceReadBudget; assertSession: () => void;
  onDocument: (data: Record<string, unknown>) => void;
}): Promise<number> {
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  let count = 0;
  for (;;) {
    input.assertSession();
    const remaining = input.budget.limit - input.budget.documentsRead;
    if (remaining <= 0) throw new PerformanceReadBudgetExceededError(input.workoutId, input.budget.limit, input.budget.documentsRead);
    const size = Math.min(PERFORMANCE_TELEMETRY_PAGE_SIZE, remaining);
    const ref = collection(db, "users", input.uid, "healthWorkouts", input.workoutId, input.channel);
    const constraints: QueryConstraint[] = [orderBy(documentId(), "asc"), ...(cursor ? [startAfter(cursor)] : []), limit(size)];
    // Intentionally bypass getDocs(), routeCache, chart caches and HR UI caches.
    const page: QuerySnapshot<DocumentData> = await getDocsFromServer(query(ref, ...constraints));
    input.budget.documentsRead += page.docs.length;
    count += page.docs.length;
    input.assertSession();
    for (const doc of page.docs) input.onDocument(doc.data());
    if (page.docs.length < size) return count;
    cursor = page.docs[page.docs.length - 1];
  }
}

function coverage(intervals: readonly PerformanceTelemetryInterval[], policy: PerformanceQualityPolicy): { seconds: number; hrSeconds: number } {
  let seconds = 0;
  let hrSeconds = 0;
  for (const interval of intervals) {
    const duration = interval.endSeconds - interval.startSeconds;
    if (duration <= 0 || duration > policy.maximumIntervalSeconds || interval.speedMps < 0 || interval.speedMps > policy.maximumSpeedMps) continue;
    seconds += duration;
    if (finite(interval.hrBpm) && interval.hrBpm >= policy.minimumHrBpm && interval.hrBpm < policy.maximumHrBpmExclusive) hrSeconds += duration;
  }
  return { seconds, hrSeconds };
}

/** Manual fresh acquisition only. This function never writes or persists raw samples.
 * Its content receipt certifies supplied observations, not an immutable iOS generation.
 */
export async function extractFreshWorkoutPerformance(input: {
  uid: string;
  workout: EffectivePerformanceWorkout;
  source: PerformanceTelemetrySource;
  asOf: string;
  extractedAt: string;
  versions: PerformanceVersions;
  policy: PerformanceQualityPolicy;
  budget: PerformanceReadBudget;
  assertSession: () => void;
}): Promise<FreshWorkoutPerformance> {
  input.assertSession();
  if (!input.uid || input.uid.includes("/") || !input.workout.workoutId || input.workout.workoutId.includes("/")) throw new TypeError("Invalid authenticated telemetry identity");
  if (!Number.isSafeInteger(input.budget.limit) || input.budget.limit < 1 || input.budget.limit > 100_000
    || !Number.isSafeInteger(input.budget.documentsRead) || input.budget.documentsRead < 0 || input.budget.documentsRead > input.budget.limit) throw new TypeError("Invalid shared child-document read budget");
  const workout = structuredClone(input.workout);
  const source = { ...input.source };
  const policy = { ...input.policy };
  const versions = { ...input.versions };
  const started = Date.parse(workout.startedAt);
  const elapsed = (Date.parse(workout.endedAt) - started) / 1000;
  const limitations = [
    "fresh_server_reads_verify_supplied_content_not_an_immutable_source_generation",
    "child_only_changes_after_extraction_require_explicit_manual_reprocessing",
    "user_sync_confirmation_is_not_scientific_completeness_proof",
  ];
  const issues = new Set<string>();
  const points: Point[] = [];
  const intervals: PerformanceTelemetryInterval[] = [];
  let routeDocuments = 0;
  let hrDocuments = 0;
  let hrSampleCount = 0;
  let hrSource: FreshWorkoutPerformance["source"]["hrSource"] = "absent";
  const eligible = workoutIsCompletedAsOf(workout, input.asOf) && workout.runKind === "outdoor"
    && (workout.durationSeconds ?? 0) >= policy.minimumWorkoutSeconds
    && (workout.distanceMeters ?? 0) >= policy.minimumWorkoutMeters
    && elapsed <= 86_400
    && Math.abs(elapsed - (workout.durationSeconds ?? 0)) <= Math.max(60, (workout.durationSeconds ?? 0) * 0.02);
  // Explicitly pending parents and ineligible workouts do not spend raw-read budget.
  if (eligible && source.routeComplete !== false) {
    routeDocuments = await readChildren({ ...input, workoutId: workout.workoutId, channel: "route", onDocument: (raw) => {
      const time = timestampMillis(raw.timestamp);
      if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || !finite(raw.lat) || Math.abs(raw.lat) > 90
        || !finite(raw.lng) || Math.abs(raw.lng) > 180 || time === null) {
        issues.add("invalid_route_sample");
        return;
      }
      // CLLocation's optional instantaneous speed is not the speed basis used here.
      if (raw.speed != null && !finite(raw.speed)) issues.add("invalid_reported_gps_speed");
      const hr = finite(raw.hr) && raw.hr >= policy.minimumHrBpm && raw.hr < policy.maximumHrBpmExclusive ? raw.hr : null;
      if (raw.hr != null && !finite(raw.hr)) issues.add("invalid_route_hr_sample");
      points.push({ index: raw.index as number, lat: raw.lat, lng: raw.lng, seconds: (time - started) / 1000, hr });
    } });
    points.sort((a, b) => a.index - b.index);
    if (source.routePointCount != null && (!Number.isSafeInteger(source.routePointCount) || source.routePointCount !== routeDocuments)) issues.add("route_point_count_mismatch");
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (point.index !== index) issues.add("missing_or_duplicate_route_index");
      if (point.seconds < 0 || point.seconds > elapsed) issues.add("route_timestamp_outside_workout");
      if (!index) continue;
      const previous = points[index - 1];
      const seconds = point.seconds - previous.seconds;
      if (seconds <= 0) { issues.add("non_increasing_route_timestamps"); continue; }
      intervals.push({ startSeconds: previous.seconds, endSeconds: point.seconds, speedMps: positionDistance(previous, point) / seconds, hrBpm: point.hr });
    }
    const measured = coverage(intervals, policy);
    hrSampleCount = points.filter(point => point.hr !== null).length;
    if (hrSampleCount) hrSource = "route";
    // A sufficient route-HR stream avoids duplicate chunk reads. Query even if a
    // legacy parent flag is false: partial or repaired chunks can precede flags.
    if (intervals.length && measured.seconds > 0 && measured.hrSeconds / measured.seconds < policy.minimumHrCoverageFraction) {
      const heartRates: HeartRate[] = [];
      const chunkIndices = new Set<number>();
      hrDocuments = await readChildren({ ...input, workoutId: workout.workoutId, channel: "hrStream", onDocument: raw => {
        if (!Number.isSafeInteger(raw.chunkIndex) || (raw.chunkIndex as number) < 0 || chunkIndices.has(raw.chunkIndex as number)
          || !Array.isArray(raw.samples) || raw.samples.length > 500) { issues.add("invalid_hr_chunk"); return; }
        chunkIndices.add(raw.chunkIndex as number);
        for (const sample of raw.samples) {
          if (heartRates.length >= MAX_HR_SAMPLES) throw new RangeError("HR telemetry exceeds the supported 100,000-sample bound; no feature was produced");
          const time = sample && typeof sample === "object" ? timestampMillis(sample.t) : null;
          if (time === null || !finite(sample.hr) || sample.hr < policy.minimumHrBpm || sample.hr >= policy.maximumHrBpmExclusive) {
            issues.add("invalid_hr_stream_sample"); continue;
          }
          const seconds = (time - started) / 1000;
          if (seconds < 0 || seconds > elapsed) { issues.add("hr_timestamp_outside_workout"); continue; }
          heartRates.push({ seconds, hr: sample.hr });
        }
      } });
      if ([...chunkIndices].sort((a, b) => a - b).some((value, index) => value !== index)) issues.add("missing_hr_chunk_index");
      heartRates.sort((a, b) => a.seconds - b.seconds);
      if (heartRates.some((value, index) => index > 0 && value.seconds === heartRates[index - 1].seconds)) issues.add("duplicate_hr_stream_timestamp");
      let cursor = 0;
      for (const interval of intervals) {
        if (interval.hrBpm !== null || !heartRates.length) continue;
        while (cursor + 1 < heartRates.length && heartRates[cursor + 1].seconds <= interval.endSeconds) cursor++;
        const before = heartRates[cursor];
        const after = heartRates[cursor + 1];
        const nearest = after && Math.abs(after.seconds - interval.endSeconds) < Math.abs(before.seconds - interval.endSeconds) ? after : before;
        if (Math.abs(nearest.seconds - interval.endSeconds) <= policy.maximumIntervalSeconds) interval.hrBpm = nearest.hr;
      }
      if (heartRates.length) { hrSource = "hrStream"; hrSampleCount = heartRates.length; }
    }
  }
  input.assertSession();
  const measured = coverage(intervals, policy);
  const measuredTimeCoverageFraction = elapsed > 0 ? measured.seconds / elapsed : null;
  const measuredHrCoverageFraction = measured.seconds > 0 ? measured.hrSeconds / measured.seconds : null;
  const distance = intervals.reduce((sum, interval) => {
    const seconds = interval.endSeconds - interval.startSeconds;
    return sum + (seconds <= policy.maximumIntervalSeconds && interval.speedMps <= policy.maximumSpeedMps ? interval.speedMps * seconds : 0);
  }, 0);
  const measuredComplete = intervals.length > 0 && measuredTimeCoverageFraction !== null
    && measuredTimeCoverageFraction >= policy.minimumCoverageFraction && measuredHrCoverageFraction !== null
    && measuredHrCoverageFraction >= policy.minimumHrCoverageFraction && workout.distanceMeters !== null
    && Math.abs(distance / workout.distanceMeters - 1) <= 0.1;
  if (source.routeComplete === undefined) limitations.push("legacy_route_completion_marker_absent_measured_coverage_only");
  limitations.push("route_and_hr_flags_and_counts_are_not_child_content_revisions");
  if (!measuredComplete && routeDocuments) limitations.push("measured_telemetry_coverage_or_distance_consistency_incomplete");
  limitations.push(...issues);
  workout.limitations = [...new Set([...workout.limitations, ...limitations])].sort();
  workout.telemetry = {
    state: source.routeComplete === false ? "pending" : !eligible ? "unknown" : !routeDocuments ? "absent" : measuredComplete && !issues.size ? "complete" : "unknown",
    verification: "supplied_content",
    contentDigest: await hashPerformanceValue({ intervals, sourceSampleCount: routeDocuments }),
  };
  input.assertSession();
  const feature = await extractWorkoutPerformanceFeature({ workout, intervals, sourceSampleCount: routeDocuments,
    asOf: input.asOf, extractedAt: input.extractedAt, versions, policy });
  input.assertSession();
  return {
    workout, feature,
    reads: { routeDocuments, hrDocuments, totalDocuments: routeDocuments + hrDocuments },
    source: { routePointCount: routeDocuments, hrSampleCount, hrSource, measuredTimeCoverageFraction, measuredHrCoverageFraction },
    limitations,
  };
}
