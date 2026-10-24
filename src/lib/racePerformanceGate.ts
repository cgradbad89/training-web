/**
 * Phase 3A is a build-time development/preview opt-in. The deployment identity
 * is baked into both bundles by next.config.ts, so client and server agree.
 * Production activation requires a separately reviewed code/config change.
 */
export function isRacePerformanceEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE === "true" &&
    process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV !== "production"
  );
}

export const RACE_PERFORMANCE_UNAVAILABLE_REASON =
  "A numerical current-capability estimate and race-day forecast are withheld until race evidence and the prediction method meet validation requirements. Completed training describes preparation; it does not establish a finish-time improvement.";
