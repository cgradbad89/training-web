"use client";

/**
 * Workout Trends section for the Personal Insights page (Phase 3).
 *
 * Renders three charts derived from cross-training data:
 *   A. Workout frequency by week (purple = strength-like, teal = pilates)
 *   B. Weight progression by exercise (one chart per exercise)
 *   C. Total weekly workout volume (sets × reps × weight)
 *
 * All Firestore fetching happens inside this component so the parent
 * Personal Insights page stays focused on running insights.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Dumbbell } from "lucide-react";

import { type HealthWorkout } from "@/types/healthWorkout";
import { type Plan, isWorkoutPlan, isExerciseItem } from "@/types/plan";
import { fetchPlans } from "@/services/plans";
import {
  isPilatesActivity,
  isStrengthLikeActivity,
} from "@/services/autoMatch";
import { weekStart as getWeekStart } from "@/utils/dates";

// ─── Card / section helpers (mirror PersonalInsightsPage styling) ───────────

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}
    >
      {children}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Dumbbell size={18} className="text-primary" />
      <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    </div>
  );
}

// ─── Frequency chart data ───────────────────────────────────────────────────

interface FrequencyDatum {
  label: string;
  weekStart: number; // ms epoch — sort key
  workout: number;
  pilates: number;
}

function buildFrequencyData(workouts: HealthWorkout[]): FrequencyDatum[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 8 weeks back, anchored on the Monday of the current week
  const buckets: FrequencyDatum[] = [];
  for (let i = 7; i >= 0; i--) {
    const ws = getWeekStart(today);
    ws.setDate(ws.getDate() - i * 7);
    buckets.push({
      label: ws.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      weekStart: ws.getTime(),
      workout: 0,
      pilates: 0,
    });
  }

  for (const w of workouts) {
    if (w.isRunLike) continue;
    const ws = getWeekStart(w.startDate).getTime();
    const bucket = buckets.find((b) => b.weekStart === ws);
    if (!bucket) continue;
    if (isPilatesActivity(w)) {
      bucket.pilates += 1;
    } else if (isStrengthLikeActivity(w)) {
      bucket.workout += 1;
    }
  }
  return buckets;
}

// ─── Weight progression data ───────────────────────────────────────────────

interface ExerciseDataPoint {
  /** ms epoch */
  date: number;
  dateLabel: string;
  weight: number;
}

interface ExerciseProgression {
  name: string;
  points: ExerciseDataPoint[];
}

/**
 * Walk every completed Workout plan session and pull out exercise data
 * grouped by exercise name (case-insensitive). Each data point is the
 * average weight across all sets recorded for that exercise on that day.
 */
function buildExerciseProgressions(
  plans: Plan[]
): ExerciseProgression[] {
  const byName = new Map<string, ExerciseDataPoint[]>();

  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) continue;
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type !== "workout") continue;
        if (entry.completed !== true) continue;
        if (!entry.exercises || entry.exercises.length === 0) continue;
        const completedDate = entry.completedAt
          ? new Date(entry.completedAt)
          : null;
        if (!completedDate || isNaN(completedDate.getTime())) continue;

        for (const item of entry.exercises) {
          if (!isExerciseItem(item)) continue;
          if (!item.name.trim()) continue;
          if (item.weight_lbs <= 0) continue;
          const key = item.name.trim().toLowerCase();
          const list = byName.get(key) ?? [];
          list.push({
            date: completedDate.getTime(),
            dateLabel: completedDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
            weight: item.weight_lbs,
          });
          byName.set(key, list);
        }
      }
    }
  }

  // Convert to sorted progressions, only keeping exercises with ≥2 points.
  const progressions: ExerciseProgression[] = [];
  for (const [key, points] of byName.entries()) {
    if (points.length < 2) continue;
    points.sort((a, b) => a.date - b.date);
    // Restore the original-cased name from the first matching plan entry.
    const displayName = findOriginalExerciseName(key, plans) ?? key;
    progressions.push({ name: displayName, points });
  }
  // Sort by data point count descending — more frequently trained first
  progressions.sort((a, b) => b.points.length - a.points.length);
  return progressions;
}

function findOriginalExerciseName(
  lowercaseKey: string,
  plans: Plan[]
): string | null {
  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) continue;
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type !== "workout") continue;
        for (const item of entry.exercises ?? []) {
          if (!isExerciseItem(item)) continue;
          if (item.name.trim().toLowerCase() === lowercaseKey) {
            return item.name.trim();
          }
        }
      }
    }
  }
  return null;
}

// ─── Volume trend data ──────────────────────────────────────────────────────

interface VolumeDatum {
  label: string;
  weekStart: number;
  volume: number;
}

function buildVolumeTrend(plans: Plan[]): VolumeDatum[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets: VolumeDatum[] = [];
  for (let i = 7; i >= 0; i--) {
    const ws = getWeekStart(today);
    ws.setDate(ws.getDate() - i * 7);
    buckets.push({
      label: ws.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      weekStart: ws.getTime(),
      volume: 0,
    });
  }

  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) continue;
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type !== "workout") continue;
        if (entry.completed !== true) continue;
        if (!entry.completedAt) continue;
        const d = new Date(entry.completedAt);
        if (isNaN(d.getTime())) continue;
        const ws = getWeekStart(d).getTime();
        const bucket = buckets.find((b) => b.weekStart === ws);
        if (!bucket) continue;

        for (const item of entry.exercises ?? []) {
          if (!isExerciseItem(item)) continue;
          if (item.weight_lbs <= 0) continue;
          bucket.volume += item.sets * item.reps * item.weight_lbs;
        }
      }
    }
  }
  return buckets;
}

