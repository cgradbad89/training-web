import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  fetchHealthWorkouts: vi.fn(),
  fetchHealthWorkoutsInRange: vi.fn(),
  fetchAllOverrides: vi.fn(),
  fetchPlans: vi.fn(),
  fetchRaces: vi.fn(),
  fetchHealthMetrics: vi.fn(),
  fetchUserSettings: vi.fn(),
  hydrateFastFinishSplits: vi.fn(),
  getIdToken: vi.fn(),
  fetch: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => h.searchParams,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, loading: false }),
}))

vi.mock('@/services/healthWorkouts', () => ({
  fetchHealthWorkouts: h.fetchHealthWorkouts,
  fetchHealthWorkoutsInRange: h.fetchHealthWorkoutsInRange,
}))

vi.mock('@/services/workoutOverrides', () => ({
  fetchAllOverrides: h.fetchAllOverrides,
}))

vi.mock('@/services/plans', () => ({ fetchPlans: h.fetchPlans }))
vi.mock('@/services/races', () => ({ fetchRaces: h.fetchRaces }))
vi.mock('@/services/healthMetrics', () => ({
  fetchHealthMetrics: h.fetchHealthMetrics,
}))
vi.mock('@/services/userSettings', () => ({
  fetchUserSettings: h.fetchUserSettings,
}))
vi.mock('@/services/fastFinishSplits', () => ({
  hydrateFastFinishSplits: h.hydrateFastFinishSplits,
}))
vi.mock('@/utils/coachContext', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/coachContext')>()
  return { ...actual, buildCoachContext: vi.fn(actual.buildCoachContext) }
})

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: { getIdToken: h.getIdToken } }),
}))

import CoachPage from '../page'
import { AppDataProvider, useAppData, type AppDataContextValue } from '@/contexts/AppDataContext'
import { selectEffectiveWorkouts } from '@/utils/selectActiveWorkouts'
import { buildCoachContext } from '@/utils/coachContext'
import type { HealthWorkout } from '@/types/healthWorkout'
import type { WorkoutOverride } from '@/types/workoutOverride'
import {
  DEFAULT_MAX_HR,
  DEFAULT_RESTING_HR,
} from '@/utils/trainingLoad'

let container: HTMLDivElement
let root: Root
let appData: AppDataContextValue

function SharedCoach() {
  const value = useAppData()
  React.useEffect(() => { appData = value }, [value])
  return <CoachPage />
}

function coachTree() {
  return <AppDataProvider uid="u1"><SharedCoach /></AppDataProvider>
}

