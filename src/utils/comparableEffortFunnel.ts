/**
 * RESEARCH-ONLY diagnostic. Aggregated eligibility funnel for the v2 comparable-effort
 * (matched pace) evidence. Never imported by Plan Insights, Run Detail, replay, capture,
 * enrollment or AI Coach; it changes no estimator number and reads no database.
 *
 * It does not re-select anything: eligible runs come from the estimator's own selector
 * arguments (via `selectResearchRuns`), the anchor from the estimator's own output, windows
 * and tolerances from `WORKOUT_RESEARCH_POLICY`/`CURRENT_HALF_POLICY`, and the final matching
 * from the real `pairResearchRuns`. Only the PAIRWISE gates are restated here so each
 * rejection can be attributed to the first failing rule; a test uses `pairResearchRuns` as an
 * oracle so the restatement cannot drift from the live rule.
 *
 * Output is counts and rule text only: no workout IDs, coordinates, or per-run values.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RacePerformanceInput } from "@/types/racePerformance";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { estimateCurrentHalfMarathon, CURRENT_HALF_POLICY } from "./experimentalCurrentPerformance";
import { isPerformanceInstant, performanceLocalDate, shiftPerformanceDate } from "./performanceEvidence";
import { pairResearchRuns, selectResearchRuns, WORKOUT_RESEARCH_POLICY } from "./workoutRaceResearch";

export const FUNNEL_VERSION = "comparable-effort-funnel-v1";
const RECENT_DAYS = 35; // the window experimental-current-hm-v2 passes to pairResearchRuns

type Input = Pick<RacePerformanceInput, "races" | "workouts" | "overrides" | "asOf" | "timeZone">;
export type GateKind = "scientifically_motivated" | "engineering_safeguard" | "provisional_assumption";

export interface FunnelGate {
  gate: string;
  rule: string;
  kind: GateKind;
  candidates: number;
  surviving: number;
  excluded: number;
  /** Candidates whose rejection is attributable to missing data rather than a mismatch. */
  missingData: number;
  primaryReason: string;
}
export interface MarginalGate { gate: string; passes: number; of: number }
export interface ComparableEffortFunnel {
  version: typeof FUNNEL_VERSION;
  asOf: string;
  anchorDate: string | null;
  anchorExpired: boolean;
  gates: FunnelGate[];
  /** Each pairwise gate applied ALONE to every baseline×recent pair (the binding-constraint view). */
  marginal: MarginalGate[];
  matchedPairs: number;
  matchedWeeks: number;
  effectivePairs: number;
  paceWeight: number;
  verdict: string;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const monday = (date: string) => shiftPerformanceDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));
const treadmill = (w: HealthWorkout) => /treadmill|indoor/i.test(w.displayType ?? "");
const hardLabel = (w: HealthWorkout) => /tempo|interval|race|fartlek|hill repeat/i.test(w.displayType ?? "");

interface PairGate { gate: string; rule: string; kind: GateKind; missing: (x: HealthWorkout, y: HealthWorkout, asOf: string) => boolean;
  pass: (x: HealthWorkout, y: HealthWorkout, asOf: string) => boolean; reason: string }
