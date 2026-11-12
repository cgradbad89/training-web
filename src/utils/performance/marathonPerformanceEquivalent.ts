/** Read-only supplementary benchmark. Never supplies a current-fitness prediction or a forecast. */
import type { CombinationItem, EvidenceItemV11, HybridV11Estimate } from "@/types/hybridPerformanceV11";
import { DEFAULT_RACE_PERFORMANCE_POLICY, HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { DEMONSTRATED_RACE_REASON, EVIDENCE_POLICY } from "./evidenceQualification";
import { TARGET_PROFILES } from "./hybridTargetProfiles";

export const MARATHON_EQUIVALENT_VERSION = "experimental-marathon-equivalent-v1" as const;
const MILE = 1609.344;

export interface MarathonEquivalentSource {
  clusterId: string;
  raceId: string | null;
  kind: CombinationItem["kind"];
  date: string;
  ageDays: number;
  distanceMeters: number;
  seconds: number;
  effectiveShare: number;
  /** A confirmed half that survived qualification AND carries positive weight in this exact combination. */
  qualifyingHalf: boolean;
}

export interface MarathonPerformanceEquivalent {
  version: typeof MARATHON_EQUIVALENT_VERSION;
  /** Exact pre-adjustment, pre-readiness-gate combination.baseSeconds; never independently converted. */
  seconds: number;
  finishSeconds: number;
  paceSecondsPerMile: number;
  confidence: "low";
  asOfDate: string;
  exponent: number;
  readinessScore: number;
  sources: readonly MarathonEquivalentSource[];
}

function isConfirmedHalf(item: EvidenceItemV11): boolean {
  return item.raceId !== null
    && Math.abs(item.distanceMeters - HALF_MARATHON_METERS) <= DEFAULT_RACE_PERFORMANCE_POLICY.sameDistanceToleranceMeters
    && (item.kind === "confirmed_race" || (item.kind === "recorded_race" && item.reasons.includes(DEMONSTRATED_RACE_REASON)));
}

/** Select ONLY from the official marathon row's retained diagnostics, including its active rollback policy. No estimator rerun. */
export function marathonPerformanceEquivalent(estimate: HybridV11Estimate): MarathonPerformanceEquivalent | null {
  const { combination, qualification, readiness } = estimate;
  const profile = TARGET_PROFILES.marathon;
  if (estimate.target?.id !== "marathon" || combination.targetDistanceMeters !== profile.distanceMeters
    || combination.status !== "available" || combination.baseSeconds === null || !Number.isFinite(combination.baseSeconds) || combination.baseSeconds <= 0
    || readiness?.score == null || !Number.isFinite(readiness.score)
    || combination.flags.includes("contradictory_evidence")) return null;

  const sources = combination.items.filter(item => Number.isFinite(item.effectiveShare) && item.effectiveShare > 0).map(item => {
    const qualified = qualification.independent.find(q => q.clusterId === item.clusterId && q.kind === item.kind && q.date === item.date);
    return { clusterId: item.clusterId, raceId: qualified?.raceId ?? null, kind: item.kind, date: item.date, ageDays: item.ageDays,
      distanceMeters: item.sourceDistanceMeters, seconds: item.sourceSeconds, effectiveShare: item.effectiveShare,
      qualifyingHalf: !!qualified && isConfirmedHalf(qualified) && qualified.ageDays >= 0 && qualified.ageDays <= EVIDENCE_POLICY.maximumAgeDays };
  });
  if (!sources.some(source => source.qualifyingHalf)) return null;
  const finishSeconds = Math.round(combination.baseSeconds / profile.roundingSeconds) * profile.roundingSeconds;
  return { version: MARATHON_EQUIVALENT_VERSION, seconds: combination.baseSeconds, finishSeconds,
    paceSecondsPerMile: Math.round(finishSeconds / (profile.distanceMeters / MILE) / 5) * 5,
    confidence: "low", asOfDate: estimate.asOfDate, exponent: combination.exponent, readinessScore: readiness.score, sources };
}
