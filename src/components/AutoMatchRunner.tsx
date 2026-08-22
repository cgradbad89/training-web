'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/contexts/AppDataContext'
import { fetchPlans } from '@/services/plans'
import {
  AUTO_MATCH_CANDIDATE_PAGE_SIZE,
  fetchAutoMatchCandidatesThroughDate,
  onHealthWorkoutsSnapshot,
  type HealthWorkoutQueryCursor,
} from '@/services/healthWorkouts'
import {
  autoMatchCrossTrainingSessions,
  autoMatchWindowStart,
} from '@/services/autoMatch'
import type { HealthWorkout } from '@/types/healthWorkout'

export const AUTO_MATCH_WORKOUT_LISTENER_LIMIT =
  AUTO_MATCH_CANDIDATE_PAGE_SIZE

interface AutoMatchRequest {
  uid: string
  generation: number
  earliestDueDate: Date
  firstPage: HealthWorkout[]
  firstPageCursor?: HealthWorkoutQueryCursor
  contentKey: string
}

export function autoMatchWorkoutPoolKey(workouts: HealthWorkout[]): string {
  return workouts
    .map((workout) =>
      [
        workout.workoutId,
        workout.startDate.getTime(),
        workout.activityType,
      ].join(':')
    )
    .join('|')
}

/**
 * Subscribes to healthWorkouts via a realtime listener and re-runs the
 * cross-training auto-matcher whenever the non-running workout pool changes.
 *
 * Why a listener (not a one-shot fetch): if a user opens /plans BEFORE iOS
 * has finished syncing today's workout, a single fetch returns a stale pool
 * with no candidates for today's session. The matcher writes nothing, the
 * session stays incomplete, and the user has to refresh later. With a
 * snapshot listener, the late-arriving sync triggers another pass automatically.
 *
 * Gating + idempotence:
 *  - The listener exists only while an active workout plan has an incomplete,
 *    due session that the matcher can act on.
 *  - We only invoke the matcher when the pool contains at least one non-run
 *    workout (workout plans match against non-run activities), so empty /
 *    runs-only snapshots short-circuit without burning a fetchPlans call.
 *  - lastKey skips passes when the same content snapshot fires twice.
 *  - inFlight prevents concurrent matcher invocations on bursty snapshots;
 *    one latest changed snapshot is queued so it is not silently lost.
 *  - The listener keeps only the newest 250 eligible workouts live. A
 *    saturated first page is paged backward through the entire earliest due
 *    local day before the matcher runs; 250 is a per-read page size, not a
 *    total correctness cap.
 *  - The matcher itself skips completed + future sessions, so re-running is safe.
 *
 * AppDataContext wiring: this component is mounted inside <AppDataProvider>
 * (see (app)/layout.tsx), so it reaches the shared workoutOverrides map and
 * refreshPlans through useAppData() — no separate fetch, no new context.
 *  - `overrides` gates the matcher's candidate pool: an excluded workout must
 *    never persist `completed: true` onto a plan entry.
 *  - `refreshPlans()` runs after a successful write so a background match shows
 *    up on /plans, /dashboard, and /plan-insights without a manual reload.
 * Both are read through refs so a changing override map or callback identity
 * never tears down and re-subscribes the snapshot listener.
 */
