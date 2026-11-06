import type { Firestore, QueryDocumentSnapshot, QuerySnapshot, Timestamp } from "firebase-admin/firestore";
import { raceEvaluationCutoff } from "@/utils/racePerformanceEvaluation";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { CURRENT_HALF_POLICY } from "@/utils/experimentalCurrentPerformance";
import { WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import { toDate } from "@/utils/dates";
import { instant, key } from "./evidence";
import { ACTIVE_RACE_QUERY_LIMIT, type RaceMeta } from "./enrollment";
import type { CaptureSlot } from "./scheduled-capture";

const WORKOUT_FIELDS = [
  "workoutId", "startDate", "endDate", "entrySource", "updatedAt", "syncedAt", "activityType", "displayType",
  "durationSeconds", "distanceMiles", "distanceMeters", "sourceName", "isRunLike", "hasRoute", "hasHRStream",
  "avgHeartRate", "avgPaceSecPerMile", "elevationGainM", "weather", "routeClusterId",
];
const RACE_FIELDS = [
  "name", "raceDate", "raceDistance", "customDistanceMiles", "createdAt", "actualRunId", "actualRunDate",
  "actualRunDistanceMiles", "actualRunDurationSeconds", "result", "performanceEvidence", "confirmationHistory",
];
const OVERRIDE_FIELDS = [
  "workoutId", "userId", "isExcluded", "excludedAt", "excludedReason", "updatedAt",
  "distanceMilesOverride", "durationSecondsOverride", "runTypeOverride",
];

export const CAPTURE_LIMITS = { workouts: 1000, races: 100, overrides: 1000 } as const;

function revisionKey(timestamp: Timestamp) {
  return `${timestamp.seconds}:${String(timestamp.nanoseconds).padStart(9, "0")}`;
}

function rows(
  snapshot: QuerySnapshot,
  cap: number,
  normalize: (row: QueryDocumentSnapshot) => object,
) {
  return snapshot.docs.slice(0, cap).map(row => {
    if (row.updateTime.seconds > snapshot.readTime.seconds || (row.updateTime.seconds === snapshot.readTime.seconds
      && row.updateTime.nanoseconds > snapshot.readTime.nanoseconds)) throw new Error("Revision after consistent read");
    return {
      id: row.id, revision: revisionKey(row.updateTime), availableAt: instant(row.updateTime.toDate().toISOString(), "revision"),
      doc: normalize(row),
    };
  });
}

function assertBound(db: Firestore, expected: { projectId?: string }) {
  if (expected.projectId === undefined) return;
  let actual: string | undefined;
  try { actual = (db as unknown as { projectId?: string }).projectId; } catch { actual = undefined; }
  if (actual !== expected.projectId) throw new Error("Firestore client is not bound to the enrolled project");
}

/** One-document, zero-payload read proving identity, project and owner path. Used only by preflight. */
export function createFirestoreProbe(db: Firestore, enrolledUid: string, expected: { projectId?: string } = {}) {
  const uid = key(enrolledUid, "enrolledUid");
  if (uid.includes("/")) throw new TypeError("Invalid enrolled UID");
  assertBound(db, expected);
  return async () => { await db.collection("users").doc(uid).collection("healthWorkouts").select().limit(1).get(); };
}

/** Caller supplies a dedicated read-only Admin client and server-owned enrollment. */
export function createFirestoreCaptureReader(db: Firestore, enrolledUid: string, expected: { projectId?: string } = {}) {
  const uid = key(enrolledUid, "enrolledUid");
  if (uid.includes("/")) throw new TypeError("Invalid enrolled UID");
  assertBound(db, expected); // before any query is issued; fails closed
  const owner = db.collection("users").doc(uid);
  return async (slot: CaptureSlot) => {
    const from = shiftPerformanceDate(slot.checkpointDate, -CURRENT_HALF_POLICY.maximumAnchorDays - WORKOUT_RESEARCH_POLICY.baselineDays);
    const first = new Date(Date.parse(raceEvaluationCutoff(from, slot.target.timeZone)) + 1);
    const [workouts, races, overrides] = await db.runTransaction(async tx => {
      // Sequential calls share the same read-only transaction and its server snapshot.
      const workouts = await tx.get(owner.collection("healthWorkouts").where("startDate", ">=", first).orderBy("startDate", "desc").select(...WORKOUT_FIELDS).limit(CAPTURE_LIMITS.workouts + 1));
      const races = await tx.get(owner.collection("halfMarathonRaces").select(...RACE_FIELDS).limit(CAPTURE_LIMITS.races + 1));
      const overrides = await tx.get(owner.collection("workoutOverrides").select(...OVERRIDE_FIELDS).limit(CAPTURE_LIMITS.overrides + 1));
      return [workouts, races, overrides] as const;
    }, { readOnly: true });

    if (!workouts.readTime.isEqual(races.readTime) || !workouts.readTime.isEqual(overrides.readTime)) {
      throw new Error("Capture sources disagree on the read timestamp");
    }
    const capturedAt = instant(workouts.readTime.toDate().toISOString(), "consistent read timestamp");
    const counts = { workouts: workouts.size, races: races.size, overrides: overrides.size };
    const enrolled = races.docs.slice(0, CAPTURE_LIMITS.races).find(row => row.id === slot.target.raceId);
    const race = !enrolled ? "absent" as const
      : normalizeRaceDocument(enrolled.id, enrolled.data()).raceDate === slot.target.raceDate ? "present" as const : "date_mismatch" as const;
    const complete = (name: keyof typeof counts) => counts[name] > CAPTURE_LIMITS[name] ? "partial" : "complete";
    const limitations = (Object.keys(counts) as (keyof typeof counts)[])
      .filter(name => complete(name) === "partial").map(name => `${name} reached its bounded-query overflow probe`);
    if (race === "absent") limitations.push("enrolled race record absent at capture");
    return {
      capturedAt, counts, race, reference: `firestore-read:${revisionKey(workouts.readTime)}`,
      coverage: { workouts: complete("workouts"), races: complete("races"), overrides: complete("overrides"),
        workoutsFrom: from, limitations },
      inputs: {
        workouts: rows(workouts, CAPTURE_LIMITS.workouts, row => {
          const model = workoutModelSummary(row.id, row.data());
          return {
            ...Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined)),
            startDate: model.startDate.toISOString(), endDate: model.endDate.toISOString(),
            syncedAt: model.syncedAt.getTime() > 0 ? model.syncedAt.toISOString() : null,
          };
        }),
        races: rows(races, CAPTURE_LIMITS.races, row => normalizeRaceDocument(row.id, row.data())),
        overrides: rows(overrides, CAPTURE_LIMITS.overrides, row => row.data()),
      },
    };
  };
}

