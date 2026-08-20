import { streamText } from 'ai'
import { COACH_GENERATION_SETTINGS, COACH_MODEL } from './coachConfig'

export interface CoachStreamResult {
  stream: ReadableStream<string>
}

export class CoachServiceError extends Error {
  constructor(
    readonly status: number,
    readonly clientMessage: string
  ) {
    super(clientMessage)
    this.name = 'CoachServiceError'
  }
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  for (const value of [
    (error as { statusCode?: unknown }).statusCode,
    (error as { status?: unknown }).status,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }

  return null
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UnknownError'
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : 'UnknownError'
}

/**
 * Converts Gateway/provider failures into stable application errors without
 * leaking provider response bodies, credentials, request IDs, or stack traces.
 */
export function toCoachServiceError(error: unknown): CoachServiceError {
  if (error instanceof CoachServiceError) return error

  const status = errorStatus(error)
  const name = errorName(error)

  if (status === 429 || name === 'GatewayRateLimitError') {
    return new CoachServiceError(
      429,
      'AI Coach is receiving too many requests. Please try again shortly.'
    )
  }

  if (
    status === 401 ||
    status === 403 ||
    name === 'GatewayAuthenticationError' ||
    name === 'GatewayForbiddenError' ||
    name === 'GatewayError'
  ) {
    return new CoachServiceError(
      503,
      'AI Coach is temporarily unavailable. Please try again later.'
    )
  }

  if (
    status === 404 ||
    status === 408 ||
    status === 424 ||
    status === 503 ||
    name === 'GatewayModelNotFoundError' ||
    name === 'GatewayFailedDependencyError' ||
    name === 'GatewayTimeoutError'
  ) {
    return new CoachServiceError(
      503,
      'AI Coach is temporarily unavailable. Please try again shortly.'
    )
  }

  return new CoachServiceError(
    502,
    'AI Coach could not complete the request. Please try again.'
  )
}

function logGenerationError(error: unknown): void {
  console.error('[Coach] AI Gateway generation failed', {
    model: COACH_MODEL,
    errorName: errorName(error),
    status: errorStatus(error),
  })
}

/**
 * Pulls text from the AI SDK full stream so error parts remain observable.
 * The SDK's text-only stream intentionally suppresses error parts.
 */
async function nextTextDelta(
  iterator: AsyncIterator<ReturnType<typeof streamText>['stream'] extends AsyncIterable<infer T> ? T : never>
): Promise<IteratorResult<string>> {
  for (;;) {
    const result = await iterator.next()
    if (result.done) return { done: true, value: undefined }

    if (result.value.type === 'error') throw result.value.error
    if (result.value.type === 'text-delta') {
      return { done: false, value: result.value.text }
    }
  }
}

export async function getCoachResponseStream(params: {
  systemPrompt: string
  question: string
  abortSignal?: AbortSignal
}): Promise<CoachStreamResult> {
  const { systemPrompt, question, abortSignal } = params

  try {
    const result = streamText({
      model: COACH_MODEL,
      system: systemPrompt,
      prompt: question,
      abortSignal,
      ...COACH_GENERATION_SETTINGS,
      onError: ({ error }) => logGenerationError(error),
    })

    const iterator = result.stream[Symbol.asyncIterator]()
    // Treat the first text delta as the HTTP commit point. Authentication,
    // entitlement, rate-limit, and unavailable-model failures that happen
    // before it become controlled JSON responses from the route.
    const first = await nextTextDelta(iterator)

    const stream = new ReadableStream<string>({
      async start(controller) {
        try {
          if (!first.done) controller.enqueue(first.value)

          for (;;) {
            const next = await nextTextDelta(iterator)
            if (next.done) break
            controller.enqueue(next.value)
          }

          controller.close()
        } catch (error) {
          // HTTP headers may already be committed. Error the stream with only a
          // controlled application error; never write a provider error as text.
          controller.error(toCoachServiceError(error))
        }
      },
      async cancel() {
        await iterator.return?.()
      },
    })

    console.log(`[Coach] streaming via AI Gateway model=${COACH_MODEL}`)
    return { stream }
  } catch (error) {
    logGenerationError(error)
    throw toCoachServiceError(error)
  }
}
