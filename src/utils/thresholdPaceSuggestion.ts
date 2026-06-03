export type ThresholdPaceSuggestionSource = "10mi" | "half";

export interface ThresholdPaceSuggestion {
  paceSecPerMile: number;
  source: ThresholdPaceSuggestionSource;
}

export function computeThresholdPaceSuggestion(
  tenMilePredictedSeconds: number | null | undefined,
  halfMarathonPredictedSeconds: number | null | undefined
): ThresholdPaceSuggestion | null {
  if (
    tenMilePredictedSeconds != null &&
    Number.isFinite(tenMilePredictedSeconds) &&
    tenMilePredictedSeconds > 0
  ) {
    return { paceSecPerMile: tenMilePredictedSeconds / 10.0, source: "10mi" };
  }

  if (
    halfMarathonPredictedSeconds != null &&
    Number.isFinite(halfMarathonPredictedSeconds) &&
    halfMarathonPredictedSeconds > 0
  ) {
    return {
      paceSecPerMile: halfMarathonPredictedSeconds / 13.109,
      source: "half",
    };
  }

  return null;
}
