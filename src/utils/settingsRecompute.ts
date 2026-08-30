import type { UserSettings } from "@/types/userSettings";
import {
  hrAnchorsChanged,
  type HrAnchors,
} from "@/utils/trainingLoad";
import type { TrainingLoadRecomputeStats } from "@/services/healthWorkouts";

export type SettingsRecomputeStatus =
  | { state: "idle" }
  | { state: "required"; anchors: HrAnchors }
  | { state: "running"; anchors: HrAnchors }
  | {
      state: "failed";
      anchors: HrAnchors;
      processed: number;
      failedWorkoutId?: string;
    };

export interface SettingsSaveResult {
  completedAnchors: HrAnchors;
  recomputeStatus: SettingsRecomputeStatus;
  recomputeStats?: TrainingLoadRecomputeStats;
  recomputeError?: unknown;
}

interface SaveSettingsWithRecomputeInput {
  uid: string;
  settings: Partial<UserSettings>;
  anchors: HrAnchors;
  completedAnchors: HrAnchors;
  recomputeStatus: SettingsRecomputeStatus;
  saveSettings: (uid: string, settings: Partial<UserSettings>) => Promise<void>;
  refreshSettings: () => Promise<void>;
  recompute: (
    uid: string,
    settings: UserSettings | null | undefined
  ) => Promise<TrainingLoadRecomputeStats>;
  refreshWorkouts: () => Promise<void>;
}

export function recomputeIsRequired(
  completedAnchors: HrAnchors,
  nextAnchors: HrAnchors,
  status: SettingsRecomputeStatus
): boolean {
  return status.state !== "idle" || hrAnchorsChanged(completedAnchors, nextAnchors);
}

/**
 * Persistence-first Settings operation. A recompute failure is returned as
 * state (not thrown) because the settings write has already succeeded and the
 * same anchors must remain retryable. Settings persistence failures still
 * reject normally.
 */
export async function saveSettingsWithRecompute(
  input: SaveSettingsWithRecomputeInput
): Promise<SettingsSaveResult> {
  const required = recomputeIsRequired(
    input.completedAnchors,
    input.anchors,
    input.recomputeStatus
  );

  await input.saveSettings(input.uid, input.settings);
  await input.refreshSettings();

  if (!required) {
    return {
      completedAnchors: input.anchors,
      recomputeStatus: { state: "idle" },
    };
  }

  try {
    const recomputeStats = await input.recompute(
      input.uid,
      input.settings as UserSettings
    );
    await input.refreshWorkouts();
    return {
      completedAnchors: input.anchors,
      recomputeStatus: { state: "idle" },
      recomputeStats,
    };
  } catch (recomputeError) {
    const detail = recomputeError as {
      progress?: { processed?: number };
      failedWorkoutId?: string;
    };
    return {
      completedAnchors: input.completedAnchors,
      recomputeStatus: {
        state: "failed",
        anchors: input.anchors,
        processed: detail.progress?.processed ?? 0,
        failedWorkoutId: detail.failedWorkoutId,
      },
      recomputeError,
    };
  }
}
