import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  setDoc,
  where,
  type Unsubscribe,
  type Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface HealthMetric {
  date: string; // "YYYY-MM-DD"
  weight_lbs?: number;
  bmi?: number;
  resting_hr?: number;
  steps?: number;
  exercise_mins?: number;
  move_calories?: number;
  stand_hours?: number;
  sleep_total_hours?: number;
  sleep_awake_mins?: number;
  /** ISO 8601 UTC string when the user fell asleep (e.g. "2026-04-19T23:14:00Z"). */
  sleep_start?: string;
  /** ISO 8601 UTC string when the user woke up (e.g. "2026-04-20T06:45:00Z"). */
  sleep_end?: string;
  brush_count?: number;
  brush_avg_duration_mins?: number;
  syncedAt?: string;
}

export async function fetchHealthMetrics(
  uid: string,
  days = 90
): Promise<HealthMetric[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const snap = await getDocs(
    query(
      collection(db, `users/${uid}/healthMetrics`),
      where("date", ">=", cutoffStr),
      orderBy("date", "desc")
    )
  );
  return snap.docs.map((d) => d.data() as HealthMetric);
}

/**
 * Fetch all healthMetrics documents whose `date` field falls within the
 * inclusive [fromDate, toDate] range. Both bounds are ISO date strings
 * ("YYYY-MM-DD"). Used by the This Week dashboard to compute per-week
 * health KPI averages without subscribing to the full collection.
 */
export async function fetchHealthMetricsRange(
  uid: string,
  fromDate: string,
  toDate: string
): Promise<HealthMetric[]> {
  const snap = await getDocs(
    query(
      collection(db, `users/${uid}/healthMetrics`),
      where("date", ">=", fromDate),
      where("date", "<=", toDate),
      orderBy("date", "asc")
    )
  );
  return snap.docs.map((d) => d.data() as HealthMetric);
}

export async function fetchAllHealthMetrics(
  uid: string
): Promise<HealthMetric[]> {
  const snap = await getDocs(
    query(
      collection(db, `users/${uid}/healthMetrics`),
      orderBy("date", "asc")
    )
  );
  return snap.docs.map((d) => d.data() as HealthMetric);
}

/**
 * Real-time listener for healthMetrics (last N days).
 * Calls `onData` whenever the result set changes.
 * Returns an unsubscribe function — caller MUST call it on unmount.
 */
export function onHealthMetricsSnapshot(
  uid: string,
  days: number,
  onData: (metrics: HealthMetric[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const q = query(
    collection(db, `users/${uid}/healthMetrics`),
    where("date", ">=", cutoffStr),
    orderBy("date", "desc")
  );

  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as HealthMetric));
    },
    (err) => {
      console.error("[onHealthMetricsSnapshot] listener error:", err);
      onError?.(err);
    }
  );
}

/**
 * Real-time listener for all-time healthMetrics.
 */
export function onAllHealthMetricsSnapshot(
  uid: string,
  onData: (metrics: HealthMetric[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, `users/${uid}/healthMetrics`),
    orderBy("date", "asc")
  );

  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as HealthMetric));
    },
    (err) => {
      console.error("[onAllHealthMetricsSnapshot] listener error:", err);
      onError?.(err);
    }
  );
}

// ── Hourly Heart Rate ────────────────────────────────────────────────────────

export interface HourlyHeartRate {
  hourlyAvgBpm: Record<string, number>; // "0"–"23", only hours with data
  sampleCount: Record<string, number>;
  updatedAt: Timestamp;
  periodDays: number;
}

/**
 * Fetch the single hourlyHeartRate document (one-time getDoc, not a listener).
 * Returns null if the document doesn't exist.
 */
export async function fetchHourlyHeartRate(
  uid: string
): Promise<HourlyHeartRate | null> {
  const snap = await getDoc(
    doc(db, `users/${uid}/healthMetrics/hourlyHeartRate`)
  );
  if (!snap.exists()) return null;
  return snap.data() as HourlyHeartRate;
}

// ── Health Goals ─────────────────────────────────────────────────────────────

/** Single-direction metric goal (resting HR, steps, sleep, brushing). */
export interface MetricGoal {
  goal: number;
  /** % deviation from goal that triggers warning (default 5). */
  warningPct?: number;
  /** % deviation from goal that triggers danger (default 15). */
  dangerPct?: number;
}

/** Weight goal — target weight ± a tolerance band counted as success. */
export interface WeightGoal {
  goal: number;
  tolerance: number;
  warningPct?: number;
  dangerPct?: number;
}

/** BMI goal — a min/max range counted as success. */
export interface BMIGoal {
  min: number;
  max: number;
  warningPct?: number;
  dangerPct?: number;
}

export interface HealthGoals {
  weight?: WeightGoal;
  bmi?: BMIGoal;
  /** Lower-is-better. */
  restingHR?: MetricGoal;
  /** Higher-is-better. */
  steps?: MetricGoal;
  /** Higher-is-better, hours. */
  sleep?: MetricGoal;
  /** Higher-is-better, sessions per day. */
  brushing?: MetricGoal;
  /** Higher-is-better, daily active minutes. */
  exerciseMins?: MetricGoal;
  /** Higher-is-better, active calories burned per day. */
  moveCalories?: MetricGoal;
  /** Higher-is-better, stand hours per day. */
  standHours?: MetricGoal;
  /** Lower-is-better, minutes awake during sleep. */
  awakeMins?: MetricGoal;
  /** Higher-is-better, average brushing duration in minutes. */
  avgBrushMins?: MetricGoal;
  updatedAt?: Timestamp;
}

const HEALTH_GOALS_DOC = (uid: string) =>
  doc(db, `users/${uid}/settings/healthGoals`);

/** Fetch the single healthGoals document. Returns null if not yet created. */
export async function fetchHealthGoals(uid: string): Promise<HealthGoals | null> {
  const snap = await getDoc(HEALTH_GOALS_DOC(uid));
  if (!snap.exists()) return null;
  return snap.data() as HealthGoals;
}

/**
 * Save (replace) the healthGoals document. Strips undefined values so
 * Firestore doesn't choke on them — undefined fields effectively clear that
 * metric's goal on next read.
 */
export async function saveHealthGoals(
  uid: string,
  goals: HealthGoals
): Promise<void> {
  // JSON round-trip drops undefined keys (Firestore rejects undefined).
  const cleaned = JSON.parse(JSON.stringify(goals)) as HealthGoals;
  await setDoc(HEALTH_GOALS_DOC(uid), {
    ...cleaned,
    updatedAt: serverTimestamp(),
  });
}

/** Delete all goals (used by the modal's "Clear All Goals" action). */
export async function clearHealthGoals(uid: string): Promise<void> {
  await deleteDoc(HEALTH_GOALS_DOC(uid));
}
