import type { HealthWorkout } from '@/types/healthWorkout';
import type { Race } from '@/types/race';
import type { RunningPlan } from '@/types/plan';
import type { WorkoutOverride } from '@/types/workoutOverride';
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon } from '@/utils/experimentalCurrentPerformance';
import { estimateHrEnhancedHalfMarathon } from '@/utils/hrEnhancedPerformance';
import { buildRaceEvidence } from '@/utils/racePerformance';
import { computeCurrentFitness, HYBRID_TARGETS_VERSION } from '@/utils/performance/hybridCurrentFitness';
import { estimateHybridHalfMarathonV11, HYBRID_V11_VERSION, type HybridV11Options } from '@/utils/performance/hybridPerformanceV11';
import { estimateHybridHalfMarathon } from '@/utils/performance/hybridPerformance';
import { estimateRaceDayForecast, FORECAST_V2_VERSION } from '@/utils/performance/raceDayForecast';
import { treatConfirmedRacesAsMaximal } from '@/utils/performance/confirmedRaceAssumption';
import { formatFinishTime, formatPacePerMile } from '@/utils/performance/currentFitnessFormat';
import { digest } from './evidence';
import { VALIDATION_POLICY, VALIDATION_TIME_ZONE, type ScheduledRace } from './prediction-schedule';

export const VALIDATION_MODELS = Object.freeze({ hybrid: HYBRID_V11_VERSION, targets: HYBRID_TARGETS_VERSION,
  evidence: 'performance-evidence-v1.1', combination: 'performance-capacity-v1.1', forecast: FORECAST_V2_VERSION,
  official: CURRENT_HALF_POLICY.version, hrEnhanced: 'experimental-hr-enhanced-hm-v1', evaluation: VALIDATION_POLICY });
export interface ValidationFlags {
  assumeConfirmedRacesMaximal: boolean; strictMaximalOnly: boolean; physiology: boolean;
  hrEnhanced: boolean; forecast: boolean;
}
export const DEFAULT_VALIDATION_FLAGS: ValidationFlags = { assumeConfirmedRacesMaximal: true, strictMaximalOnly: false, physiology: true, hrEnhanced: true, forecast: true };
export function evaluationVersion(flags: ValidationFlags) { return digest({ models: VALIDATION_MODELS, flags }); }
export interface PredictionInput {
  asOf: string; workouts: HealthWorkout[]; races: Race[]; overrides: Record<string, WorkoutOverride>;
  plans: RunningPlan[]; options: Pick<HybridV11Options, 'vo2Entries' | 'streamSummaries' | 'vo2Load' | 'streamLoad'>;
}

/** Whitelist compact diagnostics: no qualification rows, workout ids, names, samples, or full records. */
function compactHybrid(e: ReturnType<typeof estimateHybridHalfMarathonV11>) {
  return {
    model: e.version, seconds: e.seconds, displayedSeconds: e.minutes === null ? null : e.minutes * 60,
    paceSecondsPerMile: e.paceSecondsPerMile, status: e.status, confidence: e.confidence,
    evidenceQuality: e.evidenceQuality, unavailableCause: e.unavailableCause, reason: e.fallbackReason,
    asOf: e.asOf, evidenceCutoff: e.asOf, dataThrough: e.dataThrough, distanceMeters: e.targetDistanceMeters,
    confidenceRestrictions: e.confidenceRestrictions ?? [], flags: e.flags, reasons: e.reasons,
    provisionalReasons: e.influence.provisionalReasons, missing: e.missing,
    diagnostics: {
      baseSeconds: e.combination.baseSeconds, independentObservations: e.combination.independentObservations,
      raceShare: e.combination.raceShare, recentShare: e.combination.recentShare,
      latestRaceDate: e.combination.latestRaceDate, latestRaceAgeDays: e.combination.latestRaceAgeDays,
      displacementSeconds: e.combination.displacementSeconds, exponent: e.combination.exponent,
      uncertaintyFraction: e.combination.uncertaintyFraction, spreadFraction: e.combination.spreadFraction,
      physiologyAdjustmentSeconds: e.influence.physiologyAdjustmentSeconds,
      enduranceAdjustmentSeconds: e.influence.enduranceAdjustmentSeconds,
      physiology: e.physiology,
      readiness: e.readiness, inputs: e.inputs, contributions: e.contributions, conflicts: e.conflicts,
      excludedInformative: e.influence.excludedInformative,
      evidenceMix: e.qualification.independent.reduce<Record<string, number>>((out, row) => {
        out[row.kind] = (out[row.kind] ?? 0) + 1; return out;
      }, {}),
      weather: { observations: e.qualification.independent.length,
        missing: e.qualification.independent.filter(row => row.weatherMissing).length },
    },
  };
}

