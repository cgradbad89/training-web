// Reject implausible optical-sensor lows before percentile calculation.
export const MIN_VALID_HR_BPM = 40;
// Reject obvious spikes above a realistic user-observed max HR.
export const MAX_VALID_HR_BPM = 220;
export const MIN_HR_SAMPLES_FOR_SUGGESTION = 50;
export const MAX_HR_PERCENTILE = 0.99;

export function computeMaxHrSuggestion(
  perPointHrValues: Array<number | null | undefined>
): number | null {
  const valid = perPointHrValues
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= MIN_VALID_HR_BPM &&
        value <= MAX_VALID_HR_BPM
    )
    .sort((a, b) => a - b);

  if (valid.length < MIN_HR_SAMPLES_FOR_SUGGESTION) return null;

  const index = Math.ceil(MAX_HR_PERCENTILE * valid.length) - 1;
  return Math.round(valid[Math.max(0, Math.min(valid.length - 1, index))]);
}
