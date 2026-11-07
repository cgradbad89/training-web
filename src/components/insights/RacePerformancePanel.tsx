"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RaceEvidenceStatus } from "@/types/racePerformance";
import type { AppDataResolution } from "@/contexts/AppDataContext";
import { evaluateRacePerformance, nominalRaceDistanceMeters } from "@/utils/racePerformance";
import { buildRaceTrainingContext } from "@/utils/raceTrainingContext";
import { formatRaceTime } from "@/utils/riegelFit";
import { isExperimentalCurrentEstimateEnabled, isExperimentalHrEnhancedEstimateEnabled, isExperimentalHybridEstimateEnabled, isExperimentalHybridV11Enabled, isExperimentalRaceDayForecastEnabled } from "@/lib/racePerformanceGate";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { HrEnhancedEstimateRow } from "./HrEnhancedEstimateRow";
import { HybridEstimateRow } from "./HybridEstimateRow";
import { HybridV11EstimateRow } from "./HybridV11EstimateRow";
import type { PhysiologyEvidence } from "@/hooks/usePhysiologyEvidence";
import { estimateHybridHalfMarathonV11, type LoadState } from "@/utils/performance/hybridPerformanceV11";
import { RaceDayForecastRow } from "./RaceDayForecastRow";
import { estimateHybridHalfMarathon } from "@/utils/performance/hybridPerformance";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import type { Vo2Entry } from "@/utils/vo2History";
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { researchRaceCutoff, WORKOUT_RESEARCH_POLICY } from "@/utils/workoutRaceResearch";
import { daysUntil, parseLocalDate } from "@/utils/dates";
import { EstimateDetailsButton, InsightsDialog } from "./EstimateDetailsDialog";

type Source = "workouts" | "overrides" | "races" | "plans";
export type RacePerformanceSources = Record<Source, { hasLoaded: boolean; resolution: AppDataResolution }>;
const SOURCE_LABEL: Record<Source, string> = {
  workouts: "workouts", overrides: "workout overrides", races: "race records", plans: "plans",
};
const PERFORMANCE_SOURCES: Source[] = ["races", "workouts", "overrides"];
const TRAINING_SOURCES: Source[] = ["workouts", "overrides"];
const PLAN_SOURCES: Source[] = ["plans", "races"];

/** Unread sources are never evidence of absence. Cached success is usable for
 * this read-only display; the latest request's error remains visible. */
function SourceUnavailable({ sources, required }: { sources: RacePerformanceSources; required: Source[] }) {
  const missing = required.filter(source => !sources[source].hasLoaded);
  const failed = missing.filter(source => sources[source].resolution === "error");
  return <p role={failed.length ? "alert" : "status"} className="text-sm text-textSecondary">
    {failed.length
      ? `${failed.map(source => SOURCE_LABEL[source]).join(", ")} could not be loaded. Reload to retry.`
      : `Loading ${missing.map(source => SOURCE_LABEL[source]).join(", ")}…`}
  </p>;
}

function FreshnessNotice({ sources }: { sources: RacePerformanceSources }) {
  const resident = (Object.keys(sources) as Source[]).filter(source => sources[source].hasLoaded);
  const failed = resident.filter(source => sources[source].resolution === "error");
  const refreshing = resident.filter(source => sources[source].resolution === "loading");
  if (!failed.length && !refreshing.length) return null;
  return <div role="status" className="text-sm text-textSecondary space-y-1">
    {failed.length > 0 && <p>Showing previously loaded {failed.map(source => SOURCE_LABEL[source]).join(", ")}. Refresh failed; this information may be out of date. Reload to retry.</p>}
    {refreshing.length > 0 && <p>Refreshing {refreshing.map(source => SOURCE_LABEL[source]).join(", ")}. Showing previously loaded information.</p>}
  </div>;
}

const STATUS_LABEL: Record<RaceEvidenceStatus, string> = {
  verified: "Verified",
  owner_confirmed: "Owner-confirmed",
  recorded_unverified: "Recorded, unverified",
  inconsistent: "Inconsistent",
  insufficient_evidence: "Insufficient evidence",
};

