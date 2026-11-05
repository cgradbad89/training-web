import { canonicalizePerformanceValue, performanceLocalDate } from "@/utils/performanceEvidence";
import { DEFAULT_RACE_PERFORMANCE_POLICY, HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { PROTOCOL, choice, digest, instant, key, positive, readTarget, record, requireVersion, sha256, string } from "./evidence";

const optionalText = (value: unknown, field: string) => value == null ? null : string(value, field);
const optionalTime = (value: unknown, field: string) => value == null ? null : positive(value, field);

/** Intake preserves an incomplete race as an excluded candidate with explicit reasons. */
export function sealOutcome(value: unknown) {
  const raw = record(value, "outcome");
  requireVersion(raw.protocol, PROTOCOL, "Outcome protocol");
  const target = readTarget(raw.target);
  const name = string(raw.name, "official event name");
  const distanceMeters = positive(raw.distanceMeters, "official distanceMeters");
  const kind = choice(raw.kind, ["official_race", "measured_time_trial"], "outcome.kind");
  const dataKind = choice(raw.dataKind, ["synthetic", "real"], "outcome.dataKind");
  const finishSeconds = optionalTime(raw.finishSeconds, "official finishSeconds");
  const recordedDurationSeconds = optionalTime(raw.recordedDurationSeconds, "recordedDurationSeconds");
  const recordedElapsedSeconds = optionalTime(raw.recordedElapsedSeconds, "recordedElapsedSeconds");
  const workoutId = raw.workoutId == null ? null : key(raw.workoutId, "outcome.workoutId");
  const timingBasis = choice(raw.timingBasis, ["chip", "official_elapsed", "independent_elapsed", "unverified"], "outcome.timingBasis");
  const timingReconciliation = optionalText(raw.timingReconciliation, "timingReconciliation");
  const effort = choice(raw.effort, ["maximal", "nonmaximal", "unknown"], "outcome.effort");
  const effortSource = optionalText(raw.effortSource, "effortSource");
  const conditions = optionalText(raw.conditions, "conditions");
  const source = record(raw.source, "outcome.source");
  const provenance = {
    timingReference: optionalText(source.timingReference, "timingReference"),
    distanceReference: optionalText(source.distanceReference, "distanceReference"),
    knownAt: source.knownAt == null ? null : instant(source.knownAt, "outcome.source.knownAt"),
  };
  const reasons: string[] = [];
  if (Math.abs(distanceMeters - HALF_MARATHON_METERS) > DEFAULT_RACE_PERFORMANCE_POLICY.sameDistanceToleranceMeters) {
    reasons.push("Outcome is outside the half-marathon distance domain");
  }
  const timingQualified = kind === "official_race"
    ? timingBasis === "chip" || timingBasis === "official_elapsed"
    : timingBasis === "independent_elapsed";
  if (!timingQualified || !finishSeconds || !provenance.timingReference || !provenance.distanceReference) {
    reasons.push("Independent result timing and measured-distance sources required");
  }
  if (effort !== "maximal" || !effortSource) reasons.push("Documented maximal effort required");
  if (!conditions) reasons.push("Relevant race conditions required");
  if (!provenance.knownAt || performanceLocalDate(provenance.knownAt, target.timeZone) < target.raceDate) {
    reasons.push("Outcome evidence availability is unknown or precedes the event");
  }
  const clocks = [finishSeconds, recordedDurationSeconds, recordedElapsedSeconds].filter((clock): clock is number => clock !== null);
  if (clocks.length > 1) {
    const max = Math.max(...clocks);
    const tolerance = Math.max(DEFAULT_RACE_PERFORMANCE_POLICY.timingToleranceSeconds,
      DEFAULT_RACE_PERFORMANCE_POLICY.timingToleranceFraction * max);
    if (max - Math.min(...clocks) > tolerance && !timingReconciliation) reasons.push("Clock disagreement requires documented reconciliation");
  }
  const payload = {
    protocol: PROTOCOL, target, name, kind, dataKind, distanceMeters, finishSeconds, workoutId,
    recordedDurationSeconds, recordedElapsedSeconds, timingBasis, timingReconciliation,
    effort, effortSource, conditions, source: provenance, qualificationReasons: reasons,
  };
  return { ...payload, integrityDigest: digest(payload) };
}

export type Outcome = ReturnType<typeof sealOutcome>;

export function readOutcome(value: unknown): Outcome {
  const { integrityDigest, ...payload } = record(value, "sealed outcome");
  if (sha256(integrityDigest, "outcome.integrityDigest") !== digest(payload)) throw new TypeError("Outcome integrity digest mismatch");
  const checked = sealOutcome(payload);
  if (canonicalizePerformanceValue(checked) !== canonicalizePerformanceValue(value)) throw new TypeError("Outcome qualification did not replay identically");
  return checked;
}
