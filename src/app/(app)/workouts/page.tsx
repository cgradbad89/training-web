"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  Dumbbell,
  Wind,
  Flower2,
  Bike,
  Zap,
  Activity,
  type LucideProps,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatBlock } from "@/components/ui/StatBlock";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { formatDuration } from "@/utils/pace";
import { weekStart } from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";

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

// ─── Year Selector ────────────────────────────────────────────────────────────

function YearSelect({
  years,
  selected,
  onChange,
}: {
  years: number[];
  selected: number;
  onChange: (y: number) => void;
}) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(Number(e.target.value))}
      className="border border-border rounded-lg px-3 py-1.5 text-sm bg-card text-textPrimary focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </select>
  );
}

// ─── Workout Row ──────────────────────────────────────────────────────────────

function WorkoutRow({ workout }: { workout: HealthWorkout }) {
  const localDate = getLocalDate(workout);
  const dayAbbrev = DAY_ABBREVS[(localDate.getDay() + 6) % 7];
  const dayNum = localDate.getDate();

  const Icon = getIcon(workout);
  const badge = getTypeBadge(workout);

  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-surface rounded-lg transition-colors">
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
}: {
  wKey: string;
  workouts: HealthWorkout[];
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
        <WorkoutRow key={w.workoutId} workout={w} />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkoutsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [allWorkouts, setAllWorkouts] = useState<HealthWorkout[]>([]);
  const [overrides, setOverrides] = useState<Record<string, WorkoutOverride>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>("all");

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    Promise.all([
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchAllOverrides(uid),
    ])
      .then(([wkts, fetchedOverrides]) => {
        setOverrides(fetchedOverrides);
        // Filter to non-runs, exclude overridden-excluded workouts
        setAllWorkouts(
          wkts.filter(
            (w) => !w.isRunLike && !fetchedOverrides[w.workoutId]?.isExcluded
          )
        );
      })
      .catch(console.error)
      .finally(() => setLoading(false));
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
          <YearSelect
            years={availableYears}
            selected={selectedYear}
            onChange={setSelectedYear}
          />
        }
      />

      {/* Row 2: Year summary stats */}
      <YearSummary workouts={yearWorkouts} year={selectedYear} />

      {/* Row 3: Type filter tabs */}
      <TabStrip active={activeTab} onChange={setActiveTab} />

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
            <WorkoutWeekGroup key={wk} wKey={wk} workouts={workouts} />
          ))}
        </div>
      )}
    </div>
  );
}
