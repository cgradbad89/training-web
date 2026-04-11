"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ChevronDown, ChevronUp, Map as MapIcon, Plus, Trash2 } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StaticRouteMap } from "@/components/StaticRouteMap";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type CreatedRoute } from "@/types/createdRoute";
import {
  fetchCreatedRoutes,
  saveCreatedRoute,
  updateCreatedRoute,
  deleteCreatedRoute,
} from "@/services/createdRoutes";
import { formatPace, formatDuration } from "@/utils/pace";
import { getRouteStartPoint, haversineMeters } from "@/utils/routeCache";

import { CreatedRouteCanvas } from "@/components/CreatedRouteCanvas";
import { CreatedRouteDetailModal } from "@/components/CreatedRouteDetailModal";

const RunMap = dynamic(() => import("@/components/RunMap"), { ssr: false });
const RouteDrawModal = dynamic(() => import("@/components/RouteDrawModal"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

interface RouteCluster {
  id: string;
  representativeRun: HealthWorkout;
  allRuns: HealthWorkout[];
  distanceMiles: number;
  startLat: number;
  startLng: number;
}

// ─── Clustering ──────────────────────────────────────────────────────────────

/**
 * Phase 1: Group runs by distance (±0.5 miles).
 * Phase 2: Within each distance group, sub-cluster by start GPS point.
 * Two runs cluster together only if start points are within 300m.
 */
async function clusterRoutesGeographic(
  runs: HealthWorkout[],
  uid: string
): Promise<RouteCluster[]> {
  // Fetch start points for all runs in parallel (batched)
  const startPoints = new Map<string, { lat: number; lng: number } | null>();

  for (let i = 0; i < runs.length; i += 10) {
    const batch = runs.slice(i, i + 10);
    await Promise.all(
      batch.map(async (run) => {
        const pt = await getRouteStartPoint(uid, run.workoutId);
        startPoints.set(run.workoutId, pt);
      })
    );
  }

  // Sort by pace (best pace first = representative run)
  const sorted = [...runs].sort(
    (a, b) => (a.avgPaceSecPerMile ?? 999) - (b.avgPaceSecPerMile ?? 999)
  );

  const clusters: RouteCluster[] = [];
  const assigned = new Set<string>();

  for (const run of sorted) {
    if (assigned.has(run.workoutId)) continue;

    const runStart = startPoints.get(run.workoutId);
    const cluster: RouteCluster = {
      id: run.workoutId,
      representativeRun: run,
      allRuns: [run],
      distanceMiles: run.distanceMiles ?? 0,
      startLat: runStart?.lat ?? 0,
      startLng: runStart?.lng ?? 0,
    };

    for (const other of sorted) {
      if (other.workoutId === run.workoutId) continue;
      if (assigned.has(other.workoutId)) continue;

      // Distance must be within ±0.5 miles
      const distDiff = Math.abs(
        (run.distanceMiles ?? 0) - (other.distanceMiles ?? 0)
      );
      if (distDiff > 0.5) continue;

      // If either run has no start point, fall back to distance-only
      const otherStart = startPoints.get(other.workoutId);
      if (runStart && otherStart) {
        // Start points must be within 300 meters
        const dist = haversineMeters(
          runStart.lat,
          runStart.lng,
          otherStart.lat,
          otherStart.lng
        );
        if (dist > 300) continue;
      }

      cluster.allRuns.push(other);
      assigned.add(other.workoutId);
    }

    assigned.add(run.workoutId);
    clusters.push(cluster);
  }

  return clusters;
}

// ─── Distance Filter ─────────────────────────────────────────────────────────

type DistanceFilter = "all" | "<3" | "3-5" | "5-8" | "8-10" | "10+";

const FILTERS: { key: DistanceFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "<3", label: "Under 3mi" },
  { key: "3-5", label: "3\u20135mi" },
  { key: "5-8", label: "5\u20138mi" },
  { key: "8-10", label: "8\u201310mi" },
  { key: "10+", label: "10+ mi" },
];

function matchesFilter(miles: number, filter: DistanceFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "<3":
      return miles < 3;
    case "3-5":
      return miles >= 3 && miles < 5;
    case "5-8":
      return miles >= 5 && miles < 8;
    case "8-10":
      return miles >= 8 && miles < 10;
    case "10+":
      return miles >= 10;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatShortDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ─── Route Card ──────────────────────────────────────────────────────────────

interface RouteCardProps {
  cluster: RouteCluster;
  uid: string;
  onExpand: () => void;
}

function RouteCard({ cluster, uid, onExpand }: RouteCardProps) {
  const router = useRouter();
  const [showSimilar, setShowSimilar] = useState(false);
  const run = cluster.representativeRun;
  const otherRuns = cluster.allRuns.slice(1);

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
      <StaticRouteMap
        uid={uid}
        workoutId={run.workoutId}
        className="h-48"
        onClick={onExpand}
      />
      <div className="p-4 flex flex-col gap-3">
        {/* Row 1: distance + run count */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold bg-primary/10 text-primary px-2.5 py-0.5 rounded-full">
            {cluster.distanceMiles.toFixed(1)} mi
          </span>
          <span className="text-xs text-textSecondary ml-auto">
            {cluster.allRuns.length}{" "}
            {cluster.allRuns.length === 1 ? "run" : "runs"}
          </span>
        </div>

        {/* Row 2: stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Best Pace
            </span>
            <span className="text-sm font-semibold text-textPrimary tabular-nums">
              {run.avgPaceSecPerMile
                ? `${formatPace(run.avgPaceSecPerMile)} /mi`
                : "\u2014"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Avg HR
            </span>
            <span className="text-sm font-semibold text-textPrimary tabular-nums">
              {run.avgHeartRate
                ? `${Math.round(run.avgHeartRate)} bpm`
                : "\u2014"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Last Run
            </span>
            <span className="text-sm font-semibold text-textPrimary">
              {formatShortDate(run.startDate)}
            </span>
          </div>
        </div>

        {/* Row 3: view link */}
        <button
          onClick={onExpand}
          className="text-xs text-primary font-medium text-left hover:underline"
        >
          View on map &rarr;
        </button>

        {/* Similar runs */}
        {otherRuns.length > 0 && (
          <div className="border-t border-border pt-2">
            <button
              onClick={() => setShowSimilar(!showSimilar)}
              className="flex items-center gap-1 text-xs text-textSecondary hover:text-textPrimary transition-colors w-full"
            >
              {showSimilar ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
              {otherRuns.length} similar{" "}
              {otherRuns.length === 1 ? "run" : "runs"}
            </button>
            {showSimilar && (
              <div className="mt-2 flex flex-col gap-1.5">
                {otherRuns.map((r) => (
                  <button
                    key={r.workoutId}
                    onClick={() => router.push(`/runs/${r.workoutId}`)}
                    className="flex items-center justify-between text-xs py-1 hover:bg-surface rounded px-1 transition-colors"
                  >
                    <span className="text-textPrimary">
                      {formatShortDate(r.startDate)}
                    </span>
                    <span className="text-textSecondary tabular-nums">
                      {r.avgPaceSecPerMile
                        ? `${formatPace(r.avgPaceSecPerMile)} /mi`
                        : "\u2014"}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Route Detail Modal ──────────────────────────────────────────────────────

interface RouteDetailModalProps {
  cluster: RouteCluster;
  uid: string;
  onClose: () => void;
  onUseAsTemplate: (points: RoutePoint[]) => void;
}

function RouteDetailModal({ cluster, uid, onClose, onUseAsTemplate }: RouteDetailModalProps) {
  const router = useRouter();
  const run = cluster.representativeRun;
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [routeLoading, setRouteLoading] = useState(true);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRoutePoints(uid, run.workoutId)
      .then((pts) => { if (!cancelled) setRoutePoints(pts); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRouteLoading(false); });
    return () => { cancelled = true; };
  }, [uid, run.workoutId]);

  const dateDisplay = new Date(run.startDate).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const otherRuns = cluster.allRuns.filter(
    (r) => r.workoutId !== run.workoutId
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border p-4 flex items-center gap-3 z-10 rounded-t-2xl">
          <button
            onClick={onClose}
            className="text-sm text-primary font-medium shrink-0"
          >
            &larr; Close
          </button>
          <span className="text-sm font-bold text-textPrimary flex-1 text-center truncate">
            {cluster.distanceMiles.toFixed(1)} mi &middot; {dateDisplay}
          </span>
          <button
            onClick={() => {
              if (routePoints.length > 0) onUseAsTemplate(routePoints);
            }}
            disabled={routeLoading || routePoints.length === 0}
            className="text-xs text-primary font-medium hover:text-primary/80 disabled:opacity-30 shrink-0 whitespace-nowrap"
          >
            Use as template →
          </button>
        </div>

        {/* Map */}
        <div className="overflow-hidden">
          {routeLoading ? (
            <div className="h-[50vh] bg-surface animate-pulse" />
          ) : routePoints.length > 0 ? (
            <RunMap points={routePoints} className="h-[50vh]" />
          ) : (
            <div className="h-40 flex items-center justify-center">
              <p className="text-sm text-textSecondary">
                Route data not available
              </p>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="p-4 grid grid-cols-4 gap-3 border-b border-border">
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Distance
            </span>
            <span className="text-sm font-bold text-textPrimary tabular-nums">
              {run.distanceMiles.toFixed(2)} mi
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Best Pace
            </span>
            <span className="text-sm font-bold text-textPrimary tabular-nums">
              {run.avgPaceSecPerMile
                ? `${formatPace(run.avgPaceSecPerMile)} /mi`
                : "\u2014"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Avg HR
            </span>
            <span className="text-sm font-bold text-textPrimary tabular-nums">
              {run.avgHeartRate
                ? `${Math.round(run.avgHeartRate)} bpm`
                : "\u2014"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-textSecondary uppercase tracking-wide">
              Duration
            </span>
            <span className="text-sm font-bold text-textPrimary tabular-nums">
              {formatDuration(run.durationSeconds)}
            </span>
          </div>
        </div>

        {/* Other runs */}
        {otherRuns.length > 0 && (
          <div className="p-4">
            <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-3">
              Other runs on this route
            </h3>
            <div className="flex flex-col gap-2">
              {otherRuns.map((r) => (
                <button
                  key={r.workoutId}
                  onClick={() => {
                    onClose();
                    router.push(`/runs/${r.workoutId}`);
                  }}
                  className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface transition-colors text-sm"
                >
                  <span className="text-textPrimary">
                    {new Date(r.startDate).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="text-textSecondary tabular-nums">
                    {r.distanceMiles.toFixed(2)} mi &middot;{" "}
                    {r.avgPaceSecPerMile
                      ? `${formatPace(r.avgPaceSecPerMile)} /mi`
                      : "\u2014"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RoutesPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [runs, setRuns] = useState<HealthWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<DistanceFilter>("all");
  const [expandedCluster, setExpandedCluster] = useState<RouteCluster | null>(
    null
  );
  const [clusters, setClusters] = useState<RouteCluster[]>([]);
  const [clusteringLoading, setClusteringLoading] = useState(false);
  const [createdRoutes, setCreatedRoutes] = useState<CreatedRoute[]>([]);
  const [showDrawModal, setShowDrawModal] = useState(false);
  const [editingRoute, setEditingRoute] = useState<CreatedRoute | null>(null);
  const [selectedCreatedRoute, setSelectedCreatedRoute] =
    useState<CreatedRoute | null>(null);
  const [deleteRouteConfirm, setDeleteRouteConfirm] = useState<CreatedRoute | null>(null);
  /** Template waypoints from a GPS run route (downsampled for editability). */
  const [templateInitial, setTemplateInitial] = useState<{
    name: string;
    waypoints: { lat: number; lng: number }[];
  } | null>(null);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    fetchHealthWorkouts(uid, { limitCount: 500 })
      .then((wkts) => {
        setRuns(wkts.filter((w) => w.isRunLike && w.hasRoute));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid]);

  useEffect(() => {
    if (!uid || runs.length === 0) return;
    setClusteringLoading(true);
    clusterRoutesGeographic(runs, uid)
      .then((result) => {
        setClusters(result);
        setClusteringLoading(false);
      })
      .catch(() => setClusteringLoading(false));
  }, [runs, uid]);

  // Fetch created routes
  useEffect(() => {
    if (!uid) return;
    fetchCreatedRoutes(uid).then(setCreatedRoutes).catch(console.error);
  }, [uid]);

  const handleSaveRoute = async (data: {
    name: string;
    waypoints: { lat: number; lng: number }[];
    snappedPath: { lat: number; lng: number }[];
    distanceMiles: number;
  }) => {
    if (!uid) return;
    if (editingRoute) {
      // Update the existing Firestore document in place.
      await updateCreatedRoute(uid, editingRoute.id, {
        name: data.name,
        waypoints: data.waypoints,
        snappedPath: data.snappedPath,
        distanceMiles: data.distanceMiles,
      });
      // Patch local state so the detail modal re-opens with fresh data.
      const updatedRoute: CreatedRoute = {
        ...editingRoute,
        name: data.name,
        waypoints: data.waypoints,
        snappedPath: data.snappedPath,
        distanceMiles: data.distanceMiles,
        updatedAt: new Date(),
      };
      setCreatedRoutes((prev) =>
        prev.map((r) => (r.id === editingRoute.id ? updatedRoute : r))
      );
      setEditingRoute(null);
      setSelectedCreatedRoute(updatedRoute);
      return;
    }
    await saveCreatedRoute(uid, data);
    const updated = await fetchCreatedRoutes(uid);
    setCreatedRoutes(updated);
    setShowDrawModal(false);
  };

  const handleEditRoute = (route: CreatedRoute) => {
    // Close the detail modal and open the draw modal in edit mode.
    setSelectedCreatedRoute(null);
    setEditingRoute(route);
  };

  /**
   * Called from RouteDetailModal "Use as template" button.
   * Downsamples the dense GPS points to ~25 editable waypoints and opens
   * RouteDrawModal in create mode with those pre-populated.
   */
  const handleUseAsTemplate = (points: RoutePoint[], run: HealthWorkout) => {
    if (points.length === 0) return;

    // Downsample to ~25 evenly spaced waypoints
    const targetCount = 25;
    const step = Math.max(1, Math.floor(points.length / targetCount));
    const downsampled: { lat: number; lng: number }[] = [];
    for (let i = 0; i < points.length; i += step) {
      downsampled.push({ lat: points[i].lat, lng: points[i].lng });
    }
    // Always include the last point to close the route shape
    const last = points[points.length - 1];
    if (
      downsampled.length > 0 &&
      (downsampled[downsampled.length - 1].lat !== last.lat ||
        downsampled[downsampled.length - 1].lng !== last.lng)
    ) {
      downsampled.push({ lat: last.lat, lng: last.lng });
    }

    const dateLabel = run.startDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    // Close the detail modal and open the draw modal with template
    setExpandedCluster(null);
    setTemplateInitial({
      name: `Route from ${dateLabel}`,
      waypoints: downsampled,
    });
  };

  const handleDeleteRoute = async (routeId: string) => {
    if (!uid) return;
    await deleteCreatedRoute(uid, routeId);
    setCreatedRoutes((prev) => prev.filter((r) => r.id !== routeId));
    setDeleteRouteConfirm(null);
  };

  const filteredClusters = useMemo(
    () =>
      clusters.filter((c) => matchesFilter(c.distanceMiles, filter)),
    [clusters, filter]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="p-4 lg:p-6">
        <EmptyState
          title="No route data yet"
          description="Sync GPS Routes from the iOS app Settings to see your run routes here."
        />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-textPrimary">Routes</h1>
        <span className="text-sm text-textSecondary">
          {clusters.length} {clusters.length === 1 ? "route" : "routes"}{" "}
          &middot; {runs.length} runs
        </span>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              filter === key
                ? "bg-primary text-white"
                : "text-textSecondary hover:text-textPrimary hover:bg-surface"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Clustering indicator */}
      {clusteringLoading && (
        <p className="text-xs text-textSecondary">
          Grouping routes by location…
        </p>
      )}

      {/* Route cards grid */}
      {filteredClusters.length === 0 && !clusteringLoading ? (
        <EmptyState title="No routes in this distance range" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredClusters.map((cluster) => (
            <RouteCard
              key={cluster.id}
              cluster={cluster}
              uid={uid!}
              onExpand={() => setExpandedCluster(cluster)}
            />
          ))}
        </div>
      )}

      {/* Created Routes */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-textPrimary">
            Created Routes
          </h2>
          <button
            onClick={() => setShowDrawModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-colors"
          >
            <Plus size={14} />
            New Route
          </button>
        </div>

        {createdRoutes.length === 0 ? (
          <div className="bg-card rounded-2xl border border-border p-8 text-center">
            <MapIcon className="w-10 h-10 text-textSecondary mx-auto mb-3" />
            <p className="text-sm font-medium text-textPrimary mb-1">
              No created routes yet
            </p>
            <p className="text-xs text-textSecondary max-w-xs mx-auto">
              Click &ldquo;New Route&rdquo; to draw a custom route on the map.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {createdRoutes.map((route) => (
              <div
                key={route.id}
                onClick={() => setSelectedCreatedRoute(route)}
                className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm cursor-pointer hover:shadow-md transition-shadow"
              >
                <CreatedRouteCanvas
                  waypoints={route.waypoints}
                  className="h-40 w-full"
                  onClick={() => setSelectedCreatedRoute(route)}
                />
                <div className="p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-textPrimary truncate">
                      {route.name}
                    </span>
                    <span className="text-xs font-semibold bg-primary/10 text-primary px-2 py-0.5 rounded-full ml-2 shrink-0">
                      {route.distanceMiles.toFixed(2)} mi
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-textSecondary">
                      {new Date(route.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteRouteConfirm(route);
                      }}
                      className="text-textSecondary hover:text-danger transition-colors p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Route Draw Modal — create mode */}
      {showDrawModal && !editingRoute && !templateInitial && (
        <RouteDrawModal
          onSave={handleSaveRoute}
          onClose={() => setShowDrawModal(false)}
        />
      )}

      {/* Route Draw Modal — create from GPS template */}
      {templateInitial && !editingRoute && (
        <RouteDrawModal
          onSave={(data) => {
            // Clear template state, then save as new
            setTemplateInitial(null);
            handleSaveRoute(data);
          }}
          onClose={() => setTemplateInitial(null)}
          initial={templateInitial}
        />
      )}

      {/* Route Draw Modal — edit mode */}
      {editingRoute && (
        <RouteDrawModal
          onSave={handleSaveRoute}
          onClose={() => setEditingRoute(null)}
          initial={{
            name: editingRoute.name,
            waypoints: editingRoute.waypoints,
          }}
        />
      )}

      {/* Expanded route modal */}
      {expandedCluster && uid && (
        <RouteDetailModal
          cluster={expandedCluster}
          uid={uid}
          onClose={() => setExpandedCluster(null)}
          onUseAsTemplate={(points) =>
            handleUseAsTemplate(points, expandedCluster.representativeRun)
          }
        />
      )}

      {/* Created route detail modal */}
      <CreatedRouteDetailModal
        route={selectedCreatedRoute}
        onClose={() => setSelectedCreatedRoute(null)}
        onEditRoute={handleEditRoute}
        onRouteUpdated={(routeId, snappedPath, distanceMiles) => {
          setCreatedRoutes((prev) =>
            prev.map((r) =>
              r.id === routeId
                ? { ...r, snappedPath, distanceMiles }
                : r
            )
          );
          setSelectedCreatedRoute((prev) =>
            prev && prev.id === routeId
              ? { ...prev, snappedPath, distanceMiles }
              : prev
          );
        }}
      />

      {/* Delete route confirm */}
      <ConfirmDialog
        isOpen={!!deleteRouteConfirm}
        title="Delete this route?"
        message="This will permanently delete the route. This cannot be undone."
        confirmLabel="Delete Route"
        confirmVariant="danger"
        onConfirm={() => deleteRouteConfirm && handleDeleteRoute(deleteRouteConfirm.id)}
        onCancel={() => setDeleteRouteConfirm(null)}
      />
    </div>
  );
}
