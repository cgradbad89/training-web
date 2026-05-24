"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Dumbbell,
  Wind,
  Flower2,
  Bike,
  Zap,
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  type LucideProps,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
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
import { MiniCalendar, toLocalIsoDateForCalendar } from "@/components/MiniCalendar";
import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import {
  computeTrainingLoad,
  MIN_RUN_MILES_FOR_AVG,
  MIN_WORKOUT_SECONDS_FOR_AVG,
  getActivityContext,
  isHiitLikeActivity,
  isMindfulActivity,
} from "@/utils/trainingLoad";

// ─── Constants ────────────────────────────────────────────────────────────────

type TabKey =
  | "all"
  | "workout"
  | "strength"
  | "pilates"
  | "yoga"
  | "excluded";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all",      label: "All"      },
  { key: "workout",  label: "Workout"  },
  { key: "strength", label: "Strength" },
  { key: "pilates",  label: "Pilates"  },
  { key: "yoga",     label: "Yoga"     },
  { key: "excluded", label: "Excluded" },
];

// ─── Classifiers ──────────────────────────────────────────────────────────────

/** Whether `w` belongs in the given category tab. The "all" and "excluded"
 *  tabs short-circuit at the page level — they pick a different SOURCE list
 *  (active vs. excluded workouts) and don't filter by category here. */