// ─── Tooltips ──────────────────────────────────────────────────────────────

function FrequencyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number; dataKey: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((s, p) => s + (p.value || 0), 0);
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">Week of {label}</p>
      <p className="text-textSecondary">
        {total} workout{total !== 1 ? "s" : ""} this week
      </p>
    </div>
  );
}

function WeightTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: ExerciseDataPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">{d.weight} lbs</p>
      <p className="text-textSecondary">{d.dateLabel}</p>
    </div>
  );
}

function VolumeTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-md text-sm">
      <p className="font-medium text-textPrimary">
        {v.toLocaleString()} lbs total volume
      </p>
      <p className="text-textSecondary">Week of {label}</p>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface WorkoutTrendsSectionProps {
  uid: string;
  workouts: HealthWorkout[];
}

export function WorkoutTrendsSection({
  uid,
  workouts,
}: WorkoutTrendsSectionProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    fetchPlans(uid)
      .then((p) => {
        if (!cancelled) setPlans(p);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const frequencyData = useMemo(
    () => buildFrequencyData(workouts),
    [workouts]
  );
  const hasFrequencyData = frequencyData.some(
    (d) => d.workout > 0 || d.pilates > 0
  );

  const exerciseProgressions = useMemo(
    () => buildExerciseProgressions(plans),
    [plans]
  );

  const volumeData = useMemo(() => buildVolumeTrend(plans), [plans]);
  const volumeWeeksWithData = volumeData.filter((d) => d.volume > 0).length;
  const hasVolumeData = volumeWeeksWithData >= 2;

  // Tight Y-axis domain for volume — clamped to dataMin / dataMax with padding
  const volumeNonZero = volumeData.filter((d) => d.volume > 0);
  const minVolume = volumeNonZero.length
    ? Math.min(...volumeNonZero.map((d) => d.volume))
    : 0;
  const maxVolume = volumeNonZero.length
    ? Math.max(...volumeNonZero.map((d) => d.volume))
    : 0;
  const volumePad = Math.max(100, Math.round((maxVolume - minVolume) * 0.1));
  const volumeDomainMin = Math.max(0, Math.floor((minVolume - volumePad) / 100) * 100);
  const volumeDomainMax = Math.ceil((maxVolume + volumePad) / 100) * 100;

  return (
    <>
      <SectionHeader title="Workout Trends" />

      {/* ── A. Workout Frequency ─────────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-3">
          Workout Frequency
        </h3>
        {hasFrequencyData ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={frequencyData}
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip content={<FrequencyTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(v) => (v === "workout" ? "Workout" : "Pilates")}
              />
              <Bar
                dataKey="workout"
                stackId="a"
                fill="#a855f7"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="pilates"
                stackId="a"
                fill="#14b8a6"
                radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-textSecondary text-center py-6">
            No non-running workouts logged in the last 8 weeks.
          </p>
        )}
      </Card>

      {/* ── B. Weight Progression by Exercise ───────────────────── */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-3">
          Weight Progression by Exercise
        </h3>
        {!loaded ? (
          <p className="text-sm text-textSecondary text-center py-6">
            Loading…
          </p>
        ) : exerciseProgressions.length === 0 ? (
          <p className="text-sm text-textSecondary text-center py-6">
            Complete workout sessions to see weight progression
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {exerciseProgressions.map((ex) => {
              const weights = ex.points.map((p) => p.weight);
              const minW = Math.min(...weights);
              const maxW = Math.max(...weights);
              const pad = Math.max(5, Math.round((maxW - minW) * 0.15));
              const domainMin = Math.max(0, Math.floor((minW - pad) / 5) * 5);
              const domainMax = Math.ceil((maxW + pad) / 5) * 5;
              return (
                <div key={ex.name}>
                  <p className="text-xs font-semibold text-textPrimary mb-2">
                    {ex.name}
                  </p>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart
                      data={ex.points}
                      margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="var(--color-border)"
                      />
                      <XAxis
                        dataKey="dateLabel"
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[domainMin, domainMax]}
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        width={52}
                        tickFormatter={(v: number) => `${v}`}
                      />
                      <Tooltip content={<WeightTooltip />} />
                      <Line
                        type="monotone"
                        dataKey="weight"
                        stroke="#a855f7"
                        strokeWidth={2}
                        dot={{ r: 4, fill: "#a855f7", strokeWidth: 0 }}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── C. Workout Volume Trend ──────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-3">
          Weekly Workout Volume (lbs)
        </h3>
        {hasVolumeData ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={volumeData}
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[volumeDomainMin, volumeDomainMax]}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={52}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <Tooltip content={<VolumeTooltip />} cursor={{ strokeDasharray: "3 3" }} />
              <Line
                type="monotone"
                dataKey="volume"
                stroke="#a855f7"
                strokeWidth={2}
                dot={{ r: 4, fill: "#a855f7", strokeWidth: 0 }}
                activeDot={{ r: 6 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-textSecondary text-center py-6">
            Complete at least 2 weeks of workouts to see volume trends
          </p>
        )}
      </Card>
    </>
  );
}

