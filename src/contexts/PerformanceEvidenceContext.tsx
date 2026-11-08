/**
 * DORMANT (2026-11): the app shell no longer mounts this provider because its only consumers were the retired manual
 * Performance Analysis surfaces. Mounting it again re-enables the one-document saved-analysis read on first consumer use.
 */
"use client";

import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { User } from "firebase/auth";
import { useAppData } from "./AppDataContext";
import { capturePerformanceSession, getSavedPerformance } from "@/services/performancePersistence";
import { adaptSavedManualPerformance } from "@/utils/sharedPerformanceEvidence";
import { createPerformanceSessionStore } from "@/utils/performanceSessionStore";
import { assessPerformanceFreshness, observePerformanceMetadata } from "@/utils/performanceFreshness";

interface Props {
  user: User;
  sessionEpoch: number;
  isSessionCurrent: (epoch: number) => boolean;
  children: React.ReactNode;
}

const PerformanceEvidenceContext = createContext<ReturnType<typeof useOwnedPerformanceEvidence> | null>(null);

export function PerformanceEvidenceProvider(props: Props) {
  return <OwnedPerformanceEvidenceProvider key={`${props.user.uid}:${props.sessionEpoch}`} {...props} />;
}

function useOwnedPerformanceEvidence({ user, sessionEpoch, isSessionCurrent }: Props) {
  const app = useAppData();
  const [store] = useState(() => createPerformanceSessionStore({
    isCurrent: () => isSessionCurrent(sessionEpoch),
    load: async () => (await getSavedPerformance(await capturePerformanceSession({ user, sessionEpoch, isSessionCurrent }))).current,
    now: () => new Date().toISOString(),
  }));
  useLayoutEffect(() => {
    store.activate();
    return () => store.deactivate();
  }, [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { current: saved, status, origin, retrievedAt, error, observation } = state;
  const evidence = useMemo(() => adaptSavedManualPerformance(saved, {
    owner: { uid: user.uid, sessionEpoch },
    retrieval: { status: status === "available" || status === "absent" ? "success" : status,
      origin, retrievedAt, error },
    // No assumed applicability or SDK commit date. Assessment remains separate.
  }), [saved, status, origin, retrievedAt, error, user.uid, sessionEpoch]);
  const input = useMemo(() => ({ evidence, workouts: app.workouts, overrides: app.overrides,
    sources: {
      workouts: { hasLoaded: app.sourceHasLoaded.workouts, resolution: app.workoutsResolution },
      overrides: { hasLoaded: app.sourceHasLoaded.overrides, resolution: app.overridesResolution },
    }, workoutsHistoryComplete: app.workoutsHistoryComplete, now: new Date().toISOString(),
  }), [evidence, app.workouts, app.overrides, app.sourceHasLoaded.workouts, app.sourceHasLoaded.overrides,
    app.workoutsResolution, app.overridesResolution, app.workoutsHistoryComplete]);
  useEffect(() => {
    if (observation?.publicationDigest === evidence.evidence?.value.publication.publicationDigest) return;
    const next = observePerformanceMetadata(input);
    if (next) store.rememberObservation(next);
  }, [observation, evidence, input, store]);
  const freshness = useMemo(() => assessPerformanceFreshness({ ...input, observation }), [input, observation]);
  return useMemo(() => ({ state, evidence, freshness, ...store }), [state, evidence, freshness, store]);
}

function OwnedPerformanceEvidenceProvider(props: Props) {
  const value = useOwnedPerformanceEvidence(props);
  return <PerformanceEvidenceContext.Provider value={value}>{props.children}</PerformanceEvidenceContext.Provider>;
}

/** Only Insights consumers activate the one-document load. Other routes retain
 * the dormant owner; navigation and concurrent consumers reuse the same promise. */
export function usePerformanceEvidence() {
  const value = useContext(PerformanceEvidenceContext);
  if (!value) throw new Error("usePerformanceEvidence requires PerformanceEvidenceProvider");
  const { ensureLoaded } = value;
  useEffect(() => { void ensureLoaded(); }, [ensureLoaded]);
  return value;
}
