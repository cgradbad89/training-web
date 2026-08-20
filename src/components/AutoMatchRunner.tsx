'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/contexts/AppDataContext'
import { fetchPlans } from '@/services/plans'
import { onHealthWorkoutsSnapshot } from '@/services/healthWorkouts'
import { autoMatchCrossTrainingSessions } from '@/services/autoMatch'
import type { HealthWorkout } from '@/types/healthWorkout'

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
 *  - We only invoke the matcher when the pool contains at least one non-run
 *    workout (workout plans match against non-run activities), so empty /
 *    runs-only snapshots short-circuit without burning a fetchPlans call.
 *  - lastKey skips passes when the same content snapshot fires twice.
 *  - inFlight prevents concurrent matcher invocations on bursty snapshots.
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
  const { overrides, refreshPlans } = useAppData()
  const inFlight = useRef(false)
  const lastKey = useRef<string | null>(null)

  // Latest-value refs — see the note above on why these are not effect deps.
  const overridesRef = useRef(overrides)
  const refreshPlansRef = useRef(refreshPlans)
  useEffect(() => {
    overridesRef.current = overrides
  }, [overrides])
  useEffect(() => {
    refreshPlansRef.current = refreshPlans
  }, [refreshPlans])

  useEffect(() => {
    if (!user) return
    const uid = user.uid

    async function runMatcher(workouts: HealthWorkout[], key: string) {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const plans = await fetchPlans(uid)

        const { result } = await autoMatchCrossTrainingSessions(
          uid,
          plans,
          workouts,
          overridesRef.current
        )
        lastKey.current = key
        // Only refresh shared plan state when the matcher actually persisted
        // something — a no-op pass shouldn't trigger a plans read.
        if (result.updatedPlanIds.length > 0) {
          await refreshPlansRef.current()
        }
      } catch (err) {
        console.error('[AutoMatchRunner] error:', err)
      } finally {
        inFlight.current = false
      }
    }

    const unsubscribe = onHealthWorkoutsSnapshot(
      uid,
      { limitCount: 500 },
      (workouts) => {
        // Workout plans can only match against non-running activities. If the
        // current snapshot has none, skip — saves a fetchPlans + log spam.
        // A genuinely empty pool (truly no workouts yet) and a not-yet-synced
        // pool are indistinguishable here; both are correctly treated as
        // "nothing to match", and the listener will fire again when iOS syncs.
        const nonRunWorkouts = workouts.filter((w) => !w.isRunLike)
        if (nonRunWorkouts.length === 0) return

        // Content-derived key — only re-run on a meaningful pool change.
        // length + most-recent workoutId + most-recent startDate ms is
        // sufficient to detect "a new sync arrived" without hashing the array.
        const key =
          nonRunWorkouts.length +
          ':' +
          (nonRunWorkouts[0]?.workoutId ?? '') +
          ':' +
          (nonRunWorkouts[0]?.startDate?.getTime() ?? 0)
        if (key === lastKey.current) return

        void runMatcher(workouts, key)
      },
      (err) => console.error('[AutoMatchRunner] snapshot error:', err)
    )

    return () => unsubscribe()
  }, [user])

  return null
}
