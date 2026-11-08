/**
 * RETIRED FROM NAVIGATION (2026-11): these freshness/"update available" surfaces only served the manual Performance
 * Analysis workflow and are no longer rendered. Preserved, unmounted, for reversibility.
 */
"use client";

import Link from "next/link";
import { usePerformanceEvidence } from "@/contexts/PerformanceEvidenceContext";
import { PERFORMANCE_ANALYSIS_HREF } from "@/lib/performanceAnalysisNavigation";
import { PERFORMANCE_RECENT_INCOMPLETE_DAYS } from "@/utils/performanceFreshness";
import type { PerformanceFlaggedRecord, PerformanceFreshness } from "@/types/performanceFreshness";

function cutoffDate(value: string | null, timeZone: string | null): string | null {
  if (!value) return null;
  try { return new Date(value).toLocaleDateString("en-US", { timeZone: timeZone ?? "UTC", dateStyle: "medium" }); }
  catch { return value; }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Status sentence shared by every surface. Historical partial-route markers
 * never produce a top-level "wait for syncing" instruction. */
function statusMessage(freshness: PerformanceFreshness): string {
  const { status, newWorkoutIds, newlyVisibleWorkoutIds, changedWorkoutIds, incompleteWorkoutIds } = freshness;
  const count = new Set([...newWorkoutIds, ...newlyVisibleWorkoutIds, ...changedWorkoutIds]).size;
  return status === "checking" ? "Checking saved performance evidence and loaded workout records…"
    : status === "no_saved_analysis" ? "No saved detailed performance analysis. Run review and processing require separate actions."
    : status === "update_available" ? `${count} loaded ${count === 1 ? "run warrants" : "runs warrant"} review. The dated detailed analysis may need updating.`
    : status === "incomplete_sync" ? `${plural(incompleteWorkoutIds.length, "recent run reports", "recent runs report")} a partial route or unfinished upload. ${incompleteWorkoutIds.length === 1 ? "It" : "They"} may still be syncing; review after the upload completes.`
    : status === "unable_to_verify" ? "Unable to verify all performance updates from the available records. The saved analysis remains dated."
    : "No new actionable changes detected in loaded workout records.";
}

function recordDate(record: PerformanceFlaggedRecord, timeZone: string | null): string {
  return cutoffDate(record.startedAt, timeZone) ?? "Date unavailable";
}

function RecordList({ title, ids, freshness, timeZone, note, testId }: {
  title: string; ids: string[]; freshness: PerformanceFreshness; timeZone: string | null;
  note: (record: PerformanceFlaggedRecord) => string | null; testId: string;
}) {
  if (!ids.length) return null;
  return <div className="min-w-0 space-y-1" data-testid={testId}>
    <h4 className="text-xs font-semibold text-textPrimary">{title}</h4>
    <ul className="space-y-1 text-xs">{ids.map(id => {
      const record = freshness.records[id];
      if (!record) return <li key={id}>Run {id}</li>;
      const extra = note(record);
      return <li key={id} className="min-w-0">
        <Link className="font-medium text-primary underline" href={`/runs/${encodeURIComponent(id)}`}>
          {record.displayType} · <time dateTime={record.startedAt}>{recordDate(record, timeZone)}</time>
        </Link>{extra ? ` · ${extra}` : ""}
      </li>;
    })}</ul>
  </div>;
}

/** One-line tile hint. Shown only when there is something actionable or the
 * saved-state read failed; reuses the shared owner, never starts review. */
export function PerformanceEvidenceNotice() {
  const { freshness, state } = usePerformanceEvidence();
  const { status } = freshness;
  const text = state.status === "error" ? "Saved performance evidence could not be loaded."
    : status === "update_available" || status === "incomplete_sync" ? statusMessage(freshness) : null;
  if (!text) return null;
  return <div data-testid="performance-evidence-notice" data-status={status}
    className="min-w-0 rounded-lg bg-surface px-3 py-2 text-xs text-textSecondary [overflow-wrap:anywhere]">
    <span role="status">{text}</span>{" "}
    <PerformanceAnalysisLink isUpdate={status === "update_available"} />
  </div>;
}

function PerformanceAnalysisLink({ isUpdate }: { isUpdate: boolean }) {
  return <Link className="font-semibold text-primary underline" href={PERFORMANCE_ANALYSIS_HREF} prefetch={false} scroll={false}>
    {isUpdate ? "Review Performance Updates" : "Open Performance Analysis"}
  </Link>;
}

/** Shared inline language. Mounting reads one saved document, never opens review. */
export function PerformanceEvidenceStatus({ inAnalysis = false, detailed = false }: { inAnalysis?: boolean; detailed?: boolean }) {
  const { freshness, state, evidence, retry } = usePerformanceEvidence();
  const { status, newWorkoutIds, newlyVisibleWorkoutIds, changedWorkoutIds, incompleteWorkoutIds,
    historicalIncompleteWorkoutIds, uncertainWorkoutIds } = freshness;
  const cutoff = freshness.evidenceCutoff;
  const timeZone = evidence.evidence?.metadata.timeZone ?? null;
  const cutoffLabel = cutoffDate(cutoff, timeZone);
  const completedAt = evidence.evidence?.metadata.calculationCompletedAt ?? null;
  const historicalIncorporated = historicalIncompleteWorkoutIds.filter(id => freshness.records[id]?.incorporated).length;
  const changes = [
    newWorkoutIds.length ? `${newWorkoutIds.length} completed after the saved cutoff` : null,
    newlyVisibleWorkoutIds.length ? `${newlyVisibleWorkoutIds.length} newly visible in this session` : null,
    changedWorkoutIds.length ? `${changedWorkoutIds.length} source values changed since first observed in this session` : null,
  ].filter(Boolean).join(" · ");
  const membership = (record: PerformanceFlaggedRecord) => record.incorporated ? "included in the saved analysis" : null;
  return <aside aria-label="Performance Evidence" data-testid="performance-evidence-status" data-status={status}
    className="min-w-0 space-y-2 rounded-xl border border-border bg-surface p-3 text-sm text-textSecondary [overflow-wrap:anywhere]">
    {!detailed && <p className="font-semibold text-textPrimary">Performance Evidence</p>}
    <p role="status" aria-live="polite" aria-atomic="true">{statusMessage(freshness)}</p>
    {detailed && <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="saved-evidence-dates">
      <div className="flex flex-wrap gap-x-1"><dt>Last saved analysis:</dt><dd>{completedAt ? <time dateTime={completedAt} title={completedAt}>{cutoffDate(completedAt, timeZone)}</time> : state.status === "absent" ? "None saved" : "Unavailable"}</dd></div>
      <div className="flex flex-wrap gap-x-1"><dt>Saved evidence cutoff:</dt><dd>{cutoff ? <time dateTime={cutoff} title={cutoff}>{cutoffLabel}</time> : "Unavailable"}</dd></div>
    </dl>}
    {!detailed && cutoff && <p className="text-xs">Saved analysis cutoff: <time dateTime={cutoff} title={cutoff}>{cutoffLabel}</time>. Detailed measurements stay separate from the current estimate.</p>}
    {status === "update_available" && <p className="text-xs">{changes}.</p>}
    {status !== "incomplete_sync" && incompleteWorkoutIds.length > 0 && <p className="text-xs">{plural(incompleteWorkoutIds.length, "other recent run reports", "other recent runs report")} a partial upload and may still be syncing; review {incompleteWorkoutIds.length === 1 ? "it" : "them"} after the upload completes.</p>}
    {historicalIncompleteWorkoutIds.length > 0 && <p className="text-xs" data-testid="historical-incomplete-summary">{plural(historicalIncompleteWorkoutIds.length, "older run still carries", "older runs still carry")} a partial-route marker (more than {PERFORMANCE_RECENT_INCOMPLETE_DAYS} days old{historicalIncorporated ? `; ${historicalIncorporated} included in the saved analysis` : ""}). This is a historical metadata limitation; it does not show that an upload is in progress.</p>}
    {uncertainWorkoutIds.length > 0 && <p className="text-xs">{uncertainWorkoutIds.length} historical {uncertainWorkoutIds.length === 1 ? "run lacks" : "runs lack"} a sufficient comparison basis. Missing feature receipts may reflect exclusions or unprocessed history; they do not establish new runs.</p>}
    {freshness.refreshFailed && <p className="text-xs">A source request failed. Previously loaded evidence is retained; latest changes could not be verified.</p>}
    {state.publication === "processing" && <p className="text-xs">A user-confirmed performance update is in progress. The previous saved analysis remains visible.</p>}
    {state.publication === "failed" && <p className="text-xs">The last performance update failed. The previous saved analysis is retained.</p>}
    {state.status === "error" && <button type="button" className="font-semibold text-primary underline" onClick={() => void retry()}>Retry saved analysis load</button>}
    {state.error && <p className="text-xs">{state.error}</p>}
    {detailed && <div className="space-y-3 border-t border-border pt-2">
      <RecordList testId="evidence-new-runs" title="New or changed runs" ids={[...new Set([...newWorkoutIds, ...newlyVisibleWorkoutIds, ...changedWorkoutIds])]}
        freshness={freshness} timeZone={timeZone} note={record => changedWorkoutIds.includes(record.workoutId) ? "source values changed this session"
          : newlyVisibleWorkoutIds.includes(record.workoutId) ? "newly visible this session" : "completed after the saved cutoff"} />
      <RecordList testId="evidence-recent-incomplete" title="Recent partial uploads" ids={incompleteWorkoutIds}
        freshness={freshness} timeZone={timeZone} note={membership} />
      <RecordList testId="evidence-historical-incomplete" title="Older runs with incomplete route metadata" ids={historicalIncompleteWorkoutIds}
        freshness={freshness} timeZone={timeZone} note={membership} />
    </div>}
    {detailed && <p className="text-xs" data-testid="evidence-estimate-separation">Detailed manual measurements do not currently alter the experimental half-marathon estimate. Saving or updating them leaves the estimate unchanged.</p>}
    {!inAnalysis && status !== "checking" && (detailed || status !== "no_detected_changes") && <PerformanceAnalysisLink isUpdate={status === "update_available"} />}
    {inAnalysis && status === "update_available" && <p className="text-xs">Use Update Performance to open the bounded review. GPS/HR processing starts only after you select runs and confirm Analyze.</p>}
    <details className="text-xs"><summary className="cursor-pointer">Freshness limits</summary><ul className="mt-2 list-disc space-y-1 pl-4">{freshness.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>
  </aside>;
}
