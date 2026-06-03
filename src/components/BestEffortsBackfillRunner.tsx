"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { backfillBestEfforts } from "@/services/healthWorkouts";

declare global {
  interface Window {
    trainingBackfillBestEfforts?: () => Promise<{
      scanned: number;
      computed: number;
      skippedAlreadyDone: number;
      skippedNoRoute: number;
    }>;
  }
}

/**
 * Manual maintenance hook for the Best Efforts backfill.
 *
 * Existing maintenance work uses render-null layout components. This one does
 * not auto-run; authenticated users can invoke `trainingBackfillBestEfforts()`
 * from the browser console when they intentionally want to backfill GPS runs.
 */
export default function BestEffortsBackfillRunner() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    window.trainingBackfillBestEfforts = () => backfillBestEfforts(user.uid);

    return () => {
      if (window.trainingBackfillBestEfforts) {
        delete window.trainingBackfillBestEfforts;
      }
    };
  }, [user]);

  return null;
}
