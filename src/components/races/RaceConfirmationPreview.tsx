"use client";

import { useRef, useState } from "react";
import type { RaceConfirmationDraft } from "@/types/raceConfirmation";
import { buildRaceConfirmationInput, buildRaceConfirmationRevision } from "@/utils/raceConfirmation";
import { evaluateRacePerformance } from "@/utils/racePerformance";
import { RaceConfirmationEditor } from "./RaceConfirmationEditor";
import { createRaceConfirmationPreviewFixtures, SYNTHETIC_AS_OF, SYNTHETIC_TIME_ZONE } from "./raceConfirmationPreviewFixtures";

const statusLabels = {
  verified: "Official result verified",
  owner_confirmed: "Owner confirmed",
  recorded_unverified: "Recorded, unverified",
  inconsistent: "Timing or identity conflict",
  insufficient_evidence: "Insufficient evidence",
};

/** No backend, persistence, auth, route navigation or owner data enters this demo. */
export function RaceConfirmationPreview() {
  const [fixtures, setFixtures] = useState(createRaceConfirmationPreviewFixtures);
  const latestFixtures = useRef(fixtures);
  const sequence = useRef(0);
  const [selectedId, setSelectedId] = useState("synthetic-autumn-half");
  const [editorOpen, setEditorOpen] = useState(true);
  const [savedMessage, setSavedMessage] = useState("");
  const [asOf, setAsOf] = useState(SYNTHETIC_AS_OF);
  const [resetGeneration, setResetGeneration] = useState(0);
  const race = fixtures.races.find(record => record.id === selectedId)!;
  const workout = fixtures.workouts.find(record => record.workoutId === race.actualRunId)!;
  const evaluation = evaluateRacePerformance({ races: fixtures.races, workouts: fixtures.workouts, asOf, timeZone: SYNTHETIC_TIME_ZONE });

  async function saveInMemory(draft: RaceConfirmationDraft) {
    const current = latestFixtures.current.races.find(record => record.id === race.id)!;
    const input = buildRaceConfirmationInput({ race, workout, override: null, timeZone: SYNTHETIC_TIME_ZONE,
      draft, requestId: `synthetic-request-${sequence.current + 1}` });
    const availableAt = new Date(Date.parse(SYNTHETIC_AS_OF) + (sequence.current + 1) * 60_000).toISOString();
    const revision = buildRaceConfirmationRevision(input, current.confirmationHistory ?? null, availableAt);
    const updatedRace = { ...current, confirmationHistory: {
      schemaVersion: 1 as const, chronology: "client_document_untrusted" as const,
      currentRevisionId: revision.revisionId,
      revisions: { ...current.confirmationHistory?.revisions, [revision.revisionId]: revision },
    } };
    const updated = { ...latestFixtures.current, races: latestFixtures.current.races.map(record => record.id === race.id ? updatedRace : record) };
    latestFixtures.current = updated;
    sequence.current += 1;
    setFixtures(updated);
    setAsOf(availableAt);
    setSavedMessage(`Synthetic revision ${revision.revisionNumber} saved in memory for ${race.name}.`);
  }

  function reset() {
    const fresh = createRaceConfirmationPreviewFixtures();
    latestFixtures.current = fresh;
    sequence.current = 0;
    setFixtures(fresh);
    setResetGeneration(value => value + 1);
    setAsOf(SYNTHETIC_AS_OF);
    setSavedMessage("Synthetic examples reset. No saved data was changed.");
    setEditorOpen(true);
  }

  return <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 text-textPrimary sm:px-6" data-testid="race-confirmation-preview">
    <header className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-widest text-primary">Synthetic sandbox · Development / preview only</p>
      <h1 className="text-3xl font-bold tracking-tight text-textPrimary">Confirm a race result</h1>
      <p className="max-w-3xl text-sm leading-6 text-textSecondary">Try the real confirmation editor with invented races. Changes stay in this page’s memory and disappear on reload. No sign-in or owner records are used.</p>
    </header>

    <section aria-label="Synthetic race selection" className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">Choose an example</h2><p className="mt-1 text-sm text-textSecondary">Spring has conflicting clocks; autumn has matching clocks. Both start unverified.</p></div>
        <button type="button" onClick={reset} className="rounded-lg border border-border px-3 py-2 text-sm font-medium">Reset examples</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {fixtures.races.map(record => <button key={record.id} type="button" aria-pressed={selectedId === record.id}
          onClick={() => { setSelectedId(record.id); setEditorOpen(true); setSavedMessage(""); }}
          className={`min-w-0 rounded-xl border p-4 text-left ${selectedId === record.id ? "border-primary bg-primary/10" : "border-border"}`}>
          <span className="block font-semibold">{record.name}</span>
          <span className="mt-1 block text-sm text-textSecondary">{record.raceDate} · {record.id.includes("spring") ? "Recorded 2:08:00 · elapsed 2:17:00" : "Recorded and elapsed 2:04:00"}</span>
        </button>)}
      </div>
      <p className="mt-4 text-sm leading-6 text-textSecondary">For a synthetic official-source example, use <span className="break-all font-mono">https://example.com/synthetic-results</span>. For owner confirmation, write an explicit invented attestation. A timing conflict needs an explanation; matching clocks alone do not establish verification or maximal effort.</p>
    </section>

    {savedMessage && <p role="status" className="rounded-xl border border-success/30 bg-success/10 p-4 text-sm text-success">{savedMessage}</p>}
    <section aria-label="Synthetic confirmation editor" className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
      {editorOpen ? <RaceConfirmationEditor key={`${race.id}:${race.confirmationHistory?.currentRevisionId ?? "unconfirmed"}:${resetGeneration}`} race={race} workout={workout} onSave={saveInMemory}
        onClose={() => setEditorOpen(false)} timeZone={SYNTHETIC_TIME_ZONE} submitLabel="Save synthetic confirmation" />
        : <button type="button" onClick={() => setEditorOpen(true)} className="rounded-lg bg-primary px-4 py-2 font-medium text-white">Review or correct {race.name}</button>}
    </section>

    <section aria-label="Synthetic evidence outcome" className="rounded-2xl border border-border bg-card p-4 sm:p-6">
      <h2 className="text-lg font-semibold">Evidence after confirmation</h2>
      <p className="mt-2 text-sm leading-6 text-textSecondary">The existing evidence evaluator uses these sample observations. Review-clock timestamps are simulated. Saved revision chronology remains untrusted for historical predictors.</p>
      <ol className="mt-4 space-y-3">
        {evaluation.evidence.map(evidence => <li key={evidence.raceId} className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{evidence.name}</h3><span className="text-sm">{statusLabels[evidence.status]}</span></div>
          <p className="mt-1 text-sm text-textSecondary">Event date: {evidence.raceDate} · Timing: {evidence.timingAgreement}</p>
          <p className="mt-2 text-sm">{evidence.eligibleSameDistanceBenchmark ? "Eligible dated historical benchmark" : "Not an eligible confirmed historical benchmark"}</p>
        </li>)}
      </ol>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-surface p-4"><h3 className="text-sm font-medium text-textSecondary">Current capability estimate</h3><p className="mt-1 text-lg font-semibold">Unavailable</p></div>
        <div className="rounded-xl bg-surface p-4"><h3 className="text-sm font-medium text-textSecondary">Race-day forecast</h3><p className="mt-1 text-lg font-semibold">Withheld</p></div>
      </div>
      <p className="mt-3 text-sm text-textSecondary">Confirmation improves the evidence record. It does not validate a numerical prediction or confidence interval.</p>
    </section>
  </main>;
}
