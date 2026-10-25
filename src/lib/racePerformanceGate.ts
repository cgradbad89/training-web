/** Deployment identity is baked into client/server bundles by next.config.ts.
 * Production release authorizes summary display only. Non-Production builds
 * retain the existing explicit opt-in for comparison and developer review. */
export function isRacePerformanceDisplayEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV === "production"
    || isPreviewRaceCapabilityEnabled();
}

/** Editing/persistence must never inherit read-only display authorization. */
export function isRaceConfirmationEnabled(): boolean {
  return isPreviewRaceCapabilityEnabled();
}

/** Experimental numbers are a separate developer capability, never app output. */
export function isRacePerformanceResearchEnabled(): boolean {
  return isPreviewRaceCapabilityEnabled();
}

function isPreviewRaceCapabilityEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE === "true"
    && process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV !== "production";
}

export const RACE_PERFORMANCE_UNAVAILABLE_REASON =
  "A numerical current-capability estimate and race-day forecast are withheld until race evidence and the prediction method meet validation requirements. Completed training describes preparation; it does not establish a finish-time improvement.";