const P = WORKOUT_RESEARCH_POLICY;
const hrOk = (w: HealthWorkout) => positive(w.avgHeartRate) && w.avgHeartRate >= 40 && w.avgHeartRate <= 220;
const weatherOk = (w: HealthWorkout, asOf: string) => !!w.weather && isPerformanceInstant(w.weather.fetchedAt) && Date.parse(w.weather.fetchedAt) <= Date.parse(asOf);
/** Order and tolerances mirror `comparableContext` (workoutRaceResearch.ts). */
const PAIR_GATES: PairGate[] = [
  { gate: "Valid HR", rule: "both runs have average HR in 40–220 bpm", kind: "engineering_safeguard",
    missing: (x, y) => !positive(x.avgHeartRate) || !positive(y.avgHeartRate), pass: (x, y) => hrOk(x) && hrOk(y), reason: "average HR missing or implausible" },
  { gate: "HR match", rule: `average HR within ${P.maximumHeartRateDifference} bpm`, kind: "provisional_assumption",
    missing: () => false, pass: (x, y) => hrOk(x) && hrOk(y) && Math.abs(x.avgHeartRate! - y.avgHeartRate!) <= P.maximumHeartRateDifference, reason: "average HR differs by more than the tolerance" },
  { gate: "Duration match", rule: `durations within ${P.maximumDurationRatioDifference * 100}%`, kind: "provisional_assumption",
    missing: () => false, pass: (x, y) => Math.abs(x.durationSeconds / y.durationSeconds - 1) <= P.maximumDurationRatioDifference, reason: "durations differ by more than the tolerance" },
  { gate: "Clock consistency", rule: "elapsed time within max(60 s, 1%) of recorded duration", kind: "engineering_safeguard",
    missing: () => false, reason: "elapsed and recorded duration disagree (paused/edited)",
    pass: (x, y) => [x, y].every(w => Math.abs((w.endDate.getTime() - w.startDate.getTime()) / 1000 - w.durationSeconds) <= Math.max(60, w.durationSeconds * 0.01)) },
  { gate: "Outdoor", rule: "neither run is treadmill/indoor", kind: "engineering_safeguard",
    missing: () => false, pass: (x, y) => !treadmill(x) && !treadmill(y), reason: "indoor pace/incline is not measured by these parents" },
  { gate: "Same route", rule: "identical routeClusterId", kind: "scientifically_motivated",
    missing: (x, y) => !x.routeClusterId || !y.routeClusterId, pass: (x, y) => !!x.routeClusterId && x.routeClusterId === y.routeClusterId, reason: "no shared route cluster" },
  { gate: "Terrain match", rule: `climb known and within ${P.maximumClimbDifferenceMetersPerMile} m/mi`, kind: "scientifically_motivated",
    missing: (x, y) => !finite(x.elevationGainM) || !finite(y.elevationGainM),
    pass: (x, y) => finite(x.elevationGainM) && finite(y.elevationGainM) && Math.abs(x.elevationGainM / x.distanceMiles - y.elevationGainM / y.distanceMiles) <= P.maximumClimbDifferenceMetersPerMile,
    reason: "elevation missing or climb per mile differs" },
  { gate: "Weather available", rule: "both runs have weather fetched on or before the evaluation instant", kind: "engineering_safeguard",
    missing: (x, y, asOf) => !weatherOk(x, asOf) || !weatherOk(y, asOf), pass: (x, y, asOf) => weatherOk(x, asOf) && weatherOk(y, asOf), reason: "weather missing or not yet available" },
  { gate: "Weather match", rule: `temp ±${P.maximumTemperatureDifferenceF}°F, humidity ±${P.maximumHumidityDifference}%, wind ±${P.maximumWindDifferenceMph} mph`, kind: "scientifically_motivated",
    missing: (x, y) => ![x.weather?.tempF, x.weather?.humidity, x.weather?.windMph, y.weather?.tempF, y.weather?.humidity, y.weather?.windMph].every(finite),
    pass: (x, y) => [["tempF", P.maximumTemperatureDifferenceF], ["humidity", P.maximumHumidityDifference], ["windMph", P.maximumWindDifferenceMph]].every(([k, t]) => {
      const a = x.weather?.[k as "tempF"], b = y.weather?.[k as "tempF"]; return finite(a) && finite(b) && Math.abs(a - b) <= (t as number); }),
    reason: "temperature, humidity or wind differ by more than the tolerance" },
  { gate: "Same conditions", rule: "identical weather condition code", kind: "provisional_assumption",
    missing: (x, y) => !finite(x.weather?.conditionCode) || !finite(y.weather?.conditionCode),
    pass: (x, y) => finite(x.weather?.conditionCode) && finite(y.weather?.conditionCode) && x.weather!.conditionCode === y.weather!.conditionCode, reason: "different categorical weather condition" },
];

/** Index of the first failing pairwise gate, or -1 when the pair passes them all. */
export function firstFailingPairGate(baseline: HealthWorkout, recent: HealthWorkout, asOf: string): number {
  return PAIR_GATES.findIndex(g => !g.pass(baseline, recent, asOf));
}

/** Each pairwise gate applied ALONE to every baseline×recent pair. */
export function pairwiseMarginals(baseline: readonly HealthWorkout[], recent: readonly HealthWorkout[], asOf: string): MarginalGate[] {
  return PAIR_GATES.map(g => ({ gate: g.gate, of: baseline.length * recent.length,
    passes: baseline.reduce((s, b) => s + recent.filter(r => g.pass(b, r, asOf)).length, 0) }));
}

