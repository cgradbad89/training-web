"use client";

import React from "react";

/**
 * Loading placeholder for lazily-imported (next/dynamic, ssr:false) chart
 * components. Renders a ghosted chart silhouette — a faint baseline plus a row
 * of pulsing bars — so chart-heavy pages reserve the chart's space and animate
 * while Recharts streams in on the client.
 *
 * Presentation-only: no props beyond an optional `height` (defaults to ~300px)
 * so a caller can match the real chart's height (e.g. a 48px sparkline vs a
 * 220px trend card). Styling is on CSS-variable tokens (--color-card /
 * --color-border / --color-surface) via Tailwind utility classes, so it tracks
 * light/dark automatically through the app's prefers-color-scheme strategy —
 * no `.dark` class or `dark:` prefix.
 */
function ChartSkeleton({ height }: { height?: number }): React.JSX.Element {
  const h = height ?? 300;
  // Ghost bar silhouette — heights are a fixed, deterministic "chart-like"
  // profile (percent of the plot area). Not literal data, just a recognizable
  // shape while the real chart loads.
  const bars = [42, 68, 55, 80, 60, 90, 72, 84];

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading chart"
      className="w-full bg-card rounded-2xl border border-border p-5 animate-pulse"
      style={{ height: h }}
    >
      <div className="flex h-full w-full items-end gap-2">
        {bars.map((barHeight, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-md bg-surface"
            style={{ height: `${barHeight}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export { ChartSkeleton };
export default ChartSkeleton;
