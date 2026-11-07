"use client";

import { formatImpactDelta } from "@/utils/currentHalfRunImpact";
import type { HrEnhancedEstimate } from "@/types/hrEnhancedPerformance";

const label = (minutes: number) => `~${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
const dateLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** One-sentence plain-language reading of the HR evidence. Shared by Plan Insights and the details dialog. */
export function hrEvidenceSentence(e: HrEnhancedEstimate): string | null {
  const s = e.signal;
  if (!s || s.status !== "available") return null;
  const pct = Math.abs(s.contrast.shrunkPercent ?? 0);
  const support = `${e.supportingRuns.total} runs across ${e.observationWeeks.baseline + e.observationWeeks.recent} separate weeks`;
  if (e.signalDirection === "improved") return `Pace at a comparable heart rate has improved by roughly ${pct.toFixed(1)}% (after allowing for noise), based on ${support}.`;
  if (e.signalDirection === "declined") return `Pace at a comparable heart rate has slowed by roughly ${pct.toFixed(1)}% (after allowing for noise), based on ${support}.`;
  return `Pace at a comparable heart rate shows no change beyond normal noise, based on ${support}.`;
}

/**
 * Compact comparison row for the experimental HR-enhanced estimate, shown BESIDE the official one.
 * Always labelled experimental; the official estimate stays the primary prediction.
 */
export function HrEnhancedEstimateRow({ estimate: e, detailed = false }: { estimate: HrEnhancedEstimate; detailed?: boolean }) {
  const diff = e.differenceSeconds;
  const faster = diff !== null && diff < 0;
  const sentence = hrEvidenceSentence(e);
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg border border-border bg-surface p-3" data-testid="hr-enhanced-estimate" data-status={e.status}>
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-textSecondary">HR-enhanced estimate</h4>
        <span className="shrink-0 rounded-md bg-card px-2 py-0.5 text-xs font-medium text-textSecondary">Experimental</span>
      </div>
      {e.candidateMinutes !== null ? (
        <p className="text-sm tabular-nums" data-testid="hr-enhanced-value">
          <span className="text-lg font-bold text-textPrimary">{label(e.candidateMinutes)}</span>
          <span className={`ml-2 ${diff !== null && diff !== 0 ? (faster ? "text-success" : "text-warning") : "text-textSecondary"}`} data-testid="hr-enhanced-difference">
            {diff === null || diff === 0 ? "same as the official estimate"
              : `${formatImpactDelta(Math.abs(diff))} ${faster ? "faster" : "slower"} than the official estimate`}
          </span>
        </p>
      ) : (
        <p className="text-sm font-semibold text-textPrimary" data-testid="hr-enhanced-value">Not available</p>
      )}
      <p className="text-sm text-textSecondary" data-testid="hr-enhanced-reason">{sentence ?? e.fallbackReason}</p>
      {e.status === "no_change" && e.fallbackReason && sentence && e.signalDirection !== "no_detectable_change" && <p className="text-xs text-textSecondary" data-testid="hr-enhanced-no-change-note">{e.fallbackReason}</p>}
      <p className="text-xs text-textSecondary">Experimental and not independently validated. The official estimate is unchanged and remains the primary prediction.</p>
      <details className="text-xs text-textSecondary" data-testid="hr-enhanced-details">
        <summary className="cursor-pointer py-1.5 font-semibold text-primary">How heart-rate evidence is used</summary>
        <div className="space-y-2 pt-1">
          <p>Compares steady outdoor runs at a similar average heart rate before the race anchor with the last six weeks. Runs outside the shared heart-rate range, treadmill runs, hard sessions and races are not used, and nothing is extrapolated.</p>
          {e.window && <p data-testid="hr-enhanced-window">Compared windows: {dateLabel(e.window.baseline.start)}–{dateLabel(e.window.baseline.end)} (before the anchor) and {dateLabel(e.window.recent.start)}–{dateLabel(e.window.recent.end)} (recent).</p>}
          {e.supportingRuns.total > 0 && <p data-testid="hr-enhanced-support">Supporting runs: {e.supportingRuns.baseline} before the anchor ({e.observationWeeks.baseline} weeks) and {e.supportingRuns.recent} recent ({e.observationWeeks.recent} weeks). Evidence quality: {e.evidenceQuality}.</p>}
          {e.status === "available" && e.officialMinutes !== null && e.candidateMinutes !== null && <p>
            Official {label(e.officialMinutes)} → HR-enhanced {label(e.candidateMinutes)}. The heart-rate evidence can move the official estimate by at most 1.5%{e.adjustmentCap.applied ? " (that limit applied here)" : ""}, and only in the direction it points.</p>}
          {e.caveats.filter(c => !/^The official estimate remains|^Not independently validated/.test(c)).map(c => <p key={c}>{c}</p>)}
          {detailed && <ul className="list-disc space-y-1 pl-5">{e.assumptions.map(a => <li key={a}>{a}</li>)}</ul>}
          <p>Model {e.version} · signal {e.signalVersion} · calculation cutoff {e.asOf}.</p>
        </div>
      </details>
    </div>
  );
}
