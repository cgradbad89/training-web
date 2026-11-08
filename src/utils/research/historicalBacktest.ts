/**
 * RESEARCH-ONLY historical case-study toolkit (April–September 2026 backtest). Never imported by live code (test-enforced), read-only,
 * aggregate-friendly (no workout identifiers in any returned row), and it NEVER changes an estimator, a coefficient or a stored record.
 *
 * Two reconstructions of "what could the model have known at an instant" are kept strictly apart and labelled in every row:
 *
 *  strict_historical            Only records whose own timestamps prove availability: a workout needs `endDate` AND `syncedAt` ≤ cutoff, an
 *                               override needs `updatedAt` ≤ cutoff, a race record needs `createdAt` ≤ cutoff, weather needs `fetchedAt` ≤
 *                               cutoff, and a race counts as evidence only through the production `asOfMode: "historical"` rules (a confirmation
 *                               revision with a known-then time). VO₂ and HR-stream summaries carry no availability timestamp and are therefore
 *                               withheld. A bulk back-fill (e.g. an initial device import) makes earlier workouts "unknown until the import".
 *  retrospective_reconstruction Present-day records replayed with future workouts, future races, future overrides, future confirmations and
 *                               later VO₂ excluded, but where contemporaneous availability cannot be proven. Workouts that were synced long
 *                               after they ended (a back-fill) are ASSUMED available at completion; every such assumption is counted in the
 *                               row's provenance. A row from this mode is NEVER a prediction that existed at that time.
 *
 * Race-clock counterfactuals (`raceClock`) and `excludeRaceIds` exist only so a rejected record can be examined; they are labelled
 * `counterfactual_research_only` and can never be presented as a verified result.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { Race } from "@/types/race";
import type { RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { Vo2Entry } from "../vo2History";
import { estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "../experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "../hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "../performance/hybridPerformance";
import { estimateHybridHalfMarathonV11, type HybridV11Options } from "../performance/hybridPerformanceV11";
import { estimateRaceDayForecast } from "../performance/raceDayForecast";
import { performanceLocalDate } from "../performanceEvidence";
import { buildRaceEvidence } from "../racePerformance";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "../fastestMileSegment";

export type ReplayMode = "strict_historical" | "retrospective_reconstruction";
export type RaceClockBasis = "moving_time" | "elapsed_time";

export interface BacktestSource {
  races: readonly Race[];
  workouts: readonly HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plans: readonly RunningPlan[];
  vo2: readonly Vo2Entry[];
  timeZone: string;
}

export interface AsOfOptions {
  /** Counterfactual: pretend one race's two recorded clocks agree (research only). */
  raceClock?: { raceId: string; basis: RaceClockBasis };
  /** Remove the outcome link from these races (the linked run stays an ordinary training run). */
  excludeRaceIds?: readonly string[];
  stripBestEfforts?: boolean;
  /** HYPOTHETICAL: treat stale-version best-effort summaries as current (the algorithm change between versions is not modelled). */
  relabelBestEffortsCurrent?: boolean;
  stripWeather?: boolean;
  /** Reconstruction only: also drop overrides (default keeps the ones known at the instant). */
  dropAllOverrides?: boolean;
  /** Backfill threshold (days between a workout's end and its sync) beyond which reconstruction assumes contemporaneous availability. */
  backfillAssumedAfterDays?: number;
}

export interface AsOfProvenance {
  mode: ReplayMode;
  asOf: string;
  workoutsKnown: number;
  workoutsExcludedNotEnded: number;
  /** Strict mode: ended before the cutoff but not yet synced. */
  workoutsExcludedNotSynced: number;
  /** Reconstruction mode: workouts whose real sync came later than the threshold and were assumed available at completion. */
  workoutsAvailabilityAssumed: number;
  overridesApplied: number;
  overridesDroppedLater: number;
  racesKnown: number;
  racesDroppedLater: number;
  raceLinksStripped: number;
  weatherDroppedAfterCutoff: number;
  vo2Entries: number;
  hrStreamsWithheld: boolean;
  counterfactual: string | null;
  limitations: string[];
}

export interface AsOfState {
  input: { races: Race[]; workouts: HealthWorkout[]; overrides: Record<string, WorkoutOverride>; asOf: string; timeZone: string; asOfMode?: "historical" };
  vo2Entries: Vo2Entry[];
  plans: RunningPlan[];
  provenance: AsOfProvenance;
}

const DAY_MS = 86_400_000;
export const VO2_WINDOW_DAYS = 70;
const ms = (d: Date | null | undefined) => d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
const iso = (t: number) => new Date(t).toISOString();
const LINK_FIELDS = ["actualRunId", "actualRunDate", "actualRunDistanceMiles", "actualRunDurationSeconds", "actualRunAvgPace", "result"] as const;

