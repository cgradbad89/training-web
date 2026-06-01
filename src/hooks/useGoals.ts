"use client";

import { useState, useEffect } from "react";
import { type RunningGoal } from "@/types/goal";
import { fetchGoals } from "@/services/goals";

interface UseGoalsState {
  goals: RunningGoal[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useGoals(uid: string | null): UseGoalsState {
  const [goals, setGoals] = useState<RunningGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    // Guard null uid INSIDE the effect (hook is always called — no early return).
    if (!uid) {
      setGoals([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchGoals(uid)
      .then((data) => {
        if (!cancelled) setGoals(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [uid, rev]);

  return { goals, loading, error, refresh: () => setRev((r) => r + 1) };
}
