"use client";

import Link from "next/link";
import { usePerformanceEvidence } from "@/contexts/PerformanceEvidenceContext";

function cutoffDate(value: string | null, timeZone: string | null): string | null {
  if (!value) return null;
  try { return new Date(value).toLocaleDateString("en-US", { timeZone: timeZone ?? "UTC", dateStyle: "medium" }); }
  catch { return value; }
}

/** Shared inline language. Mounting reads one saved document, never opens review. */
export function PerformanceEvidenceStatus({ personal = false }: { personal?: boolean }) {
  const { freshness, state, evidence, retry } = usePerformanceEvidence();
  const { status, newWorkoutIds, newlyVisibleWorkoutIds, changedWorkoutIds, incompleteWorkoutIds, uncertainWorkoutIds } = freshness;
  const count = new Set([...newWorkoutIds, ...newlyVisibleWorkoutIds, ...changedWorkoutIds]).size;
  const cutoff = freshness.evidenceCutoff;
  const cutoffLabel = cutoffDate(cutoff, evidence.evidence?.metadata.timeZone ?? null);
  const changes = [
    newWorkoutIds.length ? `${newWorkoutIds.length} completed after the saved cutoff` : null,
    newlyVisibleWorkoutIds.length ? `${newlyVisibleWorkoutIds.length} newly visible in this session` : null,
    changedWorkoutIds.length ? `${changedWorkoutIds.length} source values changed since first observed in this session` : null,
  ].filter(Boolean).join(" · ");
  const message = status === "checking" ? "Checking saved performance evidence and loaded workout records…"
    : status === "no_saved_analysis" ? "No saved detailed performance analysis. Personal Insights lets you review runs before processing."
    : status === "update_available" ? `${count} loaded ${count === 1 ? "run warrants" : "runs warrant"} review. The dated detailed analysis may need updating.`
    : status === "incomplete_sync" ? `${incompleteWorkoutIds.length} loaded ${incompleteWorkoutIds.length === 1 ? "run has" : "runs have"} incomplete workout or route sync. Wait for syncing before processing.`
    : status === "unable_to_verify" ? "Unable to verify all performance updates from the available records. The saved analysis remains dated."
    : "No new changes detected in loaded workout records.";
  return <aside aria-label="Performance Evidence" data-testid="performance-evidence-status" data-status={status}
    className="min-w-0 space-y-2 rounded-xl border border-border bg-surface p-3 text-sm text-textSecondary [overflow-wrap:anywhere]">
    <p className="font-semibold text-textPrimary">Performance Evidence</p>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
    {cutoff && <p className="text-xs">Saved analysis cutoff: <time dateTime={cutoff} title={cutoff}>{cutoffLabel}</time>. Detailed measurements stay separate from the current estimate.</p>}
    {status === "update_available" && <p className="text-xs">{changes}.</p>}
    {uncertainWorkoutIds.length > 0 && <p className="text-xs">{uncertainWorkoutIds.length} historical {uncertainWorkoutIds.length === 1 ? "run lacks" : "runs lack"} a sufficient comparison basis. Missing feature receipts may reflect exclusions or unprocessed history; they do not establish new runs.</p>}
    {status !== "incomplete_sync" && incompleteWorkoutIds.length > 0 && <p className="text-xs">{incompleteWorkoutIds.length} other loaded runs have incomplete sync; wait before processing them.</p>}
    {freshness.refreshFailed && <p className="text-xs">A source request failed. Previously loaded evidence is retained; latest changes could not be verified.</p>}
    {state.publication === "processing" && <p className="text-xs">A user-confirmed performance update is in progress. The previous saved analysis remains visible.</p>}
    {state.publication === "failed" && <p className="text-xs">The last performance update failed. The previous saved analysis is retained.</p>}
    {state.status === "error" && <button type="button" className="font-semibold text-primary underline" onClick={() => void retry()}>Retry saved analysis load</button>}
    {state.error && <p className="text-xs">{state.error}</p>}
    {!personal && status !== "checking" && status !== "no_detected_changes" && <Link className="inline-block max-w-full font-semibold text-primary underline" href="/personal-insights#performance-analysis">{status === "update_available" ? "Review Performance Updates" : "View Personal Insights"}</Link>}
    {personal && status === "update_available" && <p className="text-xs">Use Update Performance to open the bounded review. GPS/HR processing starts only after you select runs and confirm Analyze.</p>}
    <details className="text-xs"><summary className="cursor-pointer">Freshness limits</summary><ul className="mt-2 list-disc space-y-1 pl-4">{freshness.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>
  </aside>;
}
