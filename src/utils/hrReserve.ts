// Karvonen Heart-Rate Reserve (%HRR), shared by the efficiency-score baseline.
//
// This mirrors the exact inline formula used by the Training Load V2 model in
// trainingLoad.ts (computeTrainingLoadV2 / computeStreamedTrainingLoad):
//   clamp((avgHeartRate − restingHr) / (maxHr − restingHr), 0, 1)
// so both surfaces measure effort on the same scale. Consolidating
// trainingLoad.ts's four duplicated inline copies onto this helper is known,
// accepted tech debt — a separate future cleanup, intentionally not done here.

/**
 * Fraction of heart-rate reserve used at `avgHeartRate`, clamped to [0, 1].
 * An avgHR above maxHr (or below restingHr) can't overflow / go negative.
 */
export function computeHRReserve(
  avgHeartRate: number,
  restingHr: number,
  maxHr: number
): number {
  return Math.max(0, Math.min(1, (avgHeartRate - restingHr) / (maxHr - restingHr)));
}
