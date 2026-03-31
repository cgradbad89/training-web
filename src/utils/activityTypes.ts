import { type ActivityType, RUN_TYPES, WORKOUT_TYPES } from "@/types";

/** Activity types treated as runs for metric computations */
export const RUN_LIKE_TYPES: ActivityType[] = ["Run", "TrailRun"];

/** Activity types that are displayed in the Runs section */
export const RUN_SECTION_TYPES: ActivityType[] = ["Run", "TrailRun", "Walk", "Hike"];

export function isRunLike(type: ActivityType): boolean {
  return RUN_LIKE_TYPES.includes(type);
}

export function isRunSection(type: ActivityType): boolean {
  return RUN_SECTION_TYPES.includes(type);
}

/** True if this activity counts as a Run for weekly stats (RUN_TYPES = ["Run"]) */
export function isRun(type: ActivityType): boolean {
  return (RUN_TYPES as ActivityType[]).includes(type);
}

/** True if this activity counts as a Workout for weekly stats */
export function isWorkout(type: ActivityType): boolean {
  return (WORKOUT_TYPES as ActivityType[]).includes(type);
}

/** Human-readable label for an activity type */
export function activityTypeLabel(type: ActivityType): string {
  const labels: Record<ActivityType, string> = {
    Run: "Run",
    TrailRun: "Trail Run",
    Walk: "Walk",
    Ride: "Ride",
    Swim: "Swim",
    WeightTraining: "Weight Training",
    Workout: "Workout",
    Yoga: "Yoga",
    Hike: "Hike",
    Pilates: "Pilates",
    Kayaking: "Kayaking",
    Other: "Other",
  };
  return labels[type] ?? type;
}

/** Infer display type from activity name (mirrors iOS run type inference) */
export function inferRunType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("easy")) return "Easy Run";
  if (lower.includes("tempo")) return "Tempo";
  if (lower.includes("interval") || lower.includes("speed")) return "Intervals";
  if (lower.includes("long")) return "Long Run";
  if (lower.includes("trail")) return "Trail Run";
  if (lower.includes("race")) return "Race";
  return "Run";
}

// ─── Run display tag (used in run list UI) ────────────────────────────────────

export type RunTag = "otf" | "treadmill" | "longRun" | "outdoor";

export const RUN_TAG_STYLES: Record<RunTag, string> = {
  otf:       "bg-orange-100 text-orange-700",
  treadmill: "bg-blue-100 text-blue-700",
  longRun:   "bg-purple-100 text-purple-700",
  outdoor:   "bg-green-100 text-green-700",
};

export const RUN_TAG_LABELS: Record<RunTag, string> = {
  otf:       "OTF",
  treadmill: "Treadmill",
  longRun:   "Long Run",
  outdoor:   "Outdoor",
};

/**
 * Classify a run into a display tag for the run list UI.
 * Mirrors iOS inferRunType distance logic: long run threshold is > 7 miles.
 */
export function classifyRun(name: string, distanceMiles: number): RunTag {
  const lower = name.toLowerCase();
  if (
    lower.includes("orange theory") ||
    lower.includes("orangetheory") ||
    lower.includes(" otf")
  ) {
    return "otf";
  }
  if (lower.includes("treadmill")) return "treadmill";
  if (distanceMiles > 7) return "longRun";
  return "outdoor";
}