export default function AutoMatchRunner() {
  const { user } = useAuth()
  const userUid = user?.uid ?? null
  const {
    overrides,
    refreshPlans,
    plans,
    plansLoading,
    workoutsFullReconciliationVersion,
  } = useAppData()
  const inFlight = useRef(false)
  const pendingRequest = useRef<AutoMatchRequest | null>(null)
  const lastKey = useRef<string | null>(null)
  const listenerGeneration = useRef(0)
  const matchWindowStart = !plansLoading
    ? autoMatchWindowStart(plans)
    : null
  const matchWindowStartMs = matchWindowStart?.getTime() ?? null

  // Latest-value refs — see the note above on why these are not effect deps.
  const overridesRef = useRef(overrides)
  const refreshPlansRef = useRef(refreshPlans)
  useEffect(() => {
    overridesRef.current = overrides
  }, [overrides])
  useEffect(() => {
    refreshPlansRef.current = refreshPlans
  }, [refreshPlans])

  const processRequestRef = useRef<
    (request: AutoMatchRequest) => Promise<void>
  >(async () => {})
  const processRequest = useCallback(async (request: AutoMatchRequest) => {
    if (request.generation !== listenerGeneration.current) return
    if (inFlight.current) {
      pendingRequest.current = request
      return
    }

    inFlight.current = true
    try {
      const candidates = await fetchAutoMatchCandidatesThroughDate(
        request.uid,
        request.earliestDueDate,
        {
          initialCandidates: request.firstPage,
          initialCursor: request.firstPageCursor,
        }
      )
      if (request.generation !== listenerGeneration.current) return

      const currentPlans = await fetchPlans(request.uid)
      if (request.generation !== listenerGeneration.current) return

      const { result } = await autoMatchCrossTrainingSessions(
        request.uid,
        currentPlans,
        candidates,
        overridesRef.current
      )
      if (request.generation === listenerGeneration.current) {
        lastKey.current = request.contentKey
      }
      // Only refresh shared plan state when the matcher actually persisted
      // something — a no-op pass shouldn't trigger a plans read.
      if (result.updatedPlanIds.length > 0) {
        await refreshPlansRef.current()
      }
    } catch (err) {
      console.error('[AutoMatchRunner] error:', err)
    } finally {
      inFlight.current = false
      const pending = pendingRequest.current
      pendingRequest.current = null
      if (
        pending &&
        pending.generation === listenerGeneration.current &&
        pending.contentKey !== lastKey.current
      ) {
        void processRequestRef.current(pending)
      }
    }
  }, [])
  useEffect(() => {
    processRequestRef.current = processRequest
  }, [processRequest])

  useEffect(() => {
    const generation = listenerGeneration.current + 1
    listenerGeneration.current = generation
    pendingRequest.current = null
    if (!userUid || matchWindowStartMs === null) return
    const uid = userUid
    // A newly activated plan must evaluate the listener's initial snapshot,
    // even if its workout pool matches the key from a prior subscription.
    lastKey.current = null

    const unsubscribe = onHealthWorkoutsSnapshot(
      uid,
      {
        isRunLike: false,
        startDate: new Date(matchWindowStartMs),
        limitCount: AUTO_MATCH_WORKOUT_LISTENER_LIMIT,
      },
      (workouts, firstPageCursor) => {
        // Workout plans can only match against non-running activities. If the
        // current snapshot has none, skip — saves a fetchPlans + log spam.
        // A genuinely empty pool (truly no workouts yet) and a not-yet-synced
        // pool are indistinguishable here; both are correctly treated as
        // "nothing to match", and the listener will fire again when iOS syncs.
        const nonRunWorkouts = workouts.filter((w) => !w.isRunLike)
        if (nonRunWorkouts.length === 0) return

        // Content-derived key — catches new syncs and edits to older workouts
        // within the bounded listener window without re-running for identical
        // Firestore snapshots.
        const key = autoMatchWorkoutPoolKey(nonRunWorkouts)
        if (key === lastKey.current) return

        void processRequestRef.current({
          uid,
          generation,
          earliestDueDate: new Date(matchWindowStartMs),
          firstPage: nonRunWorkouts,
          firstPageCursor,
          contentKey: key,
        })
      },
      (err) => console.error('[AutoMatchRunner] snapshot error:', err)
    )

    return () => {
      unsubscribe()
      if (listenerGeneration.current === generation) {
        listenerGeneration.current += 1
        pendingRequest.current = null
      }
    }
  }, [userUid, matchWindowStartMs, workoutsFullReconciliationVersion])

  return null
}
