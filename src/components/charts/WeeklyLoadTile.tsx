"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Dumbbell, Footprints } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

import { TrainingLoadBadge } from "@/components/ui/TrainingLoadBadge";
import {
  classifyWeekLoad,
  stepWeekIndex,
  LOAD_BAND_BELOW_MAX,
  LOAD_BAND_TYPICAL_MAX,
  type LoadBand,
  type WeekLoadSummary,
} from "@/utils/weeklyLoad";
import { parseLocalDate } from "@/utils/dates";
import { formatDuration } from "@/utils/pace";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { type RunTitleContext } from "@/utils/runPlanTitle";
import { computeLoadIntensity } from "@/utils/loadScale";

interface WeeklyLoadTileProps {
  /** Oldest → newest; last entry = current week. */
  weeks: WeekLoadSummary[];
  /** 6-month median weekly load; 0 = no baseline yet. */
  medianWeekly: number;
  /** workoutId → matched plan-entry title context (priority-1 run label).
   *  Empty/omitted when no active plan is in scope. */
  runTitleMap?: Map<string, RunTitleContext>;
}

const BAND_LABEL: Record<LoadBand, string> = {
  below: "Below your typical range",
  typical: "Within your typical range",
  above: "Above your typical range",
  wellAbove: "Well above your typical range",
};

// below → accent/info blue (--color-primary), typical → --color-success,
// above → --color-warning, wellAbove → --color-danger.
const BAND_TEXT_CLASS: Record<LoadBand, string> = {
  below: "text-primary",
  typical: "text-success",
  above: "text-warning",
  wellAbove: "text-danger",
};

