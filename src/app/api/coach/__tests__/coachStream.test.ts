import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockStreamText } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
}))

vi.mock('ai', () => ({
  streamText: mockStreamText,
}))

import { COACH_GENERATION_SETTINGS, COACH_MODEL } from '../coachConfig'
import {
  CoachServiceError,
  getCoachResponseStream,
  toCoachServiceError,
} from '../coachStream'

type TestPart =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'text-end'; id: string }
  | { type: 'finish' }
  | { type: 'error'; error: unknown }

function parts(...values: TestPart[]) {
  return (async function* () {
    for (const value of values) yield value
  })()
}

function textParts(...texts: string[]) {
  return parts(
    { type: 'text-start', id: 'answer' },
    ...texts.map(text => ({ type: 'text-delta' as const, id: 'answer', text })),
    { type: 'text-end', id: 'answer' },
    { type: 'finish' }
  )
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  let output = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return output
    output += value
  }
}

const ASK = {
  systemPrompt: 'You are a coach.',
  question: 'How am I tracking?',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getCoachResponseStream', () => {
  it('streams raw text chunks through the configured Gateway model', async () => {
    mockStreamText.mockReturnValue({
      stream: textParts('You are ', 'on track.'),
    })

    const result = await getCoachResponseStream(ASK)

    expect(await readAll(result.stream)).toBe('You are on track.')
    expect(mockStreamText).toHaveBeenCalledTimes(1)
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: COACH_MODEL,
        system: ASK.systemPrompt,
        prompt: ASK.question,
        maxOutputTokens: COACH_GENERATION_SETTINGS.maxOutputTokens,
        maxRetries: COACH_GENERATION_SETTINGS.maxRetries,
      })
    )
  })

  it('returns a controlled service error for Gateway authentication failure before streaming', async () => {
    const gatewayError = Object.assign(new Error('secret provider response'), {
      name: 'GatewayAuthenticationError',
      statusCode: 401,
    })
    mockStreamText.mockReturnValue({
      stream: parts({ type: 'error', error: gatewayError }),
    })

    await expect(getCoachResponseStream(ASK)).rejects.toMatchObject({
      status: 503,
      clientMessage: 'AI Coach is temporarily unavailable. Please try again later.',
    })
    expect(mockStreamText).toHaveBeenCalledTimes(1)
  })

  it('maps model unavailability to a controlled 503 error without a fallback call', async () => {
    const unavailable = Object.assign(new Error('model pool exhausted'), {
      name: 'GatewayFailedDependencyError',
      statusCode: 424,
    })
    mockStreamText.mockReturnValue({
      stream: parts({ type: 'error', error: unavailable }),
    })

    await expect(getCoachResponseStream(ASK)).rejects.toMatchObject({
      status: 503,
      clientMessage: 'AI Coach is temporarily unavailable. Please try again shortly.',
    })
    expect(mockStreamText).toHaveBeenCalledTimes(1)
  })

  it('surfaces a controlled error when a stream fails after partial text', async () => {
    const providerError = Object.assign(new Error('raw upstream failure'), {
      statusCode: 500,
    })
    mockStreamText.mockReturnValue({
      stream: parts(
        { type: 'text-delta', id: 'answer', text: 'Partial answer' },
        { type: 'error', error: providerError }
      ),
    })

    const result = await getCoachResponseStream(ASK)
    const reader = result.stream.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: 'Partial answer',
    })
    await expect(reader.read()).rejects.toMatchObject({
      name: 'CoachServiceError',
      clientMessage: 'AI Coach could not complete the request. Please try again.',
    })
  })
})

describe('toCoachServiceError', () => {
  it('maps Gateway rate limits to a controlled 429 response', () => {
    const error = Object.assign(new Error('quota detail'), {
      name: 'GatewayRateLimitError',
      statusCode: 429,
    })

    expect(toCoachServiceError(error)).toMatchObject({
      status: 429,
      clientMessage: 'AI Coach is receiving too many requests. Please try again shortly.',
    })
  })

  it('preserves an existing controlled Coach error', () => {
    const error = new CoachServiceError(503, 'Controlled')
    expect(toCoachServiceError(error)).toBe(error)
  })
})