/** The UTC instant of `HH:MM` local time on a calendar date in an IANA zone (DST-correct, no tz library). */
export function localInstant(date: string, time: string, timeZone: string): string {
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass settles DST transitions
  return iso(t);
}

/** Build the as-of state for one instant. Pure; inputs are never mutated. */
export function buildAsOfState(source: BacktestSource, asOf: string, mode: ReplayMode, options: AsOfOptions = {}): AsOfState {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new TypeError("Invalid backtest as-of instant");
  const tz = source.timeZone, day = performanceLocalDate(asOf, tz);
  const strict = mode === "strict_historical";
  const backfillMs = (options.backfillAssumedAfterDays ?? 3) * DAY_MS;
  const limitations: string[] = [];
  let notEnded = 0, notSynced = 0, assumed = 0, weatherDropped = 0;

  const workouts: HealthWorkout[] = [];
  for (const w of source.workouts) {
    const end = ms(w.endDate), synced = ms(w.syncedAt);
    if (end === null || end > cutoff) { notEnded++; continue; }
    let availableAt = synced;
    if (!strict && (synced === null || synced - end > backfillMs)) { availableAt = end; assumed++; }
    if (availableAt === null || availableAt > cutoff) { notSynced++; continue; }
    let next: HealthWorkout = !strict && synced !== availableAt ? { ...w, syncedAt: new Date(availableAt) } : w;
    if (next.weather && Date.parse(next.weather.fetchedAt) > cutoff && strict) { next = { ...next, weather: undefined }; weatherDropped++; }
    else if (next.weather && options.stripWeather) { next = { ...next, weather: undefined }; }
    if (options.stripBestEfforts && next.bestEfforts) next = { ...next, bestEfforts: undefined };
    else if (options.relabelBestEffortsCurrent && next.bestEfforts?.computedFromRouteComplete === true && next.bestEfforts.computationVersion !== BEST_EFFORTS_COMPUTATION_VERSION) {
      next = { ...next, bestEfforts: { ...next.bestEfforts, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION } };
    }
    workouts.push(next);
  }
  const knownIds = new Set(workouts.map(w => w.workoutId));

  const overrides: Record<string, WorkoutOverride> = {};
  let applied = 0, droppedLater = 0;
  for (const [id, o] of Object.entries(source.overrides)) {
    const t = Date.parse(o.updatedAt);
    if (options.dropAllOverrides || !Number.isFinite(t) || t > cutoff || !knownIds.has(id)) { droppedLater++; continue; }
    overrides[id] = o; applied++;
  }

  const excluded = new Set(options.excludeRaceIds ?? []);
  let racesDropped = 0, linksStripped = 0;
  let races: Race[] = [];
  for (const r of source.races) {
    const created = Date.parse(r.createdAt);
    if (strict && Number.isFinite(created) && created > cutoff) { racesDropped++; continue; }
    const futureRace = r.raceDate > day;
    const linkStillUnknown = r.actualRunId && !knownIds.has(r.actualRunId);
    if (excluded.has(r.id) || futureRace || linkStillUnknown) {
      const copy: Race = { ...r }; let stripped = false;
      for (const f of LINK_FIELDS) if (copy[f] !== undefined) { delete copy[f]; stripped = true; }
      if (stripped) linksStripped++;
      // Never let a future race's performance evidence or confirmations leak backwards.
      if (futureRace || excluded.has(r.id)) { delete copy.performanceEvidence; delete copy.confirmationHistory; }
      races.push(copy);
    } else races.push(r);
  }

  let counterfactual: string | null = options.relabelBestEffortsCurrent ? "hypothetical_research_only: stale-version best-effort summaries treated as current" : null;
  const clock = options.raceClock;
  if (clock && !strict) {
    const race = races.find(r => r.id === clock.raceId && r.actualRunId);
    const idx = race ? workouts.findIndex(w => w.workoutId === race.actualRunId) : -1;
    if (race && idx >= 0) {
      const w = workouts[idx], start = ms(w.startDate)!, end = ms(w.endDate)!;
      if (clock.basis === "moving_time") {
        workouts[idx] = { ...w, endDate: new Date(start + w.durationSeconds * 1000) };
        counterfactual = `${counterfactual ? counterfactual + "; " : ""}counterfactual_research_only: the recorded moving time is treated as the finish clock (elapsed end shortened to agree)`;
      } else {
        const elapsed = (end - start) / 1000;
        workouts[idx] = { ...w, durationSeconds: elapsed };
        races = races.map(r => r.id === race.id ? { ...r, actualRunDurationSeconds: elapsed } : r);
        counterfactual = `${counterfactual ? counterfactual + "; " : ""}counterfactual_research_only: the watch elapsed time is treated as the finish clock (moving duration lengthened to agree)`;
      }
    }
  }

  const vo2Entries = strict ? [] : source.vo2.filter(e => e.date <= day && e.date >= performanceLocalDate(iso(cutoff - VO2_WINDOW_DAYS * DAY_MS), tz));
  if (strict) {
    limitations.push("VO₂ readings and HR-stream summaries carry no availability timestamp and are withheld in strict mode.");
    limitations.push("Race outcome evidence is accepted only through asOfMode 'historical' (a confirmation revision with a known-then time); none exists for unconfirmed legacy races.");
  } else {
    limitations.push("Contemporaneous availability of back-filled workouts, best-effort summaries, VO₂ readings and HR streams cannot be proven; they are assumed available at completion.");
    limitations.push("Race link fields (actual run, copied duration) have no timestamps; links are kept once the linked workout is available.");
  }
  const plans = source.plans.filter(p => Date.parse(p.createdAt ?? "") <= cutoff).map(p => ({ ...p }));
  return {
    input: { races, workouts, overrides, asOf, timeZone: tz, ...(strict ? { asOfMode: "historical" as const } : {}) },
    vo2Entries, plans,
    provenance: { mode, asOf, workoutsKnown: workouts.length, workoutsExcludedNotEnded: notEnded, workoutsExcludedNotSynced: notSynced,
      workoutsAvailabilityAssumed: assumed, overridesApplied: applied, overridesDroppedLater: droppedLater, racesKnown: races.length,
      racesDroppedLater: racesDropped, raceLinksStripped: linksStripped, weatherDroppedAfterCutoff: weatherDropped, vo2Entries: vo2Entries.length,
      hrStreamsWithheld: strict, counterfactual, limitations },
  };
}

