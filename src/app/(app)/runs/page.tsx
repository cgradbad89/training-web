"use client";

import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { ChevronLeft, ChevronRight, Footprints } from "lucide-react";

import { MetricBadge } from "@/components/ui/MetricBadge";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { fetchActivities } from "@/services/activities";
import { fetchShoes, fetchManualShoeAssignmentsMap } from "@/services/shoes";

import {
  efficiencyDisplayScore,
  efficiencyLevel,
  distanceBucket,
} from "@/utils/metrics";
import { formatPace, formatDuration, formatMiles } from "@/utils/pace";
import { weekStart as getWeekStart, formatShortDate } from "@/utils/dates";
import {
  isRun,
  inferRunType,
  classifyRun,
  RUN_TAG_STYLES,
  RUN_TAG_LABELS,
  type RunTag,
} from "@/utils/activityTypes";
import { type StravaActivity } from "@/types/activity";
import { type RunningShoe } from "@/types/shoe";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalDate(a: StravaActivity): Date {
  return new Date(a.start_date_local || a.start_date);
}

function weekKey(date: Date): string {
  return getWeekStart(date).toISOString().split("T")[0];
}

/** Returns "Mon", "Tue", etc for a given weekday offset (0=Mon) */
const DAY_ABBREVS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];


function getPaceDisplay(a: StravaActivity): string {
  if (a.pace_min_per_mile && /^\d+:\d{2}$/.test(a.pace_min_per_mile)) {
    return `${a.pace_min_per_mile} /mi`;
  }
  if (a.pace_sec_per_mile > 0) return `${formatPace(a.pace_sec_per_mile)} /mi`;
  if (a.moving_time_s > 0 && a.distance_miles > 0) {
    return `${formatPace(a.moving_time_s / a.distance_miles)} /mi`;
  }
  return "—";
}

// ─── Mini Calendar ────────────────────────────────────────────────────────────

interface MiniCalendarProps {
  year: number;
  runs: StravaActivity[];
  onDayClick: (wKey: string) => void;
}

function MiniCalendar({ year, runs, onDayClick }: MiniCalendarProps) {
  const today = new Date();
  const [month, setMonth] = useState<number>(() => {
    // Default to current month if it's in the selected year, else December
    return today.getFullYear() === year ? today.getMonth() : 11;
  });

  // Sync month when year changes
  useEffect(() => {
    setMonth(today.getFullYear() === year ? today.getMonth() : 11);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // Build a map: "YYYY-MM-DD" → total miles
  const runsByDay = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of runs) {
      const d = getLocalDate(r);
      const key = d.toISOString().split("T")[0];
      map[key] = (map[key] ?? 0) + r.distance_miles;
    }
    return map;
  }, [runs]);

  // Calendar grid: first day of month, Mon-start
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
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
      {/* Month nav */}
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

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="text-center text-[10px] font-semibold text-textSecondary py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
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
  runs: StravaActivity[];
}

function YearStats({ runs }: YearStatsProps) {
  const count = runs.length;
  const totalMiles = runs.reduce((s, r) => s + r.distance_miles, 0);
  const avgMiPerRun = count > 0 ? totalMiles / count : 0;
  const totalTime = runs.reduce((s, r) => s + r.moving_time_s, 0);
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
  run: StravaActivity;
  shoeName: string | null;
}

