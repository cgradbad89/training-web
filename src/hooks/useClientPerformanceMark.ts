"use client";

import { useEffect, useRef } from "react";

export interface ClientPerformanceDetail {
  [key: string]: string | number | boolean | null;
}

export function markClientPerformance(
  name: string,
  detail?: ClientPerformanceDetail
): void {
  if (typeof window === "undefined") return;
  const perf = window.performance;
  if (!perf || typeof perf.mark !== "function") return;
  try {
    perf.mark(name, detail ? { detail } : undefined);
    console.info("[client-performance]", { event: "mark", name, ...detail });
  } catch {
    // Performance instrumentation must never affect the product flow.
  }
}

export function measureClientPerformance(
  name: string,
  startMark: string,
  endMark: string,
  detail?: ClientPerformanceDetail
): number | null {
  if (typeof window === "undefined") return null;
  const perf = window.performance;
  if (!perf || typeof perf.measure !== "function") return null;
  try {
    perf.measure(name, startMark, endMark);
    const entries = perf.getEntriesByName(name, "measure");
    const duration = entries.at(-1)?.duration ?? null;
    console.info("[client-performance]", {
      event: "measure",
      name,
      durationMs: duration === null ? null : Math.round(duration),
      ...detail,
    });
    return duration;
  } catch {
    return null;
  }
}

export function useClientPerformanceMark(
  name: string,
  ready: boolean,
  options?: {
    measureFrom?: string;
    measureName?: string;
    detail?: ClientPerformanceDetail;
  }
): void {
  const markedRef = useRef(false);
  const measureFrom = options?.measureFrom;
  const measureName = options?.measureName;
  const detail = options?.detail;

  useEffect(() => {
    if (!ready || markedRef.current) return;
    markedRef.current = true;
    markClientPerformance(name, detail);
    if (measureFrom && measureName) {
      measureClientPerformance(measureName, measureFrom, name, detail);
    }
  }, [detail, measureFrom, measureName, name, ready]);
}