// ─── checkpoint evaluation ───────────────────────────────────────────────────

const secondsOf = (e: CurrentHalfEstimate) => e.baselineSeconds === null || e.finishMinutes === null ? null : e.baselineSeconds + e.adjustmentSeconds;
const round = (n: number | null | undefined, k = 1) => n == null ? null : Math.round(n * 10 ** k) / 10 ** k;

export interface CheckpointOptions {
  streamSummaries?: Readonly<Record<string, HrStreamSummary>>;
  /** Race whose date is the forecast target; the plan is looked up by `linkedPlanId`. */
  forecastRaceId?: string;
  v11Options?: Partial<HybridV11Options>;
  noVo2?: boolean;
  noStreams?: boolean;
}

export interface EvidenceMix { kind: string; group: string; ageDays: number; distanceKm: number; effectiveShare: number; flags: string[] }

export interface CheckpointRow {
  asOf: string; asOfDate: string; mode: ReplayMode;
  provenance: AsOfProvenance;
  official: { status: string; seconds: number | null; anchorStatus: string | null; anchorAgeDays: number | null; anchorRejectedReasons: readonly string[]; adjustmentSeconds: number };
  hrEnhanced: { seconds: number | null };
  hybridV1: { status: string; seconds: number | null; cause: string | null };
  hybridV11: { status: string; seconds: number | null; cause: string | null; confidence: string | null; flags: readonly string[];
    raceShare: number; recentShare: number; independentObservations: number; latestRaceAgeDays: number | null; raceDominance: string;
    displacementSeconds: number | null; raceOnlySeconds: number | null; recentOnlySeconds: number | null; evidenceBaseSeconds: number | null;
    physiologyAdjustmentSeconds: number; enduranceAdjustmentSeconds: number; readiness: number | null;
    newerEvidenceDisplaced: boolean; provisional: boolean; evidence: EvidenceMix[]; missing: readonly string[]; trendClassification: string | null; trendSlopePctPer28d: number | null };
  /** Aggregate-only evidence-qualification counts: why potentially informative runs did or did not become independent evidence. */
  diagnostics: { tierCounts: Record<string, number>; excludedByReason: Record<string, number>; informativeExcluded: Record<string, number>;
    segments: { candidates: number; qualified: number }; expiredEvidence: number; ignoredByReason: Record<string, number>; runLikeKnown: number; eligibleRunsOfficial: number };
  forecast: { status: string; seconds: number | null; currentCapabilitySeconds: number | null; withheldCause: string | null; plan: string; /** The saved plan's last edit is not after the cutoff, so its state at the instant is at least not provably different. */ planStateProvable: boolean; remainingPlannedRuns: number | null; adherenceUsed: number | null } | null;
  raceEvidence: { name: string; raceDate: string; status: string; finishSeconds: number | null; durationSeconds: number | null; elapsedSeconds: number | null; timingAgreement: string;
    ageDays: number | null; stale: boolean; availableAsOf: boolean; reasons: readonly string[] }[];
}