function rangeLabel(weekStartIso: string): string {
  const start = parseLocalDate(weekStartIso);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function activityDateLabel(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Weekly Training Load tile (Strava Relative Effort style) — replaces the
 * 16-week stacked bar chart on Personal Insights. Selected week's total
 * classified against the 6-month median (classifyWeekLoad), a 16-week line
 * with the typical range shaded behind it, click-to-select dots, and the
 * selected week's activity list (runs navigate to /runs/[id]; workouts have
 * no detail route, so their rows are non-clickable).
 */
export function WeeklyLoadTile({ weeks, medianWeekly, runTitleMap }: WeeklyLoadTileProps) {
  const router = useRouter();
  // Default selection: current week (last entry).
  const [selectedIndex, setSelectedIndex] = useState(
    Math.max(0, weeks.length - 1)
  );

  // Clamp defensively if the series shrinks between renders.
  const safeIndex = Math.min(selectedIndex, Math.max(0, weeks.length - 1));
  const selected = weeks[safeIndex] ?? null;

  const chartData = useMemo(
    () =>
      weeks.map((w, i) => {
        const month = parseLocalDate(w.weekStart).toLocaleDateString("en-US", {
          month: "short",
        });
        const prevMonth =
          i > 0
            ? parseLocalDate(weeks[i - 1].weekStart).toLocaleDateString(
                "en-US",
                { month: "short" }
              )
            : null;
        return {
          weekStart: w.weekStart,
          total: Math.round(w.total),
          // Sparse month labels: only the first week of each month gets one.
          monthLabel: month !== prevMonth ? month : "",
        };
      }),
    [weeks]
  );

  const hasAnyActivity = useMemo(
    () => weeks.some((w) => w.activities.length > 0),
    [weeks]
  );

  // Single shared load scale for the Load chips: cap = highest RUN load across
  // ALL weeks in the tile (stable as the user navigates weeks). 0 when there
  // are no runs → intensity is skipped and chips render exactly as before.
  const runLoadCap = useMemo(
    () =>
      Math.max(
        0,
        ...weeks.flatMap((w) =>
          w.activities
            .filter((a) => a.kind === "run")
            .map((a) => a.load ?? 0)
        )
      ),
    [weeks]
  );

  if (!selected) return null;

  if (!hasAnyActivity) {
    return (
      <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
        <h3 className="text-sm font-semibold text-textPrimary mb-3">
          Weekly Training Load
        </h3>
        <p className="text-sm text-textSecondary text-center py-6">
          Not enough activity in the last 16 weeks.
        </p>
      </div>
    );
  }

  const hasBaseline = medianWeekly > 0;
  const band = classifyWeekLoad(selected.total, medianWeekly);
  const scoreClass = hasBaseline ? BAND_TEXT_CLASS[band] : "text-textPrimary";

  const atOldest = safeIndex === 0;
  const atCurrent = safeIndex === weeks.length - 1;

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5 flex flex-col gap-4">
      {/* Header: title + week navigation */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-textPrimary">
          Weekly Training Load
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() =>
              setSelectedIndex((i) => stepWeekIndex(i, -1, weeks.length))
            }
            disabled={atOldest}
            aria-label="Previous week"
            className="p-1.5 rounded-lg text-textSecondary hover:bg-surface hover:text-textPrimary transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs font-semibold text-textPrimary tabular-nums min-w-[104px] text-center">
            {rangeLabel(selected.weekStart)}
          </span>
          <button
            onClick={() =>
              setSelectedIndex((i) => stepWeekIndex(i, 1, weeks.length))
            }
            disabled={atCurrent}
            aria-label="Next week"
            className="p-1.5 rounded-lg text-textSecondary hover:bg-surface hover:text-textPrimary transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Score block */}
      <div className="flex items-end gap-3 flex-wrap">
        <span
          className={`text-[52px] font-extrabold leading-none tabular-nums ${scoreClass}`}
        >
          {Math.round(selected.total)}
        </span>
        <div className="flex flex-col gap-0.5 pb-1">
          {hasBaseline ? (
            <>
              <span className={`text-sm font-semibold ${scoreClass}`}>
                {BAND_LABEL[band]}
              </span>
              <span className="text-xs text-textSecondary">
                vs ~{Math.round(medianWeekly)} weekly average (6 months)
              </span>
            </>
          ) : (
            <span className="text-xs text-textSecondary">
              No 6-month baseline yet — keep logging activity
            </span>
          )}
        </div>
      </div>

      {/* 16-week line with typical-range band */}
      <div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart
            data={chartData}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onClick={(state: unknown) => {
              const idx = (
                state as { activeTooltipIndex?: number | null } | null
              )?.activeTooltipIndex;
              if (typeof idx === "number" && idx >= 0) setSelectedIndex(idx);
            }}
          >
            <XAxis
              dataKey="weekStart"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={0}
              tickFormatter={(_value: string, index: number) =>
                chartData[index]?.monthLabel ?? ""
              }
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={40}
              domain={[0, "auto"]}
            />
            {/* Typical range (75%–115% of median) shaded behind the line */}
            {hasBaseline && (
              <ReferenceArea
                y1={medianWeekly * LOAD_BAND_BELOW_MAX}
                y2={medianWeekly * LOAD_BAND_TYPICAL_MAX}
                fill="var(--color-chart-axis)"
                fillOpacity={0.1}
                stroke="none"
                ifOverflow="extendDomain"
              />
            )}
            {/* Selected-week dashed vertical marker */}
            <ReferenceLine
              x={selected.weekStart}
              stroke="var(--color-chart-axis)"
              strokeDasharray="4 4"
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke="var(--color-chart-primary)"
              strokeWidth={2}
              isAnimationActive={false}
              activeDot={false}
              dot={(props: {
                cx?: number;
                cy?: number;
                index?: number;
              }) => {
                const { cx, cy, index } = props;
                // Null guards inside the callback (React #310 guidance).
                if (cx == null || cy == null || index == null) {
                  return <g key={`wl-dot-empty-${String(index)}`} />;
                }
                const isSelected = index === safeIndex;
                return (
                  <circle
                    key={`wl-dot-${index}`}
                    cx={cx}
                    cy={cy}
                    r={isSelected ? 6 : 3.5}
                    fill="var(--color-chart-primary)"
                    stroke={isSelected ? "var(--color-card)" : "none"}
                    strokeWidth={isSelected ? 2 : 0}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedIndex(index);
                    }}
                  />
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
        <p className="text-[10px] text-textSecondary text-center mt-1">
          Tap a point to view that week
        </p>
      </div>

      {/* Activities for the selected week */}
      <div>
        <h4 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-2">
          Activities this week
        </h4>
        {selected.activities.length === 0 ? (
          <p className="text-sm text-textSecondary italic py-2">
            No activities this week
          </p>
        ) : (
          <div className="flex flex-col">
            {selected.activities.map((a) => {
              const rowContent = (
                <>
                  <span className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center shrink-0 text-textSecondary">
                    {a.kind === "run" ? (
                      <Footprints size={15} className="text-primary" />
                    ) : (
                      <Dumbbell size={15} />
                    )}
                  </span>
                  <span className="flex flex-col min-w-0 text-left">
                    <span className="text-sm font-medium text-textPrimary truncate">
                      {resolveActivityTitle({
                        activityType: a.name,
                        rawActivityType: a.activityType,
                        distanceMiles: a.distanceMiles,
                        matchedPlanEntry: runTitleMap?.get(a.id) ?? null,
                      })}
                    </span>
                    <span className="text-xs text-textSecondary">
                      {activityDateLabel(a.date)}
                    </span>
                  </span>
                  <span className="text-sm text-textSecondary tabular-nums ml-auto shrink-0">
                    {formatDuration(a.elapsedSeconds)}
                  </span>
                  {/* Load chip — renders "—" itself when load is null. Single
                      shared scale via runLoadCap (skipped when no runs). */}
                  <TrainingLoadBadge
                    score={a.load}
                    avgHeartRate={undefined}
                    intensity={
                      runLoadCap > 0
                        ? computeLoadIntensity(a.load, runLoadCap)
                        : undefined
                    }
                  />
                </>
              );
              const rowClass =
                "flex items-center gap-3 py-2 px-2 border-b border-border last:border-b-0 w-full";

              // Runs navigate to their detail page; workouts have no detail
              // route in this app (modal-only on /workouts), so their rows
              // are intentionally non-clickable.
              return a.kind === "run" ? (
                <button
                  key={a.id}
                  onClick={() => router.push(`/runs/${a.id}`)}
                  className={`${rowClass} hover:bg-surface transition-colors rounded-lg`}
                >
                  {rowContent}
                </button>
              ) : (
                <div key={a.id} className={rowClass}>
                  {rowContent}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
