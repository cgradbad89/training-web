/** Deployment identity is baked into client/server bundles by next.config.ts.
 * Production release authorizes summary display only. Non-Production builds
 * retain the existing explicit opt-in for comparison and developer review. */
export function isRacePerformanceDisplayEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV === "production"
    || isPreviewRaceCapabilityEnabled();
}

/** Read-only current HM experiment; never authorizes other consumers or writes. */
export function isExperimentalCurrentEstimateEnabled(): boolean {
  return isRacePerformanceDisplayEnabled();
}

/**
 * Experimental HR-enhanced estimate (experimental-hr-enhanced-hm-v1), shown BESIDE the official estimate.
 * Rides the existing current-estimate gate (so it can never appear where the official estimate does not),
 * plus a dedicated kill switch: set NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE=true and redeploy to remove
 * the display without touching the official estimate, saved races or any checkpoint.
 */
export function isExperimentalHrEnhancedEstimateEnabled(): boolean {
  return isExperimentalCurrentEstimateEnabled() && process.env.NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE !== "true";
}

/**
 * Experimental hybrid current-capability estimate (experimental-hybrid-hm-v1), shown beside the official and
 * HR-enhanced estimates. Independent kill switch: set NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE=true and redeploy to
 * remove the display without touching the official estimate, the HR-enhanced estimate, saved races or checkpoints.
 */
export function isExperimentalHybridEstimateEnabled(): boolean {
  return isExperimentalCurrentEstimateEnabled() && process.env.NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE !== "true";
}

/**
 * Hybrid Performance Model v1.1 (experimental-hybrid-hm-v1.1): the evidence-weighted successor shown in the hybrid position.
 * Independent rollback: set NEXT_PUBLIC_DISABLE_HYBRID_V11=true and redeploy and the page shows hybrid v1 (unchanged) and the
 * v1-based forecast again — no stored value, saved race, checkpoint, or other estimate is touched.
 */
export function isExperimentalHybridV11Enabled(): boolean {
  return isExperimentalHybridEstimateEnabled() && process.env.NEXT_PUBLIC_DISABLE_HYBRID_V11 !== "true";
}

/**
 * Demonstrated-race evidence for hybrid v1.1: a confirmed race attested `hard` or `nonmaximal` may carry a LABELLED, provisional,
 * low-confidence number (never a maximal-performance prediction, never projected by the race-day forecast). Independent rollback:
 * set NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE=true and redeploy and v1.1 ignores such races again, bit for bit.
 */
export function isDemonstratedRaceEvidenceEnabled(): boolean {
  return isExperimentalHybridV11Enabled() && process.env.NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE !== "true";
}

/**
 * Owner-approved estimator-level assumption: confirmed `hard`/`nonmaximal` races are treated as maximal anchors for PREDICTION only
 * (`treatConfirmedRacesAsMaximal`). Stored records and evidence reporting keep the true effort. Rollback: set
 * NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION=true and redeploy; hybrid v1.1 then falls back to the labelled demonstrated-race policy.
 */
export function isConfirmedRaceMaximalAssumptionEnabled(): boolean {
  return isExperimentalCurrentEstimateEnabled() && process.env.NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION !== "true";
}

/**
 * Bounded, demand-driven Apple Health VO₂ max and warm-up-trimmed HR-stream hydration for the v1.1 physiological family.
 * Separate kill switch (NEXT_PUBLIC_DISABLE_PHYSIOLOGY_HYDRATION=true) removes the extra Firestore reads and falls back to
 * whole-workout average HR without VO₂ corroboration; the estimate is otherwise unaffected.
 */
export function isPhysiologyHydrationEnabled(): boolean {
  return isExperimentalHybridV11Enabled() && process.env.NEXT_PUBLIC_DISABLE_PHYSIOLOGY_HYDRATION !== "true";
}

/**
 * Experimental race-day forecast (experimental-raceday-forecast-v1 / v2). Builds on the hybrid estimate, so it can never
 * appear where that does, and has its own kill switch (NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST=true).
 */
export function isExperimentalRaceDayForecastEnabled(): boolean {
  return isExperimentalHybridEstimateEnabled() && process.env.NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST !== "true";
}

/**
 * TEMPORARY, explicit, owner-only Production enablement of the EXISTING race-confirmation editor. Off unless a Production build sets
 * NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION to exactly "true". It only exposes the editor: every write still passes the existing
 * verified-owner session check, refreshed-token check, server-timestamp receipt, optimistic concurrency and append-only history in
 * `services/raceConfirmations.ts`, plus Firestore's own rules. It is independent of the demonstrated-race evidence policy, which stays on
 * when this is switched off (unset the variable and redeploy once the confirmations are saved).
 */
export function isOwnerRaceConfirmationProductionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV === "production"
    && process.env.NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION === "true";
}

/** Editing/persistence must never inherit read-only display authorization. */
export function isRaceConfirmationEnabled(): boolean {
  return isPreviewRaceCapabilityEnabled() || isOwnerRaceConfirmationProductionEnabled();
}

/** The full Phase 3B.2 developer research interface remains Production-off. */
export function isRacePerformanceResearchEnabled(): boolean {
  return isPreviewRaceCapabilityEnabled();
}

function isPreviewRaceCapabilityEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE === "true"
    && process.env.NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV !== "production";
}

export const RACE_PERFORMANCE_UNAVAILABLE_REASON =
  "A numerical current-capability estimate and race-day forecast are withheld until race evidence and the prediction method meet validation requirements. Completed training describes preparation; it does not establish a finish-time improvement.";
