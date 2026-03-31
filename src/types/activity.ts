export type ActivityType =
  | "Run"
  | "TrailRun"
  | "Walk"
  | "Ride"
  | "Swim"
  | "WeightTraining"
  | "Workout"
  | "Yoga"
  | "Hike"
  | "Pilates"
  | "Kayaking"
  | "Other";

export const RUN_TYPES: ActivityType[] = ["Run"];
export const WORKOUT_TYPES: ActivityType[] = [
  "WeightTraining",
  "Workout",
  "Yoga",
  "Ride",
  "Pilates",
];

export interface StravaActivity {
  id: number;
  name: string;
  type: ActivityType;
  start_date: string;
  start_date_local: string;
  timezone: string;
  distance_m: number;
  distance_miles: number;
  moving_time_s: number;
  elapsed_time_s: number;
  avg_speed_mps: number;
  max_speed_mps: number;
  avg_heartrate: number | null;
  total_elev_gain_m: number;
  kudos_count: number;
  external_id: string;
  gear_id: string | null;
  pace_min_per_mile: string;
  pace_sec_per_mile: number;
  calories: number;
  efficiencyScore?: number;
}
