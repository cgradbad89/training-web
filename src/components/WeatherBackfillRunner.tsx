'use client'

import { useEffect, useRef } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useAppData } from '@/contexts/AppDataContext'
import { fetchWeatherForRunDetailed } from '@/lib/weather'
import { saveWeatherForWorkoutIfAbsent } from '@/services/healthWorkouts'
import { runWeatherBackfillPass } from '@/services/weatherBackfill'
import { getRouteStartPoint } from '@/utils/routeCache'
import {
  EMPTY_WEATHER_LEDGER,
  WEATHER_PASS_LIMIT,
  WEATHER_SESSION_LIMIT,
  parseWeatherLedger,
  type WeatherLedger,
} from '@/utils/weatherBackfill'

const LEDGER_KEY_PREFIX = 'tw:weather-ledger:v1:'
/** Delay before a pass so it never competes with first paint or other runners. */
const START_DELAY_MS = 4000

function readLedger(uid: string): WeatherLedger {
  try {
    return parseWeatherLedger(window.localStorage.getItem(LEDGER_KEY_PREFIX + uid))
  } catch {
    return EMPTY_WEATHER_LEDGER
  }
}

function writeLedger(uid: string, ledger: WeatherLedger): void {
  try {
    window.localStorage.setItem(LEDGER_KEY_PREFIX + uid, JSON.stringify(ledger))
  } catch {
    // Storage unavailable: backoff then lasts for this tab session only.
  }
}

/**
 * Silent background runner: acquires historical weather for recent outdoor GPS
 * runs that have none, WITHOUT the owner opening Run Detail.
 *
 * What this is — and is not:
 *  - It runs only while an authenticated owner has the web app open (it is
 *    mounted in the (app) layout and driven by the shared AppData workouts). It
 *    is NOT unattended server-side processing: the existing Vercel cron has
 *    read-only Firestore access by design, and granting a server write path
 *    would be a new infrastructure/IAM change.
 *  - Each pass is bounded (WEATHER_PASS_LIMIT workouts, newest first,
 *    WEATHER_SESSION_LIMIT per session), spaced, and idempotent. Existing weather
 *    is never replaced (transactional save-if-absent). Failures back off via a
 *    per-browser ledger; HTTP 429 pauses all provider calls.
 *  - It reads one route document (the first GPS point) per attempted workout —
 *    never the track.
 *
 * See docs/weather-reliability-phase3j.md.
 */
export default function WeatherBackfillRunner() {
  const { user, sessionEpoch, isSessionCurrent } = useAuth()
  const { workouts, workoutsLoading, trainingActivated, overrides } = useAppData()
  const settled = useRef(new Set<string>())
  const attempted = useRef(0)
  const running = useRef(false)
  const latest = useRef({ workouts, overrides })
  latest.current = { workouts, overrides }

  const uid = user?.uid ?? null
  const ready = !!uid && trainingActivated !== false && !workoutsLoading

  // One controller per authenticated session: workout-pool refreshes must not
  // cancel a pass that is already running, but sign-out/unmount must.
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    return () => controller.abort()
  }, [uid, sessionEpoch])

  useEffect(() => {
    if (!ready || !uid) return
    if (attempted.current >= WEATHER_SESSION_LIMIT) return
    const controller = controllerRef.current
    if (!controller) return
    const isCurrent = () =>
      !controller.signal.aborted &&
      (!isSessionCurrent || isSessionCurrent(sessionEpoch))

    const timer = window.setTimeout(async () => {
      if (!isCurrent() || running.current) return
      running.current = true
      try {
        const remaining = WEATHER_SESSION_LIMIT - attempted.current
        const { ledger, summary } = await runWeatherBackfillPass(
          {
            workouts: latest.current.workouts,
            overrides: latest.current.overrides,
            ledger: readLedger(uid),
            settled: settled.current,
            limit: Math.min(WEATHER_PASS_LIMIT, remaining),
            isCurrent,
            signal: controller.signal,
          },
          {
            getStartPoint: (id) => getRouteStartPoint(uid, id),
            fetchWeather: (lat, lng, start, signal) =>
              fetchWeatherForRunDetailed(lat, lng, start, { signal }),
            saveIfAbsent: (id, weather) =>
              saveWeatherForWorkoutIfAbsent(uid, id, weather),
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
          }
        )
        attempted.current += summary.selected
        writeLedger(uid, ledger)
        if (summary.selected > 0 || summary.rateLimited) {
          // Counts only: no coordinates, no workout identifiers.
          console.info('[WeatherBackfill] pass', summary)
        }
      } catch (error) {
        console.error('[WeatherBackfill] pass failed', error)
      } finally {
        running.current = false
      }
    }, START_DELAY_MS)

    return () => window.clearTimeout(timer)
    // Re-evaluate when the workout pool changes (new sync, refresh).
  }, [ready, uid, workouts, sessionEpoch, isSessionCurrent])

  return null
}
