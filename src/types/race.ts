// All races are half marathon (13.109 miles)
export const HALF_MARATHON_MILES = 13.109;

export type RaceDistance = "halfMarathon";

export const RACE_DISTANCE_MILES: Record<RaceDistance, number> = {
  halfMarathon: HALF_MARATHON_MILES,
};

export interface HalfMarathonRace {
  id: string;
  name: string;
  date: string; // ISO date string
  targetPaceSecPerMile: number; // e.g. 600 = 10:00/mi
  finishTimeSeconds: number;    // targetPaceSecPerMile * 13.109
  linkedRunActivityId?: number; // Strava activity id
  isActive: boolean;
  notes?: string;
  createdAt: string;
}
