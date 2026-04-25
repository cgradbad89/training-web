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
        await autoMatchCrossTrainingSessions(uid, plans, workouts)
      } catch (err) {
        console.error('[AutoMatchRunner] error:', err)
      }
    }

    run()
  }, [user])

  return null
}
