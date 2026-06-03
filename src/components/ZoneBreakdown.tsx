"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { type RoutePoint } from "@/services/routes";
import {
  computeHRZones,
  computePaceZones,
  type ZoneBucket,
} from "@/utils/zones";
import { formatDuration, formatPace, mpsToSecPerMile } from "@/utils/pace";

// Zone palette (token-based; fastest/easiest → green, hardest/slowest → red).
const ZONE_COLORS = [
  "var(--color-chart-success)",
  "var(--color-chart-cyan)",
  "var(--color-chart-warning)",
  "var(--color-chart-orange)",
  "var(--color-chart-hr)",
];

interface ZoneBreakdownProps {
  points: RoutePoint[];
  maxHR: number;
  thresholdPaceSecPerMile?: number | null;
}

export function ZoneBreakdown({
  points,
  maxHR,
  thresholdPaceSecPerMile,
}: ZoneBreakdownProps) {
  const hrZones = useMemo(() => {
    const hrSamples: { bpm: number; seconds: number }[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const t0 = new Date(points[i].timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const dt = (t1 - t0) / 1000;
      if (!isFinite(dt) || dt <= 0) continue;

      if (points[i].hr != null) {
        hrSamples.push({ bpm: points[i].hr as number, seconds: dt });
      }
    }

    return computeHRZones(hrSamples, maxHR);
  }, [points, maxHR]);

  const paceZones = useMemo(() => {
    if (!thresholdPaceSecPerMile || thresholdPaceSecPerMile <= 0) return [];

    const perPointPaceSecPerMile = points.map((point) =>
      point.speed != null ? mpsToSecPerMile(point.speed) : null
    );
    const perPointTimestampsSec = points.map(
      (point) => new Date(point.timestamp).getTime() / 1000
    );

    return computePaceZones(
      perPointPaceSecPerMile,
      perPointTimestampsSec,
      thresholdPaceSecPerMile
    );
  }, [points, thresholdPaceSecPerMile]);

  const hasThresholdPace =
    thresholdPaceSecPerMile != null &&
    isFinite(thresholdPaceSecPerMile) &&
    thresholdPaceSecPerMile > 0;

  const paceZoneBuckets: DisplayZone[] = paceZones.map((zone) => ({
    zone: zone.zone,
    label: `Z${zone.zone} ${zone.label}`,
    seconds: zone.secondsInZone,
    pct: zone.percent,
  }));

  return (
    <div className="bg-card rounded-2xl border border-border p-5 space-y-5">
      <h2 className="text-sm font-semibold text-textPrimary">Zones</h2>

      {hrZones.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-textPrimary">
              Heart Rate Zones
            </h3>
            <span className="text-[10px] text-textSecondary">
              max HR {Math.round(maxHR)} bpm
            </span>
          </div>
          <ZoneBar zones={hrZones} />
        </div>
      )}

      <div>
        <div className="mb-2">
          <h3 className="text-xs font-semibold text-textPrimary">Pace Zones</h3>
          {hasThresholdPace ? (
            <p className="text-[11px] text-textSecondary mt-1">
              Pace zones based on your threshold pace (
              {formatPace(thresholdPaceSecPerMile)} /mi).
            </p>
          ) : (
            <p className="text-[11px] text-textSecondary mt-1">
              Set your threshold pace to see pace zones.{" "}
              <Link href="/settings" className="text-primary hover:underline">
                Open settings
              </Link>
            </p>
          )}
        </div>

        {hasThresholdPace && paceZoneBuckets.length > 0 ? (
          <ZoneBar zones={paceZoneBuckets} />
        ) : hasThresholdPace ? (
          <p className="text-sm text-textSecondary">
            Pace zone data is unavailable for this run.
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface DisplayZone {
  zone: number;
  label: string;
  seconds: number;
  pct: number;
}

function ZoneBar({ zones }: { zones: DisplayZone[] | ZoneBucket[] }) {
  return (
    <div>
      <div className="flex w-full h-7 rounded-lg overflow-hidden">
        {zones.map((z, i) => (
          <div
            key={z.zone}
            className="h-full"
            style={{
              width: `${z.pct}%`,
              backgroundColor: ZONE_COLORS[i],
            }}
            title={`${z.label}: ${formatDuration(z.seconds)} (${z.pct.toFixed(0)}%)`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3">
        {zones.map((z, i) => (
          <div key={z.zone} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: ZONE_COLORS[i] }}
            />
            <div className="min-w-0">
              <p className="text-[11px] text-textPrimary leading-tight truncate">
                {z.label}
              </p>
              <p className="text-[11px] text-textSecondary leading-tight tabular-nums">
                {formatDuration(z.seconds)} · {z.pct.toFixed(0)}%
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
