import {
  collection,
  getDocs,
  query,
  orderBy,
  where,
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
