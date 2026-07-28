import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Both SDKs are mocked — these tests never touch live Gemini/Anthropic APIs.
const { mockGenerateContentStream, mockAnthropicStream } = vi.hoisted(() => ({
  mockGenerateContentStream: vi.fn(),
  mockAnthropicStream: vi.fn(),
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream: mockGenerateContentStream }
  },
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: mockAnthropicStream }
  },
}))

import {
  isRetryableGeminiError,
  getCoachResponseStream,
  streamAnthropicResponse,
  GEMINI_RETRY_CONFIG,
} from '../coachStream'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mimics `@google/genai`'s streamed chunks (`{ text }`). */
function geminiChunks(...texts: string[]) {
  return (async function* () {
    for (const text of texts) yield { text }
  })()
}

/** A Gemini stream that yields, then breaks mid-flight. */
function geminiChunksThenThrow(texts: string[], error: unknown) {
  return (async function* () {
    for (const text of texts) yield { text }
    throw error
  })()
}

/** Mimics Anthropic's streamed message events. */
function anthropicChunks(...texts: string[]) {
  return (async function* () {
    yield { type: 'message_start' }
    for (const text of texts) {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
    }
  })()
}

async function readAll(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value as Uint8Array, { stream: true })
  }
  return out
}

/** Drives the retry backoff timers to completion, then resolves the call. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000)
  return promise
}

/** A 503 as `@google/genai` shapes it. */
function overloadError() {
  return Object.assign(
    new Error(
      'got status: 503 Service Unavailable. ' +
        '{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}'
    ),
    { name: 'ApiError', status: 503 }
  )
}

