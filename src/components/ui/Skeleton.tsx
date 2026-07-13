"use client";

import React from "react";

/**
 * Bare pulsing placeholder block — the shared building block for page-level
 * loading skeletons. No built-in dimensions; the caller sizes it entirely via
 * `className` (e.g. `className="w-24 h-4 rounded"`) to mimic the shape of
 * whatever loaded-state element it stands in for. Same bg-surface +
 * animate-pulse pattern as ChartSkeleton, so it tracks light/dark
 * automatically through the app's prefers-color-scheme strategy — no `.dark`
 * class or `dark:` prefix.
 */
function Skeleton({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={`bg-surface animate-pulse ${className}`}
    />
  );
}

export { Skeleton };
export default Skeleton;
