"use client";

import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, AlertTriangle, RotateCcw } from "lucide-react";

import { MetricBadge } from "@/components/ui/MetricBadge";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
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
import { fetchAllOverrides, restoreWorkout } from "@/services/workoutOverrides";
import { type WorkoutOverride, applyOverride } from "@/types/workoutOverride";

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

// ─── Year Selector ────────────────────────────────────────────────────────────

interface YearSelectorProps {
  years: number[];
  selected: number;
  onChange: (y: number) => void;
}

function YearSelector({ years, selected, onChange }: YearSelectorProps) {
  if (years.length <= 4) {
    return (
      <div className="flex rounded-lg border border-border overflow-hidden">
        {years.map((y) => (
          <button
            key={y}
            onClick={() => onChange(y)}
            className={`flex-1 py-1.5 text-xs font-semibold transition-colors
              ${y === selected
                ? "bg-primary text-white"
                : "text-textSecondary hover:bg-surface"
              }`}
          >
            {y}
          </button>
        ))}
      </div>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full border border-border rounded-lg px-3 py-1.5 text-sm text-textPrimary bg-card focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
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

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    Promise.all([
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
      fetchAllOverrides(uid),
    ])
      .then(([wkts, fetchedShoes, assignments, fetchedOverrides]) => {
        const runs = wkts.filter((w) => w.isRunLike);
        setAllRuns(runs);
        setShoes(fetchedShoes);
        setOverrides(fetchedOverrides);
        const autoAssigned = evaluateAutoAssignRules(runs, fetchedShoes, assignments);
        setManualAssignments({ ...autoAssigned, ...assignments });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
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

  // Detect potential duplicates: only flag when at least one is OTF/HIIT
  // Uses all visible runs (not year-filtered) so same-day pairs always detected
  const duplicateIds = useMemo(() => {
    function isOtfOrHiit(a: HealthWorkout): boolean {
      const name = a.displayType.toLowerCase();
      const type = a.activityType.toLowerCase();
      return (
        name.includes("orange") ||
        name.includes("otf") ||
        type === "high_intensity_interval_training" ||
        type.includes("hiit")
      );
    }

    const ids = new Set<string>();
    for (let i = 0; i < visibleRuns.length; i++) {
      for (let j = i + 1; j < visibleRuns.length; j++) {
        const a = visibleRuns[i];
        const b = visibleRuns[j];

        // At least one must be OTF or HIIT
        if (!isOtfOrHiit(a) && !isOtfOrHiit(b)) continue;

        // Must be within 60 minutes of each other
        const timeA = new Date(a.startDate).getTime();
        const timeB = new Date(b.startDate).getTime();
        const diffMinutes = Math.abs(timeA - timeB) / 60000;
        if (diffMinutes > 60) continue;

        // Duration within 30% of each other
        const durA = a.durationSeconds;
        const durB = b.durationSeconds;
        const durRatio = Math.min(durA, durB) / Math.max(durA, durB);
        if (durRatio < 0.3) continue;

        ids.add(a.workoutId);
        ids.add(b.workoutId);
      }
    }
    return ids;
  }, [visibleRuns]);

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
          <YearSelector
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
        <div className="flex items-center justify-end mb-4">
          <span className="text-sm text-textSecondary tabular-nums">
            {filteredRuns.length} {filteredRuns.length === 1 ? "run" : "runs"}{" "}
            &middot; {totalYearMiles.toFixed(1)} miles
          </span>
        </div>

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

        {/* Excluded workouts */}
        {excludedRuns.length > 0 && (
          <div className="mt-8 border-t border-border pt-4">
            <button
              onClick={() => setShowExcluded(!showExcluded)}
              className="text-sm text-textSecondary hover:text-textPrimary transition-colors"
            >
              {showExcluded ? "Hide" : "Show"} {excludedRuns.length} excluded{" "}
              {excludedRuns.length === 1 ? "workout" : "workouts"}
            </button>
            {showExcluded && (
              <div className="mt-3 opacity-60 space-y-2">
                {excludedRuns.map((run) => (
                  <div
                    key={run.workoutId}
                    className="flex items-center gap-3 py-2 px-4 rounded-lg bg-card border border-border"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-textPrimary">
                        {run.displayType} &middot;{" "}
                        {new Date(run.startDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      <span className="text-xs text-textSecondary ml-2">
                        {run.distanceMiles.toFixed(2)} mi
                      </span>
                    </div>
                    <button
                      onClick={async () => {
                        if (!uid) return;
                        await restoreWorkout(uid, run.workoutId);
                        setOverrides((prev) => {
                          const next = { ...prev };
                          delete next[run.workoutId];
                          return next;
                        });
                      }}
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <RotateCcw size={12} />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
