import type { Firestore, QueryDocumentSnapshot, QuerySnapshot, Timestamp } from "firebase-admin/firestore";
import { raceEvaluationCutoff } from "@/utils/racePerformanceEvaluation";
import { shiftPerformanceDate } from "@/utils/performanceEvidence";
import { workoutModelSummary } from "@/utils/workoutModelSummary";
import { normalizeRaceDocument } from "@/utils/raceDocument";
import { CURRENT_HALF_POLICY } from "@/utils/experimentalCurrentPerformance";
import { WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import { instant, key } from "./evidence";
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

/** Caller supplies a dedicated read-only Admin client and server-owned enrollment. */
export function createFirestoreCaptureReader(db: Firestore, enrolledUid: string) {
  const uid = key(enrolledUid, "enrolledUid");
  if (uid.includes("/")) throw new TypeError("Invalid enrolled UID");
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
    const complete = (name: keyof typeof counts) => counts[name] > CAPTURE_LIMITS[name] ? "partial" : "complete";
    const limitations = (Object.keys(counts) as (keyof typeof counts)[])
      .filter(name => complete(name) === "partial").map(name => `${name} reached its bounded-query overflow probe`);
    return {
      capturedAt, counts, reference: `firestore-read:${revisionKey(workouts.readTime)}`,
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
