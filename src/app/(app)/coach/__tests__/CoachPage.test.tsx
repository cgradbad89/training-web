import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  fetchHealthWorkouts: vi.fn(),
  fetchAllOverrides: vi.fn(),
  fetchPlans: vi.fn(),
  fetchRaces: vi.fn(),
  fetchHealthMetrics: vi.fn(),
  fetchUserSettings: vi.fn(),
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

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: { getIdToken: h.getIdToken } }),
}))

import CoachPage from '../page'
import {
  DEFAULT_MAX_HR,
  DEFAULT_RESTING_HR,
} from '@/utils/trainingLoad'

let container: HTMLDivElement
let root: Root

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
    root.render(<CoachPage />)
  })
  await flush()
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  h.searchParams = new URLSearchParams()
  h.fetchHealthWorkouts.mockResolvedValue([])
  h.fetchAllOverrides.mockResolvedValue({})
  h.fetchPlans.mockResolvedValue([])
  h.fetchRaces.mockResolvedValue([])
  h.fetchHealthMetrics.mockResolvedValue([])
  h.fetchUserSettings.mockResolvedValue(null)
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
})

describe('CoachPage provider behavior', () => {
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
    expect(container.textContent).toContain('settings unavailable')
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
})
