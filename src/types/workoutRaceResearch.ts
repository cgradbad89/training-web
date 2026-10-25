import type { HealthWorkout } from "./healthWorkout";
import type { Race } from "./race";
import type { WorkoutOverride } from "./workoutOverride";
import type { RacePerformanceEvidence } from "./racePerformance";
import type { RaceTrainingContext } from "@/utils/raceTrainingContext";

/** Offline/research input only. Captured-at is an observation boundary, not an
 * owner-writable claim of immutable historical availability. */
export interface WorkoutRaceResearchInput {
  workouts: readonly HealthWorkout[];
  races: readonly Race[];
  overrides: Record<string, WorkoutOverride>;
  asOf: string;
  capturedAt: string;
  timeZone: string;
  source: "synthetic" | "owner_parent_export";
  complete: { workouts: boolean; races: boolean; overrides: boolean };
  /** Explicit conditional scenario, never an automatic physiological claim. */
  allowSummaryPaceTransfer: boolean;
  historical?: boolean;
  /** Source scope/adapter omissions; never claims lifetime completeness. */
  sourceNotes?: readonly string[];
}
export interface ResearchRun {
  workout: HealthWorkout;
  date: string;
  paceSecondsPerMile: number;
  recordedType: string;
}
export interface ResearchPair {
  baselineId: string;
  recentId: string;
  recentDate: string;
  baselinePace: number;
  recentPace: number;
  paceRatio: number;
  heartRateDifference: number;
  context: string;
}
export interface ResearchEstimate {
  method: "A" | "B" | "C";
  name: string;
  status: "experimental" | "comparator_only" | "unavailable";
  /** Rounded to whole minutes. Never assign to RacePerformanceResult. */
  finishMinutes: number | null;
  paceSecondsPerMile: number | null;
  adjustmentMinutes: number | null;
  reason: string;
  assumptions: string[];
}
export interface WorkoutRaceResearchResult {
  version: "phase3b2-conditional-research-v1";
  researchOnly: true;
  validated: false;
  asOf: string;
  capturedAt: string;
  retrospective: boolean;
  anchor: RacePerformanceEvidence | null;
  raceEvidence: RacePerformanceEvidence[];
  raceEquivalences: { riegelMinutes: number | null; vdotMinutes: number | null };
  models: [ResearchEstimate, ResearchEstimate, ResearchEstimate];
  history: {
    runs: ResearchRun[];
    exclusions: { workoutId: string; reason: string }[];
    dateRange: { first: string; last: string } | null;
    miles: number;
    types: Record<string, number>;
    missing: { heartRate: number; recordedPace: number; route: number; weather: number };
  };
  training: RaceTrainingContext;
  anchorTraining: RaceTrainingContext | null;
  modelingRuns: ResearchRun[];
  sinceAnchor: { sessions: number; miles: number } | null;
  pairs: ResearchPair[];
  pairRejections: { workoutId: string; reason: string }[];
  longestObservedGapDays: number | null;
  daysSinceLatestRun: number | null;
  contributions: { feature: string; role: "descriptive" | "conditional_numeric"; minutes: number | null; explanation: string }[];
  limitations: string[];
  future: { targetName: string; targetDate: "2027-03-20"; finishMinutes: null; reason: string };
}
