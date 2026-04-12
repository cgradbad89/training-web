"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Dumbbell,
  Wind,
  Flower2,
  Bike,
  Zap,
  Activity,
  EyeOff,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  type LucideProps,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatBlock } from "@/components/ui/StatBlock";
import { useAuth } from "@/hooks/useAuth";
import { onHealthWorkoutsSnapshot } from "@/services/healthWorkouts";
import { fetchAllOverrides, excludeWorkout } from "@/services/workoutOverrides";
import { detectDuplicatePairs, type DuplicatePair } from "@/utils/duplicateDetection";
import {
  fetchDismissedDuplicates,
  dismissDuplicate,
  dismissedPairKey,
} from "@/services/dismissedDuplicates";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { formatDuration } from "@/utils/pace";
import { weekStart } from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import { WorkoutDetailModal } from "@/components/WorkoutDetailModal";
import { ExcludedItemsModal } from "@/components/ExcludedItemsModal";

// ─── Constants ────────────────────────────────────────────────────────────────

type TabKey = "all" | "active" | "mind-body";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all",       label: "All"         },
  { key: "active",    label: "Active"      },
  { key: "mind-body", label: "Mind & Body" },
];

// ─── Classifiers ──────────────────────────────────────────────────────────────

function isMindBody(w: HealthWorkout): boolean {
  const at = w.activityType;
  const dt = w.displayType.toLowerCase();
  return (
    at === "yoga" ||
    at === "pilates" ||
    dt.includes("yoga") ||
    dt.includes("pilates")
  );
}

function matchesTab(tab: TabKey, w: HealthWorkout): boolean {
  switch (tab) {
    case "all":       return true;
    case "active":    return !isMindBody(w);
    case "mind-body": return isMindBody(w);
  }
}

type IconComponent = React.ComponentType<LucideProps>;

function getIcon(w: HealthWorkout): IconComponent {
  const dt = w.displayType.toLowerCase();
  switch (w.activityType) {
    case "traditional_strength_training":
    case "functional_strength_training":
      return Dumbbell;
    case "high_intensity_interval_training":
    case "cross_training":
      return Zap;
    case "yoga":
      return Wind;
    case "pilates":
      return Flower2;
    case "cycling":
      return Bike;
    default:
      if (dt.includes("yoga"))    return Wind;
      if (dt.includes("pilates")) return Flower2;
      return Activity;
  }
}

