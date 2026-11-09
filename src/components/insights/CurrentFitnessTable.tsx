"use client";

import React, { useMemo } from "react";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { Vo2Entry } from "@/utils/vo2History";
import { isConfirmedRaceMaximalAssumptionEnabled, isDemonstratedRaceEvidenceEnabled } from "@/lib/racePerformanceGate";
import { computeCurrentFitness, type CurrentFitness } from "@/utils/performance/hybridCurrentFitness";
import { confidenceLabel, formatAsOfDate, formatFinishTime, formatPacePerMile, rowNote } from "@/utils/performance/currentFitnessFormat";
import type { LoadState } from "@/utils/performance/hybridPerformanceV11";
import type { PhysiologyEvidence } from "@/hooks/usePhysiologyEvidence";
import { useEstimateDay } from "./RacePerformancePanel";

export const CURRENT_FITNESS_TITLE = "Experimental — Hybrid Performance Model v1.1";

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
