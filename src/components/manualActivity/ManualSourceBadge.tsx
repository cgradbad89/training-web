import { isManualActivity, type HealthWorkout } from "@/types/healthWorkout";

/** Restrained provenance label. Renders nothing for Apple Health records. */
export function ManualSourceBadge({ workout }: { workout: Pick<HealthWorkout, "entrySource"> }) {
  if (!isManualActivity(workout)) return null;
  return (
    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium text-textSecondary">
      Manual
    </span>
  );
}