/** Exactly the app's estimators and assumption adapter; no alternative prediction formulas. */
export function calculateValidation(input: PredictionInput, targets: readonly ScheduledRace[], flags = DEFAULT_VALIDATION_FLAGS) {
  const modelRaces = flags.assumeConfirmedRacesMaximal ? treatConfirmedRacesAsMaximal(input.races) : input.races;
  const base = { races: modelRaces, workouts: input.workouts, overrides: input.overrides, asOf: input.asOf, timeZone: VALIDATION_TIME_ZONE };
  const official = estimateCurrentHalfMarathon(base);
  // Plan Insights only calculates HR-enhanced when official v2 is available.
  const planHr = flags.hrEnhanced && official.finishMinutes !== null ? estimateHrEnhancedHalfMarathon(base, { official }) : null;
  // Personal Insights uses the complete computeCurrentFitness pipeline, including its own HR fallback.
  const options = { ...input.options, official, strictMaximalOnly: flags.strictMaximalOnly };
  const fitness = computeCurrentFitness({ ...base, assumeConfirmedRacesMaximal: false }, options);
  const hybridV1 = estimateHybridHalfMarathon(base, { official, hrEnhanced: planHr, targetDistanceMeters: 21097.5 });
  const planHybrid = estimateHybridHalfMarathonV11(base, { ...options, hrEnhanced: planHr, hybridV1, targetDistanceMeters: 21097.5 });
  const forecasts = targets.map(target => {
    const plan = input.plans.find(p => p.id === target.linkedPlanId) ?? null;
    const reason = !flags.forecast ? 'forecast_disabled' : Math.abs(target.distanceMeters - 21097.5) >= 25 ? 'forecast_half_marathon_only'
      : !plan ? 'linked_running_plan_unavailable' : null;
    const f = reason ? null : estimateRaceDayForecast(base, { ...options, hrEnhanced: planHr, hybridV1, hybrid: planHybrid, plan, raceDate: target.raceDate });
    return { raceId: target.id, raceDate: target.raceDate, distanceMeters: target.distanceMeters,
      planReference: plan ? digest([plan.id, plan.updatedAt]) : null,
      model: FORECAST_V2_VERSION, status: f?.status ?? 'unavailable', reason: reason ?? f?.withheldCause ?? null,
      seconds: f?.seconds ?? null, displayedSeconds: f?.minutes == null ? null : f.minutes * 60,
      paceSecondsPerMile: f?.paceSecondsPerMile ?? null,
      asOf: input.asOf, evidenceCutoff: input.asOf, currentCapabilitySeconds: f?.currentCapabilitySeconds ?? null,
      readiness: f?.readiness ?? null, assumptions: f?.assumptions ?? null, scenarioRange: f?.scenarioRange ?? null,
      scenarios: f?.scenarios ?? [], reasons: f?.reasons ?? [] };
  });
  // Original attestations, never the prediction-only maximal-effort assumption. Reuse existing qualification/matching rules.
  const outcomes = buildRaceEvidence({ ...base, races: input.races }).filter(e => e.eligibleForEquivalence
    && e.effort === 'maximal' && (e.status === 'verified' || e.status === 'owner_confirmed'))
    .map(e => ({ raceId: e.raceId, raceDate: e.raceDate, distanceMeters: e.distanceMeters!, actualSeconds: e.finishSeconds!,
      knownAt: input.asOf, status: e.status, timingBasis: e.timingBasis }));
  return {
    models: VALIDATION_MODELS, flags,
    currentFitness: fitness.rows.map(row => ({ ...compactHybrid(row.estimate), id: row.id,
      status: row.status, confidence: row.confidence, evidenceQuality: row.evidenceQuality,
      displayedSeconds: row.finishSeconds, displayed: formatFinishTime(row.finishSeconds),
      displayedPacePerMile: formatPacePerMile(row.paceSecondsPerMile), provisionalReasons: row.provisionalReasons,
      flags: row.flags, reason: row.reason })),
    consistency: fitness.consistency,
    planInsights: { currentHybrid: compactHybrid(planHybrid),
      official: { model: official.version, seconds: official.finishMinutes === null ? null : official.baselineSeconds! + official.adjustmentSeconds,
        displayedSeconds: official.finishMinutes === null ? null : official.finishMinutes * 60,
        paceSecondsPerMile: official.paceSecondsPerMile, status: official.status, reason: official.reason, evidenceQuality: official.evidenceQuality },
      hrEnhanced: { model: VALIDATION_MODELS.hrEnhanced, seconds: planHr?.candidateSeconds ?? null,
        displayedSeconds: planHr?.candidateMinutes == null ? null : planHr.candidateMinutes * 60,
        paceSecondsPerMile: planHr?.candidatePaceSecondsPerMile ?? null,
        status: planHr?.status ?? 'unavailable', reason: planHr ? null : flags.hrEnhanced ? 'official_v2_unavailable' : 'hr_enhanced_disabled' }, forecasts },
    outcomes,
  };
}
export type ValidationPredictions = ReturnType<typeof calculateValidation>;
