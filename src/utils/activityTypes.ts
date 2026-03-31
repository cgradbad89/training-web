import { type ActivityType } from "@/types";

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
