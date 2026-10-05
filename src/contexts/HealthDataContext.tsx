"use client";

import React, { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { fetchHealthMetricsRange } from "@/services/healthMetrics";
import { HealthMetricsStore } from "@/utils/healthMetricsStore";

const HealthDataContext = createContext<HealthMetricsStore | null>(null);
const HealthActivityContext = createContext(false);

interface HealthDataProviderProps {
  children: React.ReactNode;
  uid: string;
  sessionEpoch: number;
  isSessionCurrent: (epoch: number) => boolean;
  healthActive: boolean;
}

export function HealthDataProvider(props: HealthDataProviderProps) {
  return <HealthDataOwner key={`${props.uid}:${props.sessionEpoch}`} {...props} />;
}

function HealthDataOwner({ children, uid, sessionEpoch, isSessionCurrent, healthActive }: HealthDataProviderProps) {
  // The shell contains no metric cache. Only mounted Health consumers subscribe
  // or request data; resident Health updates cannot recompute training pages.
  const [store] = useState(() => new HealthMetricsStore(uid, fetchHealthMetricsRange, () => isSessionCurrent(sessionEpoch)));
  useLayoutEffect(() => {
    store.activate(false);
    return () => store.retire();
  }, [store]);
  useLayoutEffect(() => { store.setActive(healthActive); }, [healthActive, store]);
  return (
    <HealthDataContext.Provider value={store}>
      <HealthActivityContext.Provider value={healthActive}>{children}</HealthActivityContext.Provider>
    </HealthDataContext.Provider>
  );
}

export function useHealthActivity() { return useContext(HealthActivityContext); }

export function useHealthData() {
  const store = useContext(HealthDataContext);
  if (!store) throw new Error("useHealthData must be used within HealthDataProvider");
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, ensureRange: store.ensureRange };
}