/** The only race fields enrollment discovery may read. No name, result, evidence, plan, location or workout data. */
const RACE_META_FIELDS = ["raceDate", "raceDistance", "customDistanceMiles", "isActive"] as const;

function raceMeta(id: string, data: Record<string, unknown>): RaceMeta {
  let raceDate: string | null = null;
  try {
    // Same conversion as normalizeRaceDocument, so discovery and the capture-time race check agree.
    if (data.raceDate) raceDate = toDate(data.raceDate).toISOString().split("T")[0];
  } catch { raceDate = null; }
  return { id, raceDate, raceDistance: data.raceDistance, customDistanceMiles: data.customDistanceMiles, isActive: data.isActive };
}

/**
 * Bounded, owner-scoped race-metadata reads for enrollment (Phase 3H). Four fields only; never touches
 * workouts, their children or any other user. Uses the automatic single-field `isActive` index, so no index
 * is added. `active()` costs at most ACTIVE_RACE_QUERY_LIMIT + 1 document reads (typically one).
 */
export function createRaceMetadataReader(db: Firestore, enrolledUid: string, expected: { projectId?: string } = {}) {
  const uid = key(enrolledUid, "enrolledUid");
  if (uid.includes("/")) throw new TypeError("Invalid enrolled UID");
  assertBound(db, expected);
  const races = db.collection("users").doc(uid).collection("halfMarathonRaces");
  return {
    async active(): Promise<{ races: RaceMeta[]; overflow: boolean }> {
      const snapshot = await races.where("isActive", "==", true).select(...RACE_META_FIELDS).limit(ACTIVE_RACE_QUERY_LIMIT + 1).get();
      const rows = snapshot.docs.map(row => raceMeta(row.id, row.data()));
      return { races: rows.slice(0, ACTIVE_RACE_QUERY_LIMIT), overflow: rows.length > ACTIVE_RACE_QUERY_LIMIT };
    },
    /** One field-masked document read, used by preflight to compare the pinned enrollment with the stored race. */
    async byId(raceId: string): Promise<RaceMeta | null> {
      const [row] = await db.getAll(races.doc(key(raceId, "raceId")), { fieldMask: [...RACE_META_FIELDS] });
      return row?.exists ? raceMeta(row.id, row.data() ?? {}) : null;
    },
  };
}
