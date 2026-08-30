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
import {
  MAX_COACH_JSON_DEPTH,
  MAX_COACH_QUESTION_CHARS,
  MAX_COACH_REQUEST_BYTES,
} from '../coachConfig'
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
  options: {
    token?: string
    rawBody?: string
    contentType?: string | null
    contentLength?: number
  } = {}
): NextRequest {
  const headers = new Headers()
  if (options.contentType !== null) {
    headers.set('Content-Type', options.contentType ?? 'application/json')
  }
  if (options.token !== undefined) {
    headers.set('Authorization', `Bearer ${options.token}`)
  }
  if (options.contentLength !== undefined) {
    headers.set('Content-Length', String(options.contentLength))
  }

  return new NextRequest('http://localhost/api/coach', {
    method: 'POST',
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  })
}

function streamingRequest(rawBody: string, token = 'valid'): NextRequest {
  const bytes = new TextEncoder().encode(rawBody)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const midpoint = Math.floor(bytes.length / 2)
      controller.enqueue(bytes.slice(0, midpoint))
      controller.enqueue(bytes.slice(midpoint))
      controller.close()
    },
  })
  return new NextRequest('http://localhost/api/coach', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
}

function contextAtPayloadDepth(payloadDepth: number): Record<string, unknown> {
  const context: Record<string, unknown> = { ...CONTEXT }
  let cursor = context
  // The top-level payload is depth 1 and context is depth 2.
  for (let depth = 3; depth <= payloadDepth; depth += 1) {
    const child: Record<string, unknown> = {}
    cursor.child = child
    cursor = child
  }
  return context
}

function validBodyAtBytes(totalBytes: number): string {
  const payload = { question: 'Q', context: { ...CONTEXT, padding: '' } }
  const empty = JSON.stringify(payload)
  const emptyBytes = new TextEncoder().encode(empty).byteLength
  if (totalBytes < emptyBytes) throw new Error('requested body is too small')
  payload.context.padding = 'x'.repeat(totalBytes - emptyBytes)
  const raw = JSON.stringify(payload)
  expect(new TextEncoder().encode(raw).byteLength).toBe(totalBytes)
  return raw
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
  h.verifyIdToken.mockResolvedValue({
    uid: 'u1',
    email: 'folstromjohn@gmail.com',
    email_verified: true,
  })
  h.getCoachResponseStream.mockResolvedValue({
    stream: textStream('Coach ', 'answer'),
  })
})

