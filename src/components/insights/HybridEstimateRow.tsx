"use client";

import { formatImpactDelta } from "@/utils/currentHalfRunImpact";
import type { HybridFamily, HybridPerformanceEstimate } from "@/types/hybridPerformance";

const label = (minutes: number) => `~${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const paceLabel = (s: number) => `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/mi`;
const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

export const HYBRID_FAMILY_LABEL: Record<HybridFamily, string> = {
  demonstrated_performance: "Demonstrated performance", physiological_trend: "Physiological trend",
  race_history: "Race history", endurance_readiness: "Endurance preparation",
};
const STATUS_LABEL = { available: "Available", provisional: "Provisional", unavailable: "Unavailable" } as const;
const CAUSE_TEXT: Record<NonNullable<HybridPerformanceEstimate["unavailableCause"]>, string> = {
  no_performance_evidence: "No qualifying race, time trial or strong sustained effort is available.",
  anchor_expired_no_contemporary_evidence: "The only qualifying race is older than 180 days and no strong recent effort replaces it.",
  insufficient_independent_evidence: "Qualifying evidence is too thin to estimate a time.",
  insufficient_endurance_preparation: "Recent long-run and volume evidence is too low to carry a half-marathon time.",
  invalid_input: "The inputs could not be evaluated.",
};

/** Largest supporting factors in plain language (never invents a factor that did not contribute). */
export function hybridFactorSentence(e: HybridPerformanceEstimate): string | null {
  if (e.seconds === null) return null;
  const parts: string[] = [];
  const race = e.contributions[2];
  if (race.status === "used") parts.push(`your recorded race${e.capacity.methods[2].evidenceCount > 1 ? " and strong efforts" : ""} (race weight ${Math.round(race.influence * 100)}% of the base)`);
  else parts.push(`demonstrated performance (${e.capacity.methods[2].evidenceCount} independent ${e.capacity.methods[2].evidenceCount === 1 ? "effort" : "efforts"}, no race anchor)`);
  const moved = e.contributions.filter(c => c.family !== "demonstrated_performance" && c.family !== "race_history" && c.status === "used" && c.seconds !== 0)
    .sort((a, b) => Math.abs(b.seconds) - Math.abs(a.seconds));
  for (const c of moved) parts.push(`${HYBRID_FAMILY_LABEL[c.family].toLowerCase()} ${c.seconds < 0 ? "faster" : "slower"} by ${formatImpactDelta(Math.abs(c.seconds))}`);
  if (!moved.length) parts.push("no sustained physiological or endurance change moves it");
  return `Mainly ${parts.join("; ")}.`;
}

/**
 * Compact comparison row for the experimental hybrid estimate, shown BESIDE the official and HR-enhanced estimates.
 * Always labelled experimental; the official estimate stays the primary prediction.
 */
export function HybridEstimateRow({ estimate: e, detailed = false }: { estimate: HybridPerformanceEstimate; detailed?: boolean }) {
  const diff = e.comparison.differenceVsOfficialSeconds;
  const faster = diff !== null && diff < 0;
  const sentence = hybridFactorSentence(e);
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg border border-border bg-surface p-3" data-testid="hybrid-estimate" data-status={e.status}>
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-textSecondary">Experimental — Hybrid Performance Model</h4>
        <span className="shrink-0 rounded-md bg-card px-2 py-0.5 text-xs font-medium text-textSecondary" data-testid="hybrid-status">{STATUS_LABEL[e.status]}</span>
      </div>
      {e.minutes !== null && e.paceSecondsPerMile !== null ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums" data-testid="hybrid-value">
            <span className="text-lg font-bold text-textPrimary">{label(e.minutes)}</span>
            <span className="font-semibold text-textSecondary">{paceLabel(e.paceSecondsPerMile)}</span>
            <span className={diff !== null && Math.abs(diff) >= 1 ? (faster ? "text-success" : "text-warning") : "text-textSecondary"} data-testid="hybrid-difference">
              {diff === null ? "official estimate unavailable for comparison" : Math.abs(diff) < 1 ? "same as the official estimate"
                : `${formatImpactDelta(Math.abs(diff))} ${faster ? "faster" : "slower"} than the official estimate`}
            </span>
          </p>
          {e.sensitivityRange && <p className="text-xs text-textSecondary" data-testid="hybrid-range">
            Assumption range {hms(e.sensitivityRange.fastSeconds)}–{hms(e.sensitivityRange.slowSeconds)} · not a statistical interval · confidence {e.confidence ?? "low"}.</p>}
        </>
      ) : <p className="text-sm font-semibold text-textPrimary" data-testid="hybrid-value">Not available</p>}
      <p className="text-sm text-textSecondary" data-testid="hybrid-reason">{sentence ?? e.fallbackReason ?? (e.unavailableCause ? CAUSE_TEXT[e.unavailableCause] : "")}</p>
      {e.seconds === null && e.capacity.seconds !== null && <p className="text-xs text-textSecondary">Demonstrated speed alone is equivalent to {label(Math.round(e.capacity.seconds / 60))} over this distance; endurance readiness is a separate question.</p>}
      {e.seconds !== null && e.flags.includes("contradictory_evidence") && <p className="text-xs text-warning" data-testid="hybrid-contradiction">Your race and recent efforts disagree, so confidence is low.</p>}
      <p className="text-xs text-textSecondary">Experimental and not independently validated. The official estimate is unchanged and remains the primary prediction.</p>
      <details className="text-xs text-textSecondary" data-testid="hybrid-details">
        <summary className="cursor-pointer py-1.5 font-semibold text-primary">How this estimate is built</summary>
        <div className="space-y-2 pt-1">
          <p>Four kinds of evidence are combined without adding correlated signals: demonstrated performance (races and strong, high-heart-rate efforts), a multiweek physiological trend (pace at a given heart rate), your race history, and endurance preparation. Ordinary easy running is never treated as a maximal effort.</p>
          <ul className="space-y-1" data-testid="hybrid-families">
            {e.contributions.map(c => <li key={c.family}><span className="font-semibold text-textPrimary">{HYBRID_FAMILY_LABEL[c.family]}</span> · {c.status.replace("_", " ")}
              {c.status === "used" && c.family !== "demonstrated_performance" && c.family !== "race_history" ? ` · ${c.seconds < 0 ? "−" : "+"}${formatImpactDelta(Math.abs(c.seconds))}, ${Math.round(c.influence * 100)}% influence` : ""}. {c.explanation}</li>)}
          </ul>
          <p data-testid="hybrid-evidence-counts">Independent performances used: {e.capacity.methods[2].evidenceCount}. Evidence quality: {e.evidenceQuality}. Excluded or expired: {e.capacity.qualification.expired.length} older than 180 days; ordinary training runs counted but never used as maximal effort: {e.capacity.qualification.counts.ordinary_training}.</p>
          {e.missing.length > 0 && <div data-testid="hybrid-missing"><p className="font-semibold text-textPrimary">Missing information</p><ul className="list-disc pl-5">{e.missing.map(m => <li key={m}>{m}</li>)}</ul></div>}
          {e.physiology && e.physiology.status === "available" && <p>{e.physiology.interpretation.observed[0]} Not supported: {e.physiology.interpretation.notSupported[0]}</p>}
          {detailed && <ul className="list-disc space-y-1 pl-5">{e.assumptions.map(a => <li key={a}>{a}</li>)}</ul>}
          <p>Model {e.version} · capacity {e.capacity.version} · calculation cutoff {e.asOf} · data through {e.dataThrough ?? "n/a"}.</p>
        </div>
      </details>
    </div>
  );
}
