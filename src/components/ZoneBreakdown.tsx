"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { type RoutePoint } from "@/services/routes";
import {
  paceZoneRanges,
  type PaceZoneRange,
  type ZoneBucket,
} from "@/utils/zones";
import {
  computeHrZonesFromPoints,
  computePaceZonesFromPoints,
  type ZoneBreakdownCache,
} from "@/utils/zoneBreakdown";
import { formatDuration, formatPace } from "@/utils/pace";

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
  /** Cached zone breakdown. When present and its basis (maxHR / threshold pace)
   *  still matches, its buckets are used verbatim so the component renders
   *  without route points; otherwise the zones are computed from `points`. */
  cache?: ZoneBreakdownCache;
}

function formatPaceRange(range: PaceZoneRange): string {
  if (range.minPaceSecPerMile == null && range.maxPaceSecPerMile != null) {
    return `faster than ${formatPace(range.maxPaceSecPerMile)} /mi`;
  }
  if (range.maxPaceSecPerMile == null && range.minPaceSecPerMile != null) {
    return `slower than ${formatPace(range.minPaceSecPerMile)} /mi`;
  }
  if (range.minPaceSecPerMile != null && range.maxPaceSecPerMile != null) {
    return `${formatPace(range.minPaceSecPerMile)}–${formatPace(
      range.maxPaceSecPerMile
    )} /mi`;
  }
  return "—";
}

export function ZoneBreakdown({
  points,
  maxHR,
  thresholdPaceSecPerMile,
  cache,
}: ZoneBreakdownProps) {
  // Prefer the cached buckets when their basis still matches the current
  // settings (so the component needs no route points); otherwise compute from
  // `points` via the SAME pure functions the cache was built with.
  const hrZones = useMemo(() => {
    if (cache && cache.maxHr === maxHR) return cache.hrZones;
    return computeHrZonesFromPoints(points, maxHR);
  }, [cache, points, maxHR]);

  const paceZones = useMemo(() => {
    const threshold = thresholdPaceSecPerMile ?? null;
    if (cache && cache.thresholdPaceSecPerMile === threshold) {
      return cache.paceZones;
    }
    return computePaceZonesFromPoints(points, threshold);
  }, [cache, points, thresholdPaceSecPerMile]);

  const hasThresholdPace =
    thresholdPaceSecPerMile != null &&
    isFinite(thresholdPaceSecPerMile) &&
    thresholdPaceSecPerMile > 0;

  const paceRanges = useMemo(
    () =>
      hasThresholdPace
        ? paceZoneRanges(thresholdPaceSecPerMile)
        : [],
    [hasThresholdPace, thresholdPaceSecPerMile]
  );

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
          <h3 className="text-xs font-semibold text-textPrimary inline-flex items-center">
            <span>Pace Zones</span>
            {hasThresholdPace && (
              <InfoTooltip
                ariaLabel="About Pace Zones"
                widthPx={320}
                content={
                  <div>
                    <p className="mb-2">
                      Based on your threshold pace of{" "}
                      {formatPace(thresholdPaceSecPerMile)} /mi:
                    </p>
                    <ul className="space-y-1">
                      {paceRanges.map((range) => (
                        <li key={range.zone} className="flex gap-1">
                          <span className="font-medium text-textPrimary">
                            {range.label}:
                          </span>
                          <span>{formatPaceRange(range)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                }
              />
            )}
          </h3>
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