function matchesCategoryTab(tab: TabKey, w: HealthWorkout): boolean {
  const at = w.activityType ?? "";
  const atLower = at.toLowerCase();
  switch (tab) {
    case "all":
      return true;
    case "workout":
      return isHiitLikeActivity(at);
    case "strength":
      // Genuine strength/lifting — uses the same low-intensity context as
      // mindful work, but isn't classified as mindful. Yoga/pilates/barre
      // are excluded here and live in their own tabs.
      return (
        getActivityContext(at) === "strength" && !isMindfulActivity(at)
      );
    case "pilates":
      return atLower.includes("pilates");
    case "yoga":
      return atLower.includes("yoga");
    case "excluded":
      // Source list swap happens at the page level; once we're here every
      // excluded workout is in scope.
      return true;
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

// TODO: review for dark mode — category pills use per-activity brand hues
// (Strength=blue, HIIT=orange, Yoga=purple, etc.) rather than theme tokens,
// so they stay identifiable but lack proper dark-mode contrast.
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

/** Tile shape matches the runs page summary tile exactly — label / value /
 *  optional subtext, same fonts and spacing. */
function SummaryTile({
  label,
  value,
  subtext,
}: {
  label: string;
  value: string;
  subtext?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-textSecondary">{label}</span>
      <span className="text-base font-bold text-textPrimary tabular-nums leading-tight">
        {value}
      </span>
      {subtext && (
        <span className="text-[10px] text-textSecondary leading-tight">
          {subtext}
        </span>
      )}
    </div>
  );
}

function YearSummary({
  workouts,
  year,
  summaryTitle,
}: {
  workouts: HealthWorkout[];
  year: number;
  /** Title rendered at the top of the card — matches the runs page's
   *  "<Year> Summary" label so the sidebar cards read consistently. */
  summaryTitle: string;
}) {
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
          calorieWorkouts.reduce((s, w) => s + w.calories, 0) /
            calorieWorkouts.length
        )
      : null;

  // Exclude short/aborted activities from the per-session avg so warmups
  // and restarts don't drag the mean down. Per-workout badges still render
  // for these in the list.
  const loadScores = workouts
    .filter((w) =>
      w.isRunLike
        ? w.distanceMiles >= MIN_RUN_MILES_FOR_AVG
        : w.durationSeconds >= MIN_WORKOUT_SECONDS_FOR_AVG
    )
    .map((w) =>
      computeTrainingLoad(w.durationSeconds, w.avgHeartRate, w.activityType)
    )
    .filter((s): s is number => s !== null);
  const avgLoadPerSession =
    loadScores.length > 0
      ? Math.round(loadScores.reduce((s, v) => s + v, 0) / loadScores.length)
      : null;

  // Weekly avg total load — sum of ALL non-null per-session loads across the
  // displayed workouts, divided by elapsed weeks in the selected year. We
  // include shorter sessions in the SUM because they're part of the week's
  // total training stress even if they're excluded from the per-session
  // mean above. Denominator is calendar-weeks-elapsed (year-only — this
  // page has no month filter), matching the runs-page convention.
  const totalLoad = workouts
    .map((w) =>
      computeTrainingLoad(w.durationSeconds, w.avgHeartRate, w.activityType)
    )
    .filter((s): s is number => s !== null)
    .reduce((a, b) => a + b, 0);
  const avgWeeklyLoad =
    totalLoad > 0 && elapsed > 0 ? Math.round(totalLoad / elapsed) : null;

  const avgLoadPerSessionStr =
    avgLoadPerSession != null ? String(avgLoadPerSession) : "—";
  const avgWeeklyLoadStr =
    avgWeeklyLoad != null ? String(avgWeeklyLoad) : "—";
  const avgLoadValue = `${avgLoadPerSessionStr} / ${avgWeeklyLoadStr}`;

  const tiles: { label: string; value: string; subtext?: string }[] = [
    { label: "Total Workouts", value: String(count) },
    {
      label: "Avg Duration",
      value:
        avgDurationSec > 0
          ? formatDuration(Math.round(avgDurationSec))
          : "—",
    },
    {
      label: "Avg Calories",
      value:
        avgCalories !== null ? `${avgCalories.toLocaleString()} kcal` : "—",
    },
    {
      label: "Avg Training Load",
      value: avgLoadValue,
      subtext: "per session / weekly avg",
    },
  ];

  return (
    <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
        {summaryTitle}
      </p>
      {workouts.length === 0 ? (
        <p className="text-xs text-textSecondary">No workouts in this view.</p>
      ) : (
        // Sidebar is 256px wide on lg, so the four tiles stay in a 2×2
        // grid — lg:grid-cols-4 was a holdover from the old full-width
        // layout and would overflow the new sidebar slot.
        <div className="grid grid-cols-2 gap-3">
          {tiles.map(({ label, value, subtext }) => (
            <SummaryTile
              key={label}
              label={label}
              value={value}
              subtext={subtext}
            />
          ))}
        </div>
      )}
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
  // Pill styling matches the runs page FilterPills so the sidebar filter
  // controls read consistently across the two pages.
  return (
    <div className="flex gap-1.5 flex-wrap">
      {TABS.map(({ key, label }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              isActive
                ? "bg-primary text-white border-primary"
                : "bg-surface text-textSecondary border-border hover:text-textPrimary"
            }`}
          >
            {label}
          </button>
        );
      })}
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
  // `years` is sorted DESC (newest at index 0), so older = higher index.
  // ← goes older (idx + 1), → goes newer (idx - 1) — matches the standard
  // timeline convention where left is earlier in time.
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => { if (idx < years.length - 1) onChange(years[idx + 1]); }}
        disabled={idx >= years.length - 1}
        className="p-1.5 rounded-lg hover:bg-surface text-textSecondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        aria-label="Previous year"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-sm font-bold text-textPrimary w-12 text-center">
        {selected}
      </span>
      <button
        onClick={() => { if (idx > 0) onChange(years[idx - 1]); }}
        disabled={idx <= 0}
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

      {/* Col 7: Training Load — only when both inputs are present */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        {workout.avgHeartRate && workout.durationSeconds > 0 ? (
          <TrainingLoadBadge
            durationSeconds={workout.durationSeconds}
            avgHeartRate={workout.avgHeartRate}
            activityType={workout.activityType}
          />
        ) : (
          <span className="text-xs text-textSecondary w-12 inline-block text-right">—</span>
        )}
      </div>
    </div>
  );
}

// ─── Week Group ───────────────────────────────────────────────────────────────

function WorkoutWeekGroup({
  wKey,
  workouts,
  onSelect,
  innerRef,
}: {
  wKey: string;
  workouts: HealthWorkout[];
  onSelect: (w: HealthWorkout) => void;
  /** Ref the parent uses to scrollIntoView when a calendar day is clicked. */
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const wStart = new Date(wKey + "T00:00:00");
  const weekLabel = wStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const totalSecs = workouts.reduce((s, w) => s + w.durationSeconds, 0);

  // Per-week summary additions — match the runs page header pattern: avg HR
  // across sessions with a valid HR, total load (sum of computeTrainingLoad
  // scores, nulls dropped). Each segment is skipped if no qualifying
  // sessions contributed to it.
  const hrVals = workouts
    .map((w) => w.avgHeartRate)
    .filter((v): v is number => typeof v === "number" && v > 0 && isFinite(v));
  const avgHR =
    hrVals.length > 0 ? hrVals.reduce((a, b) => a + b, 0) / hrVals.length : null;

  const loadScores = workouts
    .map((w) =>
      computeTrainingLoad(w.durationSeconds, w.avgHeartRate, w.activityType)
    )
    .filter((s): s is number => s != null);
  const totalLoad =
    loadScores.length > 0 ? loadScores.reduce((a, b) => a + b, 0) : null;

  const summaryParts = [
    `${workouts.length} ${workouts.length === 1 ? "workout" : "workouts"}`,
    formatDuration(totalSecs),
  ];
  if (avgHR != null) summaryParts.push(`avg ${Math.round(avgHR)}bpm`);
  if (totalLoad != null) summaryParts.push(`load ${Math.round(totalLoad)}`);

  return (
    <div ref={innerRef} className="mb-6">
      <div className="flex items-center justify-between flex-wrap gap-x-3 gap-y-1 border-b border-border pb-1.5 mb-2">
        <span className="text-sm font-semibold text-textSecondary">
          Week of {weekLabel}
        </span>
        <span className="text-xs text-textSecondary tabular-nums">
          {summaryParts.join(" · ")}
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

  // When the Excluded tab is active we swap the SOURCE list from
  // allWorkouts (active only) to excludedWorkouts. The year filter and
  // category-tab filter still apply on top of whichever source is chosen.
  const sourceWorkouts =
    activeTab === "excluded" ? excludedWorkouts : allWorkouts;

  const yearWorkouts = useMemo(
    () =>
      sourceWorkouts.filter(
        (w) => getLocalDate(w).getFullYear() === selectedYear
      ),
    [sourceWorkouts, selectedYear]
  );

  const filteredWorkouts = useMemo(
    () => yearWorkouts.filter((w) => matchesCategoryTab(activeTab, w)),
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

  // Per-day session count for the shared MiniCalendar. Reflects the active
  // filter (year + category tab) so the calendar tracks the list below.
  // Count-per-day is the cleanest visual parallel to the runs page's
  // "miles-per-day" — see Step 0 notes.
  const workoutsByDate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const w of filteredWorkouts) {
      const key = toLocalIsoDateForCalendar(getLocalDate(w));
      map[key] = (map[key] ?? 0) + 1;
    }
    return map;
  }, [filteredWorkouts]);

  // Refs the calendar uses to scroll the matching WorkoutWeekGroup into
  // view when a day pill is clicked — same UX as the runs page.
  const weekRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollToWeek = useCallback((wk: string) => {
    weekRefs.current[wk]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const activeTabLabel = TABS.find((t) => t.key === activeTab)?.label ?? "All";

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-4 lg:p-6 min-h-full">
      {/* ── Left Sidebar ────────────────────────────────────── */}
      <aside className="w-full lg:w-64 shrink-0 flex flex-col gap-5">
        {/* Filters card — Year navigator + category tabs. Same shell as
            the runs-page filters card so the two pages read consistently. */}
        <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            Year
          </p>
          <YearNavigator
            years={availableYears}
            selected={selectedYear}
            onChange={setSelectedYear}
          />
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            Type
          </p>
          <TabStrip active={activeTab} onChange={setActiveTab} />
        </div>

        {/* Summary tile — already filter-aware (Prompt 5 + Prompt C). */}
        <YearSummary
          workouts={filteredWorkouts}
          year={selectedYear}
          summaryTitle={`${selectedYear} Summary`}
        />

        {/* Calendar — hidden on mobile, matches the runs page placement.
            valuesByDate already comes from filteredWorkouts so the heat
            map tracks whichever tab is active. */}
        <div className="hidden lg:block bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-3">
            Calendar
          </p>
          <MiniCalendar
            year={selectedYear}
            valuesByDate={workoutsByDate}
            formatValue={(v) => String(v)}
            formatTooltip={(v) => `${v} ${v === 1 ? "workout" : "workouts"}`}
            onDayClick={scrollToWeek}
            lockedMonth={null}
          />
        </div>
      </aside>

      {/* ── Right Main Area ──────────────────────────────────── */}
      <main className="flex-1 min-w-0">
        {/* Duplicate suggestion banners — moved into the main column so
            they sit directly above the list they affect. */}
        {suggestionPairs.length > 0 && (
          <div className="flex flex-col gap-3 mb-4">
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
                  overridesRef.current = {
                    ...overridesRef.current,
                    [pair.otfWorkoutId]: newOverride,
                  };
                  setOverrides((prev) => ({
                    ...prev,
                    [pair.otfWorkoutId]: newOverride,
                  }));
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

        {/* Workout list grouped by week */}
        {filteredWorkouts.length === 0 ? (
          <div className="mt-4">
            {allWorkouts.length === 0 && excludedWorkouts.length === 0 ? (
              <EmptyState title="No workouts recorded yet" />
            ) : activeTab === "excluded" ? (
              <EmptyState title={`No excluded workouts in ${selectedYear}`} />
            ) : (
              <EmptyState
                title={`No ${activeTabLabel} workouts in ${selectedYear}`}
              />
            )}
          </div>
        ) : (
          <div>
            {groupedWeeks.map(([wk, workouts]) => (
              <WorkoutWeekGroup
                key={wk}
                wKey={wk}
                workouts={workouts}
                onSelect={setSelectedWorkout}
                innerRef={(el) => {
                  weekRefs.current[wk] = el;
                }}
              />
            ))}
          </div>
        )}
      </main>

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
            // Move the workout between the active and excluded lists so the
            // currently-active tab updates without a refresh. Both directions
            // are handled here now that the standalone ExcludedItemsModal is
            // gone — restoration happens via clicking an excluded row.
            if (excluded) {
              setAllWorkouts((prev) =>
                prev.filter((w) => w.workoutId !== workoutId)
              );
              setExcludedWorkouts((prev) =>
                prev.some((w) => w.workoutId === workoutId)
                  ? prev
                  : [...prev, selectedWorkout]
              );
            } else {
              setExcludedWorkouts((prev) =>
                prev.filter((w) => w.workoutId !== workoutId)
              );
              setAllWorkouts((prev) =>
                prev.some((w) => w.workoutId === workoutId)
                  ? prev
                  : [...prev, selectedWorkout]
              );
            }
            setSelectedWorkout(null);
          }}
        />
      )}
    </div>
  );
}
