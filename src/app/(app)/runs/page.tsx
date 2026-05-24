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

import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { onHealthWorkoutsSnapshot } from "@/services/healthWorkouts";
import {
  fetchShoes,
  fetchManualShoeAssignmentsMap,
  saveManualAssignments,
} from "@/services/shoes";

import { computeTrainingLoad, MIN_RUN_MILES_FOR_AVG } from "@/utils/trainingLoad";
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
  /** When set, the calendar forces this month and disables chevron nav. */
  lockedMonth?: number | null;
}

function MiniCalendar({ year, runs, onDayClick, lockedMonth }: MiniCalendarProps) {
  const today = new Date();
  const isLocked = lockedMonth !== null && lockedMonth !== undefined;
  const [month, setMonth] = useState<number>(() => {
    if (isLocked) return lockedMonth as number;
    return today.getFullYear() === year ? today.getMonth() : 11;
  });

  useEffect(() => {
    if (isLocked) {
      setMonth(lockedMonth as number);
    } else {
      setMonth(today.getFullYear() === year ? today.getMonth() : 11);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, lockedMonth]);

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

  const canGoPrev = !isLocked && month !== 0;
  const canGoNext = !isLocked && month !== 11;

  function prevMonth() {
    if (isLocked || month === 0) return;
    setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (isLocked || month === 11) return;
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

// ─── Filter Pills ─────────────────────────────────────────────────────────────

type DistanceFilter = "all" | "1-3" | "3-5" | "5-7" | "7-9" | "9+";
type LoadFilter = "all" | "easy" | "medium" | "heavy";

const DISTANCE_OPTIONS: { value: DistanceFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "1-3", label: "1–2.9 mi" },
  { value: "3-5", label: "3–4.9 mi" },
  { value: "5-7", label: "5–6.9 mi" },
  { value: "7-9", label: "7–8.9 mi" },
  { value: "9+", label: "9+ mi" },
];

const LOAD_OPTIONS: { value: LoadFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "easy", label: "Easy (<80)" },
  { value: "medium", label: "Medium (80–200)" },
  { value: "heavy", label: "Heavy (200+)" },
];

function matchesDistanceFilter(miles: number, f: DistanceFilter): boolean {
  switch (f) {
    case "all": return true;
    case "1-3": return miles >= 1 && miles < 3;
    case "3-5": return miles >= 3 && miles < 5;
    case "5-7": return miles >= 5 && miles < 7;
    case "7-9": return miles >= 7 && miles < 9;
    case "9+":  return miles >= 9;
  }
}

/** Returns true if a run with `load` (null if not computable) matches the load
 *  filter. Runs with null load are excluded from any non-"All" load view. */
function matchesLoadFilter(load: number | null, f: LoadFilter): boolean {
  if (f === "all") return true;
  if (load == null) return false;
  switch (f) {
    case "easy":   return load < 80;
    case "medium": return load >= 80 && load < 200;
    case "heavy":  return load >= 200;
  }
}

function FilterPills<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                active
                  ? "bg-primary text-white border-primary"
                  : "bg-surface text-textSecondary border-border hover:text-textPrimary"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PrTogglePill({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
        PR
      </p>
      <button
        onClick={onToggle}
        aria-pressed={active}
        className={`self-start px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          active
            ? "bg-amber-500/15 text-amber-600 border-amber-500/40 dark:text-amber-400"
            : "bg-surface text-textSecondary border-border hover:text-textPrimary"
        }`}
      >
        {active ? "🏅 PRs only ✓" : "🏅 PRs only"}
      </button>
    </div>
  );
}

// ─── Year Stats ───────────────────────────────────────────────────────────────

interface YearStatsProps {
  runs: HealthWorkout[];
  /** Avg of weekly total run loads across elapsed weeks in the window. */
  avgWeeklyLoad: number | null;
}

function YearStats({ runs, avgWeeklyLoad }: YearStatsProps) {
  const count = runs.length;
  const totalMiles = runs.reduce((s, r) => s + r.distanceMiles, 0);
  const avgMiPerRun = count > 0 ? totalMiles / count : 0;
  const totalTime = runs.reduce((s, r) => s + r.durationSeconds, 0);
  const avgPaceSec = totalMiles > 0 ? totalTime / totalMiles : 0;

  // Avg HR — simple mean of run-level avgHeartRate ignoring missing / zero.
  const hrVals = runs
    .map((r) => r.avgHeartRate)
    .filter((v): v is number => typeof v === "number" && v > 0 && isFinite(v));
  const avgHR =
    hrVals.length > 0
      ? hrVals.reduce((a, b) => a + b, 0) / hrVals.length
      : null;

  // Training Load — same TRIMP-style score as the per-run badge:
  //   computeTrainingLoad(duration, HR) → null if HR/duration invalid.
  //   We aggregate the mean of valid scores so the summary tile shows
  //   "average effort per run" rather than total load.
  //   Short/aborted runs (< MIN_RUN_MILES_FOR_AVG) are excluded so warmups
  //   and restarts don't drag the average down — their individual badges
  //   still render in the list below.
  const loadVals: number[] = [];
  for (const r of runs) {
    if (r.distanceMiles < MIN_RUN_MILES_FOR_AVG) continue;
    const load = computeTrainingLoad(r.durationSeconds, r.avgHeartRate);
    if (load != null) loadVals.push(load);
  }
  const avgLoad =
    loadVals.length > 0
      ? loadVals.reduce((a, b) => a + b, 0) / loadVals.length
      : null;

  // Dual Avg Load display — "perRun / weeklyAvg". Either side falls back
  // to "—" if there's no data to compute it from.
  const avgLoadPerRunStr = avgLoad != null ? String(Math.round(avgLoad)) : "—";
  const avgWeeklyLoadStr =
    avgWeeklyLoad != null ? String(Math.round(avgWeeklyLoad)) : "—";
  const avgLoadValue = `${avgLoadPerRunStr} / ${avgWeeklyLoadStr}`;

  const tiles: { label: string; value: string; subtext?: string }[] = [
    { label: "Runs", value: String(count) },
    { label: "Miles", value: `${totalMiles.toFixed(1)} mi` },
    { label: "Avg Mi/Run", value: `${avgMiPerRun.toFixed(2)} mi` },
    { label: "Avg Pace", value: avgPaceSec > 0 ? `${formatPace(avgPaceSec)} /mi` : "—" },
    { label: "Avg HR", value: avgHR != null ? `${Math.round(avgHR)} bpm` : "—" },
    { label: "Avg Load", value: avgLoadValue, subtext: "per run / weekly avg" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {tiles.map(({ label, value, subtext }) => (
        <div key={label} className="flex flex-col gap-0.5">
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

  const assignedShoe = shoes.find((s) => s.id === assignedShoeId) ?? null;
  const shoeName = assignedShoe
    ? assignedShoe.name || `${assignedShoe.brand} ${assignedShoe.model}`.trim()
    : null;

  const prBadges = run.prBadges ?? [];

  return (
    <div onClick={onRowClick} className="py-3 px-4 hover:bg-surface rounded-xl transition-colors group cursor-pointer">
      <div className="flex items-center gap-3">
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
          {/* Tag: sm+ only — on mobile it renders below the row */}
          <span className={`hidden sm:inline-block self-start text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${RUN_TAG_STYLES[tag]}`}>
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

        {/* Col 5: Heart Rate — hidden on mobile to prevent overflow */}
        <div className="hidden sm:block w-16 shrink-0 text-sm text-textSecondary tabular-nums text-right">
          {run.avgHeartRate ? `${Math.round(run.avgHeartRate)} bpm` : "—"}
        </div>

        {/* Col 6: Duration — hidden on mobile */}
        <div className="hidden lg:block w-16 shrink-0 text-sm text-textSecondary tabular-nums text-right">
          {formatDuration(run.durationSeconds)}
        </div>

        {/* Col 7: Training Load */}
        <div className="shrink-0">
          <TrainingLoadBadge
            durationSeconds={run.durationSeconds}
            avgHeartRate={run.avgHeartRate}
            activityType={run.activityType}
          />
        </div>

        {/* Col 8: Shoe — hidden on mobile to prevent overflow */}
        <div className="hidden sm:block relative shrink-0 w-28" data-shoe-dropdown="true" onClick={(e) => e.stopPropagation()}>
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

      {/* Tag: mobile only — sits below the data row, aligned with Col 2 */}
      <div className="sm:hidden mt-0.5 ml-12">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${RUN_TAG_STYLES[tag]}`}>
          {RUN_TAG_LABELS[tag]}
        </span>
      </div>

      {/* PR badges — render below the data row, aligned with Col 2 */}
      {prBadges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 ml-12">
          {prBadges.map((badge) => (
            <span
              key={badge}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20"
            >
              🏅 {badge}
            </span>
          ))}
        </div>
      )}
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

  // Per-week summary additions: avg HR (across runs with a valid HR) and
  // total load (sum of computeTrainingLoad scores, nulls dropped). Each
  // segment is skipped if no qualifying runs contributed to it.
  const hrVals = runs
    .map((r) => r.avgHeartRate)
    .filter((v): v is number => typeof v === "number" && v > 0 && isFinite(v));
  const avgHR =
    hrVals.length > 0 ? hrVals.reduce((a, b) => a + b, 0) / hrVals.length : null;

  const loadScores = runs
    .map((r) =>
      computeTrainingLoad(r.durationSeconds, r.avgHeartRate, r.activityType)
    )
    .filter((s): s is number => s != null);
  const totalLoad =
    loadScores.length > 0 ? loadScores.reduce((a, b) => a + b, 0) : null;

  const summaryParts = [
    `${totalMiles.toFixed(1)} mi`,
    `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
  ];
  if (avgHR != null) summaryParts.push(`avg ${Math.round(avgHR)}bpm`);
  if (totalLoad != null) summaryParts.push(`load ${Math.round(totalLoad)}`);

  return (
    <div ref={innerRef} className="mb-6">
      <div className="flex items-center justify-between flex-wrap gap-x-3 gap-y-1 border-b border-border pb-1.5 mb-1">
        <span className="text-sm font-semibold text-textSecondary">
          Week of {weekLabel}
        </span>
        <span className="text-xs text-textSecondary tabular-nums">
          {summaryParts.join(" · ")}
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

// ─── Shoes Used (sidebar section) ───────────────────────────────────────────

interface ShoesUsedProps {
  runs: HealthWorkout[];
  shoes: RunningShoe[];
  manualAssignments: Record<string, string | null>;
}

function ShoesUsed({ runs, shoes, manualAssignments }: ShoesUsedProps) {
  // Reuse the SAME per-run shoe resolution as RunRow: manualAssignments
  // map (which is set up at page level with auto-rule overlay) → shoes.find().
  // Window miles only — no startMileageOffset, no lifetime totals.
  type Row = { id: string | null; name: string; miles: number; count: number };
  const map = new Map<string, Row>();
  for (const r of runs) {
    const shoeId = manualAssignments[r.workoutId] ?? null;
    const key = shoeId ?? "__unassigned__";
    let row = map.get(key);
    if (!row) {
      const shoe = shoeId ? shoes.find((s) => s.id === shoeId) : null;
      row = {
        id: shoeId,
        name: shoe
          ? shoe.name || `${shoe.brand} ${shoe.model}`.trim() || "Unnamed shoe"
          : "Unassigned",
        miles: 0,
        count: 0,
      };
      map.set(key, row);
    }
    row.miles += r.distanceMiles;
    row.count += 1;
  }
  const rows = Array.from(map.values()).sort((a, b) => b.miles - a.miles);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-textSecondary">No runs in this period.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.id ?? "__unassigned__"}
          className="flex items-baseline justify-between gap-2"
        >
          <div className="flex items-baseline gap-2 min-w-0">
            <span
              className={`text-sm truncate ${
                row.id ? "text-textPrimary" : "text-textSecondary italic"
              }`}
            >
              {row.name}
            </span>
            <span className="text-[10px] text-textSecondary shrink-0">
              · {row.count} {row.count === 1 ? "run" : "runs"}
            </span>
          </div>
          <span className="text-sm font-semibold text-textPrimary tabular-nums shrink-0">
            {row.miles.toFixed(1)} mi
          </span>
        </li>
      ))}
    </ul>
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
  // null = "All months"; otherwise 0-indexed month within selectedYear.
  // Resets when selectedYear changes (a chosen month may not exist in the
  // new year).
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  useEffect(() => {
    setSelectedMonth(null);
  }, [selectedYear]);

  // Combinable run filters — applied AFTER year/month windowing. Reset to
  // defaults when the time window changes so the user doesn't get stuck in
  // a filter that hides everything in a freshly-selected month.
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("all");
  const [loadFilter, setLoadFilter] = useState<LoadFilter>("all");
  const [prOnly, setPrOnly] = useState<boolean>(false);
  useEffect(() => {
    setDistanceFilter("all");
    setLoadFilter("all");
    setPrOnly(false);
  }, [selectedYear, selectedMonth]);

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

  // Refs to hold latest shoes/assignments for use inside the snapshot callback
  // without re-subscribing the listener every time shoes/assignments change.
  const shoesRef = useRef<RunningShoe[]>([]);
  const assignmentsRef = useRef<Record<string, string | null>>({});

  // Fetch shoes, assignments, and overrides BEFORE starting the snapshot listener.
  // This prevents the race condition where the snapshot fires before shoe data is
  // loaded, causing "Unassigned" on first render.
  useEffect(() => {
    if (!uid) return;
    setLoading(true);

    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    Promise.all([
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
      fetchAllOverrides(uid),
    ])
      .then(([fetchedShoes, assignments, fetchedOverrides]) => {
        if (cancelled) return;

        // Populate refs so snapshot callback always sees current data
        shoesRef.current = fetchedShoes;
        assignmentsRef.current = assignments;

        // Also set state for UI that renders shoe data independently
        setShoes(fetchedShoes);
        setOverrides(fetchedOverrides);

        // NOW start the snapshot listener — guaranteed to see shoe data
        unsubscribe = onHealthWorkoutsSnapshot(
          uid,
          { limitCount: 500 },
          (wkts) => {
            if (cancelled) return;
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
          () => {
            if (!cancelled) setLoading(false);
          }
        );
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
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

  // Months (0-indexed) that have at least one run in the selected year.
  // Sorted ascending so the dropdown renders Jan → Dec.
  const availableMonths = useMemo(() => {
    const months = new Set<number>();
    for (const r of filteredRuns) months.add(getLocalDate(r).getMonth());
    return Array.from(months).sort((a, b) => a - b);
  }, [filteredRuns]);

  // Active window — runs feeding the summary tile, run list, calendar,
  // and shoes-used aggregation. With selectedMonth=null this equals
  // filteredRuns (preserving today's year-level behaviour). With a month
  // selected, narrows to that month within selectedYear.
  const windowRuns = useMemo(() => {
    if (selectedMonth === null) return filteredRuns;
    return filteredRuns.filter(
      (r) => getLocalDate(r).getMonth() === selectedMonth
    );
  }, [filteredRuns, selectedMonth]);

  // Distance / Load / PR filters applied on top of windowRuns. This is the
  // canonical "what the user sees" set — drives summary, week groups,
  // calendar dots, and shoes-used aggregation.
  const displayedRuns = useMemo(() => {
    return windowRuns.filter((r) => {
      if (!matchesDistanceFilter(r.distanceMiles, distanceFilter)) return false;
      const load = computeTrainingLoad(
        r.durationSeconds,
        r.avgHeartRate,
        r.activityType
      );
      if (!matchesLoadFilter(load, loadFilter)) return false;
      if (prOnly && !(r.prBadges && r.prBadges.length > 0)) return false;
      return true;
    });
  }, [windowRuns, distanceFilter, loadFilter, prOnly]);

  const filtersActive =
    distanceFilter !== "all" || loadFilter !== "all" || prOnly;

  // Weekly avg load — sum of weekly run loads over the displayed (filtered)
  // runs, divided by the number of elapsed weeks in the year/month window.
  // "Elapsed weeks" uses Monday-anchored buckets, clamped to today so a
  // partially-elapsed current month doesn't deflate the average. The time
  // window comes from year/month only; distance/load/PR filters affect the
  // numerator (which loads count) but NOT the denominator (calendar weeks
  // elapsed) — otherwise an aggressive filter would inflate the avg.
  const avgWeeklyLoad = useMemo<number | null>(() => {
    const totalLoad = displayedRuns.reduce((sum, r) => {
      const load = computeTrainingLoad(
        r.durationSeconds,
        r.avgHeartRate,
        r.activityType
      );
      return sum + (load ?? 0);
    }, 0);
    if (totalLoad <= 0) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let windowStart: Date;
    let windowEnd: Date;
    if (selectedMonth !== null) {
      windowStart = new Date(selectedYear, selectedMonth, 1);
      windowEnd = new Date(selectedYear, selectedMonth + 1, 0);
    } else {
      windowStart = new Date(selectedYear, 0, 1);
      windowEnd = new Date(selectedYear, 11, 31);
    }
    if (windowEnd > today) windowEnd = today;
    if (windowStart > today) return null;

    const startMonday = getWeekStart(windowStart);
    const endMonday = getWeekStart(windowEnd);
    const weeksSpanned =
      Math.max(
        0,
        Math.round((endMonday.getTime() - startMonday.getTime()) / (7 * 86400 * 1000))
      ) + 1;
    if (weeksSpanned <= 0) return null;

    return totalLoad / weeksSpanned;
  }, [displayedRuns, selectedYear, selectedMonth]);

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
    for (const run of displayedRuns) {
      const k = weekKey(getLocalDate(run));
      if (!map[k]) map[k] = [];
      map[k].push(run);
    }
    // Within each week, sort runs DESCENDING by date — most recent first.
    // Week-group order (most-recent-week first) is preserved by the outer
    // localeCompare swap below.
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => getLocalDate(b).getTime() - getLocalDate(a).getTime());
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [displayedRuns]);

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

  const totalWindowMiles = displayedRuns.reduce((s, r) => s + r.distanceMiles, 0);

  // Title for the summary tile — month-aware.
  const monthName =
    selectedMonth !== null
      ? new Date(selectedYear, selectedMonth, 1).toLocaleDateString("en-US", {
          month: "long",
        })
      : null;
  const summaryTitle =
    monthName !== null
      ? `${monthName} ${selectedYear} Summary`
      : `${selectedYear} Summary`;

  return (
    <div className="flex flex-col lg:flex-row gap-6 p-4 lg:p-6 min-h-full">
      {/* ── Left Sidebar ────────────────────────────────────── */}
      <aside className="w-full lg:w-64 shrink-0 flex flex-col gap-5">
        {/* Year + Month selector */}
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
            Month
          </p>
          <select
            value={selectedMonth ?? ""}
            onChange={(e) =>
              setSelectedMonth(
                e.target.value === "" ? null : Number(e.target.value)
              )
            }
            className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-textPrimary"
          >
            <option value="">All months</option>
            {availableMonths.map((m) => (
              <option key={m} value={m}>
                {new Date(selectedYear, m, 1).toLocaleDateString("en-US", {
                  month: "long",
                })}
              </option>
            ))}
          </select>

          {/* Additional filters — combinable with each other and with the
              year/month window above. Reset on year/month change so a
              freshly-selected window never starts empty. */}
          <FilterPills
            label="Distance"
            options={DISTANCE_OPTIONS}
            value={distanceFilter}
            onChange={setDistanceFilter}
          />
          <FilterPills
            label="Load"
            options={LOAD_OPTIONS}
            value={loadFilter}
            onChange={setLoadFilter}
          />
          <PrTogglePill
            active={prOnly}
            onToggle={() => setPrOnly((v) => !v)}
          />
        </div>

        {/* Summary tile */}
        <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            {summaryTitle}
          </p>
          {displayedRuns.length === 0 ? (
            <p className="text-xs text-textSecondary">
              {filtersActive ? "No runs match filters" : "No runs yet"}
            </p>
          ) : (
            <YearStats runs={displayedRuns} avgWeeklyLoad={avgWeeklyLoad} />
          )}
        </div>

        {/* Shoes used — sits between summary and calendar */}
        <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary">
            Shoes Used
          </p>
          <ShoesUsed
            runs={displayedRuns}
            shoes={shoes}
            manualAssignments={manualAssignments}
          />
        </div>

        {/* Mini calendar — hidden on mobile */}
        <div className="hidden lg:block bg-card rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-textSecondary mb-3">
            Calendar
          </p>
          <MiniCalendar
            year={selectedYear}
            runs={displayedRuns}
            onDayClick={scrollToWeek}
            lockedMonth={selectedMonth}
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
            {displayedRuns.length} {displayedRuns.length === 1 ? "run" : "runs"}{" "}
            &middot; {totalWindowMiles.toFixed(1)} miles
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
            <div className="hidden sm:block w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              HR
            </div>
            <div className="hidden lg:block w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Time
            </div>
            <div className="shrink-0 w-14 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Load
            </div>
            <div className="w-28 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary">
              Shoe
            </div>
          </div>
        )}

        {/* Run list */}
        {displayedRuns.length === 0 ? (
          <div className="mt-8">
            {allRuns.length === 0 ? (
              <EmptyState
                title="No runs synced"
                description="Sync workouts from the iOS app to see your runs here."
              />
            ) : filtersActive && windowRuns.length > 0 ? (
              <EmptyState
                title="No runs match your filters"
                description="Try widening the distance/load range or turning off PRs only."
              />
            ) : (
              <EmptyState
                title={
                  monthName !== null
                    ? `No runs recorded in ${monthName} ${selectedYear}`
                    : `No runs recorded in ${selectedYear}`
                }
              />
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
