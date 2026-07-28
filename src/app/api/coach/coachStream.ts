import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

// Provider models. Both remain hardcoded (see PRD §2 — the Gemini default is
// deliberately hardcoded in both the client component and the API route).
export const GEMINI_MODEL = 'gemini-3.5-flash'
export const ANTHROPIC_MODEL = 'claude-sonnet-4-6'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
})

// ── Retry configuration ───────────────────────────────────────────────────────

export interface GeminiRetryConfig {
  /** Total Gemini attempts including the first — not just the retries. */
  maxAttempts: number
  baseDelayMs: number
}

export const GEMINI_RETRY_CONFIG: GeminiRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 400,
}

export interface CoachStreamResult {
  stream: ReadableStream
  provider: 'gemini' | 'anthropic'
  usedFallback: boolean
}

// ── Error classification ──────────────────────────────────────────────────────

function numericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * True only for Gemini overload/unavailability, which is worth retrying.
 *
 * `@google/genai@2` surfaces overload two ways depending on transport: the
 * legacy `ApiError` carries a numeric `status`, while the next-gen `APIError`
 * carries both `status` and `statusCode` (a 503 becomes `InternalServerError`).
 * The serialized body also spells the condition out in the message, e.g.
 * `503 ... {"code":503,"message":"The model is overloaded...","status":"UNAVAILABLE"}`.
 *
 * Auth failures, 4xx, and malformed requests return false — retrying those
 * just burns the budget before the fallback that would actually help.
 */
export function isRetryableGeminiError(error: unknown): boolean {
  if (error === null || error === undefined) return false

  if (typeof error === 'object') {
    const candidate = error as {
      status?: unknown
      statusCode?: unknown
      code?: unknown
    }
    for (const field of [candidate.status, candidate.statusCode, candidate.code]) {
      if (numericStatus(field) === 503) return true
    }
  }

  const message = errorMessage(error).toLowerCase()
  return message.includes('unavailable') || message.includes('overloaded')
}

/** Exponential backoff with ±20% jitter: ~400ms after attempt 1, ~800ms after attempt 2. */
export function backoffDelayMs(
  attemptNumber: number,
  config: GeminiRetryConfig = GEMINI_RETRY_CONFIG
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attemptNumber - 1)
  const jitter = 1 + (Math.random() * 0.4 - 0.2)
  return Math.round(exponential * jitter)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Provider calls ────────────────────────────────────────────────────────────

export async function streamAnthropicResponse(
  systemPrompt: string,
  question: string
): Promise<ReadableStream> {
  const stream = await anthropic.messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  })

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(new TextEncoder().encode(chunk.delta.text))
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/**
 * Opens a Gemini stream and pulls the FIRST chunk before returning.
 *
 * That pull is the commit point: while it is still in flight nothing has
 * reached the client, so the caller is free to retry or fall back. Once it
 * resolves we are committed to Gemini — the buffered first chunk is replayed
 * into the returned stream and the rest is pumped as before.
 */
async function openGeminiStream(
  systemPrompt: string,
  question: string
): Promise<ReadableStream> {
  const response = await gemini.models.generateContentStream({
    model: GEMINI_MODEL,
    contents: question,
    config: {
      systemInstruction: systemPrompt,
    },
  })

  const iterator = response[Symbol.asyncIterator]()
  const firstChunk = await iterator.next()

  return new ReadableStream({
    async start(controller) {
      try {
        let result = firstChunk
        while (!result.done) {
          const text = result.value?.text
          if (text) {
            controller.enqueue(new TextEncoder().encode(text))
          }
          result = await iterator.next()
        }
        controller.close()
      } catch (error) {
        // Mid-stream failure: bytes may already have reached the client, so we
        // surface the break rather than restarting on another provider.
        controller.error(error)
      }
    },
  })
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function getCoachResponseStream(params: {
  requestedProvider: 'gemini' | 'anthropic'
  systemPrompt: string
  question: string
}): Promise<CoachStreamResult> {
  const { requestedProvider, systemPrompt, question } = params

  // An explicit Anthropic request is the user's choice — no retry, no fallback.
  // A failure here propagates to the route's outer catch exactly as before.
  if (requestedProvider === 'anthropic') {
    const stream = await streamAnthropicResponse(systemPrompt, question)
    console.log('[Coach] served by anthropic (explicitly requested) — fallback=false')
    return { stream, provider: 'anthropic', usedFallback: false }
  }

  const { maxAttempts } = GEMINI_RETRY_CONFIG
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const stream = await openGeminiStream(systemPrompt, question)
      console.log(
        `[Coach] served by gemini on attempt ${attempt}/${maxAttempts} — fallback=false`
      )
      return { stream, provider: 'gemini', usedFallback: false }
    } catch (error) {
      lastError = error
      const retryable = isRetryableGeminiError(error)
      console.warn(
        `[Coach] gemini attempt ${attempt}/${maxAttempts} failed ` +
          `(retryable=${retryable}): ${errorMessage(error)}`
      )
      if (!retryable) break
      if (attempt === maxAttempts) break
      await sleep(backoffDelayMs(attempt))
    }
  }

  console.warn(
    `[Coach] gemini unavailable after ${maxAttempts} attempt(s) — ` +
      `falling back to anthropic. Last error: ${errorMessage(lastError)}`
  )
  const stream = await streamAnthropicResponse(systemPrompt, question)
  console.log('[Coach] served by anthropic — fallback=true')
  return { stream, provider: 'anthropic', usedFallback: true }
}
