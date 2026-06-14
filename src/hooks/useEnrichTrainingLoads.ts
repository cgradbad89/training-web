import { useEffect, useRef } from "react";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type UserSettings } from "@/types/userSettings";
import { enrichTrainingLoads } from "@/services/healthWorkouts";
import { shouldEnrichLoad, enrichBasisKey } from "@/utils/trainingLoad";

/**
 * Auto-store / upgrade Training Load V2 for a loaded workout list.
 *
 * iOS writes each workout doc with NO training load (and often no HR yet — the
 * avgHeartRate + hrStream flush in a LATER write). computeAndStoreTrainingLoad has
 * no ingest-time caller, so a new workout's STORED load stays null until a manual
 * trigger (admin backfill or the Settings recompute). This hook closes that gap:
 * after a page's workout list resolves, every workout that shouldEnrichLoad() flags
 * is computed + stored, and an avg-HR value is re-computed once a route/stream
 * arrives (→ "streamed").
 *
 * Never blocks render — it runs in an effect, after paint. The writes flow back
 * through the page's own onSnapshot listener, which re-renders the displayed values
 * via resolveDisplayLoad. No UI change.
 *
 * LOOP SAFETY — the snapshot listener re-fires when enrichment writes, so this
 * effect re-runs on its own output. Two guards converge it:
 *   - `attemptedRef` records each workout's BASIS key (id + hasRoute + hasHRStream)
 *     the moment it is queued, so the same (workout, basis) is never enriched twice.
 *     This is what stops a compute that legitimately yields null (no usable HR yet,
 *     or a sparse stream) from re-writing the same value forever. A workout
 *     re-qualifies only when its basis changes (the hrStream finally lands) — which
 *     is exactly the UPGRADE we want, allowed through once.
 *   - `inFlightRef` prevents a second pass starting while one is running.
 *
 * SETTLING GUARD — `settings === undefined` means the profile fetch hasn't resolved
 * yet; enriching then would store loads against the DEFAULT HR anchors, and the
 * stored-value-wins rule in resolveDisplayLoad would mask the correct value. So we
 * wait until settings have loaded. A resolved `null` (the user has no profile doc)
 * is fine — defaults are then intentional, and a later Settings save already
 * recomputes everything via recomputeAllTrainingLoad.
 */
export function useEnrichTrainingLoads(
  uid: string | null,
  workouts: HealthWorkout[],
  settings: UserSettings | null | undefined
): void {
  const attemptedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!uid) return;
    if (settings === undefined) return; // profile still loading — see SETTLING GUARD
    if (inFlightRef.current) return;

    // Fresh candidates: need enrichment AND not already attempted for this basis.
    const fresh = workouts.filter(
      (w) => shouldEnrichLoad(w) && !attemptedRef.current.has(enrichBasisKey(w))
    );
    if (fresh.length === 0) return;

    // Record the basis up front so a snapshot re-fire mid-pass can't re-queue these.
    for (const w of fresh) attemptedRef.current.add(enrichBasisKey(w));

    inFlightRef.current = true;
    enrichTrainingLoads(uid, fresh, settings)
      .catch((err) =>
        console.error("[useEnrichTrainingLoads] enrich failed", err)
      )
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [uid, workouts, settings]);
}