/** Evaluate every model on one as-of state. Uses the shipped estimators exactly as the app would; nothing is tuned. */
export function evaluateCheckpoint(state: AsOfState, source: BacktestSource, options: CheckpointOptions = {}): CheckpointRow {
  const { input } = state;
  const day = performanceLocalDate(input.asOf, input.timeZone);
  const vo2Entries = options.noVo2 || state.provenance.mode === "strict_historical" ? undefined : state.vo2Entries;
  const streams = options.noStreams || state.provenance.mode === "strict_historical" ? undefined : options.streamSummaries;
  const official = estimateCurrentHalfMarathon(input);
  const hr = estimateHrEnhancedHalfMarathon(input, { official });
  const v1 = estimateHybridHalfMarathon(input, { official, hrEnhanced: hr, vo2Entries });
  const v11 = estimateHybridHalfMarathonV11(input, { official, hrEnhanced: hr, vo2Entries, streamSummaries: streams, hybridV1: v1,
    vo2Load: vo2Entries ? "loaded" : "not_requested", streamLoad: streams ? "loaded" : "not_requested", ...options.v11Options });
  const c = v11.combination, i = v11.influence;
  const race = options.forecastRaceId ? source.races.find(r => r.id === options.forecastRaceId) : undefined;
  const plan = race?.linkedPlanId ? state.plans.find(p => p.id === race.linkedPlanId) ?? null : null;
  let forecast: CheckpointRow["forecast"] = null;
  if (race && race.raceDate > day) {
    const f = estimateRaceDayForecast(input, { raceDate: race.raceDate, plan, hybrid: v11, official, hrEnhanced: hr, vo2Entries, streamSummaries: streams,
      vo2Load: vo2Entries ? "loaded" : "not_requested", streamLoad: streams ? "loaded" : "not_requested", hybridV1: v1 });
    forecast = { status: f.status, seconds: round(f.seconds), currentCapabilitySeconds: round(f.currentCapabilitySeconds), withheldCause: f.withheldCause,
      plan: plan ? "plan_present" : "no_plan_created_by_cutoff",
      planStateProvable: !!plan && Number.isFinite(Date.parse((plan as { updatedAt?: string }).updatedAt ?? "")) && Date.parse((plan as { updatedAt?: string }).updatedAt!) <= Date.parse(input.asOf),
      remainingPlannedRuns: f.plan?.remainingPlannedRuns ?? null, adherenceUsed: round(f.plan?.usedAdherence, 2) };
  }
  const evidence = buildRaceEvidence(input).filter(e => e.distanceMeters !== null && Math.abs(e.distanceMeters - 21_097.5) < 5);
  const anchor = official.anchor ?? official.historicalAnchor;
  return {
    asOf: input.asOf, asOfDate: day, mode: state.provenance.mode, provenance: state.provenance,
    official: { status: official.status, seconds: round(secondsOf(official)), anchorStatus: anchor?.status ?? null, anchorAgeDays: anchor?.ageDays ?? null,
      anchorRejectedReasons: official.anchor ? [] : (anchor?.reasons ?? []), adjustmentSeconds: round(official.adjustmentSeconds, 1) ?? 0 },
    hrEnhanced: { seconds: round(hr.candidateSeconds ?? null) },
    hybridV1: { status: v1.status, seconds: round(v1.seconds), cause: v1.unavailableCause },
    hybridV11: { status: v11.status, seconds: round(v11.seconds), cause: v11.unavailableCause, confidence: v11.confidence, flags: v11.flags,
      raceShare: round(i.raceShare, 3) ?? 0, recentShare: round(i.recentShare, 3) ?? 0, independentObservations: i.independentObservations, latestRaceAgeDays: i.latestRaceAgeDays,
      raceDominance: i.raceDominance, displacementSeconds: round(i.displacementSeconds), raceOnlySeconds: round(c.raceOnlySeconds), recentOnlySeconds: round(c.recentOnlySeconds),
      evidenceBaseSeconds: round(c.baseSeconds), physiologyAdjustmentSeconds: round(i.physiologyAdjustmentSeconds, 2) ?? 0, enduranceAdjustmentSeconds: round(i.enduranceAdjustmentSeconds, 2) ?? 0,
      readiness: round(v11.readiness?.score, 2), newerEvidenceDisplaced: i.newerEvidenceDisplacedRace, provisional: i.provisional,
      evidence: c.items.map(x => ({ kind: x.kind, group: x.group, ageDays: x.ageDays, distanceKm: round(x.sourceDistanceMeters / 1000, 2) ?? 0, effectiveShare: round(x.effectiveShare, 3) ?? 0, flags: x.flags })),
      missing: v11.missing, trendClassification: v11.physiology?.classification ?? null,
      trendSlopePctPer28d: v11.physiology?.slopePer28d == null ? null : round(v11.physiology.slopePer28d * 100, 2) },
    diagnostics: { tierCounts: { ...v11.qualification.base.counts } as Record<string, number>, excludedByReason: { ...v11.qualification.base.excludedByReason }, informativeExcluded: { ...v11.qualification.informativeExcluded },
      segments: { candidates: v11.qualification.segments.candidates, qualified: v11.qualification.segments.qualified }, expiredEvidence: v11.qualification.base.expired.length,
      ignoredByReason: c.ignored.reduce<Record<string, number>>((a, x) => ({ ...a, [x.reason]: (a[x.reason] ?? 0) + 1 }), {}),
      runLikeKnown: input.workouts.filter(w => w.isRunLike).length, eligibleRunsOfficial: official.eligibleRuns },
    forecast,
    raceEvidence: evidence.map(e => ({ name: e.name, raceDate: e.raceDate, status: e.status, finishSeconds: round(e.finishSeconds), durationSeconds: round(e.durationSeconds), elapsedSeconds: round(e.elapsedSeconds),
      timingAgreement: e.timingAgreement, ageDays: e.ageDays, stale: e.stale, availableAsOf: e.availableAsOf, reasons: e.reasons })),
  };
}

