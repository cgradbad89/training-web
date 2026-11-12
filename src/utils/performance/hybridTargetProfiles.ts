/**
 * Target-distance profiles for the Hybrid Performance Model v1.1 current-fitness table (5K, 10 miles, half marathon, marathon).
 *
 * ONE estimator serves every distance (`hybridPerformanceV11.ts`): the same evidence qualification, the same precision-weighted
 * combination, the same physiological trend, the same bounded-change and correlated-term rules. A profile only supplies the handful of
 * parameters that legitimately depend on the DISTANCE being predicted — nothing about the evidence itself. The half-marathon profile
 * reproduces the pre-existing v1.1 behaviour bit for bit (a golden regression test enforces it); the other three are documented
 * ENGINEERING ASSUMPTIONS, none fitted to a race outcome (accuracy is NOT EVALUABLE until enough qualified outcomes exist).
 *
 * What differs by distance, and why:
 *  - Conversion uncertainty. Converting a performance at a different distance adds uncertainty ∝ |ln(distance ratio)|. How uncertain
 *    depends on which limiter dominates at the target. A 5 K is speed/VO₂-limited, so a half-marathon result says little about it
 *    (σ 0.03/ln when the source is longer); a marathon is durability-limited, so a half-marathon result is an optimistic proxy
 *    (σ 0.04/ln when the source is shorter).
 *  - Conversion exponent. Riegel's population exponent (1.06) stays the optimistic end. Longer sources converted DOWN (HM → 5 K) use 1.06
 *    with a wide, disclosed sensitivity band; shorter sources converted UP use an exponent that rises as endurance readiness falls, to
 *    1.12 (10 mi, HM — unchanged) and to 1.15 for the marathon, where an under-prepared athlete's half-marathon result converts
 *    markedly slower than the Riegel figure.
 *  - Term weights. The pace-at-heart-rate trend is an aerobic-base signal: a weaker predictor of a speed-limited 5 K than of a long race
 *    (scale 0.75 / 0.9 / 1 / 1). The endurance-change term (readiness change since the evidence) matters least for a 5 K (0.5 / 0.75 / 1 / 1).
 *  - Gates. A 10-mile and longer target needs a minimum of endurance preparation (the existing 0.2 rule, unchanged for the half marathon).
 *    The marathon additionally needs explicit DURABILITY evidence (see `durability`) unless marathon-distance performance already carries
 *    the base: half-marathon ability is never read as proof of marathon readiness.
 *  - Directness. Confidence can only be `moderate` when at least half of the base comes from evidence within `directRatio`× of the
 *    target distance; a number derived mainly from distant evidence is provisional and low-confidence and says so.
 *  - Presentation precision. The finish time is shown to ≈ 0.3–0.5 % (15 s for a 5 K, 30 s for 10 miles, one minute for the half and
 *    full marathon) so the rounding never implies precision the evidence cannot support. The pace is shown to 5 s.
 */
export type HybridTargetId = "5k" | "10mi" | "half" | "marathon";

export interface MarathonDurabilityPolicy {
  /** Longest recent non-race run (miles, last 8 weeks): below this the estimate is withheld. */
  withholdBelowLongestRunMiles: number;
  /** Mean of the three longest weekly-longest runs (miles): below this the estimate is provisional and low-confidence at best. */
  provisionalBelowLongRunMiles: number;
  /** Median weekly miles in observed weeks: below this the estimate is provisional. */
  provisionalBelowWeeklyMiles: number;
  /** Share of the evidence base within the at-target band that demonstrates marathon durability directly and waives the training gates. */
  demonstratedShare: number;
}

export interface TargetProfile {
  id: HybridTargetId;
  label: string;
  /** Noun phrase used in explanations ("to carry a 10-mile time"). */
  noun: string;
  distanceMeters: number;
  /** Conversion uncertainty per |ln distance ratio| for sources shorter / longer than the target. */
  extrapolationSigmaPerLn: number;
  longerSourceSigmaPerLn: number;
  /** Exponent for converting a source LONGER than the target (HM → 5 K). Half marathon: the policy's fixed 1.06. */
  longerSourceExponent: number;
  /** Exponent at zero endurance readiness for sources SHORTER than the target (1.06 at full readiness). */
  maximumExponent: number;
  /** Alternative exponents for the assumption-sensitivity range: [shorter-source exponents], [longer-source exponents]. */
  sensitivityExponents: readonly [number, number];
  sensitivityLongerExponents: readonly [number, number] | null;
  physiologyScale: number;
  enduranceScale: number;
  /** Endurance-support floor below which the estimate is withheld; null = no floor (5 K). */
  minimumReadiness: number | null;
  /**
   * A performance at a LONGER distance already demonstrates the endurance for this shorter target (a recent half marathon supports a 10-mile estimate
   * even when current training is light), so it counts toward the endurance-support floor. Half marathon / marathon: the pre-existing at-target band.
   */
  longerSourceDemonstratesEndurance: boolean;
  /** Evidence within this ratio of the target distance (either side) is "direct" evidence; null = rule not applied (half marathon). */
  directRatio: number | null;
  durability: MarathonDurabilityPolicy | null;
  /** Presentation: finish-time rounding in seconds. */
  roundingSeconds: number;
}

