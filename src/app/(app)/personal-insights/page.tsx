"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  ChevronLeft,
  ChevronRight,
  Timer,
  Trophy,
  TrendingUp,
  BotMessageSquare,
  Activity,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { MetricBadge } from "@/components/ui/MetricBadge";
import { WorkoutTrendsSection } from "@/components/WorkoutTrendsSection";
import { useAuth } from "@/hooks/useAuth";
import { fetchHealthWorkouts } from "@/services/healthWorkouts";
import { fetchRaces } from "@/services/races";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { fetchAllOverrides } from "@/services/workoutOverrides";
import { applyOverride } from "@/types/workoutOverride";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type Race, RACE_DISTANCE_MILES } from "@/types/race";
import { formatPace } from "@/utils/pace";
import { weekStart as getWeekStart } from "@/utils/dates";
import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
  formatRaceTime,
  formatRacePace,
  riegelConfidenceLabel,
  type RiegelFit,
} from "@/utils/riegelFit";
import {
  buildDailyLoadMap,
  buildLoadEwmaSeries,
  CTL_DAYS,
} from "@/utils/trainingLoadSeries";
import {
  computeTrainingLoad,
  classifyHrZone,
  type HRZoneNumber,
} from "@/utils/trainingLoad";
import {
  collection,
  getDocs,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-2xl shadow-sm border border-border p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon size={18} className="text-primary" />
      <h2 className="text-lg font-bold text-textPrimary">{title}</h2>
    </div>
  );
}

