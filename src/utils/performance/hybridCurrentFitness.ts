/**
 * Hybrid Performance Model v1.1 — CURRENT-FITNESS estimates for four race distances (5K, 10 miles, half marathon, marathon).
 *
 * "What could this athlete reasonably race TODAY, given the performance they have demonstrated?" It is NOT a race-day forecast: it takes
 * no credit for training that has not happened, a taper, weather or a course (that is the separate Plan Insights race-day forecast).
 *
 * One estimator, four targets. Each row is produced by the SAME `estimateHybridHalfMarathonV11` engine (evidence qualification →
 * precision-weighted combination → bounded physiological and endurance terms → confidence) with a distance profile
 * (`hybridTargetProfiles.ts`); the half-marathon row is numerically identical to the pre-existing v1.1 estimate. Cross-distance
 * consistency is checked, never forced: if adjacent rows imply an implausible Riegel exponent (outside 1.00–1.20) both are flagged and
 * downgraded to provisional/low confidence instead of being silently adjusted.
 *
 * Every row is explicit about what it is: available, provisional (with the reasons), or unavailable (with the cause). A number is never
 * invented to fill a row. Not independently validated: there are not yet enough qualified race outcomes (see the evaluation docs).
 */
import type { HybridStatus, HybridUnavailableCause } from "@/types/hybridPerformance";
import type { HybridV11Estimate } from "@/types/hybridPerformanceV11";
import type { Race } from "@/types/race";
import type { RacePerformanceInput } from "@/types/racePerformance";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { treatConfirmedRacesAsMaximal } from "./confirmedRaceAssumption";
import { estimateHybridHalfMarathonV11, type HybridV11Options } from "./hybridPerformanceV11";
import { CROSS_DISTANCE_EXPONENT_BAND, HYBRID_TARGETS, HYBRID_TARGETS_VERSION, type HybridTargetId, type TargetProfile } from "./hybridTargetProfiles";
import { marathonPerformanceEquivalent, type MarathonPerformanceEquivalent } from "./marathonPerformanceEquivalent";

const MILE = 1609.344;
type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;

export interface CurrentFitnessRow {
  id: HybridTargetId;
  label: string;
  distanceMeters: number;
  distanceMiles: number;
  status: HybridStatus;
  /** Displayed finish time in seconds (rounded to the profile's increment); null when unavailable. The exact value is `estimate.seconds`. */
  finishSeconds: number | null;
  paceSecondsPerMile: number | null;
  confidence: "low" | "moderate" | null;
  evidenceQuality: "adequate" | "limited" | "insufficient";
  asOf: string;
  asOfDate: string;
  unavailableCause: HybridUnavailableCause | null;
  /** The plain-language insufficient-evidence reason when unavailable; null otherwise. */
  reason: string | null;
  provisionalReasons: string[];
  flags: string[];
  /** The full v1.1 result this row summarises (diagnostics, evidence mix, sensitivity range). */
  estimate: HybridV11Estimate;
}

export interface CurrentFitnessConsistency {
  /** Implied Riegel exponent between adjacent AVAILABLE rows (ln time ratio / ln distance ratio). */
  pairs: { from: HybridTargetId; to: HybridTargetId; impliedExponent: number; plausible: boolean }[];
  consistent: boolean;
}

export interface CurrentFitness {
  version: typeof HYBRID_TARGETS_VERSION;
  asOf: string;
  asOfDate: string;
  rows: CurrentFitnessRow[];
  consistency: CurrentFitnessConsistency;
  /** Supplementary performance extrapolation; never replaces a row or participates in consistency checks. */
  marathonEquivalent: MarathonPerformanceEquivalent | null;
}

export type CurrentFitnessOptions = Omit<HybridV11Options, "profile" | "targetDistanceMeters">;

