"use client";

import React, { useId, useMemo } from "react";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { Vo2Entry } from "@/utils/vo2History";
import { isConfirmedRaceMaximalAssumptionEnabled, isDemonstratedRaceEvidenceEnabled } from "@/lib/racePerformanceGate";
import { computeCurrentFitness, type CurrentFitness } from "@/utils/performance/hybridCurrentFitness";
import { confidenceLabel, formatAsOfDate, formatFinishTime, formatPacePerMile, rowNote } from "@/utils/performance/currentFitnessFormat";
import type { LoadState } from "@/utils/performance/hybridPerformanceV11";
import type { PhysiologyEvidence } from "@/hooks/usePhysiologyEvidence";
import type { MarathonEquivalentSource, MarathonPerformanceEquivalent } from "@/utils/performance/marathonPerformanceEquivalent";
import { useEstimateDay } from "./RacePerformancePanel";

export const CURRENT_FITNESS_TITLE = "Experimental — Hybrid Performance Model v1.1";

const sourceLabels: Record<MarathonEquivalentSource["kind"], string> = {
  confirmed_race: "Confirmed race", recorded_race: "Recorded race", labelled_race_run: "Race-labelled run",
  whole_run_effort: "Strong run", sustained_segment: "Sustained segment",
};

function MarathonEquivalent({ benchmark }: { benchmark: MarathonPerformanceEquivalent }) {
  const headingId = useId();
  const half = benchmark.sources.find(source => source.qualifyingHalf)!;
  return (
    <section aria-labelledby={headingId} className="mt-5 border-t border-border pt-5 min-w-0" data-testid="marathon-equivalent">
      <h3 id={headingId} className="text-xs font-semibold text-textSecondary uppercase tracking-wide">Marathon equivalent — from race performance</h3>
      <p className="mt-2 text-sm text-textPrimary">Estimated equivalent: <strong className="text-xl tabular-nums whitespace-nowrap" data-testid="marathon-equivalent-time">{formatFinishTime(benchmark.finishSeconds)}</strong></p>
      <p className="mt-1 text-xs text-textSecondary">{formatPacePerMile(benchmark.paceSecondsPerMile)}/mi equivalent · As of {formatAsOfDate(benchmark.asOfDate)}</p>
      <p className="mt-3 text-sm text-textSecondary">Based on qualified, weighted evidence, including your {formatAsOfDate(half.date)} half-marathon race.</p>
      <p className="mt-2 text-xs font-semibold text-textPrimary">Low confidence · Performance extrapolation</p>
      <p className="mt-2 text-sm text-textSecondary">This is a race-performance equivalent, not a prediction of your current marathon readiness. Your recent endurance training may not support this result.</p>
      <details className="mt-3 text-xs text-textSecondary">
        <summary className="cursor-pointer text-primary focus-visible:outline-2 focus-visible:outline-offset-2">Evidence and calculation assumptions</summary>
        <ul className="mt-2 space-y-2" aria-label="Weighted benchmark sources">
          {benchmark.sources.map(source => (
            <li key={source.clusterId} className="break-words" data-testid="marathon-equivalent-source">
              {source.qualifyingHalf ? "Confirmed half-marathon race" : sourceLabels[source.kind]} · {formatAsOfDate(source.date)} · {source.ageDays} days old · {formatFinishTime(source.seconds)} over {(source.distanceMeters / 1609.344).toFixed(2)} mi · {source.effectiveShare < 0.001 ? "<0.1" : (source.effectiveShare * 100).toFixed(1)}% weight
            </li>
          ))}
        </ul>
        <p className="mt-3">Reuses the model’s marathon-distance evidence base, weighted by recency and precision. Shorter performances use its readiness-dependent conversion (exponent {benchmark.exponent.toFixed(3)}; readiness {(benchmark.readinessScore * 100).toFixed(0)}%). Confirmed race efforts follow the model’s active evidence policy; no subjective effort adjustment is added.</p>
        <p className="mt-2">Shown to the nearest minute before physiology or endurance-change adjustments and final readiness gates. No taper or future-training credit. These conversion assumptions are unvalidated; this is not a race-day forecast, goal, or statistical accuracy range.</p>
      </details>
    </section>
  );
}

