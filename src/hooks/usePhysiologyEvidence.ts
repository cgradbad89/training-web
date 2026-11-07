"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { Vo2Entry } from "@/utils/vo2History";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { selectStreamCandidates } from "@/utils/performance/hrStreamSelection";
import { fetchHrStreamBounded, fetchVo2EvidenceWindow } from "@/services/physiologyEvidenceFirestore";
import { HrStreamEvidenceStore, Vo2EvidenceStore, type HydrationReport } from "@/services/physiologyEvidenceStores";
import type { LoadState } from "@/utils/performance/hybridPerformanceV11";

/** Module-level, in-memory only: shared by revisits of the page inside one session, never persisted. Keyed per user and sign-in inside the stores. */
export const vo2Store = new Vo2EvidenceStore(fetchVo2EvidenceWindow);
export const hrStreamStore = new HrStreamEvidenceStore(fetchHrStreamBounded);

export interface PhysiologyEvidence {
  vo2: { state: LoadState | "loading"; entries: Vo2Entry[] | undefined; docsRead: number };
  streams: { state: LoadState | "loading"; summaries: Record<string, HrStreamSummary> | undefined; report: Omit<HydrationReport, "summaries"> | null; eligible: number; withStream: number };
}
const idle: PhysiologyEvidence = { vo2: { state: "not_requested", entries: undefined, docsRead: 0 }, streams: { state: "not_requested", summaries: undefined, report: null, eligible: 0, withStream: 0 } };

export interface PhysiologyEvidenceArgs {
  enabled: boolean;
  uid: string | null;
  sessionEpoch: number;
  isSessionCurrent: (epoch: number) => boolean;
  races: readonly Race[];
  workouts: readonly HealthWorkout[];
  overrides: Record<string, WorkoutOverride>;
  timeZone: string;
  /** The local calendar day the estimate is for; the candidate window moves with it. */
  day: string | null;
  /** Performance inputs fully loaded. Nothing is requested before they are (candidates would be guesses). */
  ready: boolean;
}

/**
 * Demand-driven physiological inputs for the hybrid v1.1 estimate. Reads nothing unless `enabled && ready && uid`. VO₂ is one windowed
 * query; streams are limited to the few runs that can change the aerobic trend. Results are delivered once, only if the session
 * is still the one that asked. A failure is reported as `failed` (the estimate then uses the lower-evidence calculation and says so).
 */
export function usePhysiologyEvidence(a: PhysiologyEvidenceArgs): PhysiologyEvidence {
  // Every state is tagged with the session that produced it, so another account (or a new sign-in) can never be shown a previous
  // session's readings even for the instant before its own load starts.
  const [vo2State, setVo2] = useState<{ key: string | null; value: PhysiologyEvidence["vo2"] }>({ key: null, value: idle.vo2 });
  const [streamState, setStreams] = useState<{ key: string | null; value: PhysiologyEvidence["streams"] }>({ key: null, value: idle.streams });
  const sessionKey = a.uid ? `${a.uid}:${a.sessionEpoch}` : null;
  const active = a.enabled && a.ready && sessionKey !== null;

  // Candidate selection is a pure function of loaded data; recomputed only when the underlying lists or the day change.
  const selection = useMemo(() => {
    if (!active || !a.day) return null;
    const asOf = new Date().toISOString(); // captured once per memo (changes only with the day or the loaded data)
    const { runs } = selectResearchRuns({ races: a.races, workouts: a.workouts, overrides: a.overrides, asOf, capturedAt: asOf, timeZone: a.timeZone, source: "owner_parent_export",
      complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    return selectStreamCandidates({ runs, raceWorkoutIds: new Set(a.races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: performanceLocalDate(asOf, a.timeZone) });
  }, [active, a.day, a.races, a.workouts, a.overrides, a.timeZone]);
  // A stable identity for the candidate set: re-rendering with the same runs must not re-trigger reads.
  const candidateKey = selection ? selection.candidates.map(c => c.cacheKey).join("|") : "";
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!active || !sessionKey) { setVo2({ key: null, value: idle.vo2 }); return; }
    let cancelled = false;
    setVo2(v => (v.key === sessionKey && v.value.state === "loaded" ? v : { key: sessionKey, value: { ...idle.vo2, state: "loading" } }));
    vo2Store.load(a.uid!, a.sessionEpoch, () => !cancelled && a.isSessionCurrent(a.sessionEpoch)).then(r => {
      if (cancelled || !r) return;
      setVo2({ key: sessionKey, value: r.state === "loaded" ? { state: "loaded", entries: r.entries, docsRead: r.docsRead } : { state: "failed", entries: undefined, docsRead: 0 } });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the session identity; isSessionCurrent is stable per provider.
  }, [active, sessionKey]);

  useEffect(() => {
    const sel = selectionRef.current;
    if (!active || !sessionKey || !sel) { setStreams({ key: null, value: idle.streams }); return; }
    if (sel.candidates.length === 0) { setStreams({ key: sessionKey, value: { state: "loaded", summaries: {}, report: null, eligible: sel.eligible, withStream: sel.withStream } }); return; }
    let cancelled = false;
    setStreams(s => (s.key === sessionKey && s.value.state === "loaded" ? s : { key: sessionKey, value: { ...idle.streams, state: "loading", eligible: sel.eligible, withStream: sel.withStream } }));
    hrStreamStore.hydrate(a.uid!, a.sessionEpoch, () => !cancelled && a.isSessionCurrent(a.sessionEpoch), sel.candidates).then(r => {
      if (cancelled || !r) return;
      const { summaries, ...report } = r;
      setStreams({ key: sessionKey, value: { state: r.state === "failed" ? "failed" : "loaded", summaries: r.state === "failed" ? undefined : summaries, report, eligible: sel.eligible, withStream: sel.withStream } });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candidateKey is the stable identity of the candidate set.
  }, [active, sessionKey, candidateKey]);

  if (!active) return idle;
  return {
    vo2: vo2State.key === sessionKey ? vo2State.value : { ...idle.vo2, state: "loading" },
    streams: streamState.key === sessionKey ? streamState.value : { ...idle.streams, state: "loading" },
  };
}
