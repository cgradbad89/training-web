"use client";

import React from "react";
import { type MileSplit } from "@/utils/mileSplits";
import { formatPace } from "@/utils/pace";

// ─── Efficiency color helpers (matches MetricBadge / runs list styling) ─────

function efficiencyColor(score: number): string {
  if (score >= 7) return "text-green-700 bg-green-100";
  if (score >= 5) return "text-yellow-800 bg-yellow-100";
  return "text-orange-800 bg-orange-100";
}

// ─── Component ──────────────────────────────────────────────────────────────

interface MileSplitsTableProps {
  splits: MileSplit[];
  routeLoading: boolean;
  hasRoute: boolean;
}

export function MileSplitsTable({
  splits,
  routeLoading,
  hasRoute,
}: MileSplitsTableProps) {

  // No GPS route at all
  if (!hasRoute) {
    return (
      <div className="bg-card rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold text-textPrimary mb-2">
          Mile Splits
        </h2>
        <p className="text-sm text-textSecondary">
          Mile split data unavailable — no GPS data for this run
        </p>
      </div>
    );
  }

  // Route still loading
  if (routeLoading) {
    return (
      <div className="bg-card rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold text-textPrimary mb-3">
          Mile Splits
        </h2>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-8 bg-surface rounded-lg animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  // Route loaded but no usable splits (too few points or too short)
  if (splits.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border p-5">
        <h2 className="text-sm font-semibold text-textPrimary mb-2">
          Mile Splits
        </h2>
        <p className="text-sm text-textSecondary">
          Not enough GPS data to compute mile splits
        </p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border p-5">
      <h2 className="text-sm font-semibold text-textPrimary mb-3">
        Mile Splits
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-textSecondary uppercase tracking-wide border-b border-border">
              <th className="text-left py-2 pr-4 font-medium">Mile</th>
              <th className="text-right py-2 px-4 font-medium">Pace</th>
              <th className="text-right py-2 px-4 font-medium">Heart Rate</th>
              <th className="text-right py-2 pl-4 font-medium">Efficiency</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((split: MileSplit) => (
              <tr
                key={split.mile}
                className="border-b border-border/50 last:border-0"
              >
                <td className="py-2.5 pr-4 text-textPrimary font-medium">
                  {split.isPartial
                    ? `Mile ${split.mile} (${split.segmentMiles.toFixed(1)} mi)`
                    : `Mile ${split.mile}`}
                </td>
                <td className="py-2.5 px-4 text-right text-textPrimary tabular-nums">
                  {formatPace(split.paceSecPerMile)} /mi
                </td>
                <td className="py-2.5 px-4 text-right text-textPrimary tabular-nums">
                  {split.avgHeartRate != null
                    ? `${Math.round(split.avgHeartRate)} bpm`
                    : "\u2014"}
                </td>
                <td className="py-2.5 pl-4 text-right">
                  {split.efficiency != null ? (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${efficiencyColor(split.efficiency)}`}
                    >
                      {split.efficiency.toFixed(1)}
                    </span>
                  ) : (
                    <span className="text-textSecondary">{"\u2014"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
