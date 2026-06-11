"use client";

import { ActivityRings, type RingDatum } from "@/components/ActivityRings";
import type { RingMetric } from "@/types/healthGoal";

export interface RingKpiCardProps {
  metric: RingMetric;
  label: string;
  /** Period actual (today's value, or the summed actual for 7d/30d/YTD). */
  value: number;
  /** Resolved goal for the same period (daily goal, or summed daily goals). */
  goal: number;
  /** Uncapped; 1.0 = 100%. Must equal the hero ring's progress. */
  progress: number;
  color: string;
  valueFormatter: (v: number) => string;
  /** Routes to the Trends tab scrolled to this metric (hero handoff). */
  onClick?: () => void;
}

/**
 * One per-ring KPI card on the Health Today tab: a mini standalone ring,
 * the period actual, "<Metric> · goal <goal>", and the percent in the
 * metric's color. Pure presentation — value/goal/progress come from the
 * same computation the hero rings use, so the two can never disagree.
 */
export function RingKpiCard({
  metric,
  label,
  value,
  goal,
  progress,
  color,
  valueFormatter,
  onClick,
}: RingKpiCardProps) {
  const ring: RingDatum[] = [
    {
      metric,
      label,
      progress,
      color,
      valueLabel: `${valueFormatter(value)} / ${valueFormatter(goal)}`,
    },
  ];
  const pct = Number.isFinite(progress) ? Math.round(progress * 100) : 0;

  const content = (
    <>
      <div className="flex items-center justify-between w-full">
        <ActivityRings rings={ring} size={52} />
        <span
          className="text-sm font-bold tabular-nums"
          style={{ color }}
        >
          {pct}%
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-textPrimary tabular-nums truncate">
          {valueFormatter(value)}
        </p>
        <p className="text-xs text-textSecondary truncate">
          {label} · goal {valueFormatter(goal)}
        </p>
      </div>
    </>
  );

  if (!onClick) {
    return (
      <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-2">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} — open trends`}
      className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-2 text-left hover:bg-surface transition-colors cursor-pointer"
    >
      {content}
    </button>
  );
}
