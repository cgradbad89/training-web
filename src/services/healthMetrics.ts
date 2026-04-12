import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
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