/** Presentational: one clean table, four distances in fixed order. Provisional and unavailable states are shown, never replaced by a number. */
export function CurrentFitnessTable({ fitness }: { fitness: CurrentFitness }) {
  return (
    <div data-testid="current-fitness" className="min-w-0">
      <div className="mb-4">
        <p className="text-sm font-semibold text-textPrimary">{CURRENT_FITNESS_TITLE}</p>
        <p className="text-xs text-textSecondary mt-0.5" data-testid="current-fitness-asof">
          Current fitness as of {formatAsOfDate(fitness.asOfDate)} — what you could reasonably race today, not a race-day forecast. Evidence quality reflects model rules, not a calibrated probability.
        </p>
      </div>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-sm border-collapse" data-testid="current-fitness-table">
          <caption className="sr-only">Current-fitness race time estimates for 5K, 10 miles, half marathon and marathon</caption>
          {/* Below the `sm` breakpoint each row becomes a compact two-line block (time over pace and confidence) so nothing scrolls sideways on a phone;
              the header stays available to assistive technology. Semantics are the same table either way. */}
          <thead className="max-sm:sr-only">
            <tr className="text-xs text-textSecondary uppercase tracking-wide border-b border-border">
              <th scope="col" className="text-left py-2 pr-2 font-medium">Distance</th>
              <th scope="col" className="text-right py-2 px-2 font-medium">Predicted time</th>
              <th scope="col" className="text-right py-2 px-2 font-medium">Pace/mile</th>
              <th scope="col" className="text-right py-2 pl-2 font-medium">Evidence quality</th>
            </tr>
          </thead>
          <tbody>
            {fitness.rows.map((row, index) => {
              const note = rowNote(row), unavailable = row.status === "unavailable";
              // A row's note sits on its own full-width line beneath it; the divider follows the pair.
              const divider = index < fitness.rows.length - 1 ? "border-b border-border" : "";
              const pad = note ? "pb-1" : "pb-3";
              const padTop = note ? "pb-1" : "pb-3 max-sm:pb-1";   // first line of the stacked (phone) layout always sits tight above the second
              return (
                <React.Fragment key={row.id}>
                  <tr data-testid={`current-fitness-row-${row.id}`} data-status={row.status} className={`align-top max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:gap-x-3 ${note ? "" : divider}`}>
                    <th scope="row" className={`text-left pt-3 pr-2 font-semibold text-textPrimary ${padTop}`}>{row.label}</th>
                    <td className={`text-right pt-3 px-2 max-sm:px-0 tabular-nums whitespace-nowrap ${unavailable ? "text-textSecondary" : "font-bold text-textPrimary"} ${padTop}`} data-testid={`current-fitness-time-${row.id}`}>
                      {unavailable ? "—" : formatFinishTime(row.finishSeconds)}
                    </td>
                    <td className={`text-right max-sm:text-left pt-3 max-sm:pt-0 px-2 max-sm:px-0 tabular-nums whitespace-nowrap text-textSecondary ${pad} ${unavailable ? "" : "max-sm:after:content-['_/mi']"}`} data-testid={`current-fitness-pace-${row.id}`}>
                      {unavailable ? "—" : formatPacePerMile(row.paceSecondsPerMile)}
                    </td>
                    <td className={`text-right pt-3 max-sm:pt-0 pl-2 max-sm:pl-0 text-textSecondary ${pad}`} data-testid={`current-fitness-confidence-${row.id}`}>
                      {confidenceLabel(row)}
                    </td>
                  </tr>
                  {note && (
                    <tr data-testid={`current-fitness-notes-${row.id}`} className={`max-sm:block ${divider}`}>
                      <td colSpan={4} className="pb-3 text-xs text-textSecondary max-sm:block" data-testid={`current-fitness-note-${row.id}`}>{note}</td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {fitness.marathonEquivalent && <MarathonEquivalent benchmark={fitness.marathonEquivalent} />}
    </div>
  );
}

export interface CurrentFitnessEstimatesProps {
  races: Race[];
  /** Raw workouts: the estimators apply overrides and exclusions themselves (same inputs as Plan Insights). */
  workouts: HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  sources: { workouts: boolean; overrides: boolean; races: boolean };
  physiology?: PhysiologyEvidence;
  /** Explicit clock and zone make tests reproducible. */
  asOf?: Date;
  timeZone?: string;
}

/**
 * Container: runs the app's pure pipeline (shared race adapter → official v2 and HR-enhanced estimates → four distances) on the already
 * loaded shared data. It fetches nothing itself (physiology evidence is supplied by the page's bounded hook) and persists nothing.
 */
export function CurrentFitnessEstimates(props: CurrentFitnessEstimatesProps) {
  const { races, workouts, overrides, physiology } = props;
  const ready = props.sources.workouts && props.sources.overrides && props.sources.races;
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = useEstimateDay(props.asOf !== undefined, timeZone);
  const asOfIso = useMemo(() => props.asOf?.toISOString() ?? new Date().toISOString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Source publications and the local day intentionally refresh the captured clock.
    [props.asOf, races, workouts, overrides, ready, day, timeZone]);
  const vo2Entries: readonly Vo2Entry[] | undefined = physiology?.vo2.entries;
  const vo2Load: LoadState = physiology ? (physiology.vo2.state === "loaded" || physiology.vo2.state === "failed" ? physiology.vo2.state : "not_requested") : "not_requested";
  const streamSummaries = physiology?.streams.summaries;
  const streamLoad: LoadState = physiology ? (physiology.streams.state === "loaded" || physiology.streams.state === "failed" ? physiology.streams.state : "not_requested") : "not_requested";
  const assume = isConfirmedRaceMaximalAssumptionEnabled(), strictMaximalOnly = !isDemonstratedRaceEvidenceEnabled();
  const fitness = useMemo(() => ready ? computeCurrentFitness({ races, workouts, overrides, asOf: asOfIso, timeZone, assumeConfirmedRacesMaximal: assume },
    { vo2Entries, streamSummaries, vo2Load, streamLoad, strictMaximalOnly }) : null,
  [ready, races, workouts, overrides, asOfIso, timeZone, assume, vo2Entries, streamSummaries, vo2Load, streamLoad, strictMaximalOnly]);
  const loading = !!physiology && (physiology.vo2.state === "loading" || physiology.streams.state === "loading");
  if (!fitness) return <p role="status" className="text-sm text-textSecondary" data-testid="current-fitness-loading">Loading race and training history…</p>;
  return (
    <>
      <CurrentFitnessTable fitness={fitness} />
      {loading && <p role="status" className="text-xs text-textSecondary mt-3" data-testid="current-fitness-physiology-loading">Loading VO₂ max and heart-rate evidence; these estimates use whole-workout heart rate until it arrives.</p>}
    </>
  );
}
