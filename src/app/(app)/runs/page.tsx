"use client";

import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, AlertTriangle, EyeOff } from "lucide-react";

import { MetricBadge } from "@/components/ui/MetricBadge";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { onHealthWorkoutsSnapshot } from "@/services/healthWorkouts";
import {
  fetchShoes,
  fetchManualShoeAssignmentsMap,
  saveManualAssignments,
} from "@/services/shoes";

import {
  efficiencyDisplayScore,
  efficiencyLevel,
  distanceBucket,
} from "@/utils/metrics";
import { formatPace, formatDuration, formatMiles } from "@/utils/pace";
import { weekStart as getWeekStart } from "@/utils/dates";
import {
  classifyRun,
  RUN_TAG_STYLES,
  RUN_TAG_LABELS,
  type RunTag,
} from "@/utils/activityTypes";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";
import { evaluateAutoAssignRules } from "@/utils/shoeAutoAssign";
import { prefetchRoutes } from "@/utils/routeCache";
import { fetchAllOverrides, excludeWorkout } from "@/services/workoutOverrides";
import { ExcludedItemsModal } from "@/components/ExcludedItemsModal";
import { type WorkoutOverride, applyOverride } from "@/types/workoutOverride";
import {
  detectDuplicatePairs,
  type DuplicatePair,
} from "@/utils/duplicateDetection";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalDate(w: HealthWorkout): Date {
  return w.startDate;
}

