"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { isRunWorkout, type HealthWorkout } from "@/types/healthWorkout";
import { type ManualActivityKind } from "@/utils/manualActivity";
import { ManualActivityModal } from "./ManualActivityModal";

const SUCCESS_VISIBLE_MS = 6000;

/** Shared Add Activity entry point used by Dashboard, Runs and Workouts. */
export function AddActivityButton({
  defaultKind,
  onCreated,
}: {
  defaultKind: ManualActivityKind;
  onCreated?: (workout: HealthWorkout) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<HealthWorkout | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), SUCCESS_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  return (
    <>
      <button
        type="button"
        onClick={() => { setSaved(null); setOpen(true); }}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Activity
      </button>
      {saved && (
        <div
          role="status"
          className="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 whitespace-nowrap rounded-xl border border-border bg-card px-4 py-2 text-sm text-textPrimary shadow-lg lg:bottom-6"
        >
          Activity saved
          {isRunWorkout(saved) ? (
            <Link href={`/runs/${saved.workoutId}`} className="ml-2 font-medium text-primary hover:underline">
              View run
            </Link>
          ) : (
            <Link href="/workouts" className="ml-2 font-medium text-primary hover:underline">
              View workouts
            </Link>
          )}
        </div>
      )}
      {open && (
        <ManualActivityModal
          mode={{ type: "create", defaultKind }}
          onClose={() => setOpen(false)}
          onSaved={(workout) => {
            setOpen(false);
            setSaved(workout);
            onCreated?.(workout);
          }}
        />
      )}
    </>
  );
}
