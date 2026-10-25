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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="bg-card rounded-2xl border border-border p-5 space-y-4">
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
  const benchmark = performance.latestBenchmark;
  const maxWeeklyMiles = Math.max(1, ...training.weekly.map(week => week.miles));
  const targetSeconds = targetRace?.targetPaceSecondsPerMile && targetRace.targetPaceSecondsPerMile > 0
    ? targetRace.targetPaceSecondsPerMile * (targetDistanceMeters / 1609.344) : null;

  if (!sourcesReady) return <Section title="Race Performance">
    <p role="status" className="text-sm text-textSecondary">Race performance is unavailable until race records, workouts, overrides and plans have loaded successfully.</p>
  </Section>;

  return <div className="space-y-6" data-testid="race-performance-experience">
    <Section title="Current Performance">
      <p className="text-xs text-textSecondary">Evidence as of {dateLabel(training.recentFourWeeks.endDate)} · {timeZone}</p>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="rounded-xl border border-border p-4 space-y-2">
          <h3 className="text-sm font-semibold text-textSecondary">Historical demonstrated performance</h3>
          {benchmark ? <>
            <p className="text-3xl font-bold tabular-nums">{formatRaceTime(benchmark.finishSeconds)}</p>
            <p className="text-sm">{benchmark.name} · {dateLabel(benchmark.raceDate)}</p>
            <p className="text-sm font-semibold text-primary">{STATUS_LABEL[benchmark.status]}{benchmark.stale ? " · Older benchmark" : ""}</p>
            <p className="text-xs text-textSecondary">{benchmark.timingBasis === "confirmed_result" ? "Confirmed result time" : "Recorded time; official result and maximal effort need confirmation"}. {benchmark.ageDays} days old.</p>
            {benchmark.distanceMeters !== targetDistanceMeters && <p className="text-xs text-textSecondary">This result is at a different distance from the selected target.</p>}
          </> : <p className="text-sm text-textSecondary">No usable race benchmark is available. Review the evidence timeline below for missing or inconsistent records.</p>}
        </div>
        <div className="rounded-xl border border-border p-4 space-y-2">
          <h3 className="text-sm font-semibold text-textSecondary">Current capability estimate</h3>
          <p className="text-xl font-bold">Unavailable</p>
          <p className="text-sm text-textSecondary">A historical race records what happened on that date. A method for translating it into today’s capability has not been validated.</p>
          <p className="text-xs text-textSecondary">No confidence interval is supported. Riegel and VDOT-style equivalents remain research comparisons.</p>
        </div>
      </div>
      <details className="text-sm text-textSecondary">
        <summary className="cursor-pointer font-semibold text-primary">How to strengthen the race evidence</summary>
        <p className="mt-2">Confirm the event, date, official distance, finish time, maximal effort and conditions. Reconcile any difference between recorded duration and elapsed time. Existing race links alone do not verify an official result.</p>
        <p className="mt-2">Phase 3A displays the supplied records provisionally; confirmation persistence is a follow-on task. No race record is changed by this view.</p>
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
      <div className="overflow-x-auto">
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
      <p className="text-xs text-textSecondary">{training.limitations.join(" ")}</p>
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