function weekKey(date: Date): string {
  const d = getWeekStart(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

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

function getPaceDisplay(w: HealthWorkout): string {
  if (w.avgPaceSecPerMile && w.avgPaceSecPerMile > 0) {
    return `${formatPace(w.avgPaceSecPerMile)} /mi`;
  }
  if (w.durationSeconds > 0 && w.distanceMiles > 0) {
    return `${formatPace(w.durationSeconds / w.distanceMiles)} /mi`;
  }
  return "—";
}

// ─── Mini Calendar ────────────────────────────────────────────────────────────

interface MiniCalendarProps {
  year: number;
  runs: HealthWorkout[];
  onDayClick: (wKey: string) => void;
}

function MiniCalendar({ year, runs, onDayClick }: MiniCalendarProps) {
  const today = new Date();
  const [month, setMonth] = useState<number>(() => {
    return today.getFullYear() === year ? today.getMonth() : 11;
  });

  useEffect(() => {
    setMonth(today.getFullYear() === year ? today.getMonth() : 11);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const runsByDay = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of runs) {
      const d = getLocalDate(r);
      const key = d.toISOString().split("T")[0];
      map[key] = (map[key] ?? 0) + r.distanceMiles;
    }
    return map;
  }, [runs]);

  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const monthLabel = firstDay.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const canGoPrev = !(month === 0);
  const canGoNext = !(month === 11);

  function prevMonth() {
    if (month === 0) return;
    setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) return;
    setMonth((m) => m + 1);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={prevMonth}
          disabled={!canGoPrev}
          aria-label="Previous month"
          className="p-1 rounded-md hover:bg-surface text-textSecondary disabled:opacity-30 transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs font-semibold text-textSecondary">{monthLabel}</span>
        <button
          onClick={nextMonth}
          disabled={!canGoNext}
          aria-label="Next month"
          className="p-1 rounded-md hover:bg-surface text-textSecondary disabled:opacity-30 transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="text-center text-[10px] font-semibold text-textSecondary py-0.5">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: totalCells }).map((_, i) => {
          const dayNum = i - startOffset + 1;
          const isThisMonth = dayNum >= 1 && dayNum <= daysInMonth;
          const cellDate = new Date(year, month, dayNum);
          const isoDate = cellDate.toISOString().split("T")[0];
          const miles = runsByDay[isoDate];
          const hasRun = !!miles;
          const isToday =
            cellDate.getFullYear() === today.getFullYear() &&
            cellDate.getMonth() === today.getMonth() &&
            cellDate.getDate() === today.getDate();

          if (!isThisMonth) {
            return <div key={i} className="h-7" />;
          }

          const wk = weekKey(cellDate);

          return (
            <button
              key={i}
              onClick={() => hasRun && onDayClick(wk)}
              disabled={!hasRun}
              className={`flex flex-col items-center justify-center h-7 rounded-full transition-colors
                ${hasRun ? "cursor-pointer" : "cursor-default"}
                ${!isThisMonth ? "opacity-40" : ""}
              `}
              title={hasRun ? `${miles.toFixed(1)} mi` : undefined}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium transition-colors
                  ${hasRun ? "bg-primary text-white" : "border border-border text-textSecondary"}
                  ${isToday ? "ring-2 ring-primary ring-offset-1" : ""}
                `}
              >
                {dayNum}
              </div>
              {hasRun && (
                <span className="text-[9px] text-textSecondary leading-none mt-0.5">
                  {miles.toFixed(1)}
                </span>
              )}
            </button>
          );
        })}
      </div>
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

// ─── Year Stats ───────────────────────────────────────────────────────────────

interface YearStatsProps {
  runs: HealthWorkout[];
}

function YearStats({ runs }: YearStatsProps) {
  const count = runs.length;
  const totalMiles = runs.reduce((s, r) => s + r.distanceMiles, 0);
  const avgMiPerRun = count > 0 ? totalMiles / count : 0;
  const totalTime = runs.reduce((s, r) => s + r.durationSeconds, 0);
  const avgPaceSec = totalMiles > 0 ? totalTime / totalMiles : 0;

  return (
    <div className="grid grid-cols-2 gap-3">
      {[
        { label: "Runs", value: String(count) },
        { label: "Miles", value: `${totalMiles.toFixed(1)} mi` },
        { label: "Avg Mi/Run", value: `${avgMiPerRun.toFixed(2)} mi` },
        { label: "Avg Pace", value: avgPaceSec > 0 ? `${formatPace(avgPaceSec)} /mi` : "—" },
      ].map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-textSecondary">{label}</span>
          <span className="text-base font-bold text-textPrimary tabular-nums leading-tight">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Run Row ──────────────────────────────────────────────────────────────────

interface RunRowProps {
  run: HealthWorkout;
  shoes: RunningShoe[];
  assignedShoeId: string | null;
  isDropdownOpen: boolean;
  onToggleDropdown: () => void;
  onAssign: (shoeId: string | null) => void;
  onRowClick: () => void;
  isDuplicate?: boolean;
}

function RunRow({
  run,
  shoes,
  assignedShoeId,
  isDropdownOpen,
  onToggleDropdown,
  onAssign,
  onRowClick,
  isDuplicate,
}: RunRowProps) {
  const localDate = getLocalDate(run);
  const dayAbbrev = DAY_ABBREVS[(localDate.getDay() + 6) % 7];
  const dayNum = localDate.getDate();

  const tag = classifyRun(run.displayType, run.distanceMiles);

  const hasHR = run.avgHeartRate !== null && (run.avgSpeedMPS ?? 0) > 0;
  let displayScore = 0;
  let effBadgeLevel: "good" | "ok" | "low" | "neutral" = "neutral";

  if (hasHR && run.avgHeartRate) {
    try {
      const rawScore = ((run.avgSpeedMPS ?? 0) / run.avgHeartRate) * 1000;
      displayScore = efficiencyDisplayScore(run.avgSpeedMPS ?? 0, run.avgHeartRate);
      const level = efficiencyLevel(rawScore, distanceBucket(run.distanceMiles));
      effBadgeLevel = level === "good" ? "good" : level === "ok" ? "ok" : "low";
    } catch {
      // guard against unexpected NaN
    }
  }

  const displayScoreStr =
    hasHR && displayScore > 0 && isFinite(displayScore)
      ? displayScore.toFixed(1)
      : "—";

  const assignedShoe = shoes.find((s) => s.id === assignedShoeId) ?? null;
  const shoeName = assignedShoe
    ? assignedShoe.name || `${assignedShoe.brand} ${assignedShoe.model}`.trim()
    : null;

  return (
    <div onClick={onRowClick} className="flex items-center gap-3 py-3 px-4 hover:bg-surface rounded-xl transition-colors group cursor-pointer">
      {/* Col 1: Date */}
      <div className="flex flex-col items-center w-9 shrink-0 select-none">
        <span className="text-[10px] font-semibold text-textSecondary leading-none">{dayAbbrev}</span>
        <span className="text-sm font-bold text-textPrimary leading-tight">{dayNum}</span>
      </div>

      {/* Col 2: Run info */}
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-textPrimary truncate max-w-[180px]">
            {run.displayType}
          </span>
          {isDuplicate && (
            <span className="text-warning" title="Possible duplicate — click to view and exclude if needed">
              <AlertTriangle size={12} />
            </span>
          )}
        </div>
        <span className={`self-start text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${RUN_TAG_STYLES[tag]}`}>
          {RUN_TAG_LABELS[tag]}
        </span>
      </div>

      {/* Col 3: Distance */}
      <div className="w-16 shrink-0 text-sm font-semibold text-textPrimary tabular-nums text-right">
        {formatMiles(run.distanceMiles)} mi
      </div>

      {/* Col 4: Pace */}
      <div className="w-20 shrink-0 text-sm text-textPrimary tabular-nums text-right">
        {getPaceDisplay(run)}
      </div>

      {/* Col 5: Heart Rate */}
      <div className="w-16 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {run.avgHeartRate ? `${Math.round(run.avgHeartRate)} bpm` : "—"}
      </div>

      {/* Col 6: Duration — hidden on mobile */}
      <div className="hidden lg:block w-16 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {formatDuration(run.durationSeconds)}
      </div>

      {/* Col 7: Efficiency */}
      <div className="shrink-0">
        <MetricBadge
          label="Eff"
          value={displayScoreStr}
          level={displayScoreStr === "—" ? "neutral" : effBadgeLevel}
        />
      </div>

      {/* Col 8: Shoe */}
      <div className="relative shrink-0 w-28" data-shoe-dropdown="true" onClick={(e) => e.stopPropagation()}>
        {shoeName ? (
          <button
            onClick={onToggleDropdown}
            data-shoe-dropdown="true"
            className="text-xs bg-success/10 text-success px-2 py-0.5 rounded-full hover:bg-success/20 transition-colors"
          >
            {shoeName}
          </button>
        ) : (
          <button
            onClick={onToggleDropdown}
            data-shoe-dropdown="true"
            className="text-xs text-textSecondary hover:text-primary cursor-pointer transition-colors"
          >
            — assign
          </button>
        )}

        {isDropdownOpen && shoes.length > 0 && (
          <div
            data-shoe-dropdown="true"
            className="absolute right-0 top-full mt-1 bg-card border border-border rounded-xl shadow-lg z-50 min-w-[160px] py-1"
          >
            {shoes.map((shoe) => {
              const name = shoe.name || `${shoe.brand} ${shoe.model}`.trim();
              return (
                <button
                  key={shoe.id}
                  onClick={() => onAssign(shoe.id)}
                  data-shoe-dropdown="true"
                  className={`w-full text-left px-4 py-2 text-sm hover:bg-surface cursor-pointer transition-colors ${
                    assignedShoeId === shoe.id
                      ? "font-semibold text-primary"
                      : "text-textPrimary"
                  }`}
                >
                  {name}
                </button>
              );
            })}
            <div className="border-t border-border my-1" />
            <button
              onClick={() => onAssign(null)}
              data-shoe-dropdown="true"
              className={`w-full text-left px-4 py-2 text-sm hover:bg-surface cursor-pointer transition-colors ${
                !assignedShoeId
                  ? "font-semibold text-primary"
                  : "text-textSecondary"
              }`}
            >
              Unassigned
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Week Group ───────────────────────────────────────────────────────────────

interface WeekGroupProps {
  wKey: string;
  runs: HealthWorkout[];
  manualAssignments: Record<string, string | null>;
  innerRef: (el: HTMLDivElement | null) => void;
  shoes: RunningShoe[];
  openDropdown: string | null;
  setOpenDropdown: (id: string | null) => void;
  onAssign: (workoutId: string, shoeId: string | null) => void;
  onRunClick: (workoutId: string) => void;
  duplicateIds: Set<string>;
}

function WeekGroup({
  wKey,
  runs,
  manualAssignments,
  innerRef,
  shoes,
  openDropdown,
  setOpenDropdown,
  onAssign,
  duplicateIds,
  onRunClick,
}: WeekGroupProps) {
  const wStart = new Date(wKey + "T00:00:00");
  const weekLabel = wStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const totalMiles = runs.reduce((s, r) => s + r.distanceMiles, 0);

  return (
    <div ref={innerRef} className="mb-6">
      <div className="flex items-center justify-between border-b border-border pb-1.5 mb-1">
        <span className="text-sm font-semibold text-textSecondary">
          Week of {weekLabel}
        </span>
        <span className="text-xs text-textSecondary tabular-nums">
          {totalMiles.toFixed(1)} mi &middot; {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
      </div>

      {runs.map((run) => {
        const assignedShoeId = manualAssignments[run.workoutId] ?? null;
        return (
          <RunRow
            key={run.workoutId}
            run={run}
            shoes={shoes}
            assignedShoeId={assignedShoeId}
            isDropdownOpen={openDropdown === run.workoutId}
            onToggleDropdown={() =>
              setOpenDropdown(openDropdown === run.workoutId ? null : run.workoutId)
            }
            onAssign={(shoeId) => onAssign(run.workoutId, shoeId)}
            onRowClick={() => onRunClick(run.workoutId)}
            isDuplicate={duplicateIds.has(run.workoutId)}
          />
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RunsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [allRuns, setAllRuns] = useState<HealthWorkout[]>([]);
  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [manualAssignments, setManualAssignments] = useState<Record<string, string | null>>({});
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [showExcluded, setShowExcluded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  const weekRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-shoe-dropdown]")) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // One-time fetch for shoes, assignments, and overrides (user-managed data)
  useEffect(() => {
    if (!uid) return;
    Promise.all([
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
      fetchAllOverrides(uid),
    ])
      .then(([fetchedShoes, assignments, fetchedOverrides]) => {
        setShoes(fetchedShoes);
        setOverrides(fetchedOverrides);
        // Store raw assignments — merged with auto-assign in the snapshot callback
        shoesRef.current = fetchedShoes;
        assignmentsRef.current = assignments;
      })
      .catch(console.error);
  }, [uid]);

  // Refs to hold latest shoes/assignments for use inside the snapshot callback
  // without re-subscribing the listener every time shoes/assignments change.
  const shoesRef = useRef<RunningShoe[]>([]);
  const assignmentsRef = useRef<Record<string, string | null>>({});

  // Real-time listener for healthWorkouts — updates when iOS syncs a new run
  useEffect(() => {
    if (!uid) return;
    setLoading(true);

    const unsubscribe = onHealthWorkoutsSnapshot(
      uid,
      { limitCount: 500 },
      (wkts) => {
        const runs = wkts.filter((w) => w.isRunLike);
        setAllRuns(runs);

        // Recompute auto-assignments whenever the run list changes
        const autoAssigned = evaluateAutoAssignRules(
          runs,
          shoesRef.current,
          assignmentsRef.current
        );
        setManualAssignments({ ...autoAssigned, ...assignmentsRef.current });

        setLoading(false);

        // Background prefetch — most recent 20 runs with routes
        setTimeout(() => {
          const recentWithRoutes = runs
            .filter((a) => a.hasRoute)
            .sort(
              (a, b) =>
                new Date(b.startDate).getTime() -
                new Date(a.startDate).getTime()
            )
            .slice(0, 20)
            .map((a) => a.workoutId);
          if (recentWithRoutes.length > 0 && uid) {
            prefetchRoutes(uid, recentWithRoutes).catch(() => {});
          }
        }, 500);
      },
      () => setLoading(false)
    );

    return () => unsubscribe();
  }, [uid]);

  const activeShoes = useMemo(
    () => shoes.filter((s) => !s.isRetired),
    [shoes]
  );

  const handleAssign = useCallback(
    async (workoutId: string, shoeId: string | null) => {
      if (!uid) return;
      setManualAssignments((prev) => ({ ...prev, [workoutId]: shoeId }));
      setOpenDropdown(null);
      try {
        await saveManualAssignments(uid, { [workoutId]: shoeId });
      } catch (err) {
        console.error(err);
      }
    },
    [uid]
  );

  const availableYears = useMemo(() => {
    const years = Array.from(
      new Set(allRuns.map((r) => getLocalDate(r).getFullYear()))
    ).sort((a, b) => b - a);
    if (!years.includes(currentYear)) years.unshift(currentYear);
    return years;
  }, [allRuns, currentYear]);

  // Separate excluded from visible runs, apply overrides for display
  const { visibleRuns, excludedRuns } = useMemo(() => {
    const visible: HealthWorkout[] = [];
    const excluded: HealthWorkout[] = [];
    for (const r of allRuns) {
      const displayed = applyOverride(r, overrides[r.workoutId] ?? null);
      if (overrides[r.workoutId]?.isExcluded) {
        excluded.push(displayed);
      } else {
        visible.push(displayed);
      }
    }
    return { visibleRuns: visible, excludedRuns: excluded };
  }, [allRuns, overrides]);

  const filteredRuns = useMemo(
    () => visibleRuns.filter((r) => getLocalDate(r).getFullYear() === selectedYear),
    [visibleRuns, selectedYear]
  );

  // Detect duplicate pairs and derive badge IDs
  const duplicatePairs = useMemo(
    () => detectDuplicatePairs(visibleRuns),
    [visibleRuns]
  );
  const duplicateIds = useMemo(
    () =>
      new Set(
        duplicatePairs.flatMap((p) => [p.otfWorkoutId, p.manualWorkoutId])
      ),
    [duplicatePairs]
  );

  // Suggestion banner state — persisted to localStorage
  const [dismissedPairIds, setDismissedPairIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("dismissedDuplicatePairs");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const suggestionPairs = useMemo(
    () =>
      duplicatePairs.filter(
        (pair) =>
          !overrides[pair.otfWorkoutId]?.isExcluded &&
          !dismissedPairIds.has(pair.otfWorkoutId)
      ),
    [duplicatePairs, overrides, dismissedPairIds]
  );

  const groupedWeeks = useMemo(() => {
    const map: Record<string, HealthWorkout[]> = {};
    for (const run of filteredRuns) {
      const k = weekKey(getLocalDate(run));
      if (!map[k]) map[k] = [];
      map[k].push(run);
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => getLocalDate(a).getTime() - getLocalDate(b).getTime());
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [filteredRuns]);

  const scrollToWeek = useCallback((wk: string) => {
    weekRefs.current[wk]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const totalYearMiles = filteredRuns.reduce((s, r) => s + r.distanceMiles, 0);

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-4 lg:p-6 min-h-full">
      {/* ── Left Sidebar ────────────────────────────────────── */}
      <aside className="w-full lg:w-64 shrink-0 flex flex-col gap-5">
        {/* Year selector */}
        <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            Year
          </p>
          <YearNavigator
            years={availableYears}
            selected={selectedYear}
            onChange={setSelectedYear}
          />
        </div>

        {/* Year stats */}
        <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            {selectedYear} Summary
          </p>
          {filteredRuns.length === 0 ? (
            <p className="text-xs text-textSecondary">No runs yet</p>
          ) : (
            <YearStats runs={filteredRuns} />
          )}
        </div>

        {/* Mini calendar — hidden on mobile */}
        <div className="hidden lg:block bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-3">
            Calendar
          </p>
          <MiniCalendar
            year={selectedYear}
            runs={filteredRuns}
            onDayClick={scrollToWeek}
          />
        </div>
      </aside>

      {/* ── Right Main Area ──────────────────────────────────── */}
      <main className="flex-1 min-w-0">
        {/* Controls row */}
        <div className="flex items-center justify-end gap-3 mb-4">
          {excludedRuns.length > 0 && (
            <button
              onClick={() => setShowExcluded(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs font-medium text-textSecondary hover:text-textPrimary hover:border-textSecondary transition-colors"
            >
              <EyeOff className="w-3.5 h-3.5" />
              {excludedRuns.length} Excluded
            </button>
          )}
          <span className="text-sm text-textSecondary tabular-nums">
            {filteredRuns.length} {filteredRuns.length === 1 ? "run" : "runs"}{" "}
            &middot; {totalYearMiles.toFixed(1)} miles
          </span>
        </div>

        {/* Duplicate suggestion banners */}
        {suggestionPairs.length > 0 && (
          <div className="flex flex-col gap-3 mb-4">
            {suggestionPairs.map((pair) => (
              <DuplicateSuggestionBanner
                key={pair.otfWorkoutId}
                pair={pair}
                onExclude={async () => {
                  if (!uid) return;
                  await excludeWorkout(uid, pair.otfWorkoutId);
                  setOverrides((prev) => ({
                    ...prev,
                    [pair.otfWorkoutId]: {
                      ...prev[pair.otfWorkoutId],
                      workoutId: pair.otfWorkoutId,
                      userId: uid,
                      isExcluded: true,
                      excludedAt: new Date().toISOString(),
                      excludedReason: "auto-suggested duplicate",
                      distanceMilesOverride: null,
                      durationSecondsOverride: null,
                      runTypeOverride: null,
                      updatedAt: new Date().toISOString(),
                    },
                  }));
                }}
                onDismiss={() => {
                  setDismissedPairIds((prev) => {
                    const updated = new Set([...prev, pair.otfWorkoutId]);
                    try {
                      localStorage.setItem(
                        "dismissedDuplicatePairs",
                        JSON.stringify([...updated])
                      );
                    } catch { /* ignore */ }
                    return updated;
                  });
                }}
              />
            ))}
          </div>
        )}

        {/* Column headers — desktop only */}
        {groupedWeeks.length > 0 && (
          <div className="hidden md:flex items-center gap-3 px-4 mb-1">
            <div className="w-9 shrink-0" />
            <div className="flex-1">
              <span className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
                Run
              </span>
            </div>
            <div className="w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Dist
            </div>
            <div className="w-20 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Pace
            </div>
            <div className="hidden lg:block w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Time
            </div>
            <div className="hidden lg:block w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              HR
            </div>
            <div className="shrink-0 w-14 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Eff
            </div>
            <div className="w-28 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary">
              Shoe
            </div>
          </div>
        )}

        {/* Run list */}
        {filteredRuns.length === 0 ? (
          <div className="mt-8">
            {allRuns.length === 0 ? (
              <EmptyState
                title="No runs synced"
                description="Sync workouts from the iOS app to see your runs here."
              />
            ) : (
              <EmptyState title={`No runs recorded in ${selectedYear}`} />
            )}
          </div>
        ) : (
          groupedWeeks.map(([wk, runs]) => (
            <WeekGroup
              key={wk}
              wKey={wk}
              runs={runs}
              manualAssignments={manualAssignments}
              shoes={activeShoes}
              openDropdown={openDropdown}
              setOpenDropdown={setOpenDropdown}
              onAssign={handleAssign}
              onRunClick={(id) => router.push(`/runs/${id}`)}
              duplicateIds={duplicateIds}
              innerRef={(el) => {
                weekRefs.current[wk] = el;
              }}
            />
          ))
        )}

      </main>

      {uid && (
        <ExcludedItemsModal
          isOpen={showExcluded}
          onClose={() => setShowExcluded(false)}
          excludedItems={excludedRuns}
          userId={uid}
          onRestored={(workoutId) => {
            setOverrides((prev) => {
              const updated = { ...prev };
              delete updated[workoutId];
              return updated;
            });
          }}
        />
      )}
    </div>
  );
}
