"use client";

import type { RaceDayForecast } from "@/types/hybridPerformance";

const label = (minutes: number) => `~${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const WITHHELD: Record<NonNullable<RaceDayForecast["withheldCause"]>, string> = {
  current_capability_unavailable: "Current capability is unavailable, so there is nothing to project forward.",
  race_date_invalid_or_past: "The race date is missing or not in the future.",
  horizon_too_long: "The race is too far away for current evidence to say anything useful about race-day condition.",
  insufficient_endurance_basis: "Current endurance preparation is too low to carry a half-marathon time.",
  demonstrated_performance_only: "Current capability is only a demonstrated performance from a race that was not run at maximal effort, so it is not projected forward.",
};

/**
 * Experimental race-day forecast, kept visibly SEPARATE from current capability. Withheld states say exactly why.
 * Never labelled validated; planned training is shown as a plan, not as a fitness gain.
 */
export function RaceDayForecastRow({ forecast: f }: { forecast: RaceDayForecast }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg border border-border bg-surface p-3" data-testid="race-day-forecast" data-status={f.status}>
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-textSecondary">Experimental race-day forecast · {f.version === "experimental-raceday-forecast-v2" ? "Forecast v2" : "Forecast v1"}</h4>
        <span className="shrink-0 rounded-md bg-card px-2 py-0.5 text-xs font-medium text-textSecondary">{f.status === "provisional" ? "Provisional" : "Withheld"}</span>
      </div>
      {f.status === "provisional" && f.minutes !== null && f.scenarioRange ? <>
        <p className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums" data-testid="forecast-value">
          <span className="text-lg font-bold text-textPrimary">{label(f.minutes)}</span>
          <span className="text-textSecondary">on {f.raceDate} · {f.daysToRace} days away</span>
        </p>
        <p className="text-xs text-textSecondary" data-testid="forecast-range">Assumption range {hm(f.scenarioRange.fastSeconds)}–{hm(f.scenarioRange.slowSeconds)} · not a statistical interval.</p>
        <p className="text-sm text-textSecondary" data-testid="forecast-separation">Today’s capability is {f.currentCapabilitySeconds !== null ? label(Math.round(f.currentCapabilitySeconds / 60)) : "unavailable"} (a separate estimate). This forecast assumes no fitness gain from planned training; only endurance preparation changes with your plan.</p>
      </> : <p className="text-sm font-semibold text-textPrimary" data-testid="forecast-value">Withheld · not validated</p>}
      {f.status === "withheld" && f.withheldCause && <p className="text-sm text-textSecondary" data-testid="forecast-withheld-reason">{WITHHELD[f.withheldCause]} {f.reasons[0]}</p>}
      <details className="text-xs text-textSecondary" data-testid="forecast-details">
        <summary className="cursor-pointer py-1.5 font-semibold text-primary">How the forecast is built and what it cannot know</summary>
        <div className="space-y-2 pt-1">
          {f.scenarios.length > 0 && <ul className="space-y-1" data-testid="forecast-scenarios">{f.scenarios.map(s => <li key={s.id}>
            <span className="font-semibold text-textPrimary">{s.label}</span>{s.central ? " (central)" : ""} · {s.seconds === null ? "no numeric value" : `${hm(s.seconds)}${s.fraction !== 0 ? ` (${s.fraction < 0 ? "−" : "+"}${Math.abs(s.fraction * 100).toFixed(1)}%)` : ""}`}. {s.basis}</li>)}</ul>}
          <div><p className="font-semibold text-textPrimary">Uncertainty</p><ul className="list-disc pl-5">{f.uncertainty.map(u => <li key={u}>{u}</li>)}</ul></div>
          <ul className="list-disc pl-5">{f.caveats.map(c => <li key={c}>{c}</li>)}</ul>
          <p>Model {f.version} · calculation cutoff {f.asOf}.</p>
        </div>
      </details>
    </div>
  );
}