const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function recentWorkout() {
  return {
    workoutId: 'w1',
    name: 'Run',
    activityType: 'running',
    displayType: 'Run',
    startDate: new Date(),
    endDate: new Date(),
    durationSeconds: 1800,
    sourceName: 'Health',
    isRunLike: true,
    hasRoute: false,
    syncedAt: new Date(),
    calories: 300,
    avgHeartRate: 145,
    distanceMiles: 3,
    distanceMeters: 4828,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
  }
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(coachTree())
  })
  await flush()
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.searchParams = new URLSearchParams()
  h.fetchHealthWorkouts.mockResolvedValue([])
  h.fetchHealthWorkoutsInRange.mockResolvedValue([])
  h.fetchAllOverrides.mockResolvedValue({})
  h.fetchPlans.mockResolvedValue([])
  h.fetchRaces.mockResolvedValue([])
  h.fetchHealthMetrics.mockResolvedValue([])
  h.fetchUserSettings.mockResolvedValue(null)
  h.hydrateFastFinishSplits.mockImplementation(async (_uid, runs) => ({ runs }))
  h.getIdToken.mockResolvedValue('firebase-token')
  h.fetch.mockResolvedValue(
    new Response('Streamed coach response', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  )
  vi.stubGlobal('fetch', h.fetch)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CoachPage provider behavior', () => {
  it('eliminates all five page-owned training queries while retaining the 30-day Health read', async () => {
    await mount()
    for (const loader of [h.fetchHealthWorkouts, h.fetchAllOverrides, h.fetchPlans, h.fetchRaces, h.fetchUserSettings]) {
      // The mounted real AppDataProvider is the sole caller. Previously each
      // service ran once there and once again inside Coach.
      expect(loader).toHaveBeenCalledTimes(1)
    }
    expect(h.fetchHealthMetrics).toHaveBeenCalledOnce()
    expect(h.fetchHealthMetrics).toHaveBeenCalledWith('u1', 30)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('preserves the effective-workout projection in submitted context', async () => {
    const raw = [recentWorkout(), { ...recentWorkout(), workoutId: 'excluded' },
      { ...recentWorkout(), workoutId: 'non-run', isRunLike: false }]
    const overrides = {
      w1: { workoutId: 'w1', distanceMilesOverride: 5, durationSecondsOverride: 2000 },
      excluded: { workoutId: 'excluded', isExcluded: true },
    } as Record<string, WorkoutOverride>
    h.fetchHealthWorkouts.mockResolvedValue(raw)
    h.fetchAllOverrides.mockResolvedValue(overrides)
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    await mount()
    const body = JSON.parse(String((h.fetch.mock.calls[0][1] as RequestInit).body))
    const effective = selectEffectiveWorkouts(raw as HealthWorkout[], overrides).filter(w => w.isRunLike)
    const expected = buildCoachContext(effective, null, null)
    expect(body.context.stats).toEqual(expected.stats)
    expect(body.context.runs).toEqual(expected.runs)
    expect(raw[0].distanceMiles).toBe(3)
  })

  it('rebuilds after W/O/P/R/H shared updates without resubmitting a URL question or reloading Health', async () => {
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout()])
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    await mount()
    expect(h.fetch).toHaveBeenCalledTimes(1)

    async function changed(update: () => void | Promise<void>) {
      const builds = vi.mocked(buildCoachContext).mock.calls.length
      await act(async () => { await update() })
      await flush()
      expect(vi.mocked(buildCoachContext).mock.calls.length).toBeGreaterThan(builds)
      expect(h.fetch).toHaveBeenCalledTimes(1)
    }
    await changed(() => appData.patchOverrides(prev => ({
      ...prev, w1: { workoutId: 'w1', distanceMilesOverride: 5 } as WorkoutOverride,
    })))
    expect(container.textContent).toContain('5.0 mi')
    await changed(() => appData.patchPlan({
      id: 'plan', name: 'Updated plan', startDate: '2026-09-28',
      status: 'active', isActive: true, weeks: [{ weekNumber: 1, entries: [] }],
      createdAt: '', updatedAt: '',
    }))
    expect(container.textContent).toContain('Updated plan')
    await changed(() => appData.patchRaces(() => [{
      id: 'race', name: 'Updated race', raceDate: '2099-01-01',
      raceDistance: '5k', isActive: true, createdAt: '',
    }]))
    expect(container.textContent).toContain('Updated race')
    h.fetchUserSettings.mockResolvedValue({ maxHeartRate: 190, restingHeartRate: 70 })
    await changed(() => appData.refreshSettings())
    expect(vi.mocked(buildCoachContext).mock.lastCall?.slice(4, 6)).toEqual([190, 70])
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout(), { ...recentWorkout(), workoutId: 'w2' }])
    await changed(() => appData.refreshWorkouts())
    expect(container.textContent).toContain('2 runs')
    expect(h.fetchHealthMetrics).toHaveBeenCalledTimes(1)
  })

  it('rejects older asynchronous preparation after a shared override changes', async () => {
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout()])
    h.fetchRaces.mockResolvedValue([{
      id: 'race', name: 'Half', raceDate: '2099-01-01',
      raceDistance: 'halfMarathon', isActive: true, createdAt: '',
    }])
    const old = deferred<{ runs: HealthWorkout[] }>()
    h.hydrateFastFinishSplits.mockReturnValueOnce(old.promise)
    await mount()
    expect(container.textContent).not.toContain('Training Context Loaded')
    await act(async () => appData.patchOverrides(() => ({
      w1: { workoutId: 'w1', distanceMilesOverride: 5 } as WorkoutOverride,
    })))
    await flush()
    expect(container.textContent).toContain('5.0 mi')
    old.resolve({ runs: [recentWorkout() as HealthWorkout] })
    await flush()
    expect(container.textContent).toContain('5.0 mi')
    expect(container.textContent).not.toContain('3.0 mi')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('rejects preparation in flight when a canonical prerequisite fails', async () => {
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout()])
    h.fetchRaces.mockResolvedValue([{
      id: 'race', raceDate: '2099-01-01', raceDistance: 'halfMarathon', isActive: true,
    }])
    const old = deferred<{ runs: HealthWorkout[] }>()
    h.hydrateFastFinishSplits.mockReturnValueOnce(old.promise)
    h.searchParams = new URLSearchParams('q=Should+I+run')
    await mount()
    h.fetchUserSettings.mockRejectedValue(new Error('settings unavailable'))
    await act(async () => appData.refreshSettings())
    old.resolve({ runs: [recentWorkout() as HealthWorkout] })
    await flush()
    expect(container.textContent).toContain('Training context unavailable')
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('shows one Coach experience with no provider selector', async () => {
    await mount()

    expect(container.textContent).toContain('AI Coach')
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toContain('Gemini')
    expect(container.textContent).not.toContain('Claude')
  })

  it('sends only question and context in the request body', async () => {
    await mount()

    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set
      setValue?.call(textarea, 'How am I doing?')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const ask = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Ask'
    )
    expect(ask).toBeTruthy()
    await act(async () => {
      ask!.click()
    })
    await flush()

    expect(h.fetch).toHaveBeenCalledTimes(1)
    const init = h.fetch.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.question).toBe('How am I doing?')
    expect(body.context).toBeTruthy()
    expect(body).not.toHaveProperty('provider')
  })

  it('does not auto-submit while settings are pending', async () => {
    const settings = deferred<null>()
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    h.fetchUserSettings.mockReturnValue(settings.promise)

    await mount()

    expect(h.fetch).not.toHaveBeenCalled()
    settings.resolve(null)
  })

  it('auto-submits once with authoritative stored HR anchors', async () => {
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout()])
    h.fetchUserSettings.mockResolvedValue({
      maxHeartRate: 175,
      restingHeartRate: 65,
    })

    await mount()
    await flush()
    await flush()

    expect(h.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((h.fetch.mock.calls[0][1] as RequestInit).body))
    expect(body.context.stats).toMatchObject({
      maxHeartRate: 175,
      restingHeartRate: 65,
    })

    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(coachTree())
    })
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('auto-submits once with intentional defaults after a successful null settings result', async () => {
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    h.fetchUserSettings.mockResolvedValue(null)

    await mount()
    await flush()

    expect(h.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((h.fetch.mock.calls[0][1] as RequestInit).body))
    expect(body.context.stats).toMatchObject({
      maxHeartRate: DEFAULT_MAX_HR,
      restingHeartRate: DEFAULT_RESTING_HR,
    })
  })

  it('does not auto-submit after a settings error', async () => {
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    h.fetchUserSettings.mockRejectedValue(new Error('settings unavailable'))

    await mount()

    expect(h.fetch).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Training context unavailable')
  })

  it('does not auto-submit while another context prerequisite is pending', async () => {
    const plans = deferred<never[]>()
    h.searchParams = new URLSearchParams('q=How+am+I+doing')
    h.fetchPlans.mockReturnValue(plans.promise)

    await mount()

    expect(h.fetch).not.toHaveBeenCalled()
    plans.resolve([])
  })

  it('does not auto-submit without q', async () => {
    await mount()
    await flush()

    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('manual Send cannot bypass unresolved authoritative context', async () => {
    const settings = deferred<null>()
    h.fetchUserSettings.mockReturnValue(settings.promise)

    await mount()

    const ask = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === 'Ask'
    )
    expect(ask).toBeUndefined()
    ask?.click()
    expect(h.fetch).not.toHaveBeenCalled()
    settings.resolve(null)
  })

  it('does not describe inactive plans or races as active', async () => {
    h.searchParams = new URLSearchParams('q=What+is+active')
    h.fetchPlans.mockResolvedValue([
      {
        id: 'draft-plan',
        name: 'Draft Plan',
        planType: 'running',
        startDate: '2026-08-03',
        status: 'draft',
        isActive: false,
        weeks: [],
      },
    ])
    h.fetchRaces.mockResolvedValue([
      {
        id: 'inactive-race',
        name: 'Inactive Race',
        raceDate: '2026-09-20',
        raceDistance: 'halfMarathon',
        isActive: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    await mount()
    await flush()

    const body = JSON.parse(String((h.fetch.mock.calls[0][1] as RequestInit).body))
    expect(body.context.activePlan).toBeNull()
    expect(body.context.activeRace).toBeNull()
    expect(h.hydrateFastFinishSplits).not.toHaveBeenCalled()
  })

  it('hydrates canonical best-effort inputs for an active half-marathon race', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 19, 12))
    h.fetchHealthWorkouts.mockResolvedValue([recentWorkout()])
    h.fetchRaces.mockResolvedValue([
      {
        id: 'active-race',
        name: 'Active Race',
        raceDate: '2026-09-20',
        raceDistance: 'halfMarathon',
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
    h.fetchUserSettings.mockResolvedValue({
      maxHeartRate: 175,
      restingHeartRate: 65,
    })

    await mount()
    await flush()

    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith('u1', { limitCount: 1000 })
    expect(h.hydrateFastFinishSplits).toHaveBeenCalledWith(
      'u1',
      [expect.objectContaining({ workoutId: 'w1' })],
      expect.objectContaining({ maxHr: 175, restingHr: 65, asOf: expect.any(Date) })
    )
  })
})