export const HYBRID_TARGET_POLICY_VERSION = "hybrid-targets-v1" as const;
export const HYBRID_TARGETS_VERSION = "experimental-hybrid-v1.1-targets-2" as const;
export const HALF_MARATHON_M = 21097.5;

const FIVE_K: TargetProfile = {
  id: "5k", label: "5K", noun: "5K", distanceMeters: 5000,
  extrapolationSigmaPerLn: 0.02, longerSourceSigmaPerLn: 0.03, longerSourceExponent: 1.06, maximumExponent: 1.1,
  sensitivityExponents: [1.06, 1.1], sensitivityLongerExponents: [1.02, 1.1],
  physiologyScale: 0.75, enduranceScale: 0.5, minimumReadiness: null, longerSourceDemonstratesEndurance: true, directRatio: 2, durability: null, roundingSeconds: 15,
};
const TEN_MILES: TargetProfile = {
  id: "10mi", label: "10 miles", noun: "10-mile", distanceMeters: 16093.44,
  extrapolationSigmaPerLn: 0.02, longerSourceSigmaPerLn: 0.02, longerSourceExponent: 1.06, maximumExponent: 1.12,
  sensitivityExponents: [1.06, 1.1], sensitivityLongerExponents: [1.03, 1.09],
  physiologyScale: 0.9, enduranceScale: 0.75, minimumReadiness: 0.2, longerSourceDemonstratesEndurance: true, directRatio: 2, durability: null, roundingSeconds: 30,
};
/** Identical to the pre-existing hybrid v1.1 constants (bit for bit): see the golden regression test. */
const HALF: TargetProfile = {
  id: "half", label: "Half marathon", noun: "half-marathon", distanceMeters: HALF_MARATHON_M,
  extrapolationSigmaPerLn: 0.02, longerSourceSigmaPerLn: 0.01, longerSourceExponent: 1.06, maximumExponent: 1.12,
  sensitivityExponents: [1.06, 1.1], sensitivityLongerExponents: null,
  physiologyScale: 1, enduranceScale: 1, minimumReadiness: 0.2, longerSourceDemonstratesEndurance: false, directRatio: null, durability: null, roundingSeconds: 60,
};
const MARATHON: TargetProfile = {
  id: "marathon", label: "Marathon", noun: "marathon", distanceMeters: 42195,
  extrapolationSigmaPerLn: 0.04, longerSourceSigmaPerLn: 0.01, longerSourceExponent: 1.06, maximumExponent: 1.15,
  sensitivityExponents: [1.08, 1.15], sensitivityLongerExponents: null,
  physiologyScale: 1, enduranceScale: 1, minimumReadiness: 0.2, longerSourceDemonstratesEndurance: false, directRatio: 2.05,
  durability: { withholdBelowLongestRunMiles: 12, provisionalBelowLongRunMiles: 16, provisionalBelowWeeklyMiles: 20, demonstratedShare: 0.5 },
  roundingSeconds: 60,
};

/** In display order. */
export const HYBRID_TARGETS: readonly TargetProfile[] = Object.freeze([FIVE_K, TEN_MILES, HALF, MARATHON]);
export const TARGET_PROFILES: Readonly<Record<HybridTargetId, TargetProfile>> = Object.freeze({ "5k": FIVE_K, "10mi": TEN_MILES, half: HALF, marathon: MARATHON });

/** Plausible implied Riegel exponent between ADJACENT targets; outside it the pair is internally inconsistent and is flagged, never silently clamped. */
export const CROSS_DISTANCE_EXPONENT_BAND = Object.freeze({ min: 1.0, max: 1.2 });