describe('POST /api/coach', () => {
  it('requires Firebase authentication', async () => {
    const response = await POST(request({ question: 'Q', context: CONTEXT }))

    expect(response.status).toBe(401)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('rejects an invalid Firebase token', async () => {
    h.verifyIdToken.mockRejectedValue(new Error('bad token'))

    const response = await POST(
      request({ question: 'Q', context: CONTEXT }, { token: 'invalid' })
    )

    expect(response.status).toBe(401)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid token' })
  })

  it('rejects a verified wrong-email Firebase identity with 403', async () => {
    h.verifyIdToken.mockResolvedValue({
      uid: 'u2',
      email: 'wrong@example.com',
      email_verified: true,
    })

    const response = await POST(
      request({ question: 'Q', context: CONTEXT }, { token: 'valid' })
    )

    expect(response.status).toBe(403)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('rejects an unverified owner-email Firebase identity with 403', async () => {
    h.verifyIdToken.mockResolvedValue({
      uid: 'u1',
      email: 'folstromjohn@gmail.com',
      email_verified: false,
    })

    const response = await POST(
      request({ question: 'Q', context: CONTEXT }, { token: 'valid' })
    )

    expect(response.status).toBe(403)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' })
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
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
    expectPrivateNoStore(malformed)
    expect(incomplete.status).toBe(400)
    expectPrivateNoStore(incomplete)
    await expect(incomplete.json()).resolves.toEqual({
      error: 'Invalid question or context',
    })
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'non-object top level', body: [] },
    { label: 'empty question', body: { question: '   ', context: CONTEXT } },
    { label: 'non-string question', body: { question: 42, context: CONTEXT } },
    { label: 'null context', body: { question: 'Q', context: null } },
    { label: 'array context', body: { question: 'Q', context: [] } },
    { label: 'primitive context', body: { question: 'Q', context: 'bad' } },
  ])('rejects $label before model invocation', async ({ body }) => {
    const response = await POST(request(body, { token: 'valid' }))

    expect(response.status).toBe(400)
    expectPrivateNoStore(response)
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('requires application/json while accepting charset parameters', async () => {
    const wrong = await POST(
      request({ question: 'Q', context: CONTEXT }, {
        token: 'valid',
        contentType: 'text/plain',
      })
    )
    expect(wrong.status).toBe(415)
    expectPrivateNoStore(wrong)
    expect(h.verifyIdToken).not.toHaveBeenCalled()
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()

    const valid = await POST(
      request({ question: 'Q', context: CONTEXT }, {
        token: 'valid',
        contentType: 'application/json; charset=utf-8',
      })
    )
    expect(valid.status).toBe(200)
  })

  it('rejects questions over 4,000 code units without truncation', async () => {
    const atLimit = await POST(
      request(
        { question: 'q'.repeat(MAX_COACH_QUESTION_CHARS), context: CONTEXT },
        { token: 'valid' }
      )
    )
    expect(atLimit.status).toBe(200)

    h.getCoachResponseStream.mockClear()
    const over = await POST(
      request(
        { question: 'q'.repeat(MAX_COACH_QUESTION_CHARS + 1), context: CONTEXT },
        { token: 'valid' }
      )
    )
    expect(over.status).toBe(400)
    expectPrivateNoStore(over)
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('accepts depth 12 and rejects depth 13', async () => {
    const accepted = await POST(
      request(
        { question: 'Q', context: contextAtPayloadDepth(MAX_COACH_JSON_DEPTH) },
        { token: 'valid' }
      )
    )
    expect(accepted.status).toBe(200)

    h.getCoachResponseStream.mockClear()
    const rejected = await POST(
      request(
        { question: 'Q', context: contextAtPayloadDepth(MAX_COACH_JSON_DEPTH + 1) },
        { token: 'valid' }
      )
    )
    expect(rejected.status).toBe(400)
    expectPrivateNoStore(rejected)
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('rejects an oversized declared Content-Length before auth or model work', async () => {
    const oversized = request(
      { question: 'Q', context: CONTEXT },
      { token: 'valid' }
    )
    // undici derives Content-Length from a constructor string body; overwrite
    // it afterward to model a client declaration that the route must reject.
    oversized.headers.set(
      'Content-Length',
      String(MAX_COACH_REQUEST_BYTES + 1)
    )
    const response = await POST(oversized)

    expect(response.status).toBe(413)
    expectPrivateNoStore(response)
    expect(h.verifyIdToken).not.toHaveBeenCalled()
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('enforces actual streamed bytes when Content-Length is missing', async () => {
    const response = await POST(
      streamingRequest(validBodyAtBytes(MAX_COACH_REQUEST_BYTES + 1))
    )

    expect(response.status).toBe(413)
    expectPrivateNoStore(response)
    expect(h.getCoachResponseStream).not.toHaveBeenCalled()
  })

  it('accepts a valid body exactly at the 1 MiB boundary', async () => {
    const response = await POST(
      streamingRequest(validBodyAtBytes(MAX_COACH_REQUEST_BYTES))
    )

    expect(response.status).toBe(200)
    expectPrivateNoStore(response)
    expect(h.getCoachResponseStream).toHaveBeenCalledTimes(1)
  })

  it('returns the existing raw text streaming contract', async () => {
    const response = await POST(
      request({ question: 'How am I doing?', context: CONTEXT }, { token: 'valid' })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expectPrivateNoStore(response)
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
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toEqual({
      error: 'AI Coach is temporarily unavailable. Please try again shortly.',
    })
  })
})