function formatPaceLabel(secPerMile: number): string {
  if (!isFinite(secPerMile) || secPerMile <= 0) return "—";
  const total = Math.round(secPerMile);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatTotalTime(totalSeconds: number): string {
  if (!isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.round(totalSeconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// ─── Fastest Mile Segment ────────────────────────────────────────────────────

const EARTH_RADIUS_MI = 3958.8;
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/** Sliding window: find the fastest 1-mile segment in a route. Returns seconds or null. */
function fastestMileSegment(points: RoutePoint[]): number | null {
  if (points.length < 2) return null;

  // Build arrays of cumulative distance (miles) and timestamps (ms)
  const timestamps: number[] = [];
  const cumDist: number[] = [0];
  for (let i = 0; i < points.length; i++) {
    const ts = new Date(points[i].timestamp).getTime();
    if (isNaN(ts)) return null;
    timestamps.push(ts);
    if (i > 0) {
      cumDist.push(
        cumDist[i - 1] +
          haversineMi(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng)
      );
    }
  }

  const totalDist = cumDist[cumDist.length - 1];
  if (totalDist < 1.0) return null; // route shorter than 1 mile

  let bestSeconds: number | null = null;
  let left = 0;

  for (let right = 1; right < points.length; right++) {
    while (cumDist[right] - cumDist[left] >= 1.0) {
      // Distance from left to right >= 1 mile — find exact 1-mile crossing
      const distFromLeft = cumDist[right] - cumDist[left];
      const segDist = cumDist[right] - cumDist[right - 1];
      const overshoot = distFromLeft - 1.0;

      // Interpolate timestamp at the 1-mile mark between right-1 and right
      let crossingMs: number;
      if (segDist > 0) {
        const fraction = 1.0 - overshoot / segDist;
        crossingMs =
          timestamps[right - 1] + fraction * (timestamps[right] - timestamps[right - 1]);
      } else {
        crossingMs = timestamps[right];
      }

      const elapsed = (crossingMs - timestamps[left]) / 1000;
      if (elapsed > 0 && (bestSeconds === null || elapsed < bestSeconds)) {
        bestSeconds = elapsed;
      }
      left++;
    }
  }

  return bestSeconds;
}

// ─── Training Load Section ───────────────────────────────────────────────────

interface TrainingLoadSectionData {
  displaySeries: Array<{
    date: string;
    load: number;
    ctl: number;
    atl: number;
    tsb: number;
  }>;
  last: { ctl: number; atl: number; tsb: number } | null;
  daysOfData: number;
  peakRunLoad: number | null;
  peakRunDate: Date | null;
}

interface WeeklyLoadDatum {
  label: string;
  runLoad: number;
  workoutLoad: number;
}

function tsbBand(tsb: number): string {
  if (tsb >= 5) return "Fresh";
  if (tsb >= -10) return "Balanced";
  return "Fatigued";
}

function signedRound(n: number): string {
  const r = Math.round(n);
  if (r > 0) return `+${r}`;
  // Use a real minus sign for negative for typographic consistency.
  if (r < 0) return `−${Math.abs(r)}`;
  return "0";
}

function shortDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Zone palette — extends the TrainingLoadBadge low/moderate/hard/very-hard
// family across 5 zones so colours read consistently with the badge.
const ZONE_STYLES: Record<
  HRZoneNumber,
  { bg: string; text: string; label: string }
> = {
  1: { bg: "bg-blue-500",   text: "text-blue-500",   label: "Recovery"  },
  2: { bg: "bg-green-500",  text: "text-green-500",  label: "Aerobic"   },
  3: { bg: "bg-yellow-500", text: "text-yellow-500", label: "Tempo"     },
  4: { bg: "bg-orange-500", text: "text-orange-500", label: "Threshold" },
  5: { bg: "bg-red-500",    text: "text-red-500",    label: "Max"       },
};

// Inclusive-min / exclusive-max bpm bounds per zone, derived from HR_ZONES
// (60/70/80/90% of MAX_HR=185 → 111/130/149/167). Kept in lock-step by
// reading the same thresholds at runtime would couple this file to the
// internals; the values mirror the constants and are commented at source.
const ZONE_BPM_LABEL: Record<HRZoneNumber, string> = {
  1: "< 111",
  2: "111–129",
  3: "130–148",
  4: "149–166",
  5: "167+",
};

function TrainingLoadSection({
  data,
  weeklyData,
  intensity,
  intensityLoading,
}: {
  data: TrainingLoadSectionData;
  weeklyData: WeeklyLoadDatum[];
  intensity: {
    zoneMiles: Record<HRZoneNumber, number>;
    totalMiles: number;
    runsCounted: number;
  } | null;
  intensityLoading: boolean;
}) {
  const { displaySeries, last, daysOfData, peakRunLoad, peakRunDate } = data;
  const hasLoadData = displaySeries.some((p) => p.load > 0);
  const baselineBuilding = daysOfData < CTL_DAYS;

  const ctlValue = last && hasLoadData ? Math.round(last.ctl) : null;
  const atlValue = last && hasLoadData ? Math.round(last.atl) : null;
  const tsbValue = last && hasLoadData ? last.tsb : null;

  // Recharts data — round CTL/ATL for chart readability; keep raw TSB for tooltip.
  const chartData = displaySeries.map((p) => ({
    date: p.date,
    ctl: Math.round(p.ctl),
    atl: Math.round(p.atl),
    tsb: Math.round(p.tsb),
  }));

  // Weekly bars: show empty-state if every week has 0 load.
  const hasWeeklyData = weeklyData.some(
    (w) => w.runLoad > 0 || w.workoutLoad > 0
  );

  return (
    <>
      <Card>
        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-2">
          <div className="text-center">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
              Fitness (CTL)
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {ctlValue != null ? ctlValue : "—"}
            </p>
            <p className="text-xs text-textSecondary mt-1">42-day load</p>
          </div>
          <div className="text-center">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
              Fatigue (ATL)
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {atlValue != null ? atlValue : "—"}
            </p>
            <p className="text-xs text-textSecondary mt-1">7-day load</p>
          </div>
          <div className="text-center">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
              Form (TSB)
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {tsbValue != null ? signedRound(tsbValue) : "—"}
            </p>
            <p className="text-xs text-textSecondary mt-1">
              {tsbValue != null ? tsbBand(tsbValue) : "—"}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
              Peak Run Load
            </p>
            <p className="text-2xl font-bold text-textPrimary tabular-nums">
              {peakRunLoad != null ? Math.round(peakRunLoad) : "—"}
            </p>
            <p className="text-xs text-textSecondary mt-1">
              {peakRunDate
                ? peakRunDate.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                : "—"}
            </p>
          </div>
        </div>

        {baselineBuilding && hasLoadData && (
          <p className="text-xs text-textSecondary text-center mt-3">
            Baseline still building ({daysOfData} days)
          </p>
        )}
      </Card>

      {/* Fitness curve */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-1">
          Fitness curve — last 16 weeks
        </h3>
        <p className="text-xs text-textSecondary mb-3">
          Fitness (CTL) is your 42-day load average; Fatigue (ATL) is 7-day. The
          gap is your form.
        </p>
        {hasLoadData ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--color-border)"
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval={6}
                tickFormatter={(v: string) => shortDateLabel(v)}
              />
              <YAxis
                domain={[0, "dataMax + 10"]}
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                labelFormatter={(l) => shortDateLabel(String(l))}
                formatter={(value, name) => {
                  const label =
                    name === "ctl"
                      ? "Fitness (CTL)"
                      : name === "atl"
                        ? "Fatigue (ATL)"
                        : "Form (TSB)";
                  const num = Number(value);
                  const display =
                    name === "tsb" ? signedRound(num) : String(Math.round(num));
                  return [display, label];
                }}
                contentStyle={{
                  fontSize: 12,
                  backgroundColor: "var(--color-chart-tooltip-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "0.375rem",
                  color: "var(--color-textPrimary)",
                }}
                labelStyle={{ color: "var(--color-textSecondary)" }}
                itemStyle={{ color: "var(--color-textPrimary)" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value) =>
                  value === "ctl"
                    ? "Fitness (CTL)"
                    : value === "atl"
                      ? "Fatigue (ATL)"
                      : value
                }
              />
              <Line
                type="monotone"
                dataKey="ctl"
                stroke="var(--color-chart-primary)"
                strokeWidth={2}
                dot={false}
                name="ctl"
              />
              <Line
                type="monotone"
                dataKey="atl"
                stroke="var(--color-chart-orange)"
                strokeWidth={2}
                dot={false}
                name="atl"
              />
              {/* TSB is computed but rendered only in tooltip — wired via an
                  invisible line so Recharts includes it in payload. */}
              <Line
                type="monotone"
                dataKey="tsb"
                stroke="transparent"
                strokeWidth={0}
                dot={false}
                legendType="none"
                name="tsb"
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-textSecondary text-center py-6">
            Not enough HR-bearing activity yet to plot fitness and fatigue.
          </p>
        )}
      </Card>

      {/* Weekly load trend */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-3">
          Weekly training load — last 16 weeks
        </h3>
        {hasWeeklyData ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={weeklyData}
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
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
                formatter={(value, name) => {
                  const label =
                    name === "runLoad"
                      ? "Run load"
                      : name === "workoutLoad"
                        ? "Workout load"
                        : name;
                  return [Math.round(Number(value)), label];
                }}
                labelFormatter={(l) => `Week of ${l}`}
                contentStyle={{
                  fontSize: 12,
                  backgroundColor: "var(--color-chart-tooltip-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "0.375rem",
                  color: "var(--color-textPrimary)",
                }}
                labelStyle={{ color: "var(--color-textSecondary)" }}
                itemStyle={{ color: "var(--color-textPrimary)" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(v) =>
                  v === "runLoad"
                    ? "Run load"
                    : v === "workoutLoad"
                      ? "Workout load"
                      : v
                }
              />
              <Bar
                dataKey="runLoad"
                stackId="load"
                fill="var(--color-chart-primary)"
                radius={[0, 0, 0, 0]}
                name="runLoad"
              />
              <Bar
                dataKey="workoutLoad"
                stackId="load"
                fill="var(--color-chart-teal)"
                radius={[6, 6, 0, 0]}
                name="workoutLoad"
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-textSecondary text-center py-6">
            Not enough HR-bearing activity in the last 16 weeks.
          </p>
        )}
      </Card>

      {/* Running Intensity by HR Zone — distance-weighted share per zone */}
      <Card>
        <h3 className="text-sm font-semibold text-textPrimary mb-1">
          Running Intensity by HR Zone
        </h3>
        <p className="text-xs text-textSecondary mb-3">
          Based on per-mile HR from your last 8 weeks of GPS runs. Fills in as
          more runs sync.
        </p>

        {intensityLoading ? (
          <p className="text-sm text-textSecondary text-center py-6">
            Loading per-mile heart rate…
          </p>
        ) : !intensity || intensity.totalMiles <= 0 ? (
          <p className="text-sm text-textSecondary text-center py-6">
            Per-mile heart rate data not available yet.
          </p>
        ) : (
          <>
            {/* Single horizontal stacked bar, split into 5 zone segments. */}
            <div className="flex w-full h-3 rounded-full overflow-hidden mb-4">
              {([1, 2, 3, 4, 5] as const).map((z) => {
                const pct =
                  intensity.totalMiles > 0
                    ? (intensity.zoneMiles[z] / intensity.totalMiles) * 100
                    : 0;
                if (pct <= 0) return null;
                return (
                  <div
                    key={z}
                    className={ZONE_STYLES[z].bg}
                    style={{ width: `${pct}%` }}
                    title={`Z${z} ${ZONE_STYLES[z].label} — ${pct.toFixed(1)}%`}
                  />
                );
              })}
            </div>

            {/* Per-zone legend rows */}
            <div className="flex flex-col gap-1.5">
              {([1, 2, 3, 4, 5] as const).map((z) => {
                const miles = intensity.zoneMiles[z];
                const pct =
                  intensity.totalMiles > 0
                    ? (miles / intensity.totalMiles) * 100
                    : 0;
                return (
                  <div
                    key={z}
                    className="flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${ZONE_STYLES[z].bg}`}
                      />
                      <span className="text-textPrimary font-medium">
                        Z{z} {ZONE_STYLES[z].label}
                      </span>
                      <span className="text-textSecondary tabular-nums">
                        {ZONE_BPM_LABEL[z]} bpm
                      </span>
                    </div>
                    <span className="text-textPrimary font-semibold tabular-nums">
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-textSecondary mt-3">
              Based on {intensity.runsCounted}{" "}
              {intensity.runsCounted === 1 ? "run" : "runs"} ·{" "}
              {intensity.totalMiles.toFixed(1)} mi of per-mile HR data.
            </p>
          </>
        )}
      </Card>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PersonalInsightsPage() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const router = useRouter();

  function askCoach(question: string) {
    router.push(`/coach?q=${encodeURIComponent(question)}`);
  }

  const [workouts, setWorkouts] = useState<HealthWorkout[]>([]);
  const [races, setRaces] = useState<Race[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  // Fastest 1-mile segment from GPS route points, keyed by year
  const [fastestMileByYear, setFastestMileByYear] = useState<
    Record<number, { seconds: number; date: Date } | null>
  >({});

  // Running Intensity by HR Zone — share of miles per zone, distance-weighted.
  // Populated by a one-shot mileSplits fetch on mount (see useEffect below).
  const [intensityData, setIntensityData] = useState<{
    zoneMiles: Record<HRZoneNumber, number>;
    totalMiles: number;
    runsCounted: number;
  } | null>(null);
  const [intensityLoading, setIntensityLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;

    setLoading(true);
    Promise.all([
      fetchHealthWorkouts(uid, { limitCount: 500 }),
      fetchAllOverrides(uid),
      fetchRaces(uid),
    ])
      .then(([wkts, overrides, racesData]) => {
        const processed = wkts
          .map((w) => applyOverride(w, overrides[w.workoutId] ?? null))
          .filter((w) => !overrides[w.workoutId]?.isExcluded);
        setWorkouts(processed);
        setRaces(racesData);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [uid]);


  const runs = useMemo(() => workouts.filter((w) => w.isRunLike), [workouts]);

  // Compute fastest 1-mile GPS segment for the selected year
  useEffect(() => {
    if (!uid || runs.length === 0) return;
    if (fastestMileByYear[selectedYear] !== undefined) return; // already computed

    const yearRunsWithRoute = runs
      .filter((r) => r.startDate.getFullYear() === selectedYear && r.hasRoute && r.distanceMiles >= 1.0)
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
      .slice(0, 50); // cap for performance

    if (yearRunsWithRoute.length === 0) {
      setFastestMileByYear((prev) => ({ ...prev, [selectedYear]: null }));
      return;
    }

    Promise.all(
      yearRunsWithRoute.map(async (run) => {
        try {
          const points = await fetchRoutePoints(uid, run.workoutId);
          const secs = fastestMileSegment(points);
          return secs != null ? { seconds: secs, date: run.startDate } : null;
        } catch {
          return null;
        }
      })
    ).then((results) => {
      const valid = results.filter(
        (r): r is { seconds: number; date: Date } => r != null && r.seconds > 180 && r.seconds < 1200
      );
      const best = valid.length > 0
        ? valid.reduce((a, b) => (a.seconds < b.seconds ? a : b))
        : null;
      setFastestMileByYear((prev) => ({ ...prev, [selectedYear]: best }));
    });
  }, [uid, runs, selectedYear, fastestMileByYear]);

  // Running Intensity by HR Zone — fetch per-mile HR from mileSplits
  // subcollection for the last 8 weeks of GPS runs (capped at 40 runs).
  useEffect(() => {
    if (!uid) return;
    if (runs.length === 0) {
      setIntensityLoading(false);
      return;
    }
    let cancelled = false;
    setIntensityLoading(true);

    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 8 * 7);

    const candidateRuns = runs
      .filter(
        (r) =>
          r.hasRoute &&
          r.startDate >= eightWeeksAgo &&
          r.distanceMiles > 0
      )
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
      .slice(0, 40);

    if (candidateRuns.length === 0) {
      if (!cancelled) {
        setIntensityData({
          zoneMiles: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          totalMiles: 0,
          runsCounted: 0,
        });
        setIntensityLoading(false);
      }
      return () => {
        cancelled = true;
      };
    }

    Promise.all(
      candidateRuns.map(async (run) => {
        try {
          // Mirror src/app/(app)/runs/[id]/page.tsx pattern verbatim:
          //   path users/{uid}/healthWorkouts/{id}/mileSplits, ordered by mile.
          const snap = await getDocs(
            query(
              collection(
                db,
                `users/${uid}/healthWorkouts/${run.workoutId}/mileSplits`
              ),
              orderBy("mile", "asc")
            )
          );

          const totalMi = run.distanceMiles;
          const fullMiles = Math.floor(totalMi);
          const partial = totalMi - fullMiles; // 0 when run is whole-mile

          const miles: Array<{ mile: number; bpm: number; distance: number }> =
            [];
          snap.docs.forEach((doc) => {
            const data = doc.data() as Record<string, unknown>;
            const mile = typeof data.mile === "number" ? data.mile : null;
            const avgBpm =
              typeof data.avgBpm === "number" ? data.avgBpm : null;
            const sampleCount =
              typeof data.sampleCount === "number" ? data.sampleCount : 0;
            if (mile == null || avgBpm == null) return;
            // Guards: matches run-detail page + per-prompt 40–220 bpm sanity.
            if (sampleCount < 2) return;
            if (avgBpm < 40 || avgBpm > 220) return;

            // Per-mile distance: each whole-mile bucket = 1.0; final partial
            // mile (1-indexed = fullMiles + 1) uses the residual.
            let distance: number;
            if (mile <= fullMiles) {
              distance = 1.0;
            } else if (mile === fullMiles + 1 && partial > 0) {
              distance = partial;
            } else {
              // Defensive: out-of-range mile index — skip rather than assume.
              return;
            }
            miles.push({ mile, bpm: avgBpm, distance });
          });

          return miles;
        } catch {
          return [];
        }
      })
    ).then((perRun) => {
      if (cancelled) return;

      const zoneMiles: Record<HRZoneNumber, number> = {
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0,
      };
      let totalMiles = 0;
      let runsCounted = 0;
      for (const miles of perRun) {
        if (miles.length === 0) continue;
        runsCounted += 1;
        for (const m of miles) {
          const z = classifyHrZone(m.bpm);
          zoneMiles[z] += m.distance;
          totalMiles += m.distance;
        }
      }
      setIntensityData({ zoneMiles, totalMiles, runsCounted });
      setIntensityLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [uid, runs]);

  // ── Available years ─────────────────────────────────────────────────────────

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    runs.forEach((r) => years.add(r.startDate.getFullYear()));
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [runs]);

  // ── Riegel Predictions ──────────────────────────────────────────────────────

  const runInputs = useMemo(
    () =>
      runs.map((r) => ({
        workoutId: r.workoutId,
        distanceMiles: r.distanceMiles,
        durationSeconds: r.durationSeconds,
        startDate: r.startDate,
        activityType: r.activityType,
        sourceName: r.sourceName,
      })),
    [runs]
  );

  const raceInputs = useMemo(
    () =>
      races
        .map((r) => {
          const distance = r.raceDistance === "custom"
            ? (r.customDistanceMiles ?? 0)
            : (RACE_DISTANCE_MILES[r.raceDistance] ?? 0);
          return { raceDate: r.raceDate, distanceMiles: distance };
        })
        .filter((r) => r.distanceMiles > 0),
    [races]
  );

  const fit5k = useMemo(() => {
    const efforts = buildQualifyingEfforts(runInputs, 56, { races: raceInputs });
    return fitRiegel(efforts, 3.1069, 0, { min: 0.9, max: 1.3 });
  }, [runInputs, raceInputs]);

  const fitLong = useMemo(() => {
    const efforts = buildQualifyingEfforts(runInputs, 56, { races: raceInputs });
    return fitRiegel(efforts, 13.109, 3.0, { min: 1.04, max: 1.10 });
  }, [runInputs, raceInputs]);

  const t5k = fit5k ? predictSeconds(fit5k, 3.1069) : null;
  const t10 = fitLong ? predictSeconds(fitLong, 10.0) : null;
  const tHalf = fitLong ? predictSeconds(fitLong, 13.109) : null;
  const tMar = fitLong ? predictSeconds(fitLong, 26.219) : null;

  function overallConfidence(f5k: RiegelFit | null, fLong: RiegelFit | null): string {
    if (!fLong) return "Limited Data";
    if (fLong.n >= 6 && fLong.r2 >= 0.55) return "High";
    if (fLong.n >= 4 && fLong.r2 >= 0.45) return "Moderate";
    return "Limited Data";
  }

  const confidence = overallConfidence(fit5k, fitLong);
  const confidenceLevel: "good" | "ok" | "low" =
    confidence === "High" ? "good" : confidence === "Moderate" ? "ok" : "low";

  // ── Personal Records by Year ────────────────────────────────────────────────

  const prBuckets = [
    { label: "1–3 mi", filter: (m: number) => m >= 1.0 && m < 3.0 },
    { label: "3–6 mi", filter: (m: number) => m >= 3.0 && m < 6.0 },
    { label: "6–7 mi", filter: (m: number) => m >= 6.0 && m < 7.0 },
    { label: "7–10 mi", filter: (m: number) => m >= 7.0 && m < 10.0 },
    { label: "10+ mi", filter: (m: number) => m >= 10.0 },
  ];

  // Specific run distance PRs — ordered shortest to longest
  const specificDistances = [
    { label: "5K", targetMiles: 3.107, tolerance: 0.3 },
    { label: "5 Miles", targetMiles: 5.0, tolerance: 0.5 },
    { label: "10K", targetMiles: 6.214, tolerance: 0.5 },
    { label: "15K", targetMiles: 9.321, tolerance: 0.75 },
    { label: "10 Miles", targetMiles: 10.0, tolerance: 0.75 },
    { label: "Half Marathon", targetMiles: 13.109, tolerance: 1.0 },
  ];

  const yearRuns = useMemo(
    () => runs.filter((r) => r.startDate.getFullYear() === selectedYear),
    [runs, selectedYear]
  );

  const prs = useMemo(
    () =>
      prBuckets.map((bucket) => {
        const qualifying = yearRuns
          .filter((r) => r.distanceMiles > 0 && bucket.filter(r.distanceMiles))
          .map((r) => {
            const pace = r.durationSeconds / r.distanceMiles;
            return { pace, miles: r.distanceMiles, date: r.startDate };
          })
          .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

        if (qualifying.length === 0) return null;
        return qualifying.reduce((best, cur) => (cur.pace < best.pace ? cur : best));
      }),
    [yearRuns]
  );

  // Specific run distance PRs (fastest avg pace for qualifying runs)
  const specificPrs = useMemo(
    () =>
      specificDistances.map((dist) => {
        const candidates = yearRuns
          .filter(
            (r) =>
              r.distanceMiles >= dist.targetMiles - dist.tolerance &&
              r.distanceMiles <= dist.targetMiles + dist.tolerance &&
              r.durationSeconds > 0
          )
          .map((r) => ({
            pace: r.durationSeconds / r.distanceMiles,
            totalSeconds: r.durationSeconds,
            miles: r.distanceMiles,
            date: r.startDate,
          }))
          .filter((r) => isFinite(r.pace) && r.pace > 180 && r.pace < 1200);

        if (candidates.length === 0) return null;
        return candidates.reduce((best, cur) =>
          cur.pace < best.pace ? cur : best
        );
      }),
    [yearRuns]
  );

  // ── Pace Trends (last 8 weeks) ─────────────────────────────────────────────

  const paceTrendData = useMemo(() => {
    const nowDate = new Date();
    const currentMonday = getWeekStart(nowDate);

    return Array.from({ length: 8 }, (_, i) => {
      const weekDate = new Date(currentMonday);
      weekDate.setDate(weekDate.getDate() - (7 - i) * 7);
      const weekEndDate = new Date(weekDate);
      weekEndDate.setDate(weekDate.getDate() + 6);
      weekEndDate.setHours(23, 59, 59, 999);

      const weekRuns = runs.filter((r) => r.startDate >= weekDate && r.startDate <= weekEndDate);

      function avgPace(bucket: HealthWorkout[]): number | null {
        let totalSec = 0,
          totalMi = 0;
        bucket.forEach((r) => {
          if (r.distanceMiles <= 0) return;
          const sec = r.durationSeconds / r.distanceMiles;
          if (!isFinite(sec) || sec <= 0) return;
          totalSec += sec * r.distanceMiles;
          totalMi += r.distanceMiles;
        });
        return totalMi > 0 ? totalSec / totalMi : null;
      }

      const short = weekRuns.filter((r) => r.distanceMiles >= 1 && r.distanceMiles < 3);
      const medium = weekRuns.filter((r) => r.distanceMiles >= 3 && r.distanceMiles < 6);
      const long = weekRuns.filter((r) => r.distanceMiles >= 6);

      const label = weekDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

      return {
        label,
        short: avgPace(short),
        medium: avgPace(medium),
        long: avgPace(long),
      };
    });
  }, [runs]);

  const hasPaceTrend = paceTrendData.some((w) => w.short || w.medium || w.long);

  // ── Training Load (CTL / ATL / TSB) ────────────────────────────────────────

  const trainingLoadData = useMemo(() => {
    // Window the user sees on the chart.
    const DISPLAY_DAYS = 112; // 16 weeks
    // Seed window — 180 days is well past 3× CTL_DAYS (42), so the EWMA has
    // converged by the time we hit the displayed range.
    const SEED_DAYS = 180;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const displayStart = new Date(today);
    displayStart.setDate(today.getDate() - (DISPLAY_DAYS - 1));

    // Determine the earliest day we can safely seed from: prefer the seed
    // window, but if the user's actual history is shorter, start there.
    const earliestWorkoutTime = workouts.reduce(
      (min, w) => Math.min(min, w.startDate.getTime()),
      Infinity
    );
    const seedFromHistory =
      isFinite(earliestWorkoutTime) ? new Date(earliestWorkoutTime) : null;

    const seedFromSeedWindow = new Date(today);
    seedFromSeedWindow.setDate(today.getDate() - (SEED_DAYS - 1));

    const seedStart =
      seedFromHistory && seedFromHistory > seedFromSeedWindow
        ? new Date(
            seedFromHistory.getFullYear(),
            seedFromHistory.getMonth(),
            seedFromHistory.getDate()
          )
        : seedFromSeedWindow;

    const dailyMap = buildDailyLoadMap(workouts);
    const fullSeries = buildLoadEwmaSeries(dailyMap, seedStart, today);

    // Slice for display
    const displaySeries = fullSeries.slice(
      Math.max(0, fullSeries.length - DISPLAY_DAYS)
    );

    // Latest values from the converged series
    const last = fullSeries[fullSeries.length - 1] ?? null;

    // Total calendar days in fullSeries == seedStart→today inclusive; a useful
    // proxy for "days of data" available for baselining.
    const daysOfData = fullSeries.length;

    // Peak single-run training load over the displayed (112d) window.
    const displayStartTime = displayStart.getTime();
    let peakRunLoad = 0;
    let peakRunDate: Date | null = null;
    for (const w of workouts) {
      if (!w.isRunLike) continue;
      if (w.startDate.getTime() < displayStartTime) continue;
      const score = computeTrainingLoad(
        w.durationSeconds,
        w.avgHeartRate,
        w.activityType
      );
      if (score == null) continue;
      if (score > peakRunLoad) {
        peakRunLoad = score;
        peakRunDate = w.startDate;
      }
    }

    return {
      dailyMap,
      displaySeries,
      last,
      daysOfData,
      peakRunLoad: peakRunDate ? peakRunLoad : null,
      peakRunDate,
      displayStart,
      today,
    };
  }, [workouts]);

  const weeklyLoadData = useMemo(() => {
    // Last 16 weeks, Monday-anchored — matches Workout Frequency chart bucketing.
    const today = new Date();
    const currentMonday = getWeekStart(today);

    return Array.from({ length: 16 }, (_, i) => {
      const weekDate = new Date(currentMonday);
      weekDate.setDate(weekDate.getDate() - (15 - i) * 7);
      const label = weekDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });

      let runLoad = 0;
      let workoutLoad = 0;
      for (let d = 0; d < 7; d++) {
        const day = new Date(weekDate);
        day.setDate(weekDate.getDate() + d);
        const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(day.getDate()).padStart(2, "0")}`;
        const entry = trainingLoadData.dailyMap.get(iso);
        if (entry) {
          runLoad += entry.runLoad;
          workoutLoad += entry.workoutLoad;
        }
      }

      return {
        label,
        runLoad: Math.round(runLoad),
        workoutLoad: Math.round(workoutLoad),
      };
    });
  }, [trainingLoadData.dailyMap]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const predictions = [
    { label: "5K", distance: 3.1069, time: t5k },
    { label: "10 Miler", distance: 10.0, time: t10 },
    { label: "Half Marathon", distance: 13.109, time: tHalf },
    { label: "Marathon", distance: 26.219, time: tMar },
  ];

  return (
    <div className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-textPrimary">Personal Insights</h1>
        <button
          onClick={() => askCoach(
            'Analyze my personal running trends and fitness ' +
            'progression. What do my pace trends, PRs, and ' +
            'predicted race times suggest about my fitness ' +
            'development over time?'
          )}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/20 transition-colors"
        >
          <BotMessageSquare className="w-4 h-4" />
          Ask AI Coach
        </button>
      </div>

      {/* ── Predicted Race Times ─────────────────────────── */}
      <SectionHeader icon={Timer} title="Predicted Race Times" />

      <Card>
        <div className="flex items-center justify-between mb-5">
          <p className="text-xs text-textSecondary">Based on last 8 weeks of training</p>
          <MetricBadge label="Confidence" value={confidence} level={confidenceLevel} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {predictions.map((p) => (
            <div key={p.label} className="text-center">
              <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide mb-2">
                {p.label}
              </p>
              <p className="text-2xl font-bold text-textPrimary tabular-nums">
                {formatRaceTime(p.time)}
              </p>
              <p className="text-xs text-textSecondary mt-1">
                {p.time ? formatRacePace(p.time, p.distance) : "—"}
              </p>
            </div>
          ))}
        </div>

        {!fitLong && !fit5k && (
          <p className="text-xs text-textSecondary mt-4 text-center">
            Need 4+ qualifying runs in the last 8 weeks for predictions.
          </p>
        )}

        {fitLong && (
          <p className="text-xs text-textSecondary mt-4 text-center">
            Model: {fitLong.n} efforts, R² {fitLong.r2.toFixed(2)}, exponent{" "}
            {fitLong.k.toFixed(3)}
          </p>
        )}
        <button
          onClick={() => askCoach(
            'Based on my predicted race times, how realistic is ' +
            'my half marathon goal? What training would most ' +
            'improve my predicted finish time?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my race predictions
        </button>
      </Card>

      {/* ── Training Load ─────────────────────────────────── */}
      <SectionHeader icon={Activity} title="Training Load" />

      <TrainingLoadSection
        data={trainingLoadData}
        weeklyData={weeklyLoadData}
        intensity={intensityData}
        intensityLoading={intensityLoading}
      />

      {/* ── Personal Records by Year ─────────────────────── */}
      <SectionHeader icon={Trophy} title="Personal Records by Year" />

      <Card>
        {/* Year selector */}
        <div className="flex items-center justify-center gap-4 mb-5">
          <button
            onClick={() => setSelectedYear((y) => y - 1)}
            disabled={!availableYears.includes(selectedYear - 1)}
            className="p-1 rounded-lg hover:bg-surface disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={20} className="text-textSecondary" />
          </button>
          <span className="text-lg font-bold text-textPrimary tabular-nums w-16 text-center">
            {selectedYear}
          </span>
          <button
            onClick={() => setSelectedYear((y) => y + 1)}
            disabled={selectedYear >= new Date().getFullYear()}
            className="p-1 rounded-lg hover:bg-surface disabled:opacity-30 transition-colors"
          >
            <ChevronRight size={20} className="text-textSecondary" />
          </button>
        </div>

        {/* Unified PR table with two sections */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-textSecondary font-medium">Distance</th>
                <th className="text-right py-2 text-textSecondary font-medium">Pace</th>
                <th className="text-right py-2 text-textSecondary font-medium">Time</th>
                <th className="text-right py-2 text-textSecondary font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {/* Section 1: Best Pace by Distance */}
              <tr>
                <td colSpan={4} className="pt-4 pb-1">
                  <span className="text-xs font-semibold text-textSecondary uppercase tracking-widest">
                    Best Pace by Distance
                  </span>
                </td>
              </tr>

              {/* 1 Mile — from GPS segments */}
              {(() => {
                const mile = fastestMileByYear[selectedYear];
                return (
                  <tr className="border-b border-border/50">
                    <td className="py-3 text-textSecondary font-medium">1 Mile</td>
                    {mile ? (
                      <>
                        <td className="py-3 text-right font-semibold text-textPrimary tabular-nums">
                          {formatPaceLabel(mile.seconds)} /mi
                        </td>
                        <td className="py-3 text-right text-textSecondary tabular-nums">
                          {formatTotalTime(mile.seconds)}
                        </td>
                        <td className="py-3 text-right text-textSecondary text-xs">
                          {mile.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                      </>
                    )}
                  </tr>
                );
              })()}

              {prBuckets.map((bucket, idx) => {
                const pr = prs[idx];
                return (
                  <tr key={bucket.label} className="border-b border-border/50">
                    <td className="py-3 text-textSecondary font-medium">{bucket.label}</td>
                    {pr ? (
                      <>
                        <td className="py-3 text-right font-semibold text-textPrimary tabular-nums">
                          {formatPaceLabel(pr.pace)} /mi
                        </td>
                        <td className="py-3 text-right text-textSecondary tabular-nums">
                          {formatTotalTime(pr.pace * pr.miles)}
                        </td>
                        <td className="py-3 text-right text-textSecondary text-xs">
                          {pr.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                      </>
                    )}
                  </tr>
                );
              })}

              {/* Section 2: Specific Runs */}
              <tr>
                <td colSpan={4} className="pt-6 pb-1">
                  <span className="text-xs font-semibold text-textSecondary uppercase tracking-widest">
                    Specific Runs
                  </span>
                </td>
              </tr>
              {specificDistances.map((dist, idx) => {
                const pr = specificPrs[idx];
                return (
                  <tr key={dist.label} className="border-b border-border/50">
                    <td className="py-3 text-textSecondary font-medium">{dist.label}</td>
                    {pr ? (
                      <>
                        <td className="py-3 text-right font-semibold text-textPrimary tabular-nums">
                          {formatPaceLabel(pr.pace)} /mi
                        </td>
                        <td className="py-3 text-right text-textSecondary tabular-nums">
                          {formatTotalTime(pr.totalSeconds)}
                        </td>
                        <td className="py-3 text-right text-textSecondary text-xs">
                          {pr.date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                        <td className="py-3 text-right text-textSecondary">—</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-textSecondary mt-3 text-center">
          {yearRuns.length} runs in {selectedYear}
        </p>
        <button
          onClick={() => askCoach(
            'What do my personal records across distances suggest ' +
            'about my fitness trajectory? Am I improving, plateauing, ' +
            'or declining? What should I do differently?'
          )}
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-2"
        >
          <BotMessageSquare className="w-3 h-3" />
          Ask about my PRs and trends
        </button>
      </Card>

      {/* ── Pace Trends (Last 8 Weeks) ───────────────────── */}
      <SectionHeader icon={TrendingUp} title="Pace Trends — Last 8 Weeks" />

      {hasPaceTrend ? (
        <Card>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={paceTrendData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis
                domain={["dataMin - 30", "dataMax + 30"]}
                reversed
                tick={{ fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => formatPaceLabel(v)}
                width={50}
              />
              <Tooltip
                formatter={(v) => [formatPaceLabel(Number(v)) + " /mi"]}
                labelFormatter={(l) => `Week of ${l}`}
                contentStyle={{
                  fontSize: 12,
                  backgroundColor: 'var(--color-chart-tooltip-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '0.375rem',
                  color: 'var(--color-textPrimary)',
                }}
                labelStyle={{ color: 'var(--color-textSecondary)' }}
                itemStyle={{ color: 'var(--color-textPrimary)' }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(value) =>
                  value === "short" ? "Short (1-3 mi)" : value === "medium" ? "Medium (3-6 mi)" : "Long (6+ mi)"
                }
              />
              <Line
                type="monotone"
                dataKey="short"
                stroke="var(--color-chart-orange)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="short"
              />
              <Line
                type="monotone"
                dataKey="medium"
                stroke="var(--color-chart-primary)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="medium"
              />
              <Line
                type="monotone"
                dataKey="long"
                stroke="var(--color-chart-success)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                name="long"
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-textSecondary mt-3 text-center">
            Lower on chart = faster pace. Gaps indicate no runs in that bucket for the week.
          </p>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-textSecondary text-center">
            Not enough recent data for pace trends. Keep logging runs!
          </p>
        </Card>
      )}

      {/* ── Workout Trends (Phase 3) ────────────────────── */}
      {uid && <WorkoutTrendsSection uid={uid} workouts={workouts} />}
    </div>
  );
}
