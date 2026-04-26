export type RaceDistance =
  | "5K"
  | "10K"
  | "halfMarathon"
  | "marathon"
  | "custom";

export const HALF_MARATHON_MILES = 13.109;

export const RACE_DISTANCE_MILES: Record<Exclude<RaceDistance, "custom">, number> = {
  "5K":         3.107,
  "10K":        6.214,
  halfMarathon: 13.109,
  marathon:     26.219,
};

export const RACE_DISTANCE_LABELS: Record<RaceDistance, string> = {
  "5K":         "5K",
  "10K":        "10K",
  halfMarathon: "Half Marathon",
  marathon:     "Marathon",
  custom:       "Custom",
};

export interface Race {
  id: string;
  name: string;
  raceDate: string;                  // ISO date string
  raceDistance: RaceDistance;
  customDistanceMiles?: number;      // only when raceDistance === "custom"
  location?: string;
  targetPaceSecondsPerMile?: number;
  linkedStravaActivityId?: string;
  result?: string;                   // e.g. "2:10:45"
  notes?: string;
  isActive: boolean;
  createdAt: string;
  /** ID of the RunningPlan associated with this race (set on Races edit form). */
  linkedPlanId?: string;
  // Actual race run association (linked via run picker on the card)
  actualRunId?: string;
  actualRunDate?: string;
  actualRunDistanceMiles?: number;
  actualRunDurationSeconds?: number;
  actualRunAvgPace?: number;
}

/** Legacy alias */
export type HalfMarathonRace = Race;
