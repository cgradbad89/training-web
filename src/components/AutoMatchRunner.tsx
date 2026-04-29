'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { fetchPlans } from '@/services/plans'
import { fetchHealthWorkouts } from '@/services/healthWorkouts'
import { autoMatchCrossTrainingSessions } from '@/services/autoMatch'

export default function AutoMatchRunner() {
  const { user } = useAuth()
  const hasRun = useRef(false)

  useEffect(() => {
    if (!user || hasRun.current) return
    hasRun.current = true
    const uid = user.uid

    async function run() {
      try {
        const [plans, workouts] = await Promise.all([
          fetchPlans(uid),
          fetchHealthWorkouts(uid, { limitCount: 500 }),
        ])

        // TEMP debug — surfaces what the matcher actually sees so we can
        // confirm activityType strings + active workout-plans on user devices.
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
              (p) => (p as { planType?: string }).planType === 'workout' && p.isActive
            )
            .map((p) => p.name)
        )

        await autoMatchCrossTrainingSessions(uid, plans, workouts)
      } catch (err) {
        console.error('[AutoMatchRunner] error:', err)
      }
    }

    run()
  }, [user])

  return null
}
