/**
 * Phase 3Q.2 — performance-evidence qualification (performance-evidence-v1).
 *
 * Decides WHAT may be treated as demonstrated running performance. Pure, deterministic, no I/O,
 * no wall clock. Reuses the v2 completed-parent selector (overrides, exclusions, duplicates,
 * as-of availability) and the Phase 3A race-integrity screen unchanged.
 *
 * Tiers (an ordinary run is NEVER a maximal effort):
 *  1 confirmed_maximal     owner-confirmed / verified maximal race or time trial (Phase 3A eligibility).
 *  2 strong_unconfirmed    a recorded race with consistent clocks, a race-labelled run, or an outdoor whole-run
 *                          effort whose pace-equivalent AND heart rate both lie in the top of the athlete's OWN
 *                          trailing-year distribution and clear a margin over their typical run (percentiles alone
 *                          would always select the noisy tail of ordinary running). Strong, but maximality is not confirmed.
 *  3 ordinary_training     counted, never a numerical source (its GPS segments form a lower-bound curve only).
 *  4 unsuitable            incomplete/unreliable: partial route, timing discrepancy, implausible pace/distance,
 *                          owner-corrected distance/duration, inconsistent race records.
 *
 * Correlation: every effort derived from one workout shares a cluster and counts once; at most one
 * independent item per local day is kept. GPS best-effort segments are a descriptive envelope; they are
 * never promoted to maximal tests by being the fastest segment seen.
 *
 * Every threshold here is an engineering safeguard, not a published physiological constant.
 */
import type { RacePerformanceEvidence, RacePerformanceInput } from "@/types/racePerformance";
import type { HealthWorkout } from "@/types/healthWorkout";
import type {
  EvidenceExclusion, EvidenceQualification, EvidenceTier, PerformanceCurvePoint, PerformanceEvidenceItem,
} from "@/types/hybridPerformance";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";

