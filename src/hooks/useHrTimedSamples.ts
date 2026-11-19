"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchHRStream } from "@/services/hrStream";
import { hrTimedSamplesFromStream, type HrTimedSample } from "@/utils/hrTarget";

/**
 * Per-sample HR (seconds since start) for one workout, from the existing
 * `fetchHRStream` loader (the hrStream subcollection). Reads NOTHING unless
 * `enabled`, and at most once per workoutId for the life of the component.
 * Results arriving after unmount are ignored. `samples` is null while loading,
 * when disabled, and after a failed read.
 */
export function useHrTimedSamples(
  workoutId: string | null,
  enabled: boolean
): { samples: HrTimedSample[] | null; loading: boolean } {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const key = uid && workoutId ? `${uid}/${workoutId}` : null;

  const [results, setResults] = useState<Record<string, HrTimedSample[] | null>>({});
  const requested = useRef<Set<string>>(new Set());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !key || !uid || !workoutId) return;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    fetchHRStream(uid, workoutId)
      .then((stream) => {
        if (mounted.current) {
          setResults((r) => ({ ...r, [key]: hrTimedSamplesFromStream(stream) }));
        }
      })
      .catch((err) => {
        console.error("[useHrTimedSamples]", err);
        if (mounted.current) setResults((r) => ({ ...r, [key]: null }));
      });
  }, [enabled, key, uid, workoutId]);

  const samples = key != null && key in results ? results[key] : null;
  const loading = enabled && key != null && !(key in results);
  return { samples, loading };
}