function getTypeBadge(w: HealthWorkout): { label: string; cls: string } {
  const dt = w.displayType.toLowerCase();
  switch (w.activityType) {
    case "traditional_strength_training":
    case "functional_strength_training":
      return { label: "Strength",    cls: "bg-blue-100 text-blue-700" };
    case "high_intensity_interval_training":
      return { label: "HIIT",        cls: "bg-orange-100 text-orange-700" };
    case "cross_training":
      return { label: "Cross Train", cls: "bg-indigo-100 text-indigo-700" };
    case "yoga":
      return { label: "Yoga",        cls: "bg-purple-100 text-purple-700" };
    case "pilates":
      return { label: "Pilates",     cls: "bg-pink-100 text-pink-700" };
    case "cycling":
      return { label: "Ride",        cls: "bg-green-100 text-green-700" };
    case "mixed_cardio":
      return { label: "Cardio",      cls: "bg-teal-100 text-teal-700" };
    default:
      if (dt.includes("yoga"))    return { label: "Yoga",    cls: "bg-purple-100 text-purple-700" };
      if (dt.includes("pilates")) return { label: "Pilates", cls: "bg-pink-100 text-pink-700" };
      return { label: w.displayType || "Workout", cls: "bg-gray-100 text-gray-700" };
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function getLocalDate(w: HealthWorkout): Date {
  return w.startDate;
}

function weekKey(date: Date): string {
  const d = weekStart(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weeksElapsed(year: number): number {
  const now = new Date();
  if (year < now.getFullYear()) return 52;
  const dayOfYear = Math.ceil(
    (now.getTime() - new Date(year, 0, 1).getTime()) / 86400000
  );
  return Math.max(1, Math.ceil(dayOfYear / 7));
}

// ─── Year Summary Stats ───────────────────────────────────────────────────────

function YearSummary({ workouts, year }: { workouts: HealthWorkout[]; year: number }) {
  const elapsed = weeksElapsed(year);
  const count = workouts.length;

  const avgDurationSec =
    count > 0
      ? workouts.reduce((s, w) => s + w.durationSeconds, 0) / count
      : 0;

  const calorieWorkouts = workouts.filter((w) => w.calories > 0);
  const avgCalories =
    calorieWorkouts.length > 0
      ? Math.round(
          calorieWorkouts.reduce((s, w) => s + w.calories, 0) / calorieWorkouts.length
        )
      : null;

  const activeCount = workouts.filter((w) => !isMindBody(w)).length;
  const mindBodyCount = workouts.filter((w) => isMindBody(w)).length;

  return (
    <div className="bg-card rounded-2xl border border-border p-5 flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-4">
        <StatBlock label="Total Workouts" value={count} />
        <StatBlock
          label="Avg Duration"
          value={avgDurationSec > 0 ? formatDuration(Math.round(avgDurationSec)) : "—"}
        />
        <StatBlock
          label="Avg Calories"
          value={avgCalories !== null ? avgCalories.toLocaleString() : "—"}
          unit={avgCalories !== null ? "kcal" : undefined}
        />
      </div>
      <div className="grid grid-cols-4 gap-4">
        <StatBlock label="Active Sessions" value={activeCount} />
        <StatBlock
          label="Active Avg/Wk"
          value={(activeCount / elapsed).toFixed(1)}
        />
        <StatBlock label="Mind & Body" value={mindBodyCount} />
        <StatBlock
          label="M&B Avg/Wk"
          value={(mindBodyCount / elapsed).toFixed(1)}
        />
      </div>
    </div>
  );
}

// ─── Tab Strip ────────────────────────────────────────────────────────────────

function TabStrip({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (t: TabKey) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            key === active
              ? "bg-primary text-white"
              : "text-textSecondary hover:text-textPrimary"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Year Navigator ───────────────────────────────────────────────────────────

function YearNavigator({
  years,
  selected,
  onChange,
}: {
  years: number[];
  selected: number;
  onChange: (y: number) => void;
}) {
  const idx = years.indexOf(selected);
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => { if (idx > 0) onChange(years[idx - 1]); }}
        disabled={idx <= 0}
        className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Previous year"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-sm font-bold text-textPrimary w-12 text-center">
        {selected}
      </span>
      <button
        onClick={() => { if (idx < years.length - 1) onChange(years[idx + 1]); }}
        disabled={idx >= years.length - 1}
        className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Next year"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Workout Row ──────────────────────────────────────────────────────────────

function WorkoutRow({ workout, onClick }: { workout: HealthWorkout; onClick: () => void }) {
  const localDate = getLocalDate(workout);
  const dayAbbrev = DAY_ABBREVS[(localDate.getDay() + 6) % 7];
  const dayNum = localDate.getDate();

  const Icon = getIcon(workout);
  const badge = getTypeBadge(workout);

  return (
    <div onClick={onClick} className="flex items-center gap-3 py-3 px-4 hover:bg-surface rounded-lg transition-colors cursor-pointer">
      {/* Col 1: Date */}
      <div className="flex flex-col items-center w-11 shrink-0 select-none">
        <span className="text-xs text-textSecondary leading-none">{dayAbbrev}</span>
        <span className="text-sm font-semibold leading-tight">{dayNum}</span>
      </div>

      {/* Col 2: Icon + Name */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Icon size={16} className="text-textSecondary shrink-0" />
        <span className="text-sm font-medium truncate max-w-[200px]">{workout.displayType}</span>
      </div>

      {/* Col 3: Type Badge */}
      <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${badge.cls}`}>
        {badge.label}
      </span>

      {/* Col 4: Duration */}
      <div className="w-16 shrink-0 text-sm font-semibold tabular-nums text-right">
        {formatDuration(workout.durationSeconds)}
      </div>

      {/* Col 5: Calories — hidden on mobile */}
      <div className="hidden md:block w-20 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {workout.calories > 0
          ? `${Math.round(workout.calories).toLocaleString()} kcal`
          : "—"}
      </div>

      {/* Col 6: Heart Rate — hidden on mobile */}
      <div className="hidden md:block w-20 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {workout.avgHeartRate ? `${Math.round(workout.avgHeartRate)} bpm` : "—"}
      </div>
    </div>
  );
}

// ─── Week Group ───────────────────────────────────────────────────────────────

function WorkoutWeekGroup({
  wKey,
  workouts,
  onSelect,
}: {
  wKey: string;
  workouts: HealthWorkout[];
  onSelect: (w: HealthWorkout) => void;
}) {
  const wStart = new Date(wKey + "T00:00:00");
  const weekLabel = wStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const totalSecs = workouts.reduce((s, w) => s + w.durationSeconds, 0);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between border-b border-border pb-1.5 mb-2">
        <span className="text-sm font-semibold text-textSecondary">
          Week of {weekLabel}
        </span>
        <span className="text-xs text-textSecondary tabular-nums">
          {workouts.length} {workouts.length === 1 ? "workout" : "workouts"} &middot;{" "}
          {formatDuration(totalSecs)} total
        </span>
      </div>
      {workouts.map((w) => (
        <WorkoutRow key={w.workoutId} workout={w} onClick={() => onSelect(w)} />
      ))}
    </div>
  );
}

// ─── Duplicate Suggestion Banner ──────────────────────────────────────────────

function DuplicateSuggestionBanner({
  pair,
  onExclude,
  onDismiss,
}: {
  pair: DuplicatePair;
  onExclude: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [excluding, setExcluding] = useState(false);

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 dark:bg-amber-950/20 dark:border-amber-800">
      <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center shrink-0 mt-0.5">
        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Possible duplicate on {pair.date}
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
          <span className="font-medium">{pair.otfDisplayType}</span> and{" "}
          <span className="font-medium">{pair.manualDisplayType}</span> overlap.
          Exclude the {pair.otfDisplayType}?
        </p>
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={async () => {
              setExcluding(true);
              await onExclude();
              setExcluding(false);
            }}
            disabled={excluding}
            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {excluding ? "Excluding..." : `Exclude ${pair.otfDisplayType}`}
          </button>
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-lg text-amber-700 dark:text-amber-400 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkoutsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [allWorkouts, setAllWorkouts] = useState<HealthWorkout[]>([]);
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [excludedWorkouts, setExcludedWorkouts] = useState<HealthWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWorkout, setSelectedWorkout] = useState<HealthWorkout | null>(null);
  const [showExcludedModal, setShowExcludedModal] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [dismissedPairKeys, setDismissedPairKeys] = useState<Set<string>>(
    new Set()
  );
  // Ref so the onSnapshot callback always reads the latest dismissed set
  // without needing to recreate the listener.
  const dismissedRef = useRef<Set<string>>(new Set());

  const duplicatePairs = useMemo(
    () => detectDuplicatePairs(allWorkouts),
    [allWorkouts]
  );
  const suggestionPairs = useMemo(
    () =>
      duplicatePairs.filter(
        (pair) =>
          !overrides[pair.otfWorkoutId]?.isExcluded &&
          !dismissedPairKeys.has(
            dismissedPairKey(pair.otfWorkoutId, pair.manualWorkoutId)
          )
      ),
    [duplicatePairs, overrides, dismissedPairKeys]
  );

  useEffect(() => {
    document.body.style.overflow = selectedWorkout ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [selectedWorkout]);

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  // Ref for overrides so the onSnapshot callback always reads the latest
  const overridesRef = useRef<Record<string, WorkoutOverride>>({});

  // Combined effect: fetch overrides + dismissed pairs FIRST, then start
  // the onSnapshot listener. This eliminates the race condition where the
  // snapshot fires before overrides/dismissed data is ready.
  useEffect(() => {
    if (!uid) return;
    setLoading(true);

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    Promise.all([
      fetchAllOverrides(uid),
      fetchDismissedDuplicates(uid),
    ])
      .then(([fetchedOverrides, fetchedDismissed]) => {
        if (cancelled) return;

        // Populate refs + state with the fetched data
        overridesRef.current = fetchedOverrides;
        setOverrides(fetchedOverrides);
        dismissedRef.current = fetchedDismissed;
        setDismissedPairKeys(fetchedDismissed);

        // NOW start the real-time listener — overrides and dismissed
        // data is guaranteed ready before the first snapshot callback.
        unsubscribe = onHealthWorkoutsSnapshot(
          uid,
          { limitCount: 500, isRunLike: false },
          (nonRuns) => {
            if (cancelled) return;
            const o = overridesRef.current;
            setAllWorkouts(nonRuns.filter((w) => !o[w.workoutId]?.isExcluded));
            setExcludedWorkouts(
              nonRuns.filter((w) => o[w.workoutId]?.isExcluded === true)
            );
            setLoading(false);
          },
          () => {
            if (!cancelled) setLoading(false);
          }
        );
      })
      .catch((err) => {
        console.error("[Workouts] init fetch failed:", err);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [uid]);

  const availableYears = useMemo(() => {
    const years = Array.from(
      new Set(allWorkouts.map((w) => getLocalDate(w).getFullYear()))
    ).sort((a, b) => b - a);
    if (!years.includes(currentYear)) years.unshift(currentYear);
    return years;
  }, [allWorkouts, currentYear]);

  const yearWorkouts = useMemo(
    () => allWorkouts.filter((w) => getLocalDate(w).getFullYear() === selectedYear),
    [allWorkouts, selectedYear]
  );

  const filteredWorkouts = useMemo(
    () => yearWorkouts.filter((w) => matchesTab(activeTab, w)),
    [yearWorkouts, activeTab]
  );

  const groupedWeeks = useMemo(() => {
    const map: Record<string, HealthWorkout[]> = {};
    for (const w of filteredWorkouts) {
      const k = weekKey(getLocalDate(w));
      if (!map[k]) map[k] = [];
      map[k].push(w);
    }
    for (const k of Object.keys(map)) {
      map[k].sort(
        (a, b) => getLocalDate(b).getTime() - getLocalDate(a).getTime()
      );
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [filteredWorkouts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const activeTabLabel = TABS.find((t) => t.key === activeTab)?.label ?? "All";

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-6">
      {/* Row 1: Header + year selector */}
      <PageHeader
        title="Workout History"
        action={
          <YearNavigator
            years={availableYears}
            selected={selectedYear}
            onChange={setSelectedYear}
          />
        }
      />

      {/* Row 2: Year summary stats */}
      <YearSummary workouts={yearWorkouts} year={selectedYear} />

      {/* Duplicate suggestion banners */}
      {suggestionPairs.length > 0 && (
        <div className="flex flex-col gap-3">
          {suggestionPairs.map((pair) => (
            <DuplicateSuggestionBanner
              key={pair.otfWorkoutId}
              pair={pair}
              onExclude={async () => {
                if (!uid) return;
                await excludeWorkout(uid, pair.otfWorkoutId);
                const newOverride: WorkoutOverride = {
                  workoutId: pair.otfWorkoutId,
                  userId: uid,
                  isExcluded: true,
                  excludedAt: new Date().toISOString(),
                  excludedReason: "auto-suggested duplicate",
                  distanceMilesOverride: null,
                  durationSecondsOverride: null,
                  runTypeOverride: null,
                  updatedAt: new Date().toISOString(),
                };
                // Update both state and ref so the snapshot callback stays in sync
                overridesRef.current = { ...overridesRef.current, [pair.otfWorkoutId]: newOverride };
                setOverrides((prev) => ({ ...prev, [pair.otfWorkoutId]: newOverride }));
                setAllWorkouts((prev) =>
                  prev.filter((w) => w.workoutId !== pair.otfWorkoutId)
                );
              }}
              onDismiss={() => {
                const key = dismissedPairKey(
                  pair.otfWorkoutId,
                  pair.manualWorkoutId
                );
                // Optimistic UI — remove immediately, update both state and ref
                dismissedRef.current = new Set([...dismissedRef.current, key]);
                setDismissedPairKeys((prev) => new Set([...prev, key]));
                // Persist to Firestore (fire-and-forget)
                if (uid) {
                  dismissDuplicate(
                    uid,
                    pair.otfWorkoutId,
                    pair.manualWorkoutId
                  ).catch((err) =>
                    console.error("[Workouts] dismiss write failed:", err)
                  );
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Row 3: Type filter tabs + excluded button */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <TabStrip active={activeTab} onChange={setActiveTab} />
        </div>
        {excludedWorkouts.length > 0 && (
          <button
            onClick={() => setShowExcludedModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs font-medium text-textSecondary hover:text-textPrimary hover:border-textSecondary transition-colors shrink-0"
          >
            <EyeOff className="w-3.5 h-3.5" />
            {excludedWorkouts.length} Excluded
          </button>
        )}
      </div>

      {/* Row 4: Workout list grouped by week */}
      {filteredWorkouts.length === 0 ? (
        <div className="mt-4">
          {allWorkouts.length === 0 ? (
            <EmptyState title="No workouts recorded yet" />
          ) : (
            <EmptyState title={`No ${activeTabLabel} workouts in ${selectedYear}`} />
          )}
        </div>
      ) : (
        <div>
          {groupedWeeks.map(([wk, workouts]) => (
            <WorkoutWeekGroup key={wk} wKey={wk} workouts={workouts} onSelect={setSelectedWorkout} />
          ))}
        </div>
      )}

      {selectedWorkout && uid && (
        <WorkoutDetailModal
          workout={selectedWorkout}
          override={overrides[selectedWorkout.workoutId] ?? null}
          userId={uid}
          onClose={() => setSelectedWorkout(null)}
          onExcludeChange={(workoutId, excluded) => {
            setOverrides((prev) => ({
              ...prev,
              [workoutId]: {
                ...prev[workoutId],
                workoutId,
                userId: uid,
                isExcluded: excluded,
                excludedAt: excluded ? new Date().toISOString() : null,
                excludedReason: null,
                distanceMilesOverride: null,
                durationSecondsOverride: null,
                runTypeOverride: null,
                updatedAt: new Date().toISOString(),
              },
            }));
            if (excluded) {
              setAllWorkouts((prev) =>
                prev.filter((w) => w.workoutId !== workoutId)
              );
              setSelectedWorkout(null);
            }
          }}
        />
      )}

      {uid && (
        <ExcludedItemsModal
          isOpen={showExcludedModal}
          onClose={() => setShowExcludedModal(false)}
          excludedItems={excludedWorkouts}
          userId={uid}
          onRestored={(workoutId) => {
            setOverrides((prev) => {
              const updated = { ...prev };
              delete updated[workoutId];
              return updated;
            });
            // Move restored workout back to visible list
            const restored = excludedWorkouts.find((w) => w.workoutId === workoutId);
            if (restored) {
              setAllWorkouts((prev) => [...prev, restored]);
              setExcludedWorkouts((prev) =>
                prev.filter((w) => w.workoutId !== workoutId)
              );
            }
          }}
        />
      )}
    </div>
  );
}