/** Mirrors `BEST_EFFORT_DISTANCES_M` (a unit test asserts equality) so this pure module does not import the GPS/route graph. */
export const CURVE_DISTANCES_M = { "1mi": 1609.344, "5k": 5000, "10k": 10000, "10mi": 16093.44, half: 21097.5 } as const;
type BestEffortKey = keyof typeof CURVE_DISTANCES_M;
import { isPerformanceInstant, performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { buildRaceEvidence, HALF_MARATHON_METERS, researchRiegelSeconds } from "@/utils/racePerformance";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";

export const EVIDENCE_POLICY = Object.freeze({
  version: "performance-evidence-v1" as const,
  /** Older evidence is listed as expired and carries no numerical weight. */
  maximumAgeDays: 180,
  agingDays: 120,
  minimumDurationSeconds: 3 * 60, maximumDurationSeconds: 150 * 60,
  minimumPaceSecondsPerMile: 180, maximumPaceSecondsPerMile: 1800, maximumDistanceMiles: 26.3,
  minimumEffortDistanceMeters: 1000,
  validHrMin: 40, validHrMax: 220,
  referenceDays: 365, referenceMinimumRuns: 25,
  referenceMinimumDurationSeconds: 20 * 60, referenceMaximumDurationSeconds: 150 * 60,
  strongHrPercentile: 0.9, strongSpeedPercentile: 0.25,
  /** Percentiles alone always select the noisy tail of ordinary runs, so a strong effort must ALSO clear a margin over the athlete's typical run. */
  strongHrMarginBpm: 12, strongSpeedMargin: 0.06,
  heatExcludedF: 80,
  timingToleranceSeconds: 60, timingToleranceFraction: 0.01,
  quality: { confirmed: 1, recordedRace: 0.85, labelledRace: 0.6, strongRun: 0.45 },
  weatherMissingFactor: 0.85,
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
const MILE = 1609.344;

/** Reason carried by an item admitted under the demonstrated-race policy (see `isDemonstratedRaceEvidence`). */
export const DEMONSTRATED_RACE_REASON = "nonmaximal_effort_demonstrated_performance";

/**
 * A confirmed race that passed EVERY integrity check a confirmed-maximal race must pass (valid confirmation available as of the
 * cutoff, consistent identity/timing/distance, conditions stated) but whose attested effort is `hard` or `nonmaximal`. `hard` and
 * `nonmaximal` are treated identically; `unknown` is never admitted (it may have been maximal and is not attested). A status of
 * `verified`/`owner_confirmed` is only ever produced for a valid, available, consistent confirmation, so this adds no integrity logic.
 * It shows what was ACHIEVED, not maximal capability, and is used only through the labelled demonstrated-race policy.
 */
export function isDemonstratedRaceEvidence(e: Pick<RacePerformanceEvidence, "status" | "effort" | "conditions" | "finishSeconds" | "distanceMeters" | "availableAsOf">): boolean {
  return (e.status === "verified" || e.status === "owner_confirmed") && e.availableAsOf && (e.effort === "hard" || e.effort === "nonmaximal")
    && !!e.conditions?.trim() && positive(e.finishSeconds) && positive(e.distanceMeters);
}

export interface QualificationOptions {
  /** Admit demonstrated (confirmed hard/nonmaximal) races as `recorded_race`-class evidence. Default false: the unchanged v1 behaviour. */
  admitDemonstratedRaces?: boolean;
}
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const indoorLabel = (s: string) => /treadmill|indoor/i.test(s);
const hardStructureLabel = (s: string) => /tempo|interval|fartlek|hill repeat/i.test(s);
const raceLabel = (s: string) => /\brace\b|time.?trial/i.test(s);

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

const hmEquivalent = (workout: HealthWorkout) =>
  researchRiegelSeconds(workout.durationSeconds, workout.distanceMiles * MILE, HALF_MARATHON_METERS);

export function timingConsistent(w: HealthWorkout): boolean {
  const elapsed = (w.endDate.getTime() - w.startDate.getTime()) / 1000;
  return Math.abs(elapsed - w.durationSeconds) <= Math.max(EVIDENCE_POLICY.timingToleranceSeconds, w.durationSeconds * EVIDENCE_POLICY.timingToleranceFraction);
}

export function qualifyPerformanceEvidence(input: Input, options: QualificationOptions = {}): EvidenceQualification {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid performance-evidence cutoff is required");
  const P = EVIDENCE_POLICY;
  const asOfDate = performanceLocalDate(input.asOf, input.timeZone);
  const overrides = input.overrides ?? {};
  const { runs } = selectResearchRuns({ ...input, overrides, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const excludedByReason: Record<string, number> = {};
  const exclusions: EvidenceExclusion[] = [];
  const exclude = (clusterId: string, reason: string) => { exclusions.push({ clusterId, reason }); excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1; };
  const counts: Record<EvidenceTier, number> = { confirmed_maximal: 0, strong_unconfirmed: 0, ordinary_training: 0, unsuitable: 0 };
  const all: PerformanceEvidenceItem[] = [];

  // ── Athlete-relative effort reference (the athlete's own trailing year; never settings-derived HR). ──
  const refStart = shiftPerformanceDate(asOfDate, -P.referenceDays);
  const reference = runs.filter(r => !raceWorkoutIds.has(r.workout.workoutId) && r.date >= refStart && r.date <= asOfDate
    && r.workout.hasRoute && !indoorLabel(r.workout.displayType ?? "") && positive(r.workout.avgHeartRate)
    && r.workout.avgHeartRate >= P.validHrMin && r.workout.avgHeartRate <= P.validHrMax
    && r.workout.durationSeconds >= P.referenceMinimumDurationSeconds && r.workout.durationSeconds <= P.referenceMaximumDurationSeconds
    && r.paceSecondsPerMile >= P.minimumPaceSecondsPerMile && r.paceSecondsPerMile <= P.maximumPaceSecondsPerMile);
  const referenceAvailable = reference.length >= P.referenceMinimumRuns;
  const refHr = reference.map(r => r.workout.avgHeartRate!);
  const refEq = reference.flatMap(r => { const e = hmEquivalent(r.workout); return e === null ? [] : [e]; });
  const hrP90 = referenceAvailable ? quantile(refHr, P.strongHrPercentile) : null;
  const eqP25 = referenceAvailable ? quantile(refEq, P.strongSpeedPercentile) : null;
  const hrMedian = referenceAvailable ? quantile(refHr, 0.5) : null;
  const eqMedian = referenceAvailable ? quantile(refEq, 0.5) : null;
  const hrThreshold = hrP90 === null || hrMedian === null ? null : Math.max(hrP90, hrMedian + P.strongHrMarginBpm);
  const eqThreshold = eqP25 === null || eqMedian === null ? null : Math.min(eqP25, eqMedian * (1 - P.strongSpeedMargin));

  // ── Races: Phase 3A integrity screen, then the same provisional rule v2 uses for recorded races. ──
  const eligibleIds = new Set(runs.map(r => r.workout.workoutId));
  const raceEvidence = buildRaceEvidence({ ...input, overrides, workouts: input.workouts.filter(w => eligibleIds.has(w.workoutId)) });
  for (const e of raceEvidence) {
    const cluster = e.workoutId ?? e.raceId;
    if (e.distanceMeters === null || e.finishSeconds === null || !e.availableAsOf || e.ageDays === null) {
      counts.unsuitable++; exclude(cluster, e.status === "inconsistent" ? "race_record_inconsistent" : "race_evidence_incomplete"); continue;
    }
    const bad = e.reasons.some(r => /invalid|mismatch|conflict|excluded|unavailable|nonmaximal/.test(r));
    const confirmed = e.eligibleForEquivalence;
    const recorded = e.status === "recorded_unverified" && e.timingAgreement === "consistent"
      && e.timingBasis === "recorded_workout_duration" && !bad;
    const demonstrated = options.admitDemonstratedRaces === true && !confirmed && !recorded && isDemonstratedRaceEvidence(e);
    if (!confirmed && !recorded && !demonstrated) { counts.unsuitable++; exclude(cluster, e.status === "inconsistent" ? "race_record_inconsistent" : "race_not_usable"); continue; }
    const item: PerformanceEvidenceItem = {
      clusterId: cluster, workoutId: e.workoutId, raceId: e.raceId, kind: confirmed ? "confirmed_race" : "recorded_race",
      tier: confirmed ? "confirmed_maximal" : "strong_unconfirmed", date: e.raceDate, ageDays: e.ageDays,
      distanceMeters: e.distanceMeters, seconds: e.finishSeconds, quality: confirmed ? P.quality.confirmed : P.quality.recordedRace,
      avgHeartRate: null, tempF: null,
      reasons: confirmed ? [] : demonstrated ? [DEMONSTRATED_RACE_REASON] : ["official_time_and_maximal_effort_unverified"],
    };
    const linked = runs.find(r => r.workout.workoutId === e.workoutId)?.workout;
    if (linked) { item.avgHeartRate = positive(linked.avgHeartRate) ? linked.avgHeartRate : null; item.tempF = linked.weather?.tempF ?? null; }
    counts[item.tier]++; all.push(item);
  }

  // ── Whole-run efforts from non-race training runs. ──
  const tierOfWorkout = new Map<string, EvidenceTier>();
  for (const r of runs) {
    const w = r.workout, id = w.workoutId;
    if (raceWorkoutIds.has(id)) continue;
    const label = w.displayType ?? "";
    const override = overrides[id];
    const unsuitable = (reason: string) => { counts.unsuitable++; tierOfWorkout.set(id, "unsuitable"); exclude(id, reason); };
    const ordinary = (reason?: string) => { counts.ordinary_training++; tierOfWorkout.set(id, "ordinary_training"); if (reason) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1; };
    if (r.paceSecondsPerMile < P.minimumPaceSecondsPerMile || r.paceSecondsPerMile > P.maximumPaceSecondsPerMile
      || w.distanceMiles > P.maximumDistanceMiles) { unsuitable("implausible_pace_or_distance"); continue; }
    if (w.routeComplete === false) { unsuitable("partial_route"); continue; }
    if (!timingConsistent(w)) { unsuitable("timing_discrepancy"); continue; }
    if (override && (override.distanceMilesOverride != null || override.durationSecondsOverride != null)) { unsuitable("owner_corrected_distance_or_duration"); continue; }
    if (hardStructureLabel(label)) { ordinary("structured_session_not_whole_run_effort"); continue; }
    if (!w.hasRoute || indoorLabel(label)) { ordinary("treadmill_or_no_route"); continue; }
    if (w.durationSeconds < P.minimumDurationSeconds || w.durationSeconds > P.maximumDurationSeconds
      || w.distanceMiles * MILE < P.minimumEffortDistanceMeters) { ordinary("duration_or_distance_outside_effort_range"); continue; }
    const tempF = w.weather?.tempF ?? null;
    const build = (kind: PerformanceEvidenceItem["kind"], quality: number, reasons: string[]): PerformanceEvidenceItem => ({
      clusterId: id, workoutId: id, raceId: null, kind, tier: "strong_unconfirmed", date: r.date, ageDays: dayDiff(r.date, asOfDate),
      distanceMeters: w.distanceMiles * MILE, seconds: w.durationSeconds, quality: tempF === null ? quality * P.weatherMissingFactor : quality,
      avgHeartRate: positive(w.avgHeartRate) ? w.avgHeartRate : null, tempF, reasons: tempF === null ? [...reasons, "weather_missing"] : reasons });
    if (raceLabel(label)) { const item = build("labelled_race_run", P.quality.labelledRace, ["race_label_not_linked_to_a_race_record"]); counts.strong_unconfirmed++; tierOfWorkout.set(id, "strong_unconfirmed"); all.push(item); continue; }
    if (!positive(w.avgHeartRate) || w.avgHeartRate < P.validHrMin || w.avgHeartRate > P.validHrMax) { ordinary("missing_or_invalid_hr"); continue; }
    if (!referenceAvailable || hrThreshold === null || eqThreshold === null) { ordinary("no_athlete_effort_reference"); continue; }
    if (tempF !== null && tempF > P.heatExcludedF) { ordinary("heat_inflated_hr"); continue; }
    const eq = hmEquivalent(w);
    if (eq !== null && w.avgHeartRate >= hrThreshold && eq <= eqThreshold) {
      counts.strong_unconfirmed++; tierOfWorkout.set(id, "strong_unconfirmed");
      all.push(build("whole_run_effort", P.quality.strongRun, ["hr_and_pace_in_athlete_top_range"]));
    } else ordinary();
  }

  // ── Independence: one item per cluster (by construction) and per local day; expired items are listed, not used. ──
  const byDate = new Map<string, PerformanceEvidenceItem>();
  const expired: PerformanceEvidenceItem[] = [];
  const rank = (i: PerformanceEvidenceItem) => i.quality * 1e6 + i.distanceMeters;
  for (const item of all) {
    if (item.ageDays > P.maximumAgeDays) { expired.push(item); continue; }
    const kept = byDate.get(item.date);
    if (!kept) byDate.set(item.date, item);
    else if (rank(item) > rank(kept)) { exclude(kept.clusterId, "same_day_duplicate_effort"); byDate.set(item.date, item); }
    else exclude(item.clusterId, "same_day_duplicate_effort");
  }
  const independent = [...byDate.values()].sort((a, b) => b.quality - a.quality || a.ageDays - b.ageDays || a.clusterId.localeCompare(b.clusterId));

  // ── Descriptive best-effort envelope (a lower bound of capability, never a maximal test). ──
  const curve: PerformanceCurvePoint[] = [];
  for (const key of Object.keys(CURVE_DISTANCES_M) as BestEffortKey[]) {
    const meters = CURVE_DISTANCES_M[key];
    let best: PerformanceCurvePoint | null = null;
    for (const r of runs) {
      const be = r.workout.bestEfforts;
      if (raceWorkoutIds.has(r.workout.workoutId) || !be || r.date < refStart || r.date > asOfDate) continue;
      if (be.computedFromRouteComplete !== true || be.computationVersion !== BEST_EFFORTS_COMPUTATION_VERSION) continue;
      const seconds = be[key];
      const miles = meters / MILE;
      if (!positive(seconds) || seconds < miles * P.minimumPaceSecondsPerMile || seconds > miles * 1200) continue;
      if (!best || seconds < best.seconds) best = { distanceKey: key, distanceMeters: meters, seconds, date: r.date,
        hostTier: tierOfWorkout.get(r.workout.workoutId) ?? "ordinary_training" };
    }
    if (best) curve.push(best);
  }

  return { version: P.version, asOf: input.asOf, asOfDate, independent, all, counts, excludedByReason, expired,
    effortReference: { runs: reference.length, hrThreshold, equivalentSecondsThreshold: eqThreshold, available: referenceAvailable }, curve };
}