export function buildComparableEffortFunnel(input: Input): ComparableEffortFunnel {
  const estimate = estimateCurrentHalfMarathon(input);
  const date = performanceLocalDate(input.asOf, input.timeZone);
  const gates: FunnelGate[] = [];
  const gate = (g: Omit<FunnelGate, "excluded">) => gates.push({ ...g, excluded: g.candidates - g.surviving });

  const { runs } = selectResearchRuns({ ...input, overrides: input.overrides ?? {}, capturedAt: input.asOf, source: "owner_parent_export",
    complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
  gate({ gate: "Eligible runs", rule: "completed, valid, deduplicated, non-excluded runs (the estimator's own selector)", kind: "engineering_safeguard",
    candidates: new Set(input.workouts.map(w => w.workoutId)).size, surviving: runs.length, missingData: 0,
    primaryReason: "not running, excluded, invalid metrics or duplicate" });

  const anchor = estimate.anchor ?? estimate.historicalAnchor;
  const anchorExpired = !estimate.anchor && !!estimate.historicalAnchor;
  const base = { version: FUNNEL_VERSION, asOf: input.asOf, anchorDate: anchor?.raceDate ?? null, anchorExpired } as const;
  const empty = (verdict: string): ComparableEffortFunnel => ({ ...base, gates, marginal: [], matchedPairs: 0, matchedWeeks: 0, effectivePairs: 0, paceWeight: 0, verdict });
  if (!anchor) return empty("No race anchor: comparable-effort evidence is not evaluated.");
  if (anchorExpired) return empty(`Race anchor older than ${CURRENT_HALF_POLICY.maximumAnchorDays} days: the estimator does not evaluate comparable-effort evidence.`);

  const raceIds = new Set(input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : []));
  const notRace = runs.filter(r => !raceIds.has(r.workout.workoutId));
  gate({ gate: "Not a race result", rule: "race-linked runs are anchors, not training pairs", kind: "engineering_safeguard",
    candidates: runs.length, surviving: notRace.length, missingData: 0, primaryReason: "run is a recorded race result" });

  const baselineStart = shiftPerformanceDate(anchor.raceDate, -P.baselineDays);
  const recentStart = shiftPerformanceDate(date, -RECENT_DAYS + 1);
  const baselineWindow = notRace.filter(r => r.date >= baselineStart && r.date < anchor.raceDate);
  const recentWindow = notRace.filter(r => r.date >= recentStart && r.date > anchor.raceDate);
  const inEitherWindow = baselineWindow.length + recentWindow.length;
  gate({ gate: "In pairing windows", rule: `baseline: ${P.baselineDays} days before the anchor; recent: last ${RECENT_DAYS} days after it`, kind: "provisional_assumption",
    candidates: notRace.length, surviving: inEitherWindow, missingData: 0, primaryReason: "run falls outside both windows" });

  const dur = (r: ResearchRun) => r.workout.durationSeconds >= P.minimumDurationSeconds && r.workout.durationSeconds <= P.maximumDurationSeconds && !hardLabel(r.workout);
  const baseline = baselineWindow.filter(dur), recent = recentWindow.filter(dur);
  gate({ gate: "Steady 20–90 min", rule: "duration 20–90 min and not a tempo/interval/race/fartlek/hill label", kind: "provisional_assumption",
    candidates: inEitherWindow, surviving: baseline.length + recent.length, missingData: 0, primaryReason: "too short/long or labeled as a hard session" });

  let alive = baseline.flatMap(b => recent.map(r => ({ b: b.workout, r: r.workout })));
  for (const g of PAIR_GATES) {
    const next = alive.filter(p => g.pass(p.b, p.r, input.asOf));
    gate({ gate: g.gate, rule: g.rule, kind: g.kind, candidates: alive.length, surviving: next.length,
      missingData: alive.filter(p => !g.pass(p.b, p.r, input.asOf) && g.missing(p.b, p.r, input.asOf)).length, primaryReason: g.reason });
    alive = next;
  }
  const marginal = pairwiseMarginals(baseline.map(r => r.workout), recent.map(r => r.workout), input.asOf);

  const paired = pairResearchRuns(runs, anchor.raceDate, date, input.asOf, raceIds, RECENT_DAYS).pairs;
  gate({ gate: "One-to-one matching", rule: "each baseline and each recent run may be used once (closest HR/duration first)", kind: "engineering_safeguard",
    candidates: alive.length, surviving: paired.length, missingData: 0, primaryReason: "baseline or recent run already used by a closer pair" });

  const weeks = new Set(paired.map(p => monday(p.recentDate))).size;
  const ratios = paired.map(p => p.paceRatio).sort((a, b) => a - b);
  const median = ratios.length ? (ratios[Math.floor((ratios.length - 1) / 2)] + ratios[Math.floor(ratios.length / 2)]) / 2 : 0;
  const effective = paired.reduce((s, p) => s + Math.max(0, Math.min(1, (RECENT_DAYS - (Date.parse(date + "T00:00:00Z") - Date.parse(p.recentDate + "T00:00:00Z")) / 86400000) / 7)), 0);
  const enoughPairs = paired.length >= P.minimumPairs && weeks >= P.minimumRecentWeeks;
  const paceSupported = enoughPairs && median >= P.minimumMedianRatio && median <= P.maximumMedianRatio && ratios[ratios.length - 1] - ratios[0] <= P.maximumPairRatioSpread;
  const paceWeight = paceSupported ? Math.max(0, Math.min(1, (effective - 3) / 3)) : 0;
  gate({ gate: "Final confidence", rule: `≥${P.minimumPairs} pairs over ≥${P.minimumRecentWeeks} weeks, median ratio ${P.minimumMedianRatio}–${P.maximumMedianRatio}, spread ≤${P.maximumPairRatioSpread}, then >3 effective pairs`,
    kind: "provisional_assumption", candidates: paired.length, surviving: paceWeight > 0 ? paired.length : 0, missingData: 0,
    primaryReason: !enoughPairs ? "fewer than the required pairs or recent weeks" : !paceSupported ? "ratios outside the magnitude/spread screen" : "three or fewer effective pairs" });

  return { ...base, gates, marginal, matchedPairs: paired.length, matchedWeeks: weeks, effectivePairs: effective, paceWeight,
    verdict: paceWeight > 0 ? "Comparable-effort pace evidence contributes to the estimate."
      : `Comparable-effort pace evidence does not contribute (${gates.at(-1)!.primaryReason}).` };
}
