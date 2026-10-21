"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth, type AuthState } from "@/hooks/useAuth";
import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";
import {
  createManualPerformanceSession,
  getManualPerformanceGate,
  loadSavedPerformance,
  prepareManualPerformanceReview,
  runManualPerformanceUpdate,
  type ManualPerformanceProgress,
  type ManualPerformanceReview,
  type PerformanceSession,
  type StoredPerformanceCurrent,
  MANUAL_PERFORMANCE_SELECTION_LIMIT,
} from "@/services/manualPerformance";
import type { PerformanceAnalysisResult } from "@/types/performanceAnalysis";

const ACTION_CLASS = "rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS = "rounded-xl border border-border px-4 py-2 text-sm font-semibold text-textPrimary disabled:opacity-50";
const DEFAULT_READ_BUDGET = 5000;
const MAX_READ_BUDGET = 25000;

function dateLabel(value: string, timeZone?: string, withTime = false): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
    timeZone: value.length === 10 ? "UTC" : timeZone,
  }).format(date);
}

function durationLabel(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 3600)}:${String(Math.floor(rounded % 3600 / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

function paceLabel(speedMps: number | null): string {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0) return "Unavailable";
  const seconds = Math.round(1609.344 / speedMps);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}/mi`;
}

function SavedPerformanceDetails({ current }: { current: StoredPerformanceCurrent }) {
  const result: PerformanceAnalysisResult = current.payload.result;
  const races = result.demonstratedRaces.filter(race => Math.abs(race.nominalDistanceMeters - 21097.5) < 100);
  const limitations = [...new Set([
    ...result.completeness.coverage.limitations, ...result.warnings, ...result.limitations,
    ...result.aerobic.limitations, ...result.deviceVo2.limitations, ...result.preparation.limitations,
    ...races.flatMap(race => race.limitations),
  ])];
  return (
    <div className="space-y-4">
      <p className="text-sm text-textSecondary">
        Last calculated: <time dateTime={current.payload.calculationCompletedAt}>{dateLabel(current.payload.calculationCompletedAt, result.timeZone, true)}</time>
        {" · "}Evidence through {dateLabel(result.asOf, result.timeZone, true)}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl bg-surface p-4">
          <h3 className="font-semibold text-textPrimary">Demonstrated half-marathon performance</h3>
          {races.length ? races.map(race => (
            <p key={race.raceId} className="mt-2 text-sm text-textSecondary">
              <strong className="text-textPrimary">{durationLabel(race.durationSeconds)}</strong> on {dateLabel(race.raceDate)}
              {" · "}{race.provenance.source ?? "Workout-linked record"}. Official timing unverified.
            </p>
          )) : <p className="mt-2 text-sm text-textSecondary">No qualifying linked half-marathon result in the saved evidence.</p>}
        </section>
        <section className="rounded-xl bg-surface p-4">
          <h3 className="font-semibold text-textPrimary">Measured aerobic running</h3>
          <p className="mt-2 text-sm text-textSecondary">{result.aerobic.independentWorkoutCount} independent workouts. {result.aerobic.status === "insufficient" ? "Insufficient comparable evidence for a trend." : "Descriptive pace at observed heart rates."}</p>
          <p className="mt-2 text-xs text-textSecondary">Current: {dateLabel(result.aerobic.currentWindow.startDate)}–{dateLabel(result.aerobic.currentWindow.endDate)}. Reference: {dateLabel(result.aerobic.referenceWindow.startDate)}–{dateLabel(result.aerobic.referenceWindow.endDate)}.</p>
          {result.aerobic.bands.map(band => (
            <p key={band.lowerBpmInclusive} className="mt-2 text-sm text-textSecondary">
              {band.lowerBpmInclusive}–&lt;{band.upperBpmExclusive} bpm: {paceLabel(band.currentMedianSpeedMps)} ({band.currentWorkoutCount} runs)
              {band.status === "descriptive" && band.speedChangePct !== null ? ` · observed speed ${band.speedChangePct >= 0 ? "+" : ""}${band.speedChangePct.toFixed(1)}% vs reference` : " · comparison unavailable"}
            </p>
          ))}
        </section>
        <section className="rounded-xl bg-surface p-4">
          <h3 className="font-semibold text-textPrimary">Device VO₂ max trend</h3>
          <p className="mt-2 text-sm text-textSecondary">{result.deviceVo2.latest
            ? `${result.deviceVo2.latest.value.toFixed(1)} ${result.deviceVo2.latest.unit === "unknown" ? "(unit unverified)" : result.deviceVo2.latest.unit} on ${dateLabel(result.deviceVo2.latest.date)} · ${result.deviceVo2.latest.sourceName ?? "Device source unverified"}`
            : "No device VO₂ max measurements in the saved evidence."}</p>
          {result.deviceVo2.status === "insufficient" && <p className="mt-2 text-sm text-textSecondary">Insufficient comparable device measurements for a trend.</p>}
          {result.deviceVo2.groups.filter(group => group.status === "descriptive").map((group, index) => (
            <p key={index} className="mt-2 text-sm text-textSecondary">Median change: {group.change === null ? "Unavailable" : `${group.change >= 0 ? "+" : ""}${group.change.toFixed(1)}`} across {group.currentDates} current and {group.referenceDates} reference dates.</p>
          ))}
          <p className="mt-2 text-xs text-textSecondary">Device estimates may share pace/HR inputs; they are not measured VDOT or independent race validation.</p>
        </section>
        <section className="rounded-xl bg-surface p-4">
          <h3 className="font-semibold text-textPrimary">Endurance preparation</h3>
          <p className="mt-2 text-sm text-textSecondary">{dateLabel(result.preparation.recentWindow.startDate)}–{dateLabel(result.preparation.recentWindow.endDate)}: {result.preparation.recent.runCount ?? "Unknown"} runs, {result.preparation.recent.meters === null ? "distance unavailable" : `${(result.preparation.recent.meters / 1609.344).toFixed(1)} miles`}.</p>
          <p className="mt-2 text-sm text-textSecondary">Longest recent run: {result.preparation.longestRecentRun ? `${(result.preparation.longestRecentRun.meters / 1609.344).toFixed(1)} miles on ${dateLabel(result.preparation.longestRecentRun.date)}` : "Unavailable"}. Long runs: {result.preparation.longRunCount ?? "Unknown"}.</p>
        </section>
      </div>
      <section className="rounded-xl border border-border p-4">
        <h3 className="font-semibold text-textPrimary">Current estimated half-marathon time: Unavailable</h3>
        <p className="mt-1 text-sm text-textSecondary">The manual-performance-v1 model reports measured running performance. A validated numerical race prediction is not yet available.</p>
      </section>
      <section className="text-sm text-textSecondary">
        <h3 className="font-semibold text-textPrimary">Evidence completeness</h3>
        <p className="mt-1">Workouts: {result.completeness.coverage.workouts} · Telemetry: {result.completeness.coverage.telemetry} · Device VO₂: {result.completeness.coverage.deviceVo2}</p>
        <p>{result.completeness.acceptedFeatureCount} accepted workout features / {result.completeness.effectiveWorkoutCount} effective runs. {result.completeness.unresolvedWorkoutIds.length} unresolved; {result.completeness.rejectedWorkoutIds.length} rejected.</p>
        {limitations.length > 0 && <details className="mt-2"><summary className="cursor-pointer font-medium">Evidence limitations ({limitations.length})</summary><ul className="mt-2 list-disc space-y-1 pl-5">{limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul></details>}
        {(result.completeness.unresolvedWorkoutIds.length > 0 || result.completeness.rejectedWorkoutIds.length > 0) && <details className="mt-2"><summary className="cursor-pointer font-medium">Unresolved or excluded workout IDs</summary><p className="mt-2 break-words">Unresolved: {result.completeness.unresolvedWorkoutIds.join(", ") || "None"}. Rejected: {result.completeness.rejectedWorkoutIds.join(", ") || "None"}.</p></details>}
      </section>
    </div>
  );
}

/** One mounted owner-session only. The effect reads the saved receipt, never source telemetry. */
function SessionPerformancePanel({ auth, user }: { auth: AuthState; user: NonNullable<AuthState["user"]> }) {
  const gate = getManualPerformanceGate();
  const [saved, setSaved] = useState<StoredPerformanceCurrent | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [savedLoadFailed, setSavedLoadFailed] = useState(false);
  const [review, setReview] = useState<ManualPerformanceReview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const [readBudget, setReadBudget] = useState(String(DEFAULT_READ_BUDGET));
  const [action, setAction] = useState<"idle" | "reviewing" | "processing">("idle");
  const [progress, setProgress] = useState<ManualPerformanceProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ snapshotCreated: boolean; processedWorkoutIds: string[]; skippedWorkoutIds: string[]; documentReads: number } | null>(null);
  const active = useRef(false);
  const mounted = useRef(false);
  const reviewSession = useRef<PerformanceSession | null>(null);
  const { sessionEpoch, isSessionCurrent } = auth;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void createManualPerformanceSession({ user, sessionEpoch, isSessionCurrent })
      .then(session => loadSavedPerformance(session))
      .then(current => {
        if (!cancelled && isSessionCurrent(sessionEpoch)) setSaved(current);
      })
      .catch(reason => {
        if (!cancelled && isSessionCurrent(sessionEpoch)) {
          setSavedLoadFailed(true);
          setError(reason instanceof Error ? reason.message : "The saved performance analysis could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled && isSessionCurrent(sessionEpoch)) setLoadingSaved(false);
      });
    return () => { cancelled = true; mounted.current = false; };
  }, [user, sessionEpoch, isSessionCurrent]);

  function currentSession() { return mounted.current && isSessionCurrent(sessionEpoch); }

  async function openReview() {
    if (!gate.enabled || active.current || !currentSession()) return;
    active.current = true;
    setAction("reviewing");
    setError(null);
    setOutcome(null);
    setProgress(null);
    try {
      const session = await createManualPerformanceSession({ user, sessionEpoch, isSessionCurrent });
      const nextReview = await prepareManualPerformanceReview(session);
      if (!currentSession()) return;
      reviewSession.current = session;
      setReview(nextReview);
      setSelected(new Set(nextReview.candidates.filter(candidate => candidate.preselected && candidate.status === "new").slice(0, 3).map(candidate => candidate.workoutId)));
      setReady(false);
    } catch (reason) {
      if (currentSession()) setError(reason instanceof Error ? reason.message : "Runs could not be loaded. Try again.");
    } finally {
      active.current = false;
      if (currentSession()) setAction("idle");
    }
  }

  async function analyzeSelected() {
    const budget = Number(readBudget);
    if (!gate.enabled || active.current || !currentSession() || !review || !ready || !selected.size) return;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_READ_BUDGET) {
      setError(`Choose a whole-number read budget from 1 to ${MAX_READ_BUDGET.toLocaleString()}.`);
      return;
    }
    active.current = true;
    setAction("processing");
    setError(null);
    setOutcome(null);
    setProgress({ selected: selected.size, completed: 0, skipped: 0, documentReads: review.documentsRead, status: "Verifying the authenticated session" });
    try {
      const session = reviewSession.current;
      if (!session) throw new Error("Review expired. Reopen Update Performance and try again.");
      const update = await runManualPerformanceUpdate(session, review, {
        selectedWorkoutIds: [...selected],
        forceReprocessWorkoutIds: review.candidates.filter(candidate => selected.has(candidate.workoutId) && candidate.status !== "new").map(candidate => candidate.workoutId),
        userConfirmedReady: true,
        readBudget: budget,
      }, nextProgress => { if (currentSession()) setProgress(nextProgress); });
      if (!currentSession()) return;
      setSaved(update.current);
      setSavedLoadFailed(false);
      setOutcome(update);
      setReview(null);
      setReady(false);
    } catch (reason) {
      if (currentSession()) setError(reason instanceof Error ? reason.message : "Performance could not be saved. Your previous result is retained. Try again.");
    } finally {
      active.current = false;
      if (currentSession()) setAction("idle");
    }
  }

  const busy = action !== "idle";
  const validBudget = Number.isSafeInteger(Number(readBudget)) && Number(readBudget) >= 1 && Number(readBudget) <= MAX_READ_BUDGET;
  return (
    <section aria-labelledby="performance-analysis-title" className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="performance-analysis-title" className="text-lg font-bold text-textPrimary">Performance Analysis</h2>
        <button type="button" className={ACTION_CLASS} disabled={!gate.enabled || busy || review !== null || loadingSaved} onClick={() => void openReview()} aria-describedby={!gate.enabled ? "performance-gate-reason" : undefined}>{action === "reviewing" ? "Loading runs…" : "Update Performance"}</button>
      </div>
      {!gate.enabled && <p id="performance-gate-reason" className="rounded-xl bg-surface p-3 text-sm text-textSecondary">{gate.reason}</p>}
      {loadingSaved ? <p role="status" className="text-sm text-textSecondary">Loading saved performance analysis…</p> : saved ? <SavedPerformanceDetails current={saved} /> : <p className="text-sm text-textSecondary">{savedLoadFailed ? "The saved performance analysis could not be retrieved." : `No saved performance analysis.${gate.enabled ? " Use Update Performance to review runs and calculate when you are ready." : ""}`}</p>}
      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {outcome && <div role="status" className="rounded-xl bg-primary/10 p-4 text-sm text-textPrimary"><p>Performance analysis saved. {outcome.snapshotCreated ? "A new dated historical snapshot was created." : "The evidence and result were unchanged; no duplicate historical snapshot was created."}</p><p className="mt-1 break-words">Processed workouts: {outcome.processedWorkoutIds.join(", ") || "None"}. Skipped or rejected: {outcome.skippedWorkoutIds.join(", ") || "None"}. Firestore document reads: {outcome.documentReads.toLocaleString()}.</p><p className="mt-1">This describes the selected extraction and saved evidence; it does not certify that all historical telemetry is current.</p></div>}
      {review && <section aria-labelledby="performance-review-title" className="space-y-4 border-t border-border pt-5">
        <h3 id="performance-review-title" className="font-semibold text-textPrimary">Review runs</h3>
        <p className="text-sm text-textSecondary">Select up to {MANUAL_PERFORMANCE_SELECTION_LIMIT} runs to analyze. Selecting a previously analyzed run forces fresh GPS/HR retrieval, even when its parent record appears unchanged. Only up to three new runs are preselected; historical coverage may remain partial.</p>
        {!review.candidates.some(candidate => candidate.status === "new") && <p className="text-sm text-textSecondary">No newly recorded runs were found. Select an older run to reprocess its evidence.</p>}
        {review.limitations.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-textSecondary">{review.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>}
        <p className="text-xs text-textSecondary">Review reads: {review.documentsRead.toLocaleString()} documents. No GPS/HR telemetry is fetched until you confirm analysis.</p>
        <fieldset disabled={busy} className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium text-textPrimary">Recorded runs ({review.candidates.length})</legend>
          {review.candidates.length === 0 && <p className="text-sm text-textSecondary">No recorded runs are available in this bounded review.</p>}
          {review.candidates.map(candidate => {
            const checked = selected.has(candidate.workoutId);
            const status = candidate.status === "new" ? "New / unprocessed" : candidate.status === "analyzed" ? "Previously analyzed" : candidate.status === "changed" ? "Potentially changed" : "Incomplete or uncertain";
            return <label key={candidate.workoutId} className="flex items-start gap-3 rounded-lg bg-surface p-3 text-sm text-textPrimary"><input type="checkbox" className="mt-1" checked={checked} disabled={!checked && selected.size >= MANUAL_PERFORMANCE_SELECTION_LIMIT} aria-label={`Select ${candidate.label} (${dateLabel(candidate.startedAt)})`} onChange={event => {
              const checkedNow = event.target.checked;
              setSelected(previous => { const next = new Set(previous); if (checkedNow) next.add(candidate.workoutId); else next.delete(candidate.workoutId); return next; });
              setReady(false);
            }} /><span className="min-w-0"><span className="font-medium">{candidate.label}</span><span className="ml-2 text-textSecondary">{dateLabel(candidate.startedAt)}</span><span className="mt-1 block text-xs text-textSecondary">{status}{checked && candidate.status !== "new" ? " · Selected for reprocessing (fresh telemetry)" : ""}</span>{candidate.concerns.map((concern, index) => <span key={index} className="mt-1 block text-xs text-textSecondary">{concern}</span>)}</span></label>;
          })}
        </fieldset>
        <label className="block text-sm text-textPrimary">Child-document read budget<input type="number" min={1} max={MAX_READ_BUDGET} step={1} value={readBudget} disabled={busy} onChange={event => { setReadBudget(event.target.value); setReady(false); }} className="ml-3 w-28 rounded-lg border border-border bg-surface px-2 py-1" /></label>
        <p className="text-xs text-textSecondary">Default 5,000; maximum 25,000 per update. If the budget is exceeded, explicitly choose a higher limit and retry. Incomplete reads cannot be reported as complete.</p>
        <label className="flex items-start gap-2 text-sm text-textPrimary"><input type="checkbox" checked={ready} disabled={busy} onChange={event => setReady(event.target.checked)} className="mt-1" /><span>My selected runs have finished syncing. I understand this confirmation does not prove complete GPS/HR data.</span></label>
        <div className="flex flex-wrap items-center gap-3"><button type="button" className={ACTION_CLASS} disabled={busy || !ready || !selected.size || !validBudget} onClick={() => void analyzeSelected()}>{action === "processing" ? "Analyzing…" : `Analyze ${selected.size} selected ${selected.size === 1 ? "run" : "runs"}`}</button><button type="button" className={SECONDARY_CLASS} disabled={busy} onClick={() => { setReview(null); setError(null); setProgress(null); }}>Cancel</button></div>
      </section>}
      {progress && <div role="status" aria-live="polite" className="rounded-xl bg-surface p-3 text-sm text-textSecondary"><p>{progress.status}</p><p>Selected: {progress.selected} · Completed: {progress.completed} · Skipped / rejected: {progress.skipped} · Firestore document reads: {progress.documentReads.toLocaleString()}</p></div>}
    </section>
  );
}

/** Reusable read-only saved display plus an explicitly initiated manual workflow. */
export function PerformanceAnalysisPanel() {
  const auth = useAuth();
  if (auth.loading) return null;
  if (!auth.user || !isAuthorizedTrainingUser(auth.user.email, auth.user.emailVerified)) return null;
  return <SessionPerformancePanel key={`${auth.user.uid}:${auth.sessionEpoch}`} auth={auth} user={auth.user} />;
}
