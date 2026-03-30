/**
 * Strava activity service.
 *
 * Firestore collection: stravaActivities
 * Doc ID: Strava activity ID (number, stored as string)
 *
 * Schema (mirrors iOS StravaRow / StravaModels.swift):
 *   id              number
 *   name            string
 *   type            string (ActivityType)
 *   sport_type      string
 *   start_date      string  (ISO 8601 UTC)
 *   start_date_local string (ISO 8601 local)
 *   timezone        string
 *   distance        number  (meters)
 *   moving_time     number  (seconds)
 *   elapsed_time    number  (seconds)
 *   total_elevation_gain number (meters)
 *   average_speed   number  (m/s)
 *   max_speed       number  (m/s)
 *   average_heartrate number | null
 *   kudos_count     number
 *   external_id     string
 *   gear_id         string | null
 *   calories        number
 *   -- pre-computed by iOS sync client (optional):
 *   pace_min_per_mile string
 *   pace_sec_per_mile number
 *   distance_miles  number
 *   efficiencyScore number
 */

import {
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  orderBy,
  limit,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type StravaActivity } from "@/types";
import { metersToMiles, mpsToSecPerMile, formatPace } from "@/utils";

function docToActivity(id: string, data: Record<string, unknown>): StravaActivity {
  const distanceM = (data.distance as number) ?? 0;
  const speedMps = (data.average_speed as number) ?? 0;
  const secPerMile = data.pace_sec_per_mile
    ? (data.pace_sec_per_mile as number)
    : mpsToSecPerMile(speedMps);

  return {
    id: (data.id as number) ?? parseInt(id, 10),
    name: (data.name as string) ?? "",
    type: (data.type as StravaActivity["type"]) ?? "Other",
    start_date: (data.start_date as string) ?? "",
    start_date_local: (data.start_date_local as string) ?? "",
    timezone: (data.timezone as string) ?? "",
    distance_m: distanceM,
    distance_miles: (data.distance_miles as number) ?? metersToMiles(distanceM),
    moving_time_s: (data.moving_time as number) ?? 0,
    elapsed_time_s: (data.elapsed_time as number) ?? 0,
    avg_speed_mps: speedMps,
    max_speed_mps: (data.max_speed as number) ?? 0,
    avg_heartrate: (data.average_heartrate as number | null) ?? null,
    total_elev_gain_m: (data.total_elevation_gain as number) ?? 0,
    kudos_count: (data.kudos_count as number) ?? 0,
    external_id: (data.external_id as string) ?? "",
    gear_id: (data.gear_id as string | null) ?? null,
    pace_min_per_mile: (data.pace_min_per_mile as string) ?? formatPace(secPerMile),
    pace_sec_per_mile: secPerMile,
    calories: (data.calories as number) ?? 0,
    efficiencyScore: data.efficiencyScore as number | undefined,
  };
}

export async function fetchActivities(
  opts: { limitCount?: number; type?: string } = {}
): Promise<StravaActivity[]> {
  const constraints: QueryConstraint[] = [orderBy("start_date", "desc")];
  if (opts.type) constraints.push(where("type", "==", opts.type));
  if (opts.limitCount) constraints.push(limit(opts.limitCount));

  const q = query(collection(db, COLLECTIONS.stravaActivities), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => docToActivity(d.id, d.data() as Record<string, unknown>));
}

export async function fetchActivity(id: number): Promise<StravaActivity | null> {
  const snap = await getDoc(doc(db, COLLECTIONS.stravaActivities, String(id)));
  if (!snap.exists()) return null;
  return docToActivity(snap.id, snap.data() as Record<string, unknown>);
}
