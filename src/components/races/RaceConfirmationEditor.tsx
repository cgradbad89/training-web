"use client";

import { isRaceConfirmationEnabled } from "@/lib/racePerformanceGate";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RaceConfirmationDraft } from "@/types/raceConfirmation";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { nominalRaceDistanceMeters, parseRaceResultSeconds } from "@/utils/racePerformance";
import { formatDuration } from "@/utils/pace";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";

export interface RaceConfirmationEditorProps {
  race: Race;
  workout: HealthWorkout | null;
  override?: WorkoutOverride | null;
  onSave: (draft: RaceConfirmationDraft) => Promise<void>;
  onClose: () => void;
  timeZone?: string;
  submitLabel?: string;
}

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm text-textPrimary focus:outline-primary";
const duration = (seconds: number | null | undefined) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? formatDuration(seconds) : "Unavailable";

/** Pure editor: no authentication, database, storage, or automatic save effects. */
export function RaceConfirmationEditor(props: RaceConfirmationEditorProps) {
  if (!isRaceConfirmationEnabled()) return <p role="alert">Race confirmation editing is disabled in this build. Race records remain unchanged.</p>;
  return <EnabledRaceConfirmationEditor {...props} />;
}

function EnabledRaceConfirmationEditor({ race, workout, override = null, onSave, onClose, timeZone = "America/New_York", submitLabel }: RaceConfirmationEditorProps) {
  const prefix = useId();
  const revisions = Object.values(race.confirmationHistory?.revisions ?? {}).sort((a, b) => b.revisionNumber - a.revisionNumber);
  const current = race.confirmationHistory?.revisions[race.confirmationHistory.currentRevisionId];
  const [initial] = useState(() => ({
    officialEventName: current?.details.officialEventName ?? race.name,
    raceDate: current?.details.raceDate ?? race.raceDate,
    distanceMeters: String(current?.details.distanceMeters ?? nominalRaceDistanceMeters(race) ?? ""),
    finish: current ? formatDuration(current.details.finishSeconds) : "",
    timeBasis: current?.details.timeBasis ?? "chip" as RaceConfirmationDraft["timeBasis"],
    status: current?.details.status ?? "owner_confirmed" as RaceConfirmationDraft["status"],
    effort: current?.details.effort ?? "unknown" as RaceConfirmationDraft["effort"],
    conditions: current?.details.conditions ?? "",
    source: current?.details.source ?? "",
    timingReconciliation: current?.details.timingReconciliation ?? "",
    correctionReason: "",
  }));
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const inFlight = useRef(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const navigation = useUnsavedChanges(dirty && !saving);
  const elapsed = workout && Number.isFinite(workout.endDate?.getTime()) && Number.isFinite(workout.startDate?.getTime())
    ? (workout.endDate.getTime() - workout.startDate.getTime()) / 1000 : null;
  const recorded = workout?.durationSeconds;
  const discrepancy = typeof recorded === "number" && elapsed !== null && elapsed > 0
    && Math.abs(recorded - elapsed) > Math.max(60, Math.max(recorded, elapsed) * 0.01);
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm((old) => ({ ...old, [key]: value }));
  const close = () => { if (!saving) { if (dirty) setDiscard(true); else onClose(); } };
  const field = (name: string, label: string, content: (id: string) => ReactNode, hint?: string) => {
    const id = `${prefix}-${name}`;
    return <div className="min-w-0 space-y-1"><label htmlFor={id} className="block text-sm font-medium text-textPrimary">{label}</label>{content(id)}{hint ? <p className="text-xs text-textSecondary">{hint}</p> : null}</div>;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    const finishSeconds = parseRaceResultSeconds(form.finish);
    if (!finishSeconds) { setError("Enter a finish time as H:MM:SS or M:SS. Use the result you checked, not a guessed workout time."); return; }
    if (!workout || workout.workoutId !== race.actualRunId) { setError("Load the linked workout before confirming this race. Use Link actual run on the race card if needed."); return; }
    inFlight.current = true;
    setSaving(true);
    try {
      await onSave({ ...form, distanceMeters: Number(form.distanceMeters), finishSeconds, timingReconciliation: form.timingReconciliation || null, correctionReason: form.correctionReason || null });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Confirmation could not be saved. Your entries are still here; reload the race if it changed elsewhere.");
    } finally { inFlight.current = false; setSaving(false); }
  }

  return <div className="space-y-6 text-textPrimary">
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-widest text-primary">Development / preview only</p>
      <h2 className="text-xl font-semibold">Confirm race result</h2>
      <p className="text-sm text-textSecondary">Record the result and how you checked it. A plausible workout time does not verify an official result. Saving preserves the original observations and every earlier confirmation.</p>
    </header>

    <section aria-label="Original observations" className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <h3 className="font-semibold text-sm">Recorded observations · unverified</h3>
      <p className="text-sm">{race.name} · {race.raceDate}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div><dt className="text-textSecondary">Workout duration</dt><dd className="font-semibold tabular-nums">{duration(recorded)}</dd></div>
        <div><dt className="text-textSecondary">Start/end elapsed</dt><dd className="font-semibold tabular-nums">{duration(elapsed)}</dd></div>
        <div><dt className="text-textSecondary">Previously entered result</dt><dd className="font-semibold">{race.result || "Not recorded"}</dd></div>
      </dl>
      <p className="text-xs text-textSecondary break-all">Linked workout: {race.actualRunId ?? "None — link the actual run from the race card first"}</p>
      {workout ? <p className="text-xs text-textSecondary">Observed distance: {workout.distanceMiles?.toFixed(2)} mi. Dates are interpreted in {timeZone}.</p> : <p className="text-sm text-danger">The linked workout is unavailable. Confirmation cannot be saved.</p>}
      {override ? <div className="rounded-lg border border-border p-3 text-sm space-y-1">
        <p className="font-medium">Existing workout override · original observations retained above</p>
        <p>Effective duration: {duration(override.durationSecondsOverride ?? recorded)} · Effective distance: {(override.distanceMilesOverride ?? workout?.distanceMiles)?.toFixed(2) ?? "Unavailable"} mi</p>
        <p className="text-xs text-textSecondary">Confirmation checks these effective values as well as the recorded clocks. Any timing difference still requires an explanation.</p>
        {override.isExcluded ? <p className="text-danger">This workout is excluded and cannot be confirmed.</p> : null}
      </div> : null}
      {discrepancy ? <p role="status" className="text-sm text-danger">Timing discrepancy: {duration(Math.abs(recorded! - elapsed!))}. The shorter duration is not assumed to be chip time. This remains inconsistent until you supply an explicit reconciliation.</p> : null}
    </section>

    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={saving} className="space-y-4 disabled:opacity-70">
        <legend className="font-semibold mb-3">Confirmed result</legend>
        {field("event", "Official event name", (id) => <input id={id} value={form.officialEventName} onChange={(e) => set("officialEventName", e.target.value)} maxLength={200} required className={inputClass} />)}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {field("date", "Official event date", (id) => <input id={id} type="date" value={form.raceDate} onChange={(e) => set("raceDate", e.target.value)} required className={inputClass} />, "Must match this race. Correct the race record first if its date is wrong.")}
          {field("distance", "Official distance (meters)", (id) => <input id={id} type="number" min="1" step="0.1" value={form.distanceMeters} onChange={(e) => set("distanceMeters", e.target.value)} required className={inputClass} />, "Use the event distance, not GPS distance. A half marathon is 21097.5 m.")}
          {field("finish", "Confirmed finish time", (id) => <input id={id} placeholder="H:MM:SS" value={form.finish} onChange={(e) => set("finish", e.target.value)} maxLength={12} required className={inputClass} />, "Enter the checked result separately from workout duration.")}
          {field("basis", "Finish-time basis", (id) => <select id={id} value={form.timeBasis} onChange={(e) => set("timeBasis", e.target.value as typeof form.timeBasis)} className={inputClass}><option value="chip">Chip time (preferred when available)</option><option value="gun">Gun time</option><option value="other">Other — explain below</option></select>)}
        </div>
        {field("status", "Verification category", (id) => <select id={id} value={form.status} onChange={(e) => set("status", e.target.value as typeof form.status)} className={inputClass}><option value="owner_confirmed">Owner-confirmed · explicit attestation</option><option value="verified">Official result · checked against source</option></select>, "Official verification requires a result URL you have checked. This app does not independently verify that page.")}
        {field("source", form.status === "verified" ? "Official result URL" : "Owner attestation / provenance", (id) => <textarea id={id} value={form.source} onChange={(e) => set("source", e.target.value)} maxLength={2000} rows={2} required className={inputClass} />, form.status === "verified" ? "Paste the HTTPS or HTTP result link that supports this exact race and finish time." : "State what you personally confirm and how you know the result. A link alone is not an attestation.")}
        {field("effort", "Race effort", (id) => <select id={id} value={form.effort} onChange={(e) => set("effort", e.target.value as typeof form.effort)} className={inputClass}><option value="unknown">Unknown / not confirmed</option><option value="maximal">Maximal race effort</option><option value="hard">Hard, but not confirmed maximal</option><option value="nonmaximal">Nonmaximal</option></select>, "Only confirmed maximal efforts can qualify for a historical benchmark.")}
        {field("conditions", "Conditions and limitations", (id) => <textarea id={id} value={form.conditions} onChange={(e) => set("conditions", e.target.value)} maxLength={2000} rows={2} required className={inputClass} />, "Describe course, weather, illness, pacing, or other limitations; explicitly say when conditions are unknown.")}
        {field("reconciliation", "Timing discrepancy explanation", (id) => <textarea id={id} value={form.timingReconciliation} onChange={(e) => set("timingReconciliation", e.target.value)} maxLength={2000} rows={3} className={inputClass} />, "Explain any pause, elapsed/duration difference, or difference from the checked finish time. A discrepancy requires an explanation before saving; the faster time is never chosen automatically.")}
        {current || race.performanceEvidence ? field("correction", "Reason for correction", (id) => <textarea id={id} value={form.correctionReason} onChange={(e) => set("correctionReason", e.target.value)} maxLength={2000} required rows={2} className={inputClass} />, "Explain what changed from the previous confirmation. Earlier revisions remain available below.") : null}
      </fieldset>
      <p className="text-xs text-textSecondary">Receipt times are recorded when saved, never backdated to race day. This owner-editable history cannot prove immutable historical availability, so historical prediction research abstains. Current capability and future forecasts remain withheld.</p>
      {error ? <p role="alert" className="text-sm text-danger whitespace-pre-wrap">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" data-confirmation-cancel onClick={close} disabled={saving} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
        <button type="submit" disabled={saving || !workout || workout.workoutId !== race.actualRunId || override?.isExcluded} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving…" : submitLabel ?? (current ? "Save correction" : "Save confirmation")}</button>
      </div>
    </form>

    {revisions.length ? <section aria-label="Confirmation history" className="border-t border-border pt-4 space-y-3"><h3 className="font-semibold">Confirmation history</h3>{revisions.map((revision) => <details key={revision.revisionId} className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer">Revision {revision.revisionNumber} · {revision.details.status === "verified" ? "Official result" : "Owner-confirmed"} · {duration(revision.details.finishSeconds)}{revision.revisionId === current?.revisionId ? " · Current" : " · Superseded"}</summary>
      <dl className="mt-3 space-y-2 break-words">
        <div><dt className="text-textSecondary">Event</dt><dd>{revision.details.officialEventName} · {revision.details.raceDate} · {revision.details.distanceMeters} m</dd></div>
        <div><dt className="text-textSecondary">Received at</dt><dd>{revision.availableAt ?? "Receipt pending — not usable yet"}</dd></div>
        <div><dt className="text-textSecondary">Source / attestation</dt><dd>{revision.details.source}</dd></div>
        <div><dt className="text-textSecondary">Effort and conditions</dt><dd>{revision.details.effort} · {revision.details.conditions}</dd></div>
        <div><dt className="text-textSecondary">Reconciliation</dt><dd>{revision.details.timingReconciliation || "None supplied"}</dd></div>
        <div><dt className="text-textSecondary">Correction reason</dt><dd>{revision.correctionReason || "Initial confirmation"}</dd></div>
        <div><dt className="text-textSecondary">Original workout observation at submission</dt><dd>{duration(revision.observations.workout.durationSeconds)} · {revision.observations.workout.startDate} → {revision.observations.workout.endDate}</dd></div>
      </dl>
    </details>)}</section> : null}
    <ConfirmDialog isOpen={discard} title="Discard confirmation edits?" message="These unsaved entries will be discarded. Saved evidence and workouts remain unchanged." confirmLabel="Discard edits" confirmVariant="danger" onConfirm={onClose} onCancel={() => setDiscard(false)} />
    <ConfirmDialog isOpen={navigation.showNavWarning} title="Leave without saving?" message="Your confirmation edits have not been saved." confirmLabel="Leave" confirmVariant="danger" onConfirm={navigation.confirmNav} onCancel={navigation.cancelNav} />
  </div>;
}
