/**
 * Phase 3T.3/3T.4 — experimental race-day forecast (experimental-raceday-forecast-v1).
 *
 * A SEPARATE question from current capability: "what could this athlete reasonably run on a stated future
 * date?" It starts from the hybrid current-capability estimate (never replaces it) and adds only what can be
 * defended:
 *
 *  - Planned workouts are PLANNED ACTIONS, not completed performances and not guaranteed adaptations. They never
 *    enter the performance evidence and are never converted to synthetic efforts (the legacy path turns planned
 *    easy runs into slow synthetic efforts and refits Riegel, which drifts the projection slower as easy sessions
 *    accumulate — see the unit test that demonstrates it).
 *  - No fitness gain is assumed from future training (`fitnessGainAssumed: 0`).
 *  - The only plan-dependent effect is ENDURANCE PREPARATION for the target distance: readiness is projected at the
 *    start of taper (race − 14 d) with planned distances scaled by the athlete's OWN recent plan adherence (capped
 *    at 85 %; unknown adherence → 50 %), and fed through the same bounded exponent/endurance rules as the hybrid.
 *  - Taper: both meta-analyses report STANDARDIZED mean differences in time-trial performance (2023: 14 studies,
 *    SMD −0.45; 2007: 27 studies, 2-week taper, effect 0.59 ± 0.33) — population effect sizes that cannot be
 *    converted into a personal race-time percentage. Taper is listed as context with NO numeric credit.
 *  - Weather and course: no live forecast or climatology provider is integrated and the course profile is unknown;
 *    both are stated as unknown and never invented.
 *  - Uncertainty: a symmetric capacity-drift allowance 1 %·√(days/30) (the same prior spread the hybrid uses) plus
 *    the spread of the assumption scenarios. It is an engineering allowance, NOT a calibrated interval.
 * Withheld when current capability is unavailable, endurance preparation is unknown or too low, the date is
 * invalid/past, or the horizon exceeds 270 days.
 */
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import type { ForecastScenario, HybridPerformanceEstimate, RaceDayForecast, ForecastWithheldCause } from "@/types/hybridPerformance";
import { isPerformanceDate, isPerformanceInstant, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { HALF_MARATHON_METERS } from "@/utils/racePerformance";
import { buildRaceTrainingContext } from "@/utils/raceTrainingContext";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { computeEnduranceReadiness, type ReadinessRun } from "./enduranceReadiness";
import { estimateHybridHalfMarathon } from "./hybridPerformance";
import { estimateHybridHalfMarathonV11, type HybridV11Options } from "./hybridPerformanceV11";
import type { HybridV11Estimate } from "@/types/hybridPerformanceV11";
import type { RacePerformanceInput } from "@/types/racePerformance";

export const FORECAST_VERSION = "experimental-raceday-forecast-v1" as const;
/** v2 starts from the hybrid v1.1 current-capability estimate; v1 (starting from hybrid v1) is unchanged and reproducible. */
export const FORECAST_V2_VERSION = "experimental-raceday-forecast-v2" as const;
export const FORECAST_POLICY = Object.freeze({
  version: FORECAST_VERSION,
  maximumHorizonDays: 270,
  taperLeadDays: 14,
  maximumAdherence: 0.85, unknownAdherence: 0.5, lapseFactor: 0.5,
  driftPerSqrtMonth: 0.01,
});

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
type AnyHybrid = HybridPerformanceEstimate | HybridV11Estimate;
export interface ForecastOptions extends HybridV11Options {
  raceDate: string;
  plan: RunningPlan | null;
  /** The hybrid estimate for these exact inputs, when the caller already has it. Its version selects the forecast version. */
  hybrid?: AnyHybrid;
  /** Which current-capability model the forecast starts from when `hybrid` is not supplied (default v1, unchanged). */
  model?: "v1" | "v1.1";
}
/** Ages (days) of the evidence items that carry the current-capability base. */
function evidenceAges(h: AnyHybrid): number[] {
  return h.version === "experimental-hybrid-hm-v1.1" ? h.combination.items.map(i => i.ageDays)
    : (h.capacity.methods.find(m => m.id === "C_recent_demonstrated")?.contributions ?? []).map(i => i.ageDays);
}
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const mmss = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

const CAVEATS = [
  "Experimental, provisional and not independently validated. Current capability and this race-day forecast are separate outputs.",
  "No fitness gain is assumed from planned training: planned sessions are plans, not completed performances or guaranteed adaptations.",
  "Taper is population-level context only (standardized effect sizes from meta-analyses); no personal race-time credit is applied.",
  "Weather and course conditions are unknown. No weather forecast or climatology service is integrated, and no course profile is available.",
  "The range is an engineering allowance (capacity drift plus assumption scenarios), not a calibrated statistical interval.",
];

export function plannedRunsBetween(plan: RunningPlan | null, afterDate: string, beforeDate: string): { date: string; entry: PlannedRunEntry }[] {
  if (!plan || !isPerformanceDate(plan.startDate)) return [];
  const out: { date: string; entry: PlannedRunEntry }[] = [];
  for (const week of plan.weeks) for (const entry of week.entries) {
    if (entry.runType === "rest" || entry.workoutType === "rest" || entry.workoutType === "race" || !(entry.distanceMiles > 0)) continue;
    const date = shiftPerformanceDate(plan.startDate, entry.weekIndex * 7 + entry.weekday - 1);
    if (date > afterDate && date < beforeDate) out.push({ date, entry });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.entry.id.localeCompare(b.entry.id));
}

export function estimateRaceDayForecast(input: Input, options: ForecastOptions): RaceDayForecast {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid forecast cutoff is required");
  const P = FORECAST_POLICY, target = options.targetDistanceMeters ?? HALF_MARATHON_METERS;
  const v11 = options.hybrid ? options.hybrid.version === "experimental-hybrid-hm-v1.1" : options.model === "v1.1";
  // The forecast re-evaluates the SAME estimator at each readiness scenario, so no separate race anchor can enter.
  const estimate = (extra: { readinessOverride?: number } = {}): AnyHybrid =>
    v11 ? estimateHybridHalfMarathonV11(input, { ...options, ...extra }) : estimateHybridHalfMarathon(input, { ...options, ...extra });
  const hybrid: AnyHybrid = options.hybrid ?? estimate();
  const asOfDate = hybrid.asOfDate;
  const valid = isPerformanceDate(options.raceDate);
  const daysToRace = valid ? Math.round(dayNumber(options.raceDate) - dayNumber(asOfDate)) : NaN;
  const base = {
    version: (v11 ? FORECAST_V2_VERSION : FORECAST_VERSION) as RaceDayForecast["version"], researchStatus: "experimental_provisional" as const, validated: false as const, asOf: input.asOf, asOfDate,
    raceDate: options.raceDate, daysToRace: Number.isFinite(daysToRace) ? daysToRace : 0, targetDistanceMeters: target,
    currentCapabilitySeconds: hybrid.seconds, currentCapabilityStatus: hybrid.status, currentCapabilityModel: hybrid.version, caveats: CAVEATS,
    assumptions: { plannedTrainingTreatedAs: "planned_actions_not_adaptations" as const, fitnessGainAssumed: 0 as const,
      taper: "context_only_no_numeric_credit" as const,
      weather: (daysToRace <= 10 ? "forecast_unavailable" : "climatology_unavailable") as RaceDayForecast["assumptions"]["weather"], course: "unknown" as const },
  };
  const withheld = (cause: ForecastWithheldCause, reason: string, extra: Partial<RaceDayForecast> = {}): RaceDayForecast => ({
    ...base, status: "withheld", withheldCause: cause, seconds: null, minutes: null, paceSecondsPerMile: null, scenarioRange: null,
    horizonAllowanceFraction: 0, evidenceAgeAtRaceDays: null, scenarios: [], plan: null,
    readiness: { now: hybrid.readiness?.score ?? null, projectedCompleted: null, projectedLapse: null },
    uncertainty: [reason], reasons: [reason], ...extra });

  if (!valid || daysToRace <= 0) return withheld("race_date_invalid_or_past", "The race date is missing, invalid or not in the future.");
  if (daysToRace > P.maximumHorizonDays) return withheld("horizon_too_long", `The race is ${daysToRace} days away; beyond ${P.maximumHorizonDays} days current evidence says too little about race-day condition.`);
  if (hybrid.seconds === null) {
    const endurance = hybrid.unavailableCause === "insufficient_endurance_preparation";
    return withheld(endurance ? "insufficient_endurance_basis" : "current_capability_unavailable",
      endurance ? "Current endurance preparation is too low to carry a half-marathon time, so no race-day number is projected from it."
        : `Current capability is unavailable (${hybrid.fallbackReason ?? "insufficient evidence"}); a race-day forecast cannot be built on nothing.`);
  }

  // The plan can only change endurance preparation. If that basis is unknown (fewer than four recent weeks recorded),
  // there is nothing defensible to project from, however much capacity evidence exists.
  if (hybrid.readiness?.score == null)
    return withheld("insufficient_endurance_basis", "Endurance preparation is unknown (fewer than four recent weeks with recorded runs), so a race-day projection has no basis.");

  // ── Plan and adherence (planned runs are inputs to readiness only). ──
  const overrides = input.overrides ?? {};
  const { runs } = selectResearchRuns({ ...input, overrides, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  const raceWorkoutIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const planned = plannedRunsBetween(options.plan, asOfDate, options.raceDate);
  const context = options.plan ? buildRaceTrainingContext({ workouts: input.workouts, overrides, plan: options.plan, asOf: new Date(input.asOf), timeZone: input.timeZone, targetRaceDate: options.raceDate }) : null;
  const historical = context?.planAdherence?.completionFraction ?? null;
  const used = Math.min(P.maximumAdherence, historical ?? P.unknownAdherence);
  const readinessDate = daysToRace > P.taperLeadDays ? shiftPerformanceDate(options.raceDate, -P.taperLeadDays) : asOfDate;
  const project = (fraction: number): number | null => {
    const projectedRuns: ReadinessRun[] = [...runs, ...planned.map(({ date, entry }, i) => ({ date, workout: { workoutId: `planned-${i}`, distanceMiles: entry.distanceMiles * fraction } }))];
    return computeEnduranceReadiness({ runs: projectedRuns, raceWorkoutIds, asOfDate: readinessDate, targetDistanceMeters: target }).score;
  };
  const rNow = hybrid.readiness?.score ?? null;
  const rFull = planned.length ? project(1) : rNow, rCentral = planned.length ? project(used) : rNow, rLapse = planned.length ? project(used * P.lapseFactor) : rNow;
  const at = (score: number | null) => {
    if (score === null) return null;
    return estimate({ readinessOverride: score }).seconds;
  };
  const maintained = hybrid.seconds;
  const central = at(rCentral) ?? maintained, full = at(rFull) ?? maintained, lapse = at(rLapse);
  const fraction = (s: number | null) => s === null ? 0 : s / maintained - 1;
  const noPlan = !planned.length;
  const scenarios: ForecastScenario[] = [
    { id: "current_training_maintained", label: "Current training maintained", seconds: maintained, fraction: 0, central: false,
      basis: "Today's capability and today's endurance preparation, unchanged." },
    { id: "plan_at_historical_adherence", label: "Plan at your recent adherence", seconds: noPlan ? null : central, fraction: fraction(noPlan ? null : central), central: true,
      basis: noPlan ? "No remaining planned runs before the race." : `Planned distance scaled to ${(used * 100).toFixed(0)}% (your recent plan completion, capped); the central value of this forecast.` },
    { id: "plan_completed_as_planned", label: "Plan completed as written", seconds: noPlan ? null : full, fraction: fraction(noPlan ? null : full), central: false,
      basis: noPlan ? "No remaining planned runs before the race." : `Endurance readiness at the start of taper if every remaining planned run (${planned.length}) is done. Speed is not assumed to improve.` },
    { id: "training_lapses", label: "Training lapses", seconds: noPlan ? null : lapse, fraction: fraction(noPlan ? null : lapse), central: false,
      basis: noPlan ? "No plan to lapse from." : `Only ${(used * P.lapseFactor * 100).toFixed(0)}% of planned distance is completed.` },
    { id: "population_taper_context", label: "Taper (context only)", seconds: null, fraction: 0, central: false,
      basis: "Meta-analyses (2007; 2023) report standardized time-trial effects for a ≤21-day taper with 41–60% volume reduction and unchanged intensity and frequency. They are not convertible to a personal race-time percentage, so no credit is applied." },
  ];
  const drift = P.driftPerSqrtMonth * Math.sqrt(daysToRace / 30);
  const numeric = [central, maintained, full, lapse].filter((x): x is number => x !== null);
  const candidates = [...numeric.map(x => x * (1 - drift)), ...numeric.map(x => x * (1 + drift)),
    ...(hybrid.sensitivityRange ? [hybrid.sensitivityRange.fastSeconds * (central / maintained), hybrid.sensitivityRange.slowSeconds * (central / maintained)] : [])];
  const minutes = Math.round(central / 60);
  const ages = evidenceAges(hybrid);
  const newest = ages.length ? Math.min(...ages) : null;
  const evidenceAge = newest === null ? null : newest + daysToRace;
  const uncertainty = [
    `Capacity drift allowance ±${(drift * 100).toFixed(1)}% over ${daysToRace} days (1%·√(days/30)); fitness can rise or fall over that time and nothing here predicts which.`,
    evidenceAge !== null && evidenceAge > 180 ? `The newest performance evidence will be ${evidenceAge} days old on race day (older than the 180-day currency limit), so the forecast rests on a capability that must be re-confirmed by newer efforts.` : `The newest performance evidence will be ${evidenceAge ?? "n/a"} days old on race day.`,
    `Plan adherence assumed ${(used * 100).toFixed(0)}%${historical === null ? " (no matched history; default)" : ` (your recent plan completion ${(historical * 100).toFixed(0)}%, capped at ${(P.maximumAdherence * 100).toFixed(0)}%)`}.`,
    "Weather and course are unknown; heat, hills and wind can each change a half marathon by minutes and are not modelled.",
    ...(hybrid.status === "provisional" ? ["Current capability is itself provisional (limited or contradictory evidence)."] : []),
  ];
  return { ...base, status: "provisional", withheldCause: null, seconds: central, minutes, paceSecondsPerMile: Math.round(minutes * 60 / (target / 1609.344) / 5) * 5,
    scenarioRange: { fastSeconds: Math.min(...candidates), slowSeconds: Math.max(...candidates),
      basis: `Capacity-drift allowance ±${(drift * 100).toFixed(1)}% and endurance/plan scenarios (${mmss(Math.min(...numeric))}–${mmss(Math.max(...numeric))}). Engineering allowance, not a statistical interval.` },
    horizonAllowanceFraction: drift, evidenceAgeAtRaceDays: evidenceAge,
    scenarios,
    plan: options.plan ? { remainingPlannedRuns: planned.length, remainingPlannedMiles: planned.reduce((s, p) => s + p.entry.distanceMiles, 0),
      longestPlannedRunMiles: planned.length ? Math.max(...planned.map(p => p.entry.distanceMiles)) : null, historicalAdherence: historical, usedAdherence: used } : null,
    readiness: { now: rNow, projectedCompleted: rFull, projectedLapse: rLapse },
    uncertainty, reasons: [`Starts from the hybrid current-capability estimate (${mmss(maintained)}); only endurance preparation changes with the plan.`] };
}
