import { useEffect, useReducer, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  type HealthWorkout,
  type TrainingLoadFields,
} from "@/types/healthWorkout";
import { type UserSettings } from "@/types/userSettings";
import { enrichTrainingLoads } from "@/services/healthWorkouts";
import { getRouteCacheEpoch } from "@/utils/routeCache";
import {
  shouldEnrichLoad,
  enrichBasisKey,
  resolveMaxHr,
  resolveRestingHr,
} from "@/utils/trainingLoad";

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
 * Never blocks render — it runs in an effect, after paint. Each successful merge
 * write returns its final load fields, which are patched into shared AppData so
 * resolveDisplayLoad sees them immediately without a full workout refresh.
 *
 * LOOP SAFETY — the AppData patch re-renders this hook on its own output. Two
 * guards converge it:
 *   - `attemptedRef` records each workout's BASIS key (id + hasRoute + hasHRStream)
 *     the moment it is queued, so the same (workout, basis) is never enriched twice.
 *     This is what stops a compute that legitimately yields null (no usable HR yet,
 *     or a sparse stream) from re-writing the same value forever. A workout
 *     re-qualifies only when its basis changes (the hrStream finally lands) — which
 *     is exactly the UPGRADE we want, allowed through once.
 *   - `inFlightRef` prevents a second pass starting while one is running. Once it
 *     settles, recheck candidates that arrived while the pass was in flight.
 *
 * A page/auth/HR-anchor lifetime owns each pass. Retirement stops subsequent
 * acquisition and writes and prevents late AppData publication. Workout-list
 * updates (including our own patches) retain that owner and its attempted bases.
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
  settings: UserSettings | null | undefined,
  patchTrainingLoad: (
    workoutId: string,
    patch: TrainingLoadFields
  ) => void,
  owningPathname: "/runs" | "/workouts"
): void {
  const attemptedRef = useRef<Set<string>>(new Set());
  const lifetimeRef = useRef<{ active: boolean; epoch: number } | null>(null);
  const inFlightRef = useRef<object | null>(null);
  const [completedPass, finishPass] = useReducer((value: number) => value + 1, 0);
  const pathname = usePathname();
  const epoch = getRouteCacheEpoch();
  const maxHr = resolveMaxHr(settings);
  const restingHr = resolveRestingHr(settings);
  const profileSettled = settings !== undefined;

  useEffect(() => {
    if (!uid || !profileSettled || pathname !== owningPathname) return;
    const lifetime = { active: true, epoch };
    lifetimeRef.current = lifetime;
    attemptedRef.current = new Set();
    return () => {
      lifetime.active = false;
      if (lifetimeRef.current === lifetime) lifetimeRef.current = null;
    };
  }, [uid, pathname, owningPathname, epoch, maxHr, restingHr, profileSettled]);

  useEffect(() => {
    if (!uid) return;
    if (settings === undefined) return; // profile still loading — see SETTLING GUARD
    const lifetime = lifetimeRef.current;
    if (!lifetime) return;
    const isCurrent = () => lifetime.active && lifetimeRef.current === lifetime && lifetime.epoch === getRouteCacheEpoch();
    if (!isCurrent() || inFlightRef.current === lifetime) return;

    // Fresh candidates: need enrichment AND not already attempted for this basis.
    const fresh = workouts.filter(
      (w) =>
        shouldEnrichLoad(w, maxHr, restingHr) &&
        !attemptedRef.current.has(enrichBasisKey(w, maxHr, restingHr))
    );
    if (fresh.length === 0) return;

    // Record the basis up front so an AppData re-render can't re-queue these.
    for (const w of fresh)
      attemptedRef.current.add(enrichBasisKey(w, maxHr, restingHr));

    inFlightRef.current = lifetime;
    enrichTrainingLoads(uid, fresh, settings, { isCurrent })
      .then((results) => {
        for (const result of results) {
          if (!isCurrent()) return;
          patchTrainingLoad(result.workoutId, {
            trainingLoadV2: result.trainingLoadV2,
            trainingLoadMethod: result.trainingLoadMethod,
            trainingLoadBasisComplete: result.trainingLoadBasisComplete,
          });
        }
      })
      .catch((err) => {
        if (isCurrent()) console.error("[useEnrichTrainingLoads] enrich failed", err);
      })
      .finally(() => {
        if (inFlightRef.current === lifetime) inFlightRef.current = null;
        // A changed basis/list may have rendered while the in-flight guard was
        // held. Re-evaluate it once, with the same per-basis convergence guard.
        if (isCurrent()) finishPass();
      });
  }, [uid, workouts, settings, patchTrainingLoad, pathname, owningPathname, epoch, maxHr, restingHr, completedPass]);
}
