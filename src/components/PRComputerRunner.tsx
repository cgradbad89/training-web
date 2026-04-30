'use client'

import { useEffect, useRef } from 'react'
import { writeBatch, doc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/hooks/useAuth'
import { fetchHealthWorkouts } from '@/services/healthWorkouts'
import { computeAllPRs, buildPRBadgeMap } from '@/utils/prComputation'

const PR_THROTTLE_KEY = 'pr_last_computed'
const PR_THROTTLE_MS = 24 * 60 * 60 * 1000 // once per day

/**
 * Silent background runner that:
 *   1. Fetches all of the user's runs (no limit)
 *   2. Computes PR holders across distance bands + specific distances
 *   3. Diffs each run's prBadges against the new value and writes only the
 *      changes via a single batched commit
 *   4. Throttles itself to once per 24 hours via localStorage
 *
 * Mirrors the AutoMatchRunner mount pattern: render-null, useRef once-per-
 * session guard, fires from a useEffect on the auth user.
 */
export default function PRComputerRunner() {
  const { user } = useAuth()
  const hasRun = useRef(false)

  useEffect(() => {
    if (!user || hasRun.current) return

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

    async function run() {
      try {
        const workouts = await fetchHealthWorkouts(uid, {})
        const runs = workouts.filter((w) => w.isRunLike)

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
          // eslint-disable-next-line no-console
          console.log(`[PRComputerRunner] updated ${updateCount} runs`)
        } else {
          // eslint-disable-next-line no-console
          console.log('[PRComputerRunner] no PR changes')
        }

        try {
          window.localStorage.setItem(PR_THROTTLE_KEY, String(Date.now()))
        } catch {
          // localStorage write failed — don't crash the runner.
        }
      } catch (err) {
        console.error('[PRComputerRunner] error:', err)
      }
    }

    run()
  }, [user])

  return null
}
