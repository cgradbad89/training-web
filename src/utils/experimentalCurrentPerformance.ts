/** Read-only, unvalidated current HM estimate. Never populate validated contracts.
 * Coefficients are conservative engineering assumptions, not fitted physiology. */
import type { RacePerformanceEvidence, RacePerformanceInput } from "@/types/racePerformance";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { buildRaceEvidence, HALF_MARATHON_METERS, researchRiegelSeconds } from "./racePerformance";
import { isPerformanceInstant, performanceLocalDate, shiftPerformanceDate } from "./performanceEvidence";
import { pairResearchRuns, selectResearchRuns, WORKOUT_RESEARCH_POLICY } from "./workoutRaceResearch";
import { buildRaceTrainingContext } from "./raceTrainingContext";

export const CURRENT_HALF_POLICY = Object.freeze({
  version: "experimental-current-hm-v1", maximumAnchorDays: 180,
  volumeCoefficient: 0.02, enduranceCoefficient: 0.005,
  maximumSummaryFraction: 0.025, maximumPaceFraction: 0.03,
  relativeDeadband: 0.15, relativeFullSignal: 0.50,
  longRunDeadbandMiles: 1, longRunFullSignalMiles: 4,
  minimumRuns: 3, minimumSummaryRuns: 6, minimumSummaryWeeks: 4,
});
const days = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const median = (v: number[]) => { const a = [...v].sort((a, b) => a - b); return a.length ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2 : 0; };
const monday = (date: string) => shiftPerformanceDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));

export interface SustainedTraining {
  weeklyMiles: number;
  runningDaysPerWeek: number;
  typicalLongestMiles: number;
  observedWeeks: number;
  sessions: number;
  startDate: string;
  endDate: string;
}
export interface CurrentHalfEstimate {
  version: typeof CURRENT_HALF_POLICY.version;
  status: "experimental" | "insufficient_evidence";
  validated: false;
  asOf: string;
  dataThrough: string | null;
  anchor: RacePerformanceEvidence | null;
  baselineSeconds: number | null;
  finishMinutes: number | null;
  paceSecondsPerMile: number | null;
  adjustmentSeconds: number;
  adjustmentMethod: "summary" | "matched_effort" | "withheld";
  evidenceQuality: "limited_provisional" | "limited_confirmed" | "insufficient";
  baselineTraining: SustainedTraining | null;
  currentTraining: SustainedTraining | null;
  training: ReturnType<typeof buildRaceTrainingContext>;
  eligibleRuns: number;
  sinceAnchor: { sessions: number; miles: number };
  contributions: { feature: string; seconds: number; explanation: string }[];
  gaps: string[];
  assumptions: string[];
  reason: string;
}

/** Robust six-week medians, averaged across seven daily offsets so a record
 * enters/leaves gradually. Today is excluded from adjustment, never from totals.
 * Baseline ends eight days before race day to remove the final taper week. */
function sustained(runs: ResearchRun[], endDate: string, afterDate?: string): SustainedTraining {
  const offsets = Array.from({ length: 7 }, (_, offset) => {
    const end = shiftPerformanceDate(endDate, -offset);
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const last = shiftPerformanceDate(end, -i * 7), first = shiftPerformanceDate(last, -6);
      if (afterDate && first <= afterDate) return null;
      const selected = runs.filter(r => r.date >= first && r.date <= last);
      return { miles: selected.reduce((s, r) => s + Math.min(r.workout.distanceMiles, HALF_MARATHON_METERS / 1609.344), 0),
        days: new Set(selected.map(r => r.date)).size,
        longest: Math.min(HALF_MARATHON_METERS / 1609.344, Math.max(0, ...selected.map(r => r.workout.distanceMiles))),
        sessions: selected.length };
    }).filter(w => w !== null).filter(w => w.sessions > 0);
    return { miles: median(weeks.map(w => w.miles)), days: median(weeks.map(w => w.days)),
      longest: median(weeks.map(w => w.longest)), observed: weeks.filter(w => w.sessions > 0).length };
  });
  const startDate = shiftPerformanceDate(endDate, -47);
  const selected = runs.filter(r => r.date >= startDate && r.date <= endDate && (!afterDate || r.date > afterDate));
  return { weeklyMiles: mean(offsets.map(o => o.miles)), runningDaysPerWeek: mean(offsets.map(o => o.days)),
    typicalLongestMiles: mean(offsets.map(o => o.longest)), observedWeeks: Math.min(...offsets.map(o => o.observed)),
    sessions: selected.length, startDate: afterDate && afterDate >= startDate ? shiftPerformanceDate(afterDate, 1) : startDate, endDate };
}