function RunRow({ run, shoeName }: RunRowProps) {
  const localDate = getLocalDate(run);
  const dayAbbrev = DAY_ABBREVS[(localDate.getDay() + 6) % 7];
  const dayNum = localDate.getDate();

  const tag = classifyRun(run.name, run.distance_miles);

  const hasHR = run.avg_heartrate !== null && run.avg_speed_mps > 0;
  let displayScore = 0;
  let effBadgeLevel: "good" | "ok" | "low" | "neutral" = "neutral";

  if (hasHR && run.avg_heartrate) {
    try {
      const rawScore = (run.avg_speed_mps / run.avg_heartrate) * 1000;
      displayScore = efficiencyDisplayScore(run.avg_speed_mps, run.avg_heartrate);
      const level = efficiencyLevel(rawScore, distanceBucket(run.distance_miles));
      effBadgeLevel = level === "good" ? "good" : level === "ok" ? "ok" : "low";
    } catch {
      // guard against unexpected NaN
    }
  }

  const displayScoreStr =
    hasHR && displayScore > 0 && isFinite(displayScore)
      ? displayScore.toFixed(1)
      : "—";

  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-surface rounded-xl transition-colors group">
      {/* Col 1: Date */}
      <div className="flex flex-col items-center w-9 shrink-0 select-none">
        <span className="text-[10px] font-semibold text-textSecondary leading-none">{dayAbbrev}</span>
        <span className="text-sm font-bold text-textPrimary leading-tight">{dayNum}</span>
      </div>

      {/* Col 2: Run info */}
      <div className="flex flex-col min-w-0 flex-1 gap-0.5">
        <span className="text-sm font-medium text-textPrimary truncate max-w-[180px]">
          {run.name}
        </span>
        <span className={`self-start text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${RUN_TAG_STYLES[tag]}`}>
          {RUN_TAG_LABELS[tag]}
        </span>
      </div>

      {/* Col 3: Distance */}
      <div className="w-16 shrink-0 text-sm font-semibold text-textPrimary tabular-nums text-right">
        {formatMiles(run.distance_miles)} mi
      </div>

      {/* Col 4: Pace */}
      <div className="w-20 shrink-0 text-sm text-textPrimary tabular-nums text-right">
        {getPaceDisplay(run)}
      </div>

      {/* Col 5: Duration — hidden on mobile */}
      <div className="hidden lg:table-cell w-16 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {formatDuration(run.moving_time_s)}
      </div>

      {/* Col 6: Heart Rate — hidden on mobile */}
      <div className="hidden lg:table-cell w-16 shrink-0 text-sm text-textPrimary tabular-nums text-right">
        {run.avg_heartrate ? `${Math.round(run.avg_heartrate)} bpm` : "—"}
      </div>

      {/* Col 7: Elevation — hidden on mobile */}
      <div className="hidden lg:table-cell w-14 shrink-0 text-sm text-textSecondary tabular-nums text-right">
        {run.total_elev_gain_m > 0 ? `${Math.round(run.total_elev_gain_m)}m` : "—"}
      </div>

      {/* Col 8: Efficiency */}
      <div className="shrink-0">
        <MetricBadge
          label="Eff"
          value={displayScoreStr}
          level={displayScoreStr === "—" ? "neutral" : effBadgeLevel}
        />
      </div>

      {/* Col 9: Shoe — hidden on mobile */}
      {shoeName !== undefined && (
        <div className="hidden lg:table-cell items-center gap-1 w-28 shrink-0 text-xs text-textSecondary truncate">
          {shoeName ? (
            <>
              <Footprints size={11} className="shrink-0 text-textSecondary" />
              <span className="truncate">{shoeName}</span>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ─── Week Group ───────────────────────────────────────────────────────────────

interface WeekGroupProps {
  wKey: string;
  runs: StravaActivity[];
  shoeMap: Record<string, string>;
  manualAssignments: Record<string, string | null>;
  innerRef: (el: HTMLDivElement | null) => void;
}

function WeekGroup({ wKey, runs, shoeMap, manualAssignments, innerRef }: WeekGroupProps) {
  const wStart = new Date(wKey + "T00:00:00");
  const weekLabel = wStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const totalMiles = runs.reduce((s, r) => s + r.distance_miles, 0);

  return (
    <div ref={innerRef} className="mb-6">
      {/* Week header */}
      <div className="flex items-center justify-between border-b border-border pb-1.5 mb-1">
        <span className="text-sm font-semibold text-textSecondary">
          Week of {weekLabel}
        </span>
        <span className="text-xs text-textSecondary tabular-nums">
          {totalMiles.toFixed(1)} mi &middot; {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
      </div>

      {/* Run rows */}
      {runs.map((run) => {
        const assignedShoeId = manualAssignments[String(run.id)] ?? null;
        const shoeName = assignedShoeId ? (shoeMap[assignedShoeId] ?? null) : null;
        return <RunRow key={run.id} run={run} shoeName={shoeName} />;
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RunsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [allRuns, setAllRuns] = useState<StravaActivity[]>([]);
  const [shoes, setShoes] = useState<RunningShoe[]>([]);
  const [manualAssignments, setManualAssignments] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  const weekRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    Promise.all([
      fetchActivities({ limitCount: 500 }),
      fetchShoes(uid),
      fetchManualShoeAssignmentsMap(uid),
    ])
      .then(([acts, fetchedShoes, assignments]) => {
        setAllRuns(acts.filter((a) => isRun(a.type)));
        setShoes(fetchedShoes);
        setManualAssignments(assignments);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid]);

  // Available years derived from data
  const availableYears = useMemo(() => {
    const years = Array.from(
      new Set(allRuns.map((r) => getLocalDate(r).getFullYear()))
    ).sort((a, b) => b - a);
    if (!years.includes(currentYear)) years.unshift(currentYear);
    return years;
  }, [allRuns, currentYear]);

  // Runs for the selected year
  const filteredRuns = useMemo(
    () => allRuns.filter((r) => getLocalDate(r).getFullYear() === selectedYear),
    [allRuns, selectedYear]
  );

  // Group by week, sorted descending
  const groupedWeeks = useMemo(() => {
    const map: Record<string, StravaActivity[]> = {};
    for (const run of filteredRuns) {
      const k = weekKey(getLocalDate(run));
      if (!map[k]) map[k] = [];
      map[k].push(run);
    }
    // Sort within each week ascending (oldest first in week)
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => getLocalDate(a).getTime() - getLocalDate(b).getTime());
    }
    // Sort weeks descending
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [filteredRuns]);

  // Shoe lookup map: id → display name
  const shoeMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of shoes) {
      m[s.id] = s.name || `${s.brand} ${s.model}`.trim();
    }
    return m;
  }, [shoes]);

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

  const totalYearMiles = filteredRuns.reduce((s, r) => s + r.distance_miles, 0);

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
            <div className="hidden lg:table-cell w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Time
            </div>
            <div className="hidden lg:table-cell w-16 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              HR
            </div>
            <div className="hidden lg:table-cell w-14 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Elev
            </div>
            <div className="shrink-0 w-14 text-xs font-semibold uppercase tracking-widest text-textSecondary text-right">
              Eff
            </div>
            <div className="hidden lg:table-cell w-28 shrink-0 text-xs font-semibold uppercase tracking-widest text-textSecondary">
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
                description="Connect Strava to see your runs here."
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
              shoeMap={shoeMap}
              manualAssignments={manualAssignments}
              innerRef={(el) => {
                weekRefs.current[wk] = el;
              }}
            />
          ))
        )}
      </main>
    </div>
  );
}
