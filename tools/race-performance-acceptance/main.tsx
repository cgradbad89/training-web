import "./research/style.css";
import { normalizeWorkoutResearchExport } from "../../src/utils/workoutResearchInput";
import { ResearchPanel } from "./research/ResearchPanel";
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RacePerformancePanel } from '../../src/components/insights/RacePerformancePanel';
import { buildRaceTrainingContext } from '../../src/utils/raceTrainingContext';
import { evaluateRacePerformance } from '../../src/utils/racePerformance';
import { createAcceptanceSession, type AcceptanceSession, type AcceptanceIdentity } from './connection';
import type { AcceptanceSources, ParentRead } from './loader';
import { scopeAcceptanceSources } from './loader';
import type { installRuntimeGuard } from './runtimeGuard';

type Guard = ReturnType<typeof installRuntimeGuard>;
type Config = Parameters<typeof createAcceptanceSession>[0];
const EMPTY = { races: [], workouts: [], overrides: {}, plan: null, selectedRace: null };
const TIME_ZONE = 'America/New_York';
const SAVED_AS_OF = new Date('2026-10-23T03:59:59.999Z');

function Acceptance({ guard, config }: { guard: Guard; config: Config }) {
  const [session, setSession] = useState<AcceptanceSession | null>(null);
  const [identity, setIdentity] = useState<AcceptanceIdentity | null>(null);
  const [rawSources, setSources] = useState<AcceptanceSources | null>(null);
  const [parentInspection, setParentInspection] = useState<ParentRead[] | null>(null);
  const [status, setStatus] = useState('Isolated. No authentication or source reads yet.');
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [mode, setMode] = useState<'owner' | 'empty' | 'unavailable'>('owner');
  const [planId, setPlanId] = useState('');
  const [instrumentation, setInstrumentation] = useState(guard.snapshot());
  const [asOf, setAsOf] = useState(() => new Date());
  const sources = rawSources ? scopeAcceptanceSources(rawSources, { asOfs: [asOf, SAVED_AS_OF], timeZone: TIME_ZONE }) : null;
  async function signIn() {
    setBusy(true);
    let next: AcceptanceSession | null = null;
    try {
      next = createAcceptanceSession(config, () => {
        guard.revokeOwner(); setIdentity(null); setSources(null); setParentInspection(null); setStopped(true);
        setStatus('BLOCKED: owner session changed. Close this harness.');
      });
      setSession(next);
      const owner = await next.signIn();
      guard.authorizeOwner(owner.uid); setIdentity(owner);
      setStatus('Verified owner signed in with in-memory authentication. Parent records have not been read.');
    } catch (error) {
      guard.revokeOwner(); await next?.dispose(); setSession(null); setStopped(true);
      setStatus(`BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); setInstrumentation(guard.snapshot()); }
  }
  async function load() {
    if (!session) return;
    setBusy(true);
    try {
      const raw = await session.load();
      const loaded = scopeAcceptanceSources(raw, { asOfs: [new Date(raw.loadedAt), SAVED_AS_OF], timeZone: TIME_ZONE });
      setSources(loaded); setAsOf(new Date(loaded.loadedAt));
      const targets = loaded.races.filter(race => race.raceDate === '2027-03-20' && race.raceDistance === 'halfMarathon');
      const linked = targets.length === 1 ? loaded.plans.find(plan => plan.id === targets[0].linkedPlanId) : null;
      const active = loaded.plans.filter(plan => plan.status === 'active');
      setPlanId(linked?.id ?? (active.length === 1 ? active[0].id : ''));
      setStatus(loaded.sourcesReady ? (loaded.invalidWorkouts.length > 0 ? `Reporting-window evaluation ready with ${loaded.invalidWorkouts.length} historical distance-unknown parents excluded. Full-history completeness is not established.` : 'Server parent reads complete within declared bounds.') : 'BLOCKED: one or more source scopes are unavailable, malformed or materially relevant. See diagnostics; missing data is not zero.');
      if (!loaded.sourcesReady) { setStopped(true); guard.revokeOwner(); await session.dispose(); }
    } catch (error) {
      setStatus(`BLOCKED: isolated source loading failed: ${error instanceof Error ? error.message : String(error)}`);
      setStopped(true); guard.revokeOwner(); await session.dispose();
    } finally { setBusy(false); setInstrumentation(guard.snapshot()); }
  }
  async function inspectParents() {
    if (!session) return;
    setBusy(true);
    try { setParentInspection(await session.inspectInvalidParents()); setStatus('Exactly two owner workout parents inspected. No collection or child reads performed by this action.'); }
    catch (error) { setStatus(`BLOCKED: parent inspection failed: ${error instanceof Error ? error.message : String(error)}`); setStopped(true); guard.revokeOwner(); await session.dispose(); }
    finally { setBusy(false); setInstrumentation(guard.snapshot()); }
  }
  async function dispose() {
    guard.revokeOwner(); await session?.dispose(); setIdentity(null); setSources(null); setParentInspection(null); setStopped(true);
    setStatus('Session disposed. In-memory credentials and Firebase app discarded. Close this tab.'); setInstrumentation(guard.snapshot());
  }
  const targets = sources?.races.filter(race => race.raceDate === '2027-03-20' && race.raceDistance === 'halfMarathon') ?? [];
  const selectedRace = targets.length === 1 ? targets[0] : null;
  const plan = sources?.plans.find(item => item.id === planId) ?? null;
  const props = mode === 'owner' && sources ? { races: sources.races, workouts: sources.workouts, overrides: sources.overrides, plan, selectedRace } : EMPTY;
  const ready = mode === 'empty' || (mode === 'owner' && sources?.sourcesReady === true);
  const training = sources?.sourcesReady ? buildRaceTrainingContext({ workouts: sources.workouts, overrides: sources.overrides, plan, asOf, timeZone: TIME_ZONE, targetRaceDate: '2027-03-20' }) : null;
  const performance = sources?.sourcesReady ? evaluateRacePerformance({ races: sources.races, workouts: sources.workouts, overrides: sources.overrides, asOf: asOf.toISOString(), timeZone: TIME_ZONE, targetDistanceMeters: 21097.5 }) : null;
  const savedWindow = sources?.sourcesReady ? buildRaceTrainingContext({ workouts: sources.workouts, overrides: sources.overrides, plan, asOf: SAVED_AS_OF, timeZone: TIME_ZONE, targetRaceDate: '2027-03-20' }) : null;
  return <main className="acceptance-shell">
    <header><h1>Phase 3A isolated owner acceptance</h1><p>Local developer tool · Firestore Lite server reads · no cache or write queue · in-memory authentication</p></header>
    <section className="acceptance-controls">
      <p role="status">{status}</p>
      <div className="acceptance-actions">
        <button disabled={busy || stopped || !!identity} onClick={signIn}>Sign in as owner</button>
        <button disabled={busy || stopped || !identity || !!parentInspection} onClick={inspectParents}>Inspect exactly two invalid parents</button>
        <button disabled={busy || stopped || !identity || !!sources} onClick={load}>Read bounded owner parents</button>
        <button disabled={busy || !session} onClick={dispose}>Dispose isolated session</button>
      </div>
      {identity && <p>{identity.email} · unique app: {identity.appName}</p>}
      <p>Snapshot: {asOf.toISOString()} · {TIME_ZONE}. No normal application shell, route points or HR streams are mounted.</p>
      <label>Component state <select value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="owner">Authenticated owner data</option><option value="empty">Synthetic empty account</option><option value="unavailable">Unavailable sources</option>
      </select></label>
      {sources && <label>Read-only plan context <select value={planId} onChange={event => setPlanId(event.target.value)}>
        <option value="">No selected plan</option>{sources.plans.map(item => <option value={item.id} key={item.id}>{item.name} ({item.status})</option>)}
      </select></label>}
      {mode !== 'owner' && <p className="acceptance-state-label">Component state test: {mode}. This is not actual owner data.</p>}
      {parentInspection && <details open><summary>Two-parent diagnostic records</summary><pre data-testid="parent-inspection">{JSON.stringify(parentInspection, null, 2)}</pre></details>}
      <details open><summary>Isolation instrumentation</summary><pre data-testid="isolation-diagnostics">{JSON.stringify(instrumentation, null, 2)}</pre><p>Denied IndexedDB capability probes never invoke the native store. No persistent database can be opened by this page. Read counts contain no tokens or request bodies.</p></details>
    </section>
    {sources?.reportingScope && <section className="acceptance-controls"><p>Scoped source disclosure: {sources.workouts.length} valid parents retained; {sources.invalidWorkouts.length} historical parents with unknown distance excluded. Unknown distance is not zero. Scope proof covers both reporting clocks and every selectable plan.</p><details><summary>Reporting-window exclusion proof</summary><pre data-testid="reporting-scope">{JSON.stringify(sources.reportingScope, null, 2)}</pre></details></section>}
    <div data-testid="actual-panel"><RacePerformancePanel {...props} sourcesReady={ready} asOf={asOf} timeZone={TIME_ZONE} /></div>
    {sources?.sourcesReady && <ResearchPanel input={normalizeWorkoutResearchExport({ races: sources.races, workouts: sources.workouts, overrides: sources.overrides, invalidWorkouts: sources.invalidWorkouts, reportingScope: sources.reportingScope,
      asOf: asOf.toISOString(), capturedAt: sources.loadedAt, timeZone: TIME_ZONE, source: "owner_parent_export",
      complete: {workouts: true, races: true, overrides: true} })} />}
    {sources && <section className="acceptance-controls"><h2>Server provenance and canonical parent records</h2>
      <p>Plans loaded: {sources.plans.length}. Target race matches: {targets.length}. Multiple target matches require explicit reconciliation.</p>
      <details open><summary>Source completeness</summary><pre data-testid="source-diagnostics">{JSON.stringify(sources.diagnostics, null, 2)}</pre></details>
      <details><summary>Exact parent records and calculation outputs</summary><pre data-testid="owner-records">{JSON.stringify({ loadedAt: sources.loadedAt, races: sources.races, workouts: sources.workouts, overrides: sources.overrides, plans: sources.plans, selectedPlanId: planId, invalidWorkouts: sources.invalidWorkouts, reportingScope: sources.reportingScope, performance, training, savedWindow }, null, 2)}</pre></details>
    </section>}
  </main>;
}

export async function mountAcceptance(guard: Guard) {
  const host = document.getElementById('root');
  if (!host) throw new Error('Missing acceptance root');
  try {
    const response = await fetch('/acceptance-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Explicit public Firebase config unavailable');
    const config = await response.json() as Config;
    createRoot(host).render(<Acceptance guard={guard} config={config} />);
  } catch (error) { host.textContent = `BLOCKED: ${error instanceof Error ? error.message : String(error)}`; }
}
