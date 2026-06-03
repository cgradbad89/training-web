"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { backfillBestEfforts } from "@/services/healthWorkouts";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";

type BackfillStats = {
  scanned: number;
  computed: number;
  skippedAlreadyDone: number;
  skippedNoRoute: number;
};

declare global {
  interface Window {
    trainingBackfillBestEfforts?: () => Promise<BackfillStats>;
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
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<BackfillStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    window.trainingBackfillBestEfforts = () => backfillBestEfforts(user.uid);

    return () => {
      if (window.trainingBackfillBestEfforts) {
        delete window.trainingBackfillBestEfforts;
      }
    };
  }, [user]);

  async function handleBackfill() {
    if (!user || running) return;

    setRunning(true);
    setError(null);
    try {
      const result = await backfillBestEfforts(user.uid);
      setStats(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      setError(message);
    } finally {
      setRunning(false);
    }
  }

  if (!user) return null;

  return (
    <aside className="fixed right-4 bottom-24 lg:bottom-4 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-card shadow-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
            Debug / Maintenance
          </p>
          <p className="mt-1 text-sm font-semibold text-textPrimary">
            Best Efforts
          </p>
        </div>
        {running ? <LoadingSpinner size="sm" className="mt-1 shrink-0" /> : null}
      </div>

      <button
        type="button"
        onClick={handleBackfill}
        disabled={running}
        className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {running ? "Backfilling..." : "Backfill Best Efforts (GPS runs)"}
      </button>

      {stats ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-surface border border-border p-2">
            <dt className="text-textSecondary">Scanned</dt>
            <dd className="text-sm font-semibold text-textPrimary">
              {stats.scanned}
            </dd>
          </div>
          <div className="rounded-lg bg-surface border border-border p-2">
            <dt className="text-textSecondary">Computed</dt>
            <dd className="text-sm font-semibold text-textPrimary">
              {stats.computed}
            </dd>
          </div>
          <div className="rounded-lg bg-surface border border-border p-2">
            <dt className="text-textSecondary">Skipped already-done</dt>
            <dd className="text-sm font-semibold text-textPrimary">
              {stats.skippedAlreadyDone}
            </dd>
          </div>
          <div className="rounded-lg bg-surface border border-border p-2">
            <dt className="text-textSecondary">Skipped no-route</dt>
            <dd className="text-sm font-semibold text-textPrimary">
              {stats.skippedNoRoute}
            </dd>
          </div>
        </dl>
      ) : null}

      {error ? (
        <p className="mt-3 text-xs font-medium text-danger">{error}</p>
      ) : null}
    </aside>
  );
}