const ASK = { systemPrompt: 'You are a coach.', question: 'How am I tracking?' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── isRetryableGeminiError ────────────────────────────────────────────────────

describe('isRetryableGeminiError', () => {
  it('is true for a 503 ApiError with a numeric status', () => {
    expect(isRetryableGeminiError(overloadError())).toBe(true)
  })

  it('is true for a next-gen APIError carrying statusCode 503', () => {
    const err = Object.assign(new Error('Service Unavailable'), {
      status: 503,
      statusCode: 503,
    })
    expect(isRetryableGeminiError(err)).toBe(true)
  })

  it('is true when the message mentions UNAVAILABLE without a status field', () => {
    expect(isRetryableGeminiError(new Error('UNAVAILABLE: backend busy'))).toBe(true)
  })

  it('is true when the message mentions overload in mixed case', () => {
    expect(isRetryableGeminiError(new Error('The model is Overloaded'))).toBe(true)
  })

  it('is false for an auth-style 401 error', () => {
    const err = Object.assign(new Error('API key not valid. Please pass a valid API key.'), {
      status: 401,
    })
    expect(isRetryableGeminiError(err)).toBe(false)
  })

  it('is false for a 400 malformed-request error', () => {
    const err = Object.assign(new Error('Invalid JSON payload received.'), { status: 400 })
    expect(isRetryableGeminiError(err)).toBe(false)
  })

  it('is false for a generic error and for null/undefined', () => {
    expect(isRetryableGeminiError(new Error('boom'))).toBe(false)
    expect(isRetryableGeminiError(null)).toBe(false)
    expect(isRetryableGeminiError(undefined)).toBe(false)
  })
})

// ── getCoachResponseStream — Gemini path ──────────────────────────────────────

describe('getCoachResponseStream (gemini)', () => {
  it('succeeds on the first attempt without falling back', async () => {
    mockGenerateContentStream.mockResolvedValueOnce(geminiChunks('You are ', 'on track.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(false)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1)
    expect(mockAnthropicStream).not.toHaveBeenCalled()
    expect(await readAll(result.stream)).toBe('You are on track.')
  })

  it('retries a retryable failure and succeeds on the third attempt', async () => {
    mockGenerateContentStream
      .mockRejectedValueOnce(overloadError())
      .mockRejectedValueOnce(overloadError())
      .mockResolvedValueOnce(geminiChunks('Recovered.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(false)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(3)
    expect(mockAnthropicStream).not.toHaveBeenCalled()
    expect(await readAll(result.stream)).toBe('Recovered.')
  })

  it('falls back to Anthropic after exhausting all retryable attempts', async () => {
    mockGenerateContentStream.mockRejectedValue(overloadError())
    mockAnthropicStream.mockImplementation(() => anthropicChunks('Fallback advice.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('anthropic')
    expect(result.usedFallback).toBe(true)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(GEMINI_RETRY_CONFIG.maxAttempts)
    expect(mockAnthropicStream).toHaveBeenCalledTimes(1)
    expect(await readAll(result.stream)).toBe('Fallback advice.')
  })

  it('falls back immediately on a non-retryable error without burning the retry budget', async () => {
    const authError = Object.assign(new Error('API key not valid.'), { status: 401 })
    mockGenerateContentStream.mockRejectedValue(authError)
    mockAnthropicStream.mockImplementation(() => anthropicChunks('Fallback advice.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('anthropic')
    expect(result.usedFallback).toBe(true)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(1)
    expect(mockAnthropicStream).toHaveBeenCalledTimes(1)
  })

  it('retries when the failure happens pulling the first chunk (no bytes sent yet)', async () => {
    mockGenerateContentStream
      .mockResolvedValueOnce(geminiChunksThenThrow([], overloadError()))
      .mockResolvedValueOnce(geminiChunks('Second time lucky.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(false)
    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2)
    expect(await readAll(result.stream)).toBe('Second time lucky.')
  })

  it('commits to Gemini once the first chunk arrives and does not fall back mid-stream', async () => {
    mockGenerateContentStream.mockResolvedValueOnce(
      geminiChunksThenThrow(['Partial answer'], overloadError())
    )
    mockAnthropicStream.mockImplementation(() => anthropicChunks('Fallback advice.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'gemini', ...ASK })
    )

    expect(result.provider).toBe('gemini')
    expect(result.usedFallback).toBe(false)
    expect(mockAnthropicStream).not.toHaveBeenCalled()
    // The break surfaces to the client as a failed stream — not a restart.
    await expect(readAll(result.stream)).rejects.toThrow()
  })
})

// ── getCoachResponseStream — explicit Anthropic path ──────────────────────────

describe('getCoachResponseStream (anthropic)', () => {
  it('calls Anthropic directly without touching Gemini', async () => {
    mockAnthropicStream.mockImplementation(() => anthropicChunks('Claude says hi.'))

    const result = await settle(
      getCoachResponseStream({ requestedProvider: 'anthropic', ...ASK })
    )

    expect(result.provider).toBe('anthropic')
    expect(result.usedFallback).toBe(false)
    expect(mockAnthropicStream).toHaveBeenCalledTimes(1)
    expect(mockGenerateContentStream).not.toHaveBeenCalled()
    expect(await readAll(result.stream)).toBe('Claude says hi.')
  })

  it('propagates an Anthropic failure without retrying or falling back to Gemini', async () => {
    mockAnthropicStream.mockImplementation(() => {
      throw new Error('anthropic exploded')
    })

    // No `settle` here: the explicit-Anthropic path schedules no backoff timers.
    await expect(
      getCoachResponseStream({ requestedProvider: 'anthropic', ...ASK })
    ).rejects.toThrow('anthropic exploded')

    expect(mockAnthropicStream).toHaveBeenCalledTimes(1)
    expect(mockGenerateContentStream).not.toHaveBeenCalled()
  })
})

// ── streamAnthropicResponse ───────────────────────────────────────────────────

describe('streamAnthropicResponse', () => {
  it('streams only text_delta content, ignoring other event types', async () => {
    mockAnthropicStream.mockImplementation(() =>
      (async function* () {
        yield { type: 'message_start' }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
        yield { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }
        yield { type: 'message_stop' }
      })()
    )

    const stream = await streamAnthropicResponse('sys', 'q')
    expect(await readAll(stream)).toBe('Hello world')
  })

  it('passes the system prompt, question, and model through to the SDK', async () => {
    mockAnthropicStream.mockImplementation(() => anthropicChunks('ok'))

    await streamAnthropicResponse('SYSTEM', 'QUESTION')

    expect(mockAnthropicStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        system: 'SYSTEM',
        messages: [{ role: 'user', content: 'QUESTION' }],
      })
    )
  })
})
