"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { StatBlock } from "@/components/ui/StatBlock";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkout } from "@/services/healthWorkouts";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { fetchShoes, fetchManualShoeAssignmentsMap } from "@/services/shoes";
import { type HealthWorkout, computeEfficiencyDisplay } from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";
import { formatPace, formatDuration } from "@/utils/pace";
import {
  efficiencyDisplayScore,
  efficiencyLevel,
  distanceBucket,
  driftLevel,
} from "@/utils/metrics";

// Dynamic import — Leaflet requires browser APIs
const RunMap = dynamic(() => import("@/components/RunMap"), { ssr: false });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEffBadgeLevel(
  workout: HealthWorkout
): "good" | "ok" | "low" | "neutral" {
  const hasHR =
    workout.avgHeartRate !== null && (workout.avgSpeedMPS ?? 0) > 0;
  if (!hasHR || !workout.avgHeartRate) return "neutral";
  try {
    const rawScore =
      ((workout.avgSpeedMPS ?? 0) / workout.avgHeartRate) * 1000;
    const level = efficiencyLevel(rawScore, distanceBucket(workout.distanceMiles));
    return level === "good" ? "good" : level === "ok" ? "ok" : "low";
  } catch {
    return "neutral";
  }
}

function getDriftBadgeLevel(
  workout: HealthWorkout
): "good" | "ok" | "high" | "neutral" {
  if (workout.hrDriftPct == null) return "neutral";
  const level = driftLevel(workout.hrDriftPct, distanceBucket(workout.distanceMiles));
  return level;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workoutId = params.id as string;
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [workout, setWorkout] = useState<HealthWorkout | null>(null);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string | null>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(true);

  useEffect(() => {
    if (!uid || !workoutId) return;
    setLoading(true);

    Promise.all([
      fetchHealthWorkout(uid, workoutId),
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
    ])
      .then(([w, s, a]) => {
        setWorkout(w);
        setShoes(s);
        setAssignments(a);

        // Fetch route only if workout has one
        if (w?.hasRoute) {
          fetchRoutePoints(uid, workoutId)
            .then(setRoutePoints)
            .catch(console.error)
            .finally(() => setRouteLoading(false));
        } else {
          setRouteLoading(false);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid, workoutId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!workout) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-textSecondary">Workout not found</p>
        <button
          onClick={() => router.back()}
          className="text-primary text-sm font-medium"
        >
          Go back
        </button>
      </div>
    );
  }

  // Shoe assignment
  const assignedShoeId = assignments[workout.workoutId] ?? null;
  const assignedShoe = shoes.find((s) => s.id === assignedShoeId) ?? null;
  const shoeName = assignedShoe
    ? assignedShoe.name || `${assignedShoe.brand} ${assignedShoe.model}`.trim()
    : null;

  // Date formatting
  const startDate = new Date(workout.startDate);
  const dateDisplay = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const fullDateDisplay = startDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeDisplay = startDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  // Efficiency
  const effDisplay = computeEfficiencyDisplay(workout);
  const effBadgeLevel = getEffBadgeLevel(workout);
  const effStr = effDisplay != null ? effDisplay.toFixed(1) : "—";

  // HR Drift
  const driftBadgeLevel = getDriftBadgeLevel(workout);
  const driftStr =
    workout.hrDriftPct != null ? `${workout.hrDriftPct.toFixed(1)}%` : "—";

  return (
    <div className="max-w-4xl mx-auto p-4 lg:p-6 flex flex-col gap-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="p-2 rounded-xl hover:bg-surface transition-colors text-textSecondary"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-textPrimary truncate">
            {workout.displayType} &middot; {dateDisplay}
          </h1>
        </div>
        {shoeName && (
          <span className="text-xs bg-success/10 text-success px-2.5 py-1 rounded-full font-medium shrink-0">
            {shoeName}
          </span>
        )}
      </div>

      {/* ── Stats Grid ──────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 gap-5">
          <StatBlock
            label="Distance"
            value={workout.distanceMiles > 0 ? workout.distanceMiles.toFixed(2) : "—"}
            unit={workout.distanceMiles > 0 ? "mi" : undefined}
          />
          <StatBlock
            label="Pace"
            value={
              workout.avgPaceSecPerMile
                ? formatPace(workout.avgPaceSecPerMile)
                : "—"
            }
            unit={workout.avgPaceSecPerMile ? "/mi" : undefined}
          />
          <StatBlock
            label="Duration"
            value={formatDuration(workout.durationSeconds)}
          />
          <StatBlock
            label="Avg HR"
            value={
              workout.avgHeartRate
                ? Math.round(workout.avgHeartRate).toString()
                : "—"
            }
            unit={workout.avgHeartRate ? "bpm" : undefined}
          />
          <StatBlock
            label="Calories"
            value={
              workout.calories
                ? Math.round(workout.calories).toString()
                : "—"
            }
            unit={workout.calories ? "kcal" : undefined}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500 uppercase tracking-wide">
              Efficiency
            </span>
            <MetricBadge
              label="Eff"
              value={effStr}
              level={effStr === "—" ? "neutral" : effBadgeLevel}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500 uppercase tracking-wide">
              HR Drift
            </span>
            <MetricBadge
              label="Drift"
              value={driftStr}
              level={driftStr === "—" ? "neutral" : driftBadgeLevel}
            />
          </div>
          <StatBlock
            label="Cadence"
            value={
              workout.cadenceSPM != null
                ? Math.round(workout.cadenceSPM).toString()
                : "—"
            }
            unit={workout.cadenceSPM != null ? "spm" : undefined}
          />
        </div>

        {/* Second row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mt-5 pt-5 border-t border-border">
          <StatBlock
            label="Elevation Gain"
            value={
              workout.elevationGainM != null
                ? Math.round(workout.elevationGainM).toString()
                : "—"
            }
            unit={workout.elevationGainM != null ? "m" : undefined}
          />
          <StatBlock
            label="Date & Time"
            value={fullDateDisplay}
            sublabel={timeDisplay}
          />
        </div>
      </div>

      {/* ── Route Map ───────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {workout.hasRoute ? (
          routeLoading ? (
            <div className="h-64 sm:h-96 bg-surface animate-pulse" />
          ) : routePoints.length > 0 ? (
            <RunMap points={routePoints} />
          ) : (
            <div className="h-64 sm:h-96 flex items-center justify-center">
              <p className="text-sm text-textSecondary">
                Route data not yet synced
              </p>
            </div>
          )
        ) : (
          <div className="h-40 flex items-center justify-center">
            <p className="text-sm text-textSecondary">
              No GPS route available for this run
            </p>
          </div>
        )}
      </div>

      {/* ── Splits ──────────────────────────────────────────── */}
      {/* TODO: Fetch splits from users/{uid}/healthWorkouts/{id}/splits
          when iOS sync adds per-mile split data */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold text-textPrimary mb-2">
          Mile Splits
        </h2>
        <p className="text-sm text-textSecondary">Mile splits coming soon</p>
        <p className="text-xs text-textSecondary mt-1">
          Split data will appear here in a future update
        </p>
      </div>
    </div>
  );
}
