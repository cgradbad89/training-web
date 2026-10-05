'use client'

import { useEffect, useRef } from 'react'
import { writeBatch, doc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/contexts/AppDataContext'
import { fetchHealthWorkouts } from '@/services/healthWorkouts'
import { computeAllPRs, buildPRBadgeMap } from '@/utils/prComputation'

const PR_THROTTLE_KEY = 'pr_last_computed'
const PR_THROTTLE_MS = 24 * 60 * 60 * 1000 // once per day

function scheduleWhenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 5000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(callback, 1500)
  return () => window.clearTimeout(id)
}

/**
 * Silent background runner that:
 *   1. Reuses AppData workouts when its bounded read contains full history;
 *      falls back to an unbounded read only for users who hit that cap
 *   2. Computes PR holders across distance bands + specific distances
 *   3. Diffs each run's prBadges against the new value and writes only the
 *      changes via a single batched commit
 *   4. Throttles itself to once per 24 hours via localStorage
 *
 * Mirrors the AutoMatchRunner mount pattern: render-null, useRef once-per-
 * session guard, fires from a useEffect on the auth user.
 */
export default function PRComputerRunner() {
  const { user, sessionEpoch, isSessionCurrent } = useAuth()
  const { workouts, workoutsLoading, workoutsHistoryComplete, trainingActivated } = useAppData()
  const hasRun = useRef(false)

  useEffect(() => {
    if (!user || trainingActivated === false || workoutsLoading || hasRun.current) return

    // Throttle — skip if we already ran in the last 24 hours.
    try {
      const last = window.localStorage.getItem(PR_THROTTLE_KEY)
      if (last) {
        const lastMs = parseInt(last, 10)
        if (
          !Number.isNaN(lastMs) &&
          Date.now() - lastMs < PR_THROTTLE_MS
        ) {
          return
        }
      }
    } catch {
      // localStorage unavailable — proceed without throttle.
    }

    hasRun.current = true
    const uid = user.uid
    let cancelled = false
    let completed = false
    const isCurrent = () => !cancelled &&
      (!isSessionCurrent || isSessionCurrent(sessionEpoch))

    async function run() {
      try {
        if (!isCurrent()) return
        const sourceWorkouts = workoutsHistoryComplete
          ? workouts
          : await fetchHealthWorkouts(uid, {})
        if (!isCurrent()) return
        const runs = sourceWorkouts.filter((w) => w.isRunLike)

        const prResults = computeAllPRs(runs)
        const badgeMap = buildPRBadgeMap(prResults)

        const batch = writeBatch(db)
        let updateCount = 0

        for (const run of runs) {
          const newBadges = badgeMap.get(run.workoutId) ?? []
          const oldBadges = run.prBadges ?? []

          // Compare as sorted JSON so order doesn't matter.
          const a = [...newBadges].sort().join('|')
          const b = [...oldBadges].sort().join('|')
          if (a === b) continue

          const ref = doc(db, 'users', uid, 'healthWorkouts', run.workoutId)
          batch.update(ref, { prBadges: newBadges })
          updateCount++
        }

        if (updateCount > 0) {
          await batch.commit()
          console.log(`[PRComputerRunner] updated ${updateCount} runs`)
        } else {
          console.log('[PRComputerRunner] no PR changes')
        }

        if (!isCurrent()) return
        completed = true
        try {
          window.localStorage.setItem(PR_THROTTLE_KEY, String(Date.now()))
        } catch {
          // localStorage write failed — don't crash the runner.
        }
      } catch (err) {
        console.error('[PRComputerRunner] error:', err)
      }
    }

    const cancelIdle = scheduleWhenIdle(() => {
      void run()
    })
    return () => {
      cancelled = true
      cancelIdle()
      // Cancelled idle/data work never completed this session's PR attempt.
      // Strict replay and a refreshed snapshot must be able to reschedule it.
      if (!completed) hasRun.current = false
    }
  }, [user, workouts, workoutsHistoryComplete, workoutsLoading, trainingActivated, sessionEpoch, isSessionCurrent])

  return null
}