const REASON_LABEL: Record<string, string> = {
  conflicting_race_records: "Conflicting copies of this race record need review.",
  invalid_race_date: "The race date is missing or invalid.",
  invalid_race_distance: "The race distance is missing or invalid.",
  race_record_not_available_as_of: "The race record was added after this evidence cutoff.",
  confirmation_not_available_as_of: "Confirmation was supplied after this evidence cutoff.",
  unknown_confirmation_revision_time: "The confirmation date is unknown.",
  unversioned_race_metadata: "The race record has no known-then revision history.",
  invalid_confirmation: "Confirmation is incomplete or invalid.",
  invalid_confirmation_history: "Confirmation history is incomplete or invalid; no revision can be trusted.",
  confirmation_chronology_untrusted: "This owner-editable confirmation history cannot establish what was known before a past race; historical prediction is withheld.",
  confirmation_workout_identity_mismatch: "The confirmation no longer matches the linked workout. Review the race link and save a correction.",
  confirmation_observations_changed: "The race or workout observations changed after confirmation. Review them and save a new evidence revision.",
  confirmation_race_identity_mismatch: "The confirmed event date or distance disagrees with the race record.",
  conflicting_workout_records: "Conflicting workout summaries need review.",
  workout_linked_to_multiple_races: "The same workout is linked to multiple races.",
  override_identity_mismatch: "The workout override does not match the linked workout.",
  linked_workout_excluded: "The linked workout is excluded.",
  linked_workout_unavailable: "The linked workout is outside the loaded history or missing.",
  workout_not_available_as_of: "The workout or its correction was unavailable at the evidence cutoff.",
  race_workout_date_or_type_mismatch: "The linked workout date or activity type does not match this race.",
  race_workout_distance_mismatch: "The recorded workout distance does not match this race.",
  missing_valid_workout_timing: "Valid workout duration and elapsed timing are required.",
  duration_elapsed_discrepancy: "Recorded duration and elapsed time require reconciliation.",
  copied_workout_duration_discrepancy: "The race’s copied duration disagrees with the workout summary.",
  result_workout_timing_discrepancy: "The entered result disagrees with workout timing.",
  official_result_and_effort_unverified: "Official time and effort remain unverified.",
  nonmaximal_effort: "This effort was not maximal and cannot support a race equivalent.",
  maximal_effort_not_confirmed: "Maximal effort has not been confirmed.",
  conditions_not_confirmed: "Race conditions have not been confirmed.",
  historical_benchmark_not_current_capability: "This older performance does not establish today’s capability.",
};

function dateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Date unavailable";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** Round the magnitude symmetrically. Keep a small nonzero adjustment visible. */
function adjustmentLabel(seconds: number, decimals = 0): string {
  const sign = seconds < 0 ? "−" : seconds > 0 ? "+" : "";
  const magnitude = Math.abs(seconds);
  const minutes = (magnitude / 60).toFixed(decimals);
  if (seconds !== 0 && Number(minutes) === 0) {
    return magnitude < 0.01 ? `${sign}<0.01 s` : `${sign}${magnitude.toFixed(magnitude < 1 ? 2 : 1)} s`;
  }
  return `${sign}${minutes} min`;
}

const SUMMARY_REASON = {
  not_evaluated: "Summary adjustment was not evaluated.",
  insufficient_coverage: "Insufficient eligible comparison history. Each period needs six runs and four observed weeks at every smoothing offset.",
  inside_deadbands: "Sustained training remains inside the summary deadbands. No meaningful change was detected.",
  offsetting_signals: "The supported training signals offset each other.",
  attenuated_to_zero: "Freshness or support reduced the summary adjustment to zero.",
  supported: "Sustained preparation supports a summary adjustment.",
} satisfies Record<CurrentHalfEstimate["diagnostics"]["summary"], string>;

const MATCHED_REASON = {
  not_evaluated: "Comparable-effort matching was not evaluated.",
  insufficient_pairs_or_weeks: `Too few qualifying comparable-effort pairs across separate weeks. A pair needs one run before and one after the race with average heart rate within ${WORKOUT_RESEARCH_POLICY.maximumHeartRateDifference} bpm, duration within ${Math.round(WORKOUT_RESEARCH_POLICY.maximumDurationRatioDifference * 100)}%, and the same route, terrain and weather. Without enough pairs this evidence is not used, so it has no effect on the estimate.`,
  inconsistent_ratios: "Matched paces disagree beyond the permitted magnitude or spread.",
  insufficient_effective_pairs: "Too few effective pairs after the age weights to change the estimate.",
  supported: "Qualifying pairs contribute to the training adjustment.",
} satisfies Record<CurrentHalfEstimate["diagnostics"]["matched"], string>;

function anchorLifecycle(current: CurrentHalfEstimate): string | null {
  const age = current.historicalAnchor?.ageDays;
  if (age == null) return null;
  const daysLeft = CURRENT_HALF_POLICY.maximumAnchorDays - age;
  if (daysLeft < 0) return "This dated benchmark is outside the 180-day current-estimate window.";
  if (daysLeft === 0) return "This is the anchor’s last eligible day. Its training adjustment has faded to zero.";
  if (daysLeft <= 7) return `This anchor reaches its final eligible day in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}.`;
  return null;
}

