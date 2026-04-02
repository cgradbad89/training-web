import {
  collection,
  getDocs,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface RoutePoint {
  index: number;
  lat: number;
  lng: number;
  altitude: number;
  timestamp: string; // ISO string
  speed: number | null;
}

function docToRoutePoint(data: Record<string, unknown>): RoutePoint {
  const ts = data.timestamp as { toDate?: () => Date } | null;
  return {
    index: (data.index as number) ?? 0,
    lat: (data.lat as number) ?? 0,
    lng: (data.lng as number) ?? 0,
    altitude: (data.altitude as number) ?? 0,
    timestamp: ts?.toDate?.()?.toISOString() ?? "",
    speed: (data.speed as number | null) ?? null,
  };
}

export async function fetchRoutePoints(
  uid: string,
  workoutId: string
): Promise<RoutePoint[]> {
  const ref = collection(
    db,
    "users",
    uid,
    "healthWorkouts",
    workoutId,
    "route"
  );
  const q = query(ref, orderBy("index", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    docToRoutePoint(d.data() as Record<string, unknown>)
  );
}
