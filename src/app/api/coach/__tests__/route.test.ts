import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getCoachResponseStream: vi.fn(),
}))

vi.mock('@/lib/firebaseAdmin', () => ({
  getAuth: () => ({ verifyIdToken: h.verifyIdToken }),
}))

vi.mock('../coachStream', async importOriginal => {
  const original = await importOriginal<typeof import('../coachStream')>()
  return {
    ...original,
    getCoachResponseStream: h.getCoachResponseStream,
  }
})

import { CoachServiceError } from '../coachStream'
import { POST } from '../route'

const CONTEXT = {
  runs: [],
  activePlan: null,
  activeRace: null,
  stats: {
    totalRuns: 0,
    totalMiles: 0,
    avgWeeklyMiles: 0,
    avgPace: null,
    avgHR: null,
    longestRun: 0,
    longRunCount: 0,
    mediumRunCount: 0,
    shortRunCount: 0,
  },
  healthSummary: null,
}

function request(
  body: unknown,
  options: { token?: string; rawBody?: string } = {}
): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (options.token !== undefined) {
    headers.set('Authorization', `Bearer ${options.token}`)
  }

  return new NextRequest('http://localhost/api/coach', {
    method: 'POST',
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  })
}

function textStream(...chunks: string[]): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.verifyIdToken.mockResolvedValue({ uid: 'u1' })
  h.getCoachResponseStream.mockResolvedValue({
    stream: textStream('Coach ', 'answer'),
  })
})

describe('POST /api/coach', () => {
  it('requires Firebase authentication', async () => {
    const response = await POST(request({ question: 'Q', context: CONTEXT }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('rejects an invalid Firebase token', async () => {
    h.verifyIdToken.mockRejectedValue(new Error('bad token'))

    const response = await POST(
      request({ question: 'Q', context: CONTEXT }, { token: 'invalid' })
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid token' })
  })

  it('rejects malformed and incomplete request bodies with JSON errors', async () => {
    const malformed = await POST(
      request(null, { token: 'valid', rawBody: '{not-json' })
    )
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toEqual({
      error: 'Invalid request body',
    })

    const incomplete = await POST(
      request({ question: '', context: CONTEXT }, { token: 'valid' })
    )
    expect(incomplete.status).toBe(400)
    await expect(incomplete.json()).resolves.toEqual({
      error: 'Missing question or context',
    })
  })

  it('returns the existing raw text streaming contract', async () => {
    const response = await POST(
      request({ question: 'How am I doing?', context: CONTEXT }, { token: 'valid' })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    await expect(response.text()).resolves.toBe('Coach answer')
  })

  it('ignores legacy provider input and always uses the centralized Coach model path', async () => {
    await POST(
      request(
        { question: 'Q', context: CONTEXT, provider: 'gemini' },
        { token: 'valid' }
      )
    )

    expect(h.getCoachResponseStream).toHaveBeenCalledTimes(1)
    expect(h.getCoachResponseStream).toHaveBeenCalledWith(
      expect.not.objectContaining({ requestedProvider: expect.anything() })
    )
  })

  it('maps Gateway/model failure to a controlled JSON response', async () => {
    h.getCoachResponseStream.mockRejectedValue(
      new CoachServiceError(
        503,
        'AI Coach is temporarily unavailable. Please try again shortly.'
      )
    )

    const response = await POST(
      request({ question: 'Q', context: CONTEXT }, { token: 'valid' })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'AI Coach is temporarily unavailable. Please try again shortly.',
    })
  })
})