function adjustmentReason(current: CurrentHalfEstimate): string {
  if (current.finishMinutes === null) return current.reason;
  const { summary, freshness } = current.diagnostics;
  if (current.adjustmentSeconds === 0) {
    if (freshness === 0) return "Freshness support is zero. The estimate uses the unadjusted race baseline.";
    if (current.adjustmentMethod === "matched_effort") return "The blended signals produce no net adjustment to the race baseline.";
    if (summary === "insufficient_coverage") {
      const month = new Date(`${current.anchor!.raceDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
      return `Not enough sustained evidence to adjust your ${month} race baseline.`;
    }
    return SUMMARY_REASON[summary];
  }
  const features = current.contributions.filter(c => c.seconds !== 0).map(c => c.feature.toLowerCase());
  const reason = `${current.adjustmentMethod === "summary" ? "Sustained " : ""}${features.join(" and ")} evidence contributes to this experimental adjustment.`;
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return current.finishMinutes === Math.round(current.baselineSeconds! / 60)
    ? `The adjustment leaves the displayed finish minute unchanged. ${text}` : text;
}

/** Advance local-day policies even in an open tab. This clock does no data IO. */
export function useEstimateDay(fixed: boolean, timeZone: string): string | null {
  const [day, setDay] = useState(() => fixed ? null : performanceLocalDate(new Date().toISOString(), timeZone));
  useEffect(() => {
    if (fixed) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const now = new Date();
      const localDay = performanceLocalDate(now.toISOString(), timeZone);
      const nextMidnight = Date.parse(researchRaceCutoff(shiftPerformanceDate(localDay, 1), timeZone)) + 1;
      timer = setTimeout(() => {
        setDay(performanceLocalDate(new Date().toISOString(), timeZone));
        schedule();
      }, Math.max(1, nextMidnight - now.getTime()));
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      setDay(performanceLocalDate(new Date().toISOString(), timeZone));
      schedule();
    };
    // A fixed snapshot needs no clock. A resumed tab catches a throttled timer.
    schedule();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [fixed, timeZone]);
  return day;
}

function Section({ title, children, compact = false }: { title: string; children: React.ReactNode; compact?: boolean }) {
  return <section className={`min-w-0 break-words bg-card rounded-2xl border border-border ${compact ? "p-4 sm:p-5 space-y-3" : "p-5 space-y-4"}`}>
    <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    {children}
  </section>;
}

function StandaloneEstimateDetails({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <EstimateDetailsButton buttonRef={trigger} open={open} onClick={() => setOpen(true)} />
    {open && <InsightsDialog title="Estimate Details" testId="estimate-details" returnFocusRef={trigger} onClose={() => setOpen(false)}>
      {children}
    </InsightsDialog>}
  </>;
}

export interface RacePerformancePanelProps {
  races: Race[];
  workouts: HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plan: RunningPlan | null;
  selectedRace: Race | null;
  sources: RacePerformanceSources;
  /** Explicit clock and zone make previews/tests reproducible. */
  asOf?: Date;
  timeZone?: string;
  /** Optional compact saved-evidence hint for the tile (supplied by the page). */
  evidenceNotice?: React.ReactNode;
  /** Saved Performance Evidence section for the details modal. The panel never
   * acquires evidence itself; the page passes the shared-provider view. */
  evidenceDetails?: React.ReactNode;
  /** Optional, already-loaded VO₂ max readings for corroboration only. The panel never fetches them. */
  vo2Entries?: readonly Vo2Entry[];
  /** Bounded, session-scoped VO₂ max and HR-stream evidence acquired by the page (hook). The panel never fetches it. Overrides `vo2Entries`. */
  physiology?: PhysiologyEvidence;
  /** Optional tile actions supplied by the authenticated Plan Insights page. */
  renderActions?: (estimateDetails: React.ReactNode) => React.ReactNode;
}

/** Summary-only view. The local-day timer never acquires evidence. */
export function RacePerformancePanel(props: RacePerformancePanelProps) {
  const { races, workouts, overrides, plan, selectedRace, sources } = props;
  const detailsId = useId();
  const performanceReady = PERFORMANCE_SOURCES.every(source => sources[source].hasLoaded);
  const trainingReady = TRAINING_SOURCES.every(source => sources[source].hasLoaded);
  const planReady = PLAN_SOURCES.every(source => sources[source].hasLoaded);
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = useEstimateDay(props.asOf !== undefined, timeZone);
  // Relevant source publications use a fresh cutoff. Render-only state reuses it.
  const asOfIso = useMemo(() => props.asOf?.toISOString() ?? new Date().toISOString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- These changes intentionally refresh the captured clock.
    [props.asOf, races, workouts, overrides, performanceReady, day, timeZone]);
  const targetDistanceMeters = selectedRace ? nominalRaceDistanceMeters(selectedRace) ?? 21097.5 : 21097.5;
  // The declared product goal supplies an empty-account outlook, never a race result.
  const targetRace = selectedRace ?? races.find(r => r.raceDate === "2027-03-20" && r.raceDistance === "halfMarathon") ?? null;
  const targetDate = targetRace?.raceDate ?? "2027-03-20";
  const performance = useMemo(() => performanceReady ? evaluateRacePerformance({
    races, workouts, overrides, asOf: asOfIso, timeZone, targetDistanceMeters,
  }) : null, [performanceReady, races, workouts, overrides, asOfIso, timeZone, targetDistanceMeters]);
  const training = useMemo(() => trainingReady ? buildRaceTrainingContext({
    workouts, overrides, plan: planReady ? plan : null, asOf: new Date(asOfIso), targetRaceDate: targetDate, timeZone,
  }) : null, [trainingReady, planReady, workouts, overrides, plan, asOfIso, targetDate, timeZone]);
  const currentEnabled = isExperimentalCurrentEstimateEnabled();
  const current = useMemo(() => currentEnabled && performanceReady ? estimateCurrentHalfMarathon({
    races, workouts, overrides, asOf: asOfIso, timeZone,
  }) : null, [currentEnabled, performanceReady, races, workouts, overrides, asOfIso, timeZone]);
  // Same official result is reused (never recomputed differently) so both rows share anchor, cutoff and inputs.
  const hrEnabled = currentEnabled && isExperimentalHrEnhancedEstimateEnabled();
  const hrEnhanced = useMemo(() => hrEnabled && current && current.finishMinutes !== null
    ? estimateHrEnhancedHalfMarathon({ races, workouts, overrides, asOf: asOfIso, timeZone }, { official: current }) : null,
  [hrEnabled, current, races, workouts, overrides, asOfIso, timeZone]);
  // Independent of v2 availability: the hybrid can answer when the race anchor has expired. Never edits v2/HR results.
  const hybridEnabled = currentEnabled && isExperimentalHybridEstimateEnabled();
  const v11Enabled = hybridEnabled && isExperimentalHybridV11Enabled();
  const physiology = props.physiology;
  const vo2Entries = physiology ? physiology.vo2.entries : props.vo2Entries;
  const vo2Load: LoadState = physiology ? (physiology.vo2.state === "loaded" || physiology.vo2.state === "failed" ? physiology.vo2.state : "not_requested") : props.vo2Entries ? "loaded" : "not_requested";
  const streamSummaries = physiology?.streams.summaries;
  const streamLoad: LoadState = physiology ? (physiology.streams.state === "loaded" || physiology.streams.state === "failed" ? physiology.streams.state : "not_requested") : "not_requested";
  const physiologyLoading = !!physiology && (physiology.vo2.state === "loading" || physiology.streams.state === "loading");
  const hybrid = useMemo(() => hybridEnabled && performanceReady ? estimateHybridHalfMarathon({ races, workouts, overrides, asOf: asOfIso, timeZone },
    { official: current, hrEnhanced, vo2Entries: props.vo2Entries, targetDistanceMeters: 21097.5 }) : null,
  [hybridEnabled, performanceReady, races, workouts, overrides, asOfIso, timeZone, current, hrEnhanced, props.vo2Entries]);
  // v1.1 reuses the same official/HR-enhanced results (never recomputed differently) and keeps v1 only for the comparison line.
  const hybridV11 = useMemo(() => v11Enabled && performanceReady ? estimateHybridHalfMarathonV11({ races, workouts, overrides, asOf: asOfIso, timeZone },
    { official: current, hrEnhanced, vo2Entries, streamSummaries, vo2Load, streamLoad, hybridV1: hybrid, targetDistanceMeters: 21097.5 }) : null,
  [v11Enabled, performanceReady, races, workouts, overrides, asOfIso, timeZone, current, hrEnhanced, vo2Entries, streamSummaries, vo2Load, streamLoad, hybrid]);
  const forecastEnabled = hybridEnabled && isExperimentalRaceDayForecastEnabled() && Math.abs(targetDistanceMeters - 21097.5) < 25;
  // The forecast starts from whichever hybrid is displayed (v1.1 → forecast v2; rollback → v1 forecast), never from a separate race anchor.
  const forecast = useMemo(() => {
    if (!forecastEnabled || !planReady) return null;
    const input = { races, workouts, overrides, asOf: asOfIso, timeZone };
    if (v11Enabled) return hybridV11 ? estimateRaceDayForecast(input, { raceDate: targetDate, plan, hybrid: hybridV11, official: current, hrEnhanced, vo2Entries, streamSummaries, vo2Load, streamLoad, hybridV1: hybrid }) : null;
    return hybrid ? estimateRaceDayForecast(input, { raceDate: targetDate, plan, hybrid, official: current, hrEnhanced, vo2Entries: props.vo2Entries }) : null;
  }, [forecastEnabled, v11Enabled, hybridV11, hybrid, planReady, races, workouts, overrides, asOfIso, timeZone, targetDate, plan, current, hrEnhanced, vo2Entries, streamSummaries, vo2Load, streamLoad, props.vo2Entries]);
  const benchmark = performance?.latestBenchmark ?? null;
  const displayedAnchor = current?.historicalAnchor ?? benchmark;
  const lifecycle = current ? anchorLifecycle(current) : null;
  const maxWeeklyMiles = Math.max(1, ...(training?.weekly ?? []).map(week => week.miles));
  const daysToTargetRace = daysUntil(targetDate, parseLocalDate(performanceLocalDate(asOfIso, timeZone)));
  const targetSeconds = targetRace?.targetPaceSecondsPerMile && targetRace.targetPaceSecondsPerMile > 0
    ? targetRace.targetPaceSecondsPerMile * (targetDistanceMeters / 1609.344) : null;

  const renderActions = props.renderActions ?? (details => details && (
    <StandaloneEstimateDetails>{details}</StandaloneEstimateDetails>
  ));

  return <div className="min-w-0 space-y-6" data-testid="race-performance-experience">
    <FreshnessNotice sources={sources} />
    <Section title="Current Performance" compact>
      {performance ? <div className="min-w-0 space-y-3" data-testid={currentEnabled ? "experimental-current-estimate" : undefined}>
        {currentEnabled ? <>
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold text-textSecondary">Current half-marathon estimate</h3>
            <span className="shrink-0 rounded-md bg-surface px-2 py-1 text-xs font-medium text-textSecondary">Experimental</span>
          </div>
          {current?.finishMinutes != null ? <>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 tabular-nums" data-testid="estimate-values">
              <p className="text-4xl sm:text-5xl font-bold tracking-tight text-textPrimary">~{Math.floor(current.finishMinutes / 60)}:{String(current.finishMinutes % 60).padStart(2, "0")}</p>
              <p className="text-lg font-semibold text-textSecondary">~{Math.floor(current.paceSecondsPerMile! / 60)}:{String(current.paceSecondsPerMile! % 60).padStart(2, "0")}<span className="text-sm font-normal">/mi</span></p>
            </div>
            <p className="text-sm text-textSecondary" data-testid="estimate-basis">Based on your {dateLabel(current.anchor!.raceDate)} race ({current.anchor!.finishSeconds != null ? `${formatRaceTime(current.anchor!.finishSeconds)}, ` : ""}{STATUS_LABEL[current.anchor!.status].toLowerCase()}) and completed training{current.adjustmentSeconds !== 0 ? ` · ${adjustmentLabel(current.adjustmentSeconds)} training adjustment` : ""}.</p>
          </> : <>
            <p className="font-semibold">Insufficient evidence</p>
            {current && <p className="text-sm text-textSecondary" data-testid="estimate-unavailable-reason">{current.reason}</p>}
            {displayedAnchor && <p className="text-sm text-textSecondary" data-testid="estimate-basis">Historical race: {displayedAnchor.finishSeconds != null ? formatRaceTime(displayedAnchor.finishSeconds) : "time unavailable"} · {dateLabel(displayedAnchor.raceDate)} · {STATUS_LABEL[displayedAnchor.status]}</p>}
          </>}
          {hrEnhanced && <HrEnhancedEstimateRow estimate={hrEnhanced} />}
          {v11Enabled ? hybridV11 && <HybridV11EstimateRow estimate={hybridV11} /> : hybrid && <HybridEstimateRow estimate={hybrid} />}
          {v11Enabled && physiologyLoading && <p role="status" className="text-xs text-textSecondary" data-testid="physiology-loading">Loading VO₂ max and heart-rate evidence; the estimate above uses whole-workout heart rate until it arrives.</p>}
          {lifecycle && <p className="text-sm text-textSecondary" data-testid="anchor-lifecycle">{lifecycle}</p>}
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-textSecondary">
            <div className="flex flex-wrap gap-x-1"><dt>Calculated as of:</dt><dd>{current ? dateLabel(performanceLocalDate(current.asOf, timeZone)) : "Unavailable"}</dd></div>
            <div className="flex flex-wrap gap-x-1"><dt>Latest included run:</dt><dd>{current?.dataThrough ? dateLabel(current.dataThrough) : "Unavailable"}</dd></div>
          </dl>
        </> : <>
          <h3 className="text-sm font-semibold text-textSecondary">Current capability estimate</h3>
          <p className="text-xl font-bold">Unavailable</p>
          <p className="text-sm text-textSecondary">An experimental current estimate is not enabled in this build.</p>
          {displayedAnchor && <p className="text-sm text-textSecondary">Historical race: {displayedAnchor.finishSeconds != null ? formatRaceTime(displayedAnchor.finishSeconds) : "time unavailable"} · {displayedAnchor.name} · {dateLabel(displayedAnchor.raceDate)} · {STATUS_LABEL[displayedAnchor.status]}</p>}
        </>}
        {!displayedAnchor && <p className="text-sm text-textSecondary">No usable race benchmark is available. Review the evidence timeline below for missing or inconsistent records.</p>}
      </div> : <SourceUnavailable sources={sources} required={PERFORMANCE_SOURCES} />}
      {props.evidenceNotice}
      {renderActions(performance ? <>
        <section aria-labelledby={`${detailsId}-methodology`} className="min-w-0 space-y-4 text-sm text-textSecondary" data-testid="estimate-methodology">
          <h3 id={`${detailsId}-methodology`} className="text-base font-bold text-textPrimary">Estimate methodology</h3>
          <dl className="border-y border-border py-3 space-y-2 text-sm" data-testid="estimate-breakdown">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-textSecondary">Historical race{displayedAnchor && <span className="block text-xs">{STATUS_LABEL[displayedAnchor.status]}{displayedAnchor.stale ? " · Older benchmark" : ""}</span>}</dt>
              <dd className="shrink-0 font-semibold tabular-nums text-textPrimary">{displayedAnchor?.finishSeconds != null ? formatRaceTime(displayedAnchor.finishSeconds) : "Unavailable"}</dd>
            </div>
            {current?.baselineSeconds != null && current.anchor?.finishSeconds !== current.baselineSeconds && <div className="flex justify-between gap-4">
              <dt className="text-textSecondary">Half-marathon equivalent</dt><dd className="shrink-0 font-semibold tabular-nums text-textPrimary">{formatRaceTime(current.baselineSeconds)}</dd>
            </div>}
            {currentEnabled && <div className="flex items-start justify-between gap-4">
              <dt className="text-textSecondary">Training adjustment</dt>
              <dd className="text-right" data-testid="training-adjustment"><span className="font-semibold tabular-nums text-textPrimary">{current?.finishMinutes != null ? adjustmentLabel(current.adjustmentSeconds) : "Unavailable"}</span>
                {current?.finishMinutes != null && current.adjustmentSeconds !== 0 && <span className="block text-xs text-textSecondary">Estimated {current.adjustmentSeconds < 0 ? "faster" : "slower"}</span>}
              </dd>
            </div>}
          </dl>
          {current && <div>
            {current.finishMinutes !== null && current.finishMinutes === Math.round(current.baselineSeconds! / 60) &&
              <h4 className="font-semibold text-textPrimary">Why hasn’t my estimate changed?</h4>}
            <p data-testid="adjustment-reason">{adjustmentReason(current)}</p>
          </div>}
          {!currentEnabled && displayedAnchor && <p>{displayedAnchor.name} · {dateLabel(displayedAnchor.raceDate)}</p>}
          {current ? <div className="space-y-3" data-testid="estimate-why">
            <div className="grid grid-cols-1 min-w-0 gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-1"><h4 className="font-semibold text-textPrimary">Race anchor</h4>
                {current.anchor ? <><p>{current.anchor.name} · {dateLabel(current.anchor.raceDate)} · {STATUS_LABEL[current.anchor.status]}{current.anchor.stale ? " · Older benchmark" : ""}.</p>
                  <p>{current.anchor.timingBasis === "confirmed_result" ? "Confirmed result time" : "Recorded time; official result and maximal effort need confirmation"}. {current.anchor.ageDays} days old.</p></> : current.historicalAnchor
                  ? <p>{current.historicalAnchor.name} · {dateLabel(current.historicalAnchor.raceDate)} · {STATUS_LABEL[current.historicalAnchor.status]}. {lifecycle}</p>
                  : <p>No usable race anchor.</p>}
                <p>Race-equivalent baseline: {current.baselineSeconds === null ? "Unavailable" : formatRaceTime(current.baselineSeconds)}.</p>
              </div>
              <div className="min-w-0 space-y-1"><h4 className="font-semibold text-textPrimary">Training evidence</h4>
                <p>{current.anchor && <>Since that race: {current.sinceAnchor.sessions} completed training runs, {current.sinceAnchor.miles.toFixed(1)} mi. </>}Recent 4 / 8 weeks: {current.training.recentFourWeeks.miles.toFixed(1)} / {(current.training.recentFourWeeks.miles + current.training.priorFourWeeks.miles).toFixed(1)} mi.</p>
                <p>{current.diagnostics.recentTrainingRuns} eligible training runs across {current.diagnostics.recentTrainingWeeks} weeks in the last 56 days.</p>
                <p>Training adjustment before rounding: {current.finishMinutes === null ? "Unavailable" : `${Number(current.adjustmentSeconds.toFixed(2))} seconds`}.</p>
                {current.baselineTraining && current.currentTraining && <p>Comparison coverage: {current.baselineTraining.sessions} runs / {current.baselineTraining.observedWeeks} weeks before the anchor, {current.currentTraining.sessions} runs / {current.currentTraining.observedWeeks} weeks after it. Week counts use the least-covered smoothing offset.</p>}
              </div>
            </div>
            <div className="space-y-2"><h4 className="font-semibold text-textPrimary">Adjustment evidence</h4>
              {current.finishMinutes !== null && <ul className="list-disc pl-5 space-y-1" data-testid="adjustment-diagnostics">
                <li>{SUMMARY_REASON[current.diagnostics.summary]}</li>
                <li>{MATCHED_REASON[current.diagnostics.matched]} Matched: {current.diagnostics.matchedPairs} pairs across {current.diagnostics.matchedWeeks} weeks ({current.diagnostics.effectivePairs.toFixed(1)} effective).</li>
                {current.diagnostics.freshness !== null && current.diagnostics.freshness < 1 &&
                  <li>Anchor and recent-run freshness retain {(current.diagnostics.freshness * 100).toFixed(0)}% of supported adjustment.</li>}
              </ul>}
              <ul className="space-y-2">{current.contributions.map(c => <li key={c.feature}><span className="font-semibold">{c.feature}: {adjustmentLabel(c.seconds, 1)}.</span> {c.explanation}</li>)}</ul>
            </div>
            <div className="space-y-2"><h4 className="font-semibold text-textPrimary">Evidence limitations</h4><ul className="list-disc pl-5 space-y-1">{current.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div>
            {Object.keys(current.diagnostics.excludedByReason).length > 0 && <details>
              <summary className="cursor-pointer py-2 font-semibold text-primary">Workout selection details</summary>
              <ul className="list-disc pl-5 space-y-1">{Object.entries(current.diagnostics.excludedByReason).map(([reason, count]) =>
                <li key={reason} className="capitalize">{reason.replaceAll("_", " ")} · {count}</li>)}</ul>
            </details>}
            <div className="space-y-1"><h4 className="font-semibold text-textPrimary">Experimental methodology</h4>
              <p>Unvalidated training adjustment. Finish time rounds to the nearest minute; pace derives from that time and rounds to five seconds per mile. The adjustment is applied before rounding the finish time. No confidence interval is supported. This estimate has not been validated for your individual accuracy.</p>
            </div>
            <details><summary className="cursor-pointer py-2 font-semibold text-primary rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Model assumptions</summary><ul className="mt-2 space-y-1">{current.assumptions.map(a => <li key={a}>{a}</li>)}</ul></details>
            {hrEnhanced && <div className="space-y-2" data-testid="hr-enhanced-methodology"><h4 className="font-semibold text-textPrimary">HR-enhanced estimate (experimental)</h4>
              <HrEnhancedEstimateRow estimate={hrEnhanced} detailed /></div>}
            {v11Enabled ? hybridV11 && <div className="space-y-2" data-testid="hybrid-methodology"><h4 className="font-semibold text-textPrimary">Hybrid Performance Model v1.1 (experimental)</h4>
              <HybridV11EstimateRow estimate={hybridV11} detailed /></div>
              : hybrid && <div className="space-y-2" data-testid="hybrid-methodology"><h4 className="font-semibold text-textPrimary">Hybrid Performance Model (experimental)</h4>
              <HybridEstimateRow estimate={hybrid} detailed /></div>}
            <p className="text-xs">Model {current.version} · Evidence quality: {current.evidenceQuality.replaceAll("_", " ")} · Calculation cutoff {current.asOf} · {timeZone}</p>
          </div> : <p>{currentEnabled ? "The experimental estimate could not be calculated from the loaded evidence." : "An experimental current estimate is not enabled in this build."}</p>}
          <div className="space-y-2"><h4 className="font-semibold text-textPrimary">How to strengthen the race evidence</h4>
            <p>Confirm the event, date, official distance, finish time, maximal effort and conditions. Reconcile any difference between recorded duration and elapsed time. Existing race links alone do not verify an official result.</p>
            <p>This read-only view displays the supplied records provisionally. No race record is changed by this view.</p>
            <Link href="/races" className="inline-block text-primary underline">Review existing race records</Link>
          </div>
        </section>
        <section aria-labelledby={`${detailsId}-evidence`} className="min-w-0 space-y-3 border-t border-border pt-5" data-testid="estimate-saved-evidence">
          <h3 id={`${detailsId}-evidence`} className="text-base font-bold text-textPrimary">Saved Performance Evidence</h3>
          {props.evidenceDetails ?? <p className="text-sm text-textSecondary">Saved performance evidence is not available in this view. Detailed manual measurements do not alter the experimental estimate.</p>}
        </section>
      </> : null)}
    </Section>

    <Section title="Training Progress">
      {training ? <>
      <p className="text-sm text-textSecondary">Completed running only. Scheduled workouts contribute no performance credit. These summaries describe the loaded history; missing records do not prove no training.</p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div><dt className="text-xs text-textSecondary">Recent 4 weeks</dt><dd className="text-2xl font-bold">{training.recentFourWeeks.miles.toFixed(1)} <span className="text-sm font-normal">mi</span></dd></div>
        <div><dt className="text-xs text-textSecondary">Prior 4 weeks</dt><dd className="text-2xl font-bold">{training.priorFourWeeks.miles.toFixed(1)} <span className="text-sm font-normal">mi</span></dd></div>
        <div><dt className="text-xs text-textSecondary">Completed sessions · 4 weeks</dt><dd className="text-2xl font-bold">{training.recentFourWeeks.sessions}</dd></div>
        <div><dt className="text-xs text-textSecondary">Longest recent run</dt><dd className="text-2xl font-bold">{training.longestRecentRun == null ? "—" : `${training.longestRecentRun.miles.toFixed(1)} mi`}</dd></div>
      </dl>
      <p className="text-sm text-textSecondary">{training.mileageChangePct == null ? "Mileage comparison unavailable without prior recorded mileage." : `Recorded mileage change: ${training.mileageChangePct > 0 ? "+" : ""}${training.mileageChangePct.toFixed(0)}% versus the prior 4 weeks.`}</p>
      {!planReady && <div className="text-sm text-textSecondary"><p>Plan context is unavailable.</p><SourceUnavailable sources={sources} required={PLAN_SOURCES} /></div>}
      <details className="min-w-0"><summary className="cursor-pointer text-sm font-semibold text-primary">Weekly training details</summary>
      <div className="overflow-x-auto mt-3">
        <table className="w-full text-sm text-left">
          <caption className="text-left text-sm font-semibold mb-3">Weekly mileage and longest run · Monday start</caption>
          <thead><tr className="border-b border-border text-textSecondary"><th scope="col" className="py-2">Week of</th><th scope="col">Completed mileage</th><th scope="col" className="text-right">Sessions</th><th scope="col" className="text-right">Longest</th></tr></thead>
          <tbody>{training.weekly.map(week => <tr key={week.startDate} className="border-b border-border/50">
            <th scope="row" className="py-2 font-normal whitespace-nowrap pr-3">{dateLabel(week.startDate)}{week.partialWeek ? " · partial" : ""}</th>
            <td className="py-2 w-1/2"><div className="flex gap-2 items-center"><span className="min-w-12 tabular-nums">{week.miles.toFixed(1)} mi</span><div className="h-2 bg-surface rounded-full flex-1" aria-hidden="true"><div className="h-2 bg-primary rounded-full" style={{ width: `${week.miles / maxWeeklyMiles * 100}%` }} /></div></div></td>
            <td className="text-right tabular-nums">{week.sessions}</td><td className="text-right tabular-nums pl-3">{week.longestRunMiles != null ? `${week.longestRunMiles.toFixed(1)} mi` : "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="grid gap-3 md:grid-cols-2 text-sm text-textSecondary">
        <p>Consistency: runs recorded in {training.consistency.weeksWithRuns} of {training.consistency.totalWeeks} completed weeks.</p>
        <p>Long runs (≥{training.longRuns.thresholdMiles} mi): {training.longRuns.recentCount} in the recent 4 weeks; {training.longRuns.priorCount} in the prior 4 weeks.</p>
        <p>{training.longRuns.progressionMiles == null ? "Long-run distance comparison unavailable without long runs in both windows." : `Longest long-run distance change: ${training.longRuns.progressionMiles > 0 ? "+" : ""}${training.longRuns.progressionMiles.toFixed(1)} mi across the two windows.`}</p>
        {planReady ? <>
          <p>Recorded faster sessions: {training.fasterSessions.count}. Intent requires a supported completed plan match.</p>
          <p>{training.planAdherence ? `Plan adherence: ${training.planAdherence.completedSessions} of ${training.planAdherence.plannedSessions} elapsed sessions matched.` : "Plan adherence unavailable without a linked training plan."}</p>
        </> : null}
      </div>
      <details className="text-sm text-textSecondary"><summary className="cursor-pointer">Recent workout durations</summary>
        <ul className="mt-2 space-y-1">{training.recentDurations.slice(0, 10).map(run => <li key={run.workoutId}>{dateLabel(run.date)} · {Math.round(run.durationSeconds / 60)} min</li>)}</ul>
        {training.recentDurations.length === 0 && <p className="mt-2">No completed runs in the recent window.</p>}
      </details>
      <p className="text-xs text-textSecondary">{training.limitations.filter(line => !currentEnabled || !line.startsWith("Training summaries describe completed recorded running;")).join(" ")}</p>
      </details>
      </> : <SourceUnavailable sources={sources} required={TRAINING_SOURCES} />}
    </Section>

    <Section title="Race-Day Outlook">
      {sources.races.hasLoaded ? <>
      <p className="font-semibold">{targetRace?.name ?? "Rock and Roll Half Marathon"}</p>
      <p className="text-sm text-textSecondary">{dateLabel(targetDate)} · {!Number.isFinite(daysToTargetRace) ? "Date unavailable" : daysToTargetRace >= 0 ? `${daysToTargetRace} days away` : `${Math.abs(daysToTargetRace)} days ago`}{!targetRace ? " · Planned goal; no matching race record selected" : ""}</p>
      <dl className="grid gap-4 md:grid-cols-3">
        <div><dt className="text-xs text-textSecondary">Owner’s target finish time</dt><dd className="font-semibold">{targetSeconds ? formatRaceTime(targetSeconds) : "Not set"}</dd></div>
        <div><dt className="text-xs text-textSecondary">Historical benchmark</dt><dd className="font-semibold">{benchmark ? `${formatRaceTime(benchmark.finishSeconds)} · ${dateLabel(benchmark.raceDate)} · ${STATUS_LABEL[benchmark.status]}` : "Unavailable"}</dd>{!performanceReady && <SourceUnavailable sources={sources} required={PERFORMANCE_SOURCES} />}</div>
        <div><dt className="text-xs text-textSecondary">Race-day forecast</dt><dd className="font-semibold" data-testid="race-day-forecast-summary">{forecast?.status === "provisional" && forecast.minutes !== null
          ? `~${Math.floor(forecast.minutes / 60)}:${String(forecast.minutes % 60).padStart(2, "0")} · provisional · experimental` : "Withheld · not validated"}</dd></div>
      </dl>
      {forecast && <RaceDayForecastRow forecast={forecast} />}
      <p className="text-sm text-textSecondary">Training progress and time remaining do not establish a finish-time improvement. Numerical scenarios and uncertainty ranges require independent chronological validation first.</p>
      </> : <SourceUnavailable sources={sources} required={["races"]} />}
    </Section>

    <Section title="Historical Performance Timeline">
      {performance ? <>
      <p className="text-sm text-textSecondary">Actual race dates and recorded evidence. Results remain separate observations, with no interpolated weeks or projected trend.</p>
      {performance.evidence.length === 0 ? <p className="text-sm text-textSecondary">No past race results are available.</p> : <ol className="space-y-3">{performance.evidence.map(evidence => <li key={evidence.raceId} className="rounded-xl bg-surface border border-border p-4 space-y-1">
        <p className="text-sm font-semibold">{evidence.name} · {dateLabel(evidence.raceDate)}</p>
        <p className="text-sm">{STATUS_LABEL[evidence.status]}{evidence.finishSeconds != null ? ` · ${formatRaceTime(evidence.finishSeconds)}` : " · No usable finish time"}{evidence.stale ? " · Older benchmark" : ""}</p>
        <p className="text-xs text-textSecondary">{evidence.timingAgreement === "discrepant" ? "Recorded duration and elapsed time disagree. " : ""}{evidence.reasons.map(reason => REASON_LABEL[reason] ?? "This record needs evidence review.").join(" ")}</p>
        {evidence.durationSeconds != null && evidence.elapsedSeconds != null && evidence.timingAgreement === "discrepant" && <p className="text-xs text-textSecondary">Recorded duration {formatRaceTime(evidence.durationSeconds)}; elapsed {formatRaceTime(evidence.elapsedSeconds)}. Resolve timing before use as a benchmark.</p>}
      </li>)}</ol>}
      </> : <SourceUnavailable sources={sources} required={PERFORMANCE_SOURCES} />}
    </Section>
  </div>;
}
