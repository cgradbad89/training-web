"use client";

import React, { useMemo } from "react";
import { type RoutePoint } from "@/services/routes";
import { type GapPoint } from "@/utils/gradeAdjustedPace";
import {
  computeHRZones,
  computePaceZones,
  type ZoneBucket,
} from "@/utils/zones";
import { formatDuration } from "@/utils/pace";

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
  perPointGap: GapPoint[];
  maxHR: number;
}

export function ZoneBreakdown({
  points,
  perPointGap,
  maxHR,
}: ZoneBreakdownProps) {
  const { hrZones, paceZones } = useMemo(() => {
    const hrSamples: { bpm: number; seconds: number }[] = [];
    const paceSamples: { gapSecPerMile: number; seconds: number }[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const t0 = new Date(points[i].timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const dt = (t1 - t0) / 1000;
      if (!isFinite(dt) || dt <= 0) continue;

      if (points[i].hr != null) {
        hrSamples.push({ bpm: points[i].hr as number, seconds: dt });
      }
      // perPointGap[i] is the segment from point i → i+1.
      const gap = perPointGap[i]?.gradeAdjPaceSecPerMile;
      if (gap != null) {
        paceSamples.push({ gapSecPerMile: gap, seconds: dt });
      }
    }

    return {
      hrZones: computeHRZones(hrSamples, maxHR),
      paceZones: computePaceZones(paceSamples),
    };
  }, [points, perPointGap, maxHR]);

  if (hrZones.length === 0 && paceZones.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl border border-border p-5 space-y-5">
      <h2 className="text-sm font-semibold text-textPrimary">Zones</h2>

      {/* Heart-rate zones */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
            Heart Rate Zones
          </h3>
          <span className="text-[10px] text-textSecondary">
            max HR {Math.round(maxHR)} bpm
          </span>
        </div>
        {hrZones.length > 0 ? (
          <ZoneBar zones={hrZones} />
        ) : (
          <p className="text-sm text-textSecondary">
            Per-point HR not available for this run
          </p>
        )}
      </div>

      {/* Pace zones */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
            Pace Zones
          </h3>
          <span className="text-[10px] text-textSecondary">
            run-relative (GAP quintiles)
          </span>
        </div>
        {paceZones.length > 0 ? (
          <ZoneBar zones={paceZones} />
        ) : (
          <p className="text-sm text-textSecondary">
            Not enough data to compute pace zones
          </p>
        )}
      </div>
    </div>
  );
}

function ZoneBar({ zones }: { zones: ZoneBucket[] }) {
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
