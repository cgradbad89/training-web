"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RaceEvidenceStatus } from "@/types/racePerformance";
import { evaluateRacePerformance, nominalRaceDistanceMeters } from "@/utils/racePerformance";
import { buildRaceTrainingContext } from "@/utils/raceTrainingContext";
import { formatRaceTime } from "@/utils/riegelFit";
import { isExperimentalCurrentEstimateEnabled } from "@/lib/racePerformanceGate";
import { estimateCurrentHalfMarathon, type CurrentHalfEstimate } from "@/utils/experimentalCurrentPerformance";
import { performanceLocalDate } from "@/utils/performanceEvidence";

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

/** Format the supplied adjustment only; never subtract rounded finish times. */
function adjustmentLabel(seconds: number, decimals = 0): string {
  const minutes = decimals ? Number((seconds / 60).toFixed(decimals)) : Math.round(seconds / 60);
  return `${minutes < 0 ? "−" : minutes > 0 ? "+" : ""}${Math.abs(minutes).toFixed(decimals)} min`;
}

function adjustmentReason(current: CurrentHalfEstimate): string {
  if (current.finishMinutes === null) return current.reason;
  if (current.adjustmentMethod === "withheld" && current.adjustmentSeconds === 0 && current.anchor) {
    const month = new Date(`${current.anchor.raceDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    return `Not enough sustained evidence to adjust your ${month} race baseline.`;
  }
  const features = current.contributions.filter(c => c.seconds !== 0).map(c => c.feature.toLowerCase());
  const reason = features.length
    ? `${current.adjustmentMethod === "summary" ? "Sustained " : ""}${features.join(" and ")} evidence contributes to this experimental adjustment.`
    : current.reason;
  const roundedZero = current.adjustmentSeconds !== 0 && Math.round(current.adjustmentSeconds / 60) === 0;
  const text = reason.charAt(0).toUpperCase() + reason.slice(1);
  return roundedZero ? `A sub-minute adjustment rounds to 0 min. ${text}` : text;
}

function Section({ title, children, compact = false }: { title: string; children: React.ReactNode; compact?: boolean }) {
  return <section className={`min-w-0 break-words bg-card rounded-2xl border border-border ${compact ? "p-4 sm:p-5 space-y-3" : "p-5 space-y-4"}`}>
    <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    {children}
  </section>;
}

export interface RacePerformancePanelProps {
  races: Race[];
  workouts: HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plan: RunningPlan | null;
  selectedRace: Race | null;
  sourcesReady: boolean;
  /** Explicit clock and zone make previews/tests reproducible. */
  asOf?: Date;
  timeZone?: string;
}

/** Summary-only view. No service imports, child acquisition, persistence or timers. */
export function RacePerformancePanel(props: RacePerformancePanelProps) {
  const { races, workouts, overrides, plan, selectedRace, sourcesReady } = props;
  const asOf = props.asOf ?? new Date();
  const asOfIso = asOf.toISOString();
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const targetDistanceMeters = selectedRace ? nominalRaceDistanceMeters(selectedRace) ?? 21097.5 : 21097.5;
  // The declared product goal supplies an empty-account outlook, never a race result.
  const targetRace = selectedRace ?? races.find(r => r.raceDate === "2027-03-20" && r.raceDistance === "halfMarathon") ?? null;
  const targetDate = targetRace?.raceDate ?? "2027-03-20";
  const performance = useMemo(() => evaluateRacePerformance({
    races, workouts, overrides, asOf: asOfIso, timeZone, targetDistanceMeters,
  }), [races, workouts, overrides, asOfIso, timeZone, targetDistanceMeters]);
  const training = useMemo(() => buildRaceTrainingContext({
    workouts, overrides, plan, asOf: new Date(asOfIso), targetRaceDate: targetDate, timeZone,
  }), [workouts, overrides, plan, asOfIso, targetDate, timeZone]);
  const currentEnabled = isExperimentalCurrentEstimateEnabled();
  const current = useMemo(() => currentEnabled && sourcesReady ? estimateCurrentHalfMarathon({
    races, workouts, overrides, asOf: asOfIso, timeZone,
  }) : null, [currentEnabled, sourcesReady, races, workouts, overrides, asOfIso, timeZone]);
  const benchmark = performance.latestBenchmark;
  const displayedAnchor = current?.anchor ?? benchmark;
  const maxWeeklyMiles = Math.max(1, ...training.weekly.map(week => week.miles));
  const targetSeconds = targetRace?.targetPaceSecondsPerMile && targetRace.targetPaceSecondsPerMile > 0
    ? targetRace.targetPaceSecondsPerMile * (targetDistanceMeters / 1609.344) : null;

  if (!sourcesReady) return <Section title="Race Performance">
    <p role="status" className="text-sm text-textSecondary">Race performance is unavailable until race records, workouts, overrides and plans have loaded successfully.</p>
  </Section>;

  return <div className="min-w-0 space-y-6" data-testid="race-performance-experience">
    <Section title="Current Performance" compact>
      <div className="min-w-0 space-y-3" data-testid={currentEnabled ? "experimental-current-estimate" : undefined}>
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
            <p className="text-sm text-textSecondary">Based on your {dateLabel(current.anchor!.raceDate)} race and completed training.</p>
          </> : <p className="font-semibold">Insufficient evidence</p>}
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-textSecondary">
            <div className="flex flex-wrap gap-x-1"><dt>Calculated as of:</dt><dd>{current ? dateLabel(performanceLocalDate(current.asOf, timeZone)) : "Unavailable"}</dd></div>
            <div className="flex flex-wrap gap-x-1"><dt>Latest included run:</dt><dd>{current?.dataThrough ? dateLabel(current.dataThrough) : "Unavailable"}</dd></div>
          </dl>
        </> : <>
          <h3 className="text-sm font-semibold text-textSecondary">Current capability estimate</h3>
          <p className="text-xl font-bold">Unavailable</p>
          <p className="text-sm text-textSecondary">An experimental current estimate is not enabled in this build.</p>
        </>}
        <dl className="border-y border-border py-3 space-y-2 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-textSecondary">Historical race{displayedAnchor && <span className="block text-xs">{STATUS_LABEL[displayedAnchor.status]}{displayedAnchor.stale ? " · Older benchmark" : ""}</span>}</dt>
            <dd className="shrink-0 font-semibold tabular-nums">{displayedAnchor?.finishSeconds != null ? formatRaceTime(displayedAnchor.finishSeconds) : "Unavailable"}</dd>
          </div>
          {current?.baselineSeconds != null && current.anchor?.finishSeconds !== current.baselineSeconds && <div className="flex justify-between gap-4">
            <dt className="text-textSecondary">Half-marathon equivalent</dt><dd className="shrink-0 font-semibold tabular-nums">{formatRaceTime(current.baselineSeconds)}</dd>
          </div>}
          {currentEnabled && <div className="flex items-start justify-between gap-4">
            <dt className="text-textSecondary">Training adjustment</dt>
            <dd className="text-right" data-testid="training-adjustment"><span className="font-semibold tabular-nums">{current?.finishMinutes != null ? adjustmentLabel(current.adjustmentSeconds) : "Unavailable"}</span>
              {current?.finishMinutes != null && current.adjustmentSeconds !== 0 && <span className="block text-xs text-textSecondary">{Math.round(current.adjustmentSeconds / 60) === 0 ? "Rounded · " : ""}Estimated {current.adjustmentSeconds < 0 ? "faster" : "slower"}</span>}
            </dd>
          </div>}
        </dl>
        {current && <p className="text-sm text-textSecondary" data-testid="adjustment-reason">{adjustmentReason(current)}</p>}
        {!displayedAnchor && <p className="text-sm text-textSecondary">No usable race benchmark is available. Review the evidence timeline below for missing or inconsistent records.</p>}
        {!currentEnabled && displayedAnchor && <p className="text-sm text-textSecondary">{displayedAnchor.name} · {dateLabel(displayedAnchor.raceDate)}</p>}
      </div>
      {current &&
        <details className="text-sm text-textSecondary">
          <summary className="cursor-pointer py-2 font-semibold text-primary rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Why this estimate?</summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-1 min-w-0 gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-1"><h4 className="font-semibold text-textPrimary">Race anchor</h4>
                {current.anchor ? <><p>{current.anchor.name} · {dateLabel(current.anchor.raceDate)} · {STATUS_LABEL[current.anchor.status]}{current.anchor.stale ? " · Older benchmark" : ""}.</p>
                  <p>{current.anchor.timingBasis === "confirmed_result" ? "Confirmed result time" : "Recorded time; official result and maximal effort need confirmation"}. {current.anchor.ageDays} days old.</p></> : <p>No usable race anchor.</p>}
                <p>Race-equivalent baseline: {current.baselineSeconds === null ? "Unavailable" : formatRaceTime(current.baselineSeconds)}.</p>
              </div>
              <div className="min-w-0 space-y-1"><h4 className="font-semibold text-textPrimary">Training evidence</h4>
                <p>Since that race: {current.sinceAnchor.sessions} completed training runs, {current.sinceAnchor.miles.toFixed(1)} mi. Recent 4 / 8 weeks: {current.training.recentFourWeeks.miles.toFixed(1)} / {(current.training.recentFourWeeks.miles + current.training.priorFourWeeks.miles).toFixed(1)} mi.</p>
                <p>Training adjustment before rounding: {current.finishMinutes === null ? "Unavailable" : `${adjustmentLabel(current.adjustmentSeconds, 1)} (${current.adjustmentSeconds} seconds)`}.</p>
                <p>{current.reason}</p>
              </div>
            </div>
            <div className="space-y-2"><h4 className="font-semibold text-textPrimary">Adjustment evidence</h4>
              <ul className="space-y-2">{current.contributions.map(c => <li key={c.feature}><span className="font-semibold">{c.feature}: {adjustmentLabel(c.seconds, 1)}.</span> {c.explanation}</li>)}</ul>
            </div>
            <div className="space-y-2"><h4 className="font-semibold text-textPrimary">Evidence limitations</h4><ul className="list-disc pl-5 space-y-1">{current.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul></div>
            <div className="space-y-1"><h4 className="font-semibold text-textPrimary">Experimental methodology</h4>
              <p>Unvalidated training adjustment. Finish time rounds to the nearest minute; pace derives from that time and rounds to five seconds per mile. Adjustment minutes round separately from the model’s unrounded adjustment. No confidence interval is supported. This estimate has not been validated for your individual accuracy.</p>
            </div>
            <details><summary className="cursor-pointer py-2">Model assumptions</summary><ul className="mt-2 space-y-1">{current.assumptions.map(a => <li key={a}>{a}</li>)}</ul></details>
            <p className="text-xs">Model {current.version} · Evidence quality: {current.evidenceQuality.replaceAll("_", " ")} · Calculation cutoff {current.asOf} · {timeZone}</p>
          </div>
        </details>
      }
      <details className="text-sm text-textSecondary">
        <summary className="cursor-pointer font-semibold text-primary">How to strengthen the race evidence</summary>
        <p className="mt-2">Confirm the event, date, official distance, finish time, maximal effort and conditions. Reconcile any difference between recorded duration and elapsed time. Existing race links alone do not verify an official result.</p>
        <p className="mt-2">This read-only view displays the supplied records provisionally. No race record is changed by this view.</p>
        <Link href="/races" className="inline-block mt-2 text-primary hover:underline">Review existing race records</Link>
      </details>
    </Section>

    <Section title="Training Progress">
      <p className="text-sm text-textSecondary">Completed running only. Scheduled workouts contribute no performance credit. These summaries describe the loaded history; missing records do not prove no training.</p>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div><dt className="text-xs text-textSecondary">Recent 4 weeks</dt><dd className="text-2xl font-bold">{training.recentFourWeeks.miles.toFixed(1)} <span className="text-sm font-normal">mi</span></dd></div>
        <div><dt className="text-xs text-textSecondary">Prior 4 weeks</dt><dd className="text-2xl font-bold">{training.priorFourWeeks.miles.toFixed(1)} <span className="text-sm font-normal">mi</span></dd></div>
        <div><dt className="text-xs text-textSecondary">Completed sessions · 4 weeks</dt><dd className="text-2xl font-bold">{training.recentFourWeeks.sessions}</dd></div>
        <div><dt className="text-xs text-textSecondary">Longest recent run</dt><dd className="text-2xl font-bold">{training.longestRecentRun == null ? "—" : `${training.longestRecentRun.miles.toFixed(1)} mi`}</dd></div>
      </dl>
      <p className="text-sm text-textSecondary">{training.mileageChangePct == null ? "Mileage comparison unavailable without prior recorded mileage." : `Recorded mileage change: ${training.mileageChangePct > 0 ? "+" : ""}${training.mileageChangePct.toFixed(0)}% versus the prior 4 weeks.`}</p>
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
        <p>Recorded faster sessions: {training.fasterSessions.count}. Intent requires a supported completed plan match.</p>
        <p>{training.planAdherence ? `Plan adherence: ${training.planAdherence.completedSessions} of ${training.planAdherence.plannedSessions} elapsed sessions matched.` : "Plan adherence unavailable without a linked training plan."}</p>
      </div>
      <details className="text-sm text-textSecondary"><summary className="cursor-pointer">Recent workout durations</summary>
        <ul className="mt-2 space-y-1">{training.recentDurations.slice(0, 10).map(run => <li key={run.workoutId}>{dateLabel(run.date)} · {Math.round(run.durationSeconds / 60)} min</li>)}</ul>
        {training.recentDurations.length === 0 && <p className="mt-2">No completed runs in the recent window.</p>}
      </details>
      <p className="text-xs text-textSecondary">{training.limitations.filter(line => !currentEnabled || !line.startsWith("Training summaries describe completed recorded running;")).join(" ")}</p>
      </details>
    </Section>

    <Section title="Race-Day Outlook">
      <p className="font-semibold">{targetRace?.name ?? "Rock and Roll Half Marathon"}</p>
      <p className="text-sm text-textSecondary">{dateLabel(targetDate)} · {training.daysToTargetRace == null ? "Date unavailable" : training.daysToTargetRace >= 0 ? `${training.daysToTargetRace} days away` : `${Math.abs(training.daysToTargetRace)} days ago`}{!targetRace ? " · Planned goal; no matching race record selected" : ""}</p>
      <dl className="grid gap-4 md:grid-cols-3">
        <div><dt className="text-xs text-textSecondary">Owner’s target finish time</dt><dd className="font-semibold">{targetSeconds ? formatRaceTime(targetSeconds) : "Not set"}</dd></div>
        <div><dt className="text-xs text-textSecondary">Historical benchmark</dt><dd className="font-semibold">{benchmark ? `${formatRaceTime(benchmark.finishSeconds)} · ${dateLabel(benchmark.raceDate)} · ${STATUS_LABEL[benchmark.status]}` : "Unavailable"}</dd></div>
        <div><dt className="text-xs text-textSecondary">Race-day forecast</dt><dd className="font-semibold">Withheld · not validated</dd></div>
      </dl>
      <p className="text-sm text-textSecondary">Training progress and time remaining do not establish a finish-time improvement. Numerical scenarios and uncertainty ranges require independent chronological validation first.</p>
    </Section>

    <Section title="Historical Performance Timeline">
      <p className="text-sm text-textSecondary">Actual race dates and recorded evidence. Results remain separate observations, with no interpolated weeks or projected trend.</p>
      {performance.evidence.length === 0 ? <p className="text-sm text-textSecondary">No past race results are available.</p> : <ol className="space-y-3">{performance.evidence.map(evidence => <li key={evidence.raceId} className="rounded-xl bg-surface border border-border p-4 space-y-1">
        <p className="text-sm font-semibold">{evidence.name} · {dateLabel(evidence.raceDate)}</p>
        <p className="text-sm">{STATUS_LABEL[evidence.status]}{evidence.finishSeconds != null ? ` · ${formatRaceTime(evidence.finishSeconds)}` : " · No usable finish time"}{evidence.stale ? " · Older benchmark" : ""}</p>
        <p className="text-xs text-textSecondary">{evidence.timingAgreement === "discrepant" ? "Recorded duration and elapsed time disagree. " : ""}{evidence.reasons.map(reason => REASON_LABEL[reason] ?? "This record needs evidence review.").join(" ")}</p>
        {evidence.durationSeconds != null && evidence.elapsedSeconds != null && evidence.timingAgreement === "discrepant" && <p className="text-xs text-textSecondary">Recorded duration {formatRaceTime(evidence.durationSeconds)}; elapsed {formatRaceTime(evidence.elapsedSeconds)}. Resolve timing before use as a benchmark.</p>}
      </li>)}</ol>}
    </Section>
  </div>;
}