function rowOf(profile: TargetProfile, e: HybridV11Estimate): CurrentFitnessRow {
  const unavailable = e.status === "unavailable" || e.seconds === null;
  const increment = profile.roundingSeconds;
  return {
    id: profile.id, label: profile.label, distanceMeters: profile.distanceMeters, distanceMiles: profile.distanceMeters / MILE,
    status: unavailable ? "unavailable" : e.status,
    finishSeconds: unavailable ? null : Math.round(e.seconds! / increment) * increment,
    paceSecondsPerMile: unavailable ? null : e.paceSecondsPerMile,
    confidence: unavailable ? null : e.confidence,
    evidenceQuality: e.evidenceQuality,
    asOf: e.asOf, asOfDate: e.asOfDate,
    unavailableCause: unavailable ? e.unavailableCause : null,
    reason: unavailable ? (e.fallbackReason ?? e.reasons[0] ?? "Evidence is insufficient for this distance.") : null,
    provisionalReasons: unavailable ? [] : e.influence.provisionalReasons,
    flags: e.flags, estimate: e,
  };
}

/** The four rows, in display order, from one shared input and one shared set of optional sources. */
export function estimateHybridCurrentFitness(input: Input, options: CurrentFitnessOptions = {}): CurrentFitness {
  const rows = HYBRID_TARGETS.map(profile => rowOf(profile, estimateHybridHalfMarathonV11(input, { ...options, profile })));
  const pairs: CurrentFitnessConsistency["pairs"] = [];
  const available = rows.filter(r => r.finishSeconds !== null && r.estimate.seconds !== null);
  for (let i = 1; i < available.length; i++) {
    const a = available[i - 1], b = available[i];
    const k = Math.log(b.estimate.seconds! / a.estimate.seconds!) / Math.log(b.distanceMeters / a.distanceMeters);
    pairs.push({ from: a.id, to: b.id, impliedExponent: k, plausible: k >= CROSS_DISTANCE_EXPONENT_BAND.min && k <= CROSS_DISTANCE_EXPONENT_BAND.max });
  }
  for (const p of pairs.filter(x => !x.plausible)) {
    const reason = `The ${p.from === "5k" ? "5K" : p.from} and ${p.to} estimates imply an implausible distance-scaling exponent (${p.impliedExponent.toFixed(2)}, expected ${CROSS_DISTANCE_EXPONENT_BAND.min.toFixed(2)}–${CROSS_DISTANCE_EXPONENT_BAND.max.toFixed(2)}); both are provisional.`;
    for (const id of [p.from, p.to]) {
      const row = rows.find(r => r.id === id)!;
      row.status = "provisional"; row.confidence = "low"; row.flags = [...new Set([...row.flags, "inconsistent_with_adjacent_distance"])];
      if (!row.provisionalReasons.includes(reason)) row.provisionalReasons = [...row.provisionalReasons, reason];
    }
  }
  const first = rows[0];
  return { version: HYBRID_TARGETS_VERSION, asOf: first.asOf, asOfDate: first.asOfDate, rows, consistency: { pairs, consistent: pairs.every(p => p.plausible) },
    marathonEquivalent: marathonPerformanceEquivalent(rows.find(row => row.id === "marathon")!.estimate) };
}

export interface CurrentFitnessPipelineInput extends Input {
  /** Apply the owner-approved prediction-only assumption (confirmed hard/nonmaximal races anchor as maximal). Default true, like the app. */
  assumeConfirmedRacesMaximal?: boolean;
}

/**
 * The app's complete pipeline in one pure function, so every surface (Personal Insights, research, tests) computes the SAME numbers:
 * the shared race adapter → the official v2 and HR-enhanced estimates (which v1.1 reuses for corroboration, exactly as Plan Insights does)
 * → the four distances.
 */
export function computeCurrentFitness(input: CurrentFitnessPipelineInput, options: CurrentFitnessOptions = {}): CurrentFitness {
  const races: readonly Race[] = input.assumeConfirmedRacesMaximal === false ? input.races : treatConfirmedRacesAsMaximal(input.races);
  const base: Input = { races: races as Race[], workouts: input.workouts, overrides: input.overrides, asOf: input.asOf, timeZone: input.timeZone };
  const official = options.official ?? estimateCurrentHalfMarathon(base);
  const hrEnhanced = options.hrEnhanced ?? estimateHrEnhancedHalfMarathon(base, { official });
  return estimateHybridCurrentFitness(base, { ...options, official, hrEnhanced });
}

export { HYBRID_TARGETS, HYBRID_TARGETS_VERSION };
