import { type HealthWorkout } from "@/types/healthWorkout";

export interface DuplicatePair {
  otfWorkoutId: string;
  manualWorkoutId: string;
  otfDisplayType: string;
  manualDisplayType: string;
  date: string;
}

export function isOtfOrHiit(a: HealthWorkout): boolean {
  const name = a.displayType.toLowerCase();
  const type = a.activityType.toLowerCase();
  const source = (a.sourceName ?? "").toLowerCase();
  return (
    name.includes("orange") ||
    name.includes("otf") ||
    type === "high_intensity_interval_training" ||
    type.includes("hiit") ||
    source.includes("orangetheory") ||
    source.includes("orange theory") ||
    source.includes("otf")
  );
}

export function detectDuplicatePairs(
  activities: HealthWorkout[]
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const pairedIds = new Set<string>();

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];

      // Skip if already paired
      if (pairedIds.has(a.workoutId) || pairedIds.has(b.workoutId)) continue;

      // At least one must be OTF/HIIT
      const aIsOtf = isOtfOrHiit(a);
      const bIsOtf = isOtfOrHiit(b);
      if (!aIsOtf && !bIsOtf) continue;

      // Within 60 minutes
      const timeA = new Date(a.startDate).getTime();
      const timeB = new Date(b.startDate).getTime();
      if (Math.abs(timeA - timeB) / 60000 > 60) continue;

      // Duration ratio >= 0.3
      const durRatio =
        Math.min(a.durationSeconds, b.durationSeconds) /
        Math.max(a.durationSeconds, b.durationSeconds);
      if (durRatio < 0.3) continue;

      // Determine which is OTF and which is manual
      const otf = aIsOtf ? a : b;
      const manual = aIsOtf ? b : a;

      pairs.push({
        otfWorkoutId: otf.workoutId,
        manualWorkoutId: manual.workoutId,
        otfDisplayType: otf.displayType,
        manualDisplayType: manual.displayType,
        date: new Date(otf.startDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
      });

      pairedIds.add(otf.workoutId);
      pairedIds.add(manual.workoutId);
    }
  }

  return pairs;
}