function chooseAnchor(evidence: RacePerformanceEvidence[]): RacePerformanceEvidence | null {
  const same = (e: RacePerformanceEvidence) => e.distanceMeters !== null && Math.abs(e.distanceMeters - HALF_MARATHON_METERS) <= 5;
  const eligible = evidence.filter(e => e.ageDays !== null && e.ageDays <= CURRENT_HALF_POLICY.maximumAnchorDays
    && (e.eligibleForEquivalence || (same(e) && e.status === "recorded_unverified" && e.availableAsOf
      && e.timingAgreement === "consistent" && e.timingBasis === "recorded_workout_duration"
      && !e.reasons.some(r => /invalid|mismatch|conflict|excluded|unavailable|nonmaximal/.test(r)))));
  const rank = (e: RacePerformanceEvidence) => same(e) ? e.status === "verified" ? 0 : e.status === "owner_confirmed" ? 1 : 2 : 3;
  return eligible.sort((a, b) => rank(a) - rank(b) || b.raceDate.localeCompare(a.raceDate) || a.raceId.localeCompare(b.raceId))[0] ?? null;
}

/** Only already loaded completed parents. No settings, goals or planned inputs. */
export function estimateCurrentHalfMarathon(input: Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">): CurrentHalfEstimate {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("A valid current-estimate cutoff is required");
  const date = performanceLocalDate(input.asOf, input.timeZone);
  const { runs, exclusions } = selectResearchRuns({ ...input, overrides: input.overrides ?? {}, capturedAt: input.asOf,
    source: "owner_parent_export", complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false });
  const eligibleIds = new Set(runs.map(r => r.workout.workoutId));
  const evidence = buildRaceEvidence({ ...input, workouts: input.workouts.filter(w => eligibleIds.has(w.workoutId)) });
  const anchor = chooseAnchor(evidence);
  const raceIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const trainingRuns = runs.filter(r => !raceIds.has(r.workout.workoutId)
    && r.paceSecondsPerMile >= 180 && r.paceSecondsPerMile <= 1800 && r.workout.distanceMiles <= 26.3);
  const recent = trainingRuns.filter(r => r.date >= shiftPerformanceDate(date, -55));
  const equivalentSeconds = anchor ? researchRiegelSeconds(anchor.finishSeconds!, anchor.distanceMeters!, HALF_MARATHON_METERS) : null;
  const baselineSeconds = equivalentSeconds !== null && equivalentSeconds >= 2700 && equivalentSeconds <= 21600 ? equivalentSeconds : null;
  const since = anchor ? trainingRuns.filter(r => r.date > anchor.raceDate) : [];
  const training = buildRaceTrainingContext({ workouts: runs.map(r => r.workout), asOf: new Date(input.asOf), timeZone: input.timeZone });
  const baselineTraining = anchor ? sustained(trainingRuns, shiftPerformanceDate(anchor.raceDate, -8)) : null;
  const currentTraining = anchor ? sustained(trainingRuns, shiftPerformanceDate(date, -1), anchor.raceDate) : null;
  const gaps = ["Loaded history is not certified complete; absent records do not prove inactivity."];
  if (exclusions.length) gaps.push(`${exclusions.length} supplied records were excluded or deduplicated by the completed-parent selector.`);
  if (trainingRuns.length < runs.length - runs.filter(r => raceIds.has(r.workout.workoutId)).length) gaps.push("Implausible distance/pace summaries were omitted from numerical adjustment.");
  if (anchor?.status === "recorded_unverified") gaps.push("Anchor official time and maximal effort remain unverified; consistent clocks alone do not verify a race.");
  const last = trainingRuns.at(-1)?.date ?? null;
  const daysSinceRun = last ? days(last, date) : null;
  if (daysSinceRun !== null && daysSinceRun > 14) gaps.push(`${daysSinceRun} days since the latest supplied training run. Interruption versus missing coverage is unknown; adjustment support fades, without a fitness-decay penalty.`);
  if (anchor && anchor.ageDays! > 90) gaps.push("Anchor is older than 90 days; adjustment strength fades to zero at 180 days.");
  const assumptions = [
    "Unvalidated engineering heuristic; no personalized calibration or confidence interval.",
    "Race baseline uses nominal event distance; other distances use fixed Riegel exponent 1.06.",
    "Training preparation can conservatively modify the anchor; mileage is not a direct measurement of speed.",
    "Summary formula: −support × [0.02 × (0.75 × volume signal + 0.25 × frequency signal) + 0.005 × endurance signal], bounded ±2.5%. Relative signals have a 15% deadband and reach full strength after another 50%; endurance has a 1-mile deadband and another 4 miles to full strength.",
    "Support scales by the lesser of one, days since anchor / 56, and current sessions / 12; fades for anchors 90–180 days old and for last supplied runs 14–42 days old. Unobserved weeks are omitted, never treated as inactivity.",
    "Six-week medians averaged across seven daily offsets suppress single-run and rolling-boundary noise; final pre-race taper week is omitted.",
    "Goals and planned/future workouts never enter this current estimate; future race-day forecasts remain disabled.",
  ];
  const contributions: CurrentHalfEstimate["contributions"] = [];
  let fraction = 0, adjustmentMethod: CurrentHalfEstimate["adjustmentMethod"] = "withheld";
  const enough = recent.length >= CURRENT_HALF_POLICY.minimumRuns && new Set(recent.map(r => monday(r.date))).size >= 2;
  let reason = !anchor ? "No usable race anchor within 180 days; timing conflicts, exclusions and unconfirmed effort limits remain authoritative."
    : baselineSeconds === null ? "Race-equivalent time is outside this experiment’s 45-minute to six-hour numerical domain."
    : !enough ? "At least three completed training runs across two recent weeks are required for a current estimate."
    : "Training evidence does not support a sustained numerical change; retain the race-equivalent baseline.";
  if (anchor && enough && baselineSeconds !== null) {
    const paired = pairResearchRuns(runs, anchor.raceDate, date, input.asOf, raceIds, 35).pairs;
    const ratios = paired.map(p => p.paceRatio), ratio = median(ratios);
    const paceSupported = ratios.length >= WORKOUT_RESEARCH_POLICY.minimumPairs
      && new Set(paired.map(p => monday(p.recentDate))).size >= WORKOUT_RESEARCH_POLICY.minimumRecentWeeks
      && ratio >= 0.85 && ratio <= 1.15 && Math.max(...ratios) - Math.min(...ratios) <= 0.10;
    const freshness = clamp((180 - anchor.ageDays!) / 90, 0, 1) * (daysSinceRun === null ? 0 : clamp((42 - daysSinceRun) / 28, 0, 1));
    const b = baselineTraining!, c = currentTraining!;
    const reliable = [b, c].every(s => s.sessions >= CURRENT_HALF_POLICY.minimumSummaryRuns && s.observedWeeks >= CURRENT_HALF_POLICY.minimumSummaryWeeks
      && s.weeklyMiles > 0 && s.runningDaysPerWeek > 0);
    if (reliable) {
      const signal = (relative: number) => Math.sign(relative) * clamp((Math.abs(relative) - CURRENT_HALF_POLICY.relativeDeadband) / CURRENT_HALF_POLICY.relativeFullSignal, 0, 1);
      const volume = signal(c.weeklyMiles / b.weeklyMiles - 1), frequency = signal(c.runningDaysPerWeek / b.runningDaysPerWeek - 1);
      const preparation = 0.75 * volume + 0.25 * frequency;
      const deltaLong = c.typicalLongestMiles - b.typicalLongestMiles;
      let endurance = Math.sign(deltaLong) * clamp((Math.abs(deltaLong) - 1) / 4, 0, 1);
      // Longer runs alone do not earn a speed credit while other training declines.
      if (endurance > 0 && (c.weeklyMiles < b.weeklyMiles * 0.85 || c.runningDaysPerWeek < b.runningDaysPerWeek * 0.85)) endurance = 0;
      const support = Math.min(1, days(anchor.raceDate, date) / 56, c.sessions / 12) * freshness;
      const preparationFraction = -CURRENT_HALF_POLICY.volumeCoefficient * preparation * support;
      const enduranceFraction = -CURRENT_HALF_POLICY.enduranceCoefficient * endurance * support;
      fraction = clamp(preparationFraction + enduranceFraction, -CURRENT_HALF_POLICY.maximumSummaryFraction, CURRENT_HALF_POLICY.maximumSummaryFraction);
      adjustmentMethod = "summary";
      reason = fraction === 0 ? "Sustained training remains inside the summary deadbands; no numerical change is justified."
        : `Sustained ${fraction < 0 ? "stronger" : "reduced"} preparation relative to the pre-race baseline supports a small heuristic ${fraction < 0 ? "improvement" : "slowdown"}.`;
      contributions.push({ feature: "Volume and frequency", seconds: baselineSeconds * preparationFraction,
        explanation: `Robust weekly mileage ${b.weeklyMiles.toFixed(1)} → ${c.weeklyMiles.toFixed(1)} mi; run days ${b.runningDaysPerWeek.toFixed(1)} → ${c.runningDaysPerWeek.toFixed(1)}. 75/25 blend, 15% deadband, 2% maximum before support scaling.` },
      { feature: "Endurance preparation", seconds: baselineSeconds * enduranceFraction,
        explanation: `Typical weekly longest run ${b.typicalLongestMiles.toFixed(1)} → ${c.typicalLongestMiles.toFixed(1)} mi. One-mile deadband; at most 0.5% before support scaling; isolated longest-run outliers earn no credit.` });
    } else gaps.push("Summary adjustment withheld: each period needs at least six runs and four observed weeks; empty weeks cannot establish inactivity. Final taper week is excluded from the baseline.");
    const effectivePairs = paired.reduce((sum, p) => sum + clamp((35 - days(p.recentDate, date)) / 7, 0, 1), 0);
    const paceWeight = paceSupported ? clamp((effectivePairs - 3) / 3, 0, 1) : 0;
    if (paceWeight > 0) {
      const paceFraction = clamp((ratio - 1) * 0.5, -CURRENT_HALF_POLICY.maximumPaceFraction, CURRENT_HALF_POLICY.maximumPaceFraction) * freshness;
      fraction = fraction * (1 - paceWeight) + paceFraction * paceWeight;
      for (const contribution of contributions) {
        contribution.seconds *= 1 - paceWeight;
        contribution.explanation += ` Summary weight ${((1 - paceWeight) * 100).toFixed(0)}%; comparable-effort evidence supplies the remainder.`;
      }
      adjustmentMethod = "matched_effort";
      reason = "Comparable-effort pace evidence progressively replaces the summary adjustment; correlated signals are not added.";
      assumptions.push("Half of the accepted median pace contrast transfers to HM time, capped at ±3%; this transfer remains unvalidated. Pace weight rises from zero at three effective pairs to full strength at six; pairs fade over days 28–35.");
      contributions.push({ feature: "Comparable-effort pace", seconds: baselineSeconds * paceFraction * paceWeight,
        explanation: `${paired.length} independent context-matched pairs; median pace contrast ${((ratio - 1) * 100).toFixed(1)}%; weight ${(paceWeight * 100).toFixed(0)}%. HR, route, terrain, duration and weather screens apply.` });
    } else gaps.push("No sufficiently supported multiweek comparable-effort pace contrast; missing HR/route/weather does not exclude valid summary training.");
  }
  if (!contributions.length) contributions.push({ feature: "Training adjustment withheld", seconds: 0,
    explanation: "Insufficient sustained or comparable-effort evidence; use zero adjustment rather than inventing speed or inactivity." });
  const available = anchor !== null && enough && baselineSeconds !== null;
  const finishMinutes = available ? Math.round(baselineSeconds * (1 + fraction) / 60) : null;
  return { version: CURRENT_HALF_POLICY.version, status: available ? "experimental" : "insufficient_evidence", validated: false,
    asOf: input.asOf, dataThrough: runs.at(-1)?.date ?? null, anchor, baselineSeconds, finishMinutes,
    paceSecondsPerMile: finishMinutes === null ? null : Math.round(finishMinutes * 60 / (HALF_MARATHON_METERS / 1609.344) / 5) * 5,
    adjustmentSeconds: available ? baselineSeconds * fraction || 0 : 0, adjustmentMethod, evidenceQuality: !anchor ? "insufficient" : anchor.status === "recorded_unverified" ? "limited_provisional" : "limited_confirmed",
    baselineTraining, currentTraining, training, eligibleRuns: runs.length,
    sinceAnchor: { sessions: since.length, miles: since.reduce((s, r) => s + r.workout.distanceMiles, 0) },
    contributions, gaps, assumptions, reason };
}
