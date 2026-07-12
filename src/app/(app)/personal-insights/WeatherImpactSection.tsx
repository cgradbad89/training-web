"use client";

import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { CloudSun } from "lucide-react";
import { ChartSkeleton } from "@/components/ui/ChartSkeleton";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  buildWeatherCorrelationData,
  computeLinearTrend,
} from "./weatherCorrelation";
import { type TempScatterPoint } from "./PaceTemperatureChart";

// Lazy-load the Recharts render trees (client-only) so this chart-heavy route
// ships less JS up front — same next/dynamic + ChartSkeleton pattern the
// page's other charts use.
const PaceTemperatureChart = dynamic(
  () => import("./PaceTemperatureChart").then((m) => m.PaceTemperatureChart),
  { ssr: false, loading: () => <ChartSkeleton height={260} /> },
);
const HeartRateTemperatureChart = dynamic(
  () =>
    import("./HeartRateTemperatureChart").then(
      (m) => m.HeartRateTemperatureChart,
    ),
  { ssr: false, loading: () => <ChartSkeleton height={260} /> },
);

// Minimum valid points before a chart is worth plotting; below this we show an
// empty-state message for that specific chart instead of a sparse scatter.
const MIN_POINTS = 5;

/** Trend-line endpoints at the dataset's min/max x, or null to skip the line. */
function trendEndpoints(points: TempScatterPoint[]): TempScatterPoint[] | null {
  const trend = computeLinearTrend(points);
  if (!trend) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  if (!isFinite(minX) || !isFinite(maxX) || minX === maxX) return null;
  return [
    { x: minX, y: trend.slope * minX + trend.intercept },
    { x: maxX, y: trend.slope * maxX + trend.intercept },
  ];
}

function RangeToggle({
  range,
  onChange,
}: {
  range: 180 | 365;
  onChange: (r: 180 | 365) => void;
}) {
  const options: { value: 180 | 365; label: string }[] = [
    { value: 180, label: "6 months" },
    { value: 365, label: "12 months" },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden">
      {options.map((o) => {
        const active = o.value === range;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-primary text-white"
                : "bg-card text-textSecondary hover:text-textPrimary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ChartBlock({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-textPrimary mb-0.5">{title}</h3>
      <p className="text-xs text-textSecondary mb-3">{subtitle}</p>
      {count < MIN_POINTS ? (
        <p className="text-sm text-textSecondary text-center py-16">
          Not enough runs with weather data in this range.
        </p>
      ) : (
        children
      )}
    </div>
  );
}

export function WeatherImpactSection({
  workouts,
}: {
  workouts: HealthWorkout[];
}): React.JSX.Element {
  const [range, setRange] = useState<180 | 365>(180);

  const { pacePoints, hrPoints, paceTrend, hrTrend } = useMemo(() => {
    const data = buildWeatherCorrelationData(workouts, range);

    const pace: TempScatterPoint[] = data.map((d) => ({
      x: d.tempF,
      y: d.paceSecPerMile,
    }));
    // HR chart excludes points with a null avgHeartRate.
    const hr: TempScatterPoint[] = data
      .filter((d) => d.avgHeartRate != null)
      .map((d) => ({ x: d.tempF, y: d.avgHeartRate as number }));

    return {
      pacePoints: pace,
      hrPoints: hr,
      paceTrend: trendEndpoints(pace),
      hrTrend: trendEndpoints(hr),
    };
  }, [workouts, range]);

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <CloudSun size={18} className="text-primary" />
          <h2 className="text-lg font-bold text-textPrimary">Weather impact</h2>
        </div>
        <RangeToggle range={range} onChange={setRange} />
      </div>
      <p className="text-xs text-textSecondary mb-5">
        How temperature relates to your running pace and heart rate. Each dot is
        a run; the dashed line is the overall trend.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartBlock
          title="Pace vs. temperature"
          subtitle="Lower is faster. Warmer runs often skew slower."
          count={pacePoints.length}
        >
          <PaceTemperatureChart points={pacePoints} trendLine={paceTrend} />
        </ChartBlock>

        <ChartBlock
          title="Heart rate vs. temperature"
          subtitle="Average HR per run. Heat typically raises cardiac cost."
          count={hrPoints.length}
        >
          <HeartRateTemperatureChart points={hrPoints} trendLine={hrTrend} />
        </ChartBlock>
      </div>
    </div>
  );
}