/** A deterministic one-line reason an estimate moved between two consecutive rows, from the model's own decomposition. */
export function explainChange(prev: CheckpointRow | null, row: CheckpointRow): string {
  const a = prev?.hybridV11, b = row.hybridV11;
  if (!prev || !a) return "first checkpoint";
  if (a.seconds === null && b.seconds === null) return b.cause ? `still unavailable (${b.cause})` : "still unavailable";
  if (a.seconds === null) return `became available (${a.cause ?? "previously unavailable"} resolved)`;
  if (b.seconds === null) return `became unavailable (${b.cause ?? "unknown cause"})`;
  const delta = b.seconds - a.seconds;
  if (Math.abs(delta) < 1) return "no material change";
  const parts: [string, number][] = [
    ["evidence base (new/aged performance evidence)", (b.evidenceBaseSeconds ?? 0) - (a.evidenceBaseSeconds ?? 0)],
    ["physiology trend adjustment", b.physiologyAdjustmentSeconds - a.physiologyAdjustmentSeconds],
    ["endurance-readiness adjustment", b.enduranceAdjustmentSeconds - a.enduranceAdjustmentSeconds],
  ];
  const [name] = parts.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
  const kindsNow = new Set(b.evidence.map(e => e.kind)), kindsBefore = new Set(a.evidence.map(e => e.kind));
  const added = [...kindsNow].filter(k => !kindsBefore.has(k)), removed = [...kindsBefore].filter(k => !kindsNow.has(k));
  const note = [added.length ? `new ${added.join("/")}` : "", removed.length ? `${removed.join("/")} aged out` : "", b.independentObservations !== a.independentObservations ? `observations ${a.independentObservations}→${b.independentObservations}` : ""].filter(Boolean).join("; ");
  return `${delta < 0 ? "faster" : "slower"} by ${Math.abs(Math.round(delta))} s, mainly ${name}${note ? ` (${note})` : ""}`;
}

/** Prediction error convention: predicted − actual (positive = predicted slower than occurred). */
export const predictionError = (predicted: number | null, actual: number | null): number | null => predicted === null || actual === null ? null : Math.round((predicted - actual) * 10) / 10;

export const DEFAULT_REQUIRED_QUALIFIED_OUTCOMES = 5;

/** How many of the supplied outcomes could count as independent qualified holdouts. Thresholds are never lowered here. */
export function holdoutAssessment(outcomes: { raceDate: string; qualified: boolean; reasons: string[] }[], required = DEFAULT_REQUIRED_QUALIFIED_OUTCOMES) {
  const qualified = outcomes.filter(o => o.qualified).length;
  return { candidates: outcomes.length, qualified, required, evaluable: qualified >= required,
    label: "Historical case study — insufficient independent outcomes for scientific validation.", reasons: outcomes.map(o => ({ raceDate: o.raceDate, qualified: o.qualified, reasons: o.reasons })) };
}
