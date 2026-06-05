'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
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
 */
export default function AutoMatchRunner() {
  const { user } = useAuth()
  const inFlight = useRef(false)
  const lastKey = useRef<string | null>(null)

  useEffect(() => {
    if (!user) return
    const uid = user.uid

    async function runMatcher(workouts: HealthWorkout[], key: string) {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const plans = await fetchPlans(uid)

        // Debug — fires on real matching passes, not on every render/snapshot.
        // eslint-disable-next-line no-console
        console.log(
          '[AutoMatchRunner] non-running workouts (last 500):',
          workouts
            .filter((w) => !w.isRunLike)
            .map((w) => ({
              workoutId: w.workoutId,
              date: w.startDate.toISOString().split('T')[0],
              activityType: w.activityType,
            }))
        )
        // eslint-disable-next-line no-console
        console.log(
          '[AutoMatchRunner] active workout plans:',
          plans
            .filter(
              (p) =>
                (p as { planType?: string }).planType === 'workout' &&
                (p as { status?: string }).status === 'active'
            )
            .map((p) => p.name)
        )

        await autoMatchCrossTrainingSessions(uid, plans, workouts)
        lastKey.current = key
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
