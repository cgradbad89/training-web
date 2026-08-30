import { NextRequest } from 'next/server'
import { createTextStreamResponse } from 'ai'
import { getCoachResponseStream } from './coachStream'
import {
  MAX_COACH_JSON_DEPTH,
  MAX_COACH_QUESTION_CHARS,
  MAX_COACH_REQUEST_BYTES,
} from './coachConfig'
import { isAuthorizedTrainingUser } from '@/lib/trainingAuthorization'

const PRIVATE_NO_STORE = 'private, no-store'

class CoachRequestTooLargeError extends Error {}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('Content-Type')
  if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return jsonError('Content-Type must be application/json', 415)
  }

  const contentLength = req.headers.get('Content-Length')
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_COACH_REQUEST_BYTES) {
      return jsonError('Request body is too large', 413)
    }
  }

  // Verify Firebase Auth token
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.split('Bearer ')[1]

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: jsonHeaders() }
    )
  }

  try {
    const { getAuth } = await import('@/lib/firebaseAdmin')
    const decoded = await getAuth().verifyIdToken(token)
    if (!isAuthorizedTrainingUser(decoded.email, decoded.email_verified)) {
      return new Response(
        JSON.stringify({ error: 'Forbidden' }),
        { status: 403, headers: jsonHeaders() }
      )
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid token' }),
      { status: 401, headers: jsonHeaders() }
    )
  }

  try {
    let body: unknown
    try {
      const rawBody = await readBoundedBody(req)
      body = JSON.parse(rawBody) as unknown
    } catch (error) {
      if (error instanceof CoachRequestTooLargeError) {
        return jsonError('Request body is too large', 413)
      }
      return jsonError('Invalid request body', 400)
    }

    if (!isPlainJsonObject(body) || exceedsJsonDepth(body, MAX_COACH_JSON_DEPTH)) {
      return jsonError('Invalid request body', 400)
    }

    const { question, context } = body

    if (
      typeof question !== 'string' ||
      question.trim().length < 1 ||
      question.length > MAX_COACH_QUESTION_CHARS ||
      !isPlainJsonObject(context)
    ) {
      return jsonError('Invalid question or context', 400)
    }

    // Build structured system prompt with all training context
    const systemPrompt = buildSystemPrompt(context as unknown as CoachContext)

    const { stream: readable } = await getCoachResponseStream({
      systemPrompt,
      question,
      abortSignal: req.signal,
    })

    return createTextStreamResponse({
      stream: readable,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': PRIVATE_NO_STORE,
      },
    })
  } catch (error: unknown) {
    const status =
      typeof error === 'object' && error !== null &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : 500
    const message =
      typeof error === 'object' && error !== null &&
      typeof (error as { clientMessage?: unknown }).clientMessage === 'string'
        ? (error as { clientMessage: string }).clientMessage
        : 'AI Coach could not complete the request. Please try again.'
    return jsonError(message, status)
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: jsonHeaders(),
  })
}

function jsonHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': PRIVATE_NO_STORE,
  }
}

async function readBoundedBody(req: NextRequest): Promise<string> {
  if (!req.body) return ''

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > MAX_COACH_REQUEST_BYTES) {
        await reader.cancel()
        throw new CoachRequestTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Count object/array containers with the top-level object at depth 1. */
function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: isContainer(value) ? 1 : 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > maxDepth) return true
    if (!isContainer(current.value)) continue

    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value)
    for (const child of children) {
      if (isContainer(child)) {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return false
}

function isContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSystemPrompt(context: CoachContext): string {
  const {
    runs,
    activePlan,
    activeRace,
    stats,
  } = context

  const raceSection = activeRace
    ? `
## Active Race Goal
- Race: ${activeRace.name}
- Date: ${activeRace.raceDate}
- Days away: ${activeRace.daysAway}
- Distance: ${activeRace.distanceLabel ?? 'Unknown'}
- Target pace: ${activeRace.targetPace ?? '—'} /mi
- Goal finish time: ${activeRace.goalTime ?? '—'}
- Predicted finish time: ${activeRace.predictedTime ?? 'Not enough data'}
- Status: ${activeRace.comparisonStatus ?? 'Unknown'}
`.trim()
    : 'No active race goal set.'

  const planSection = activePlan
    ? `
## Active Training Plan
- Plan: ${activePlan.name}
- Progress: Week ${activePlan.currentWeek} of ${activePlan.totalWeeks}
- Plan adherence: ${activePlan.adherencePct}% (${activePlan.weeksHitTarget} of ${activePlan.weeksCompleted} weeks hit target)
- Total planned miles to date: ${activePlan.plannedMilesToDate.toFixed(1)} mi
- Total actual miles to date: ${activePlan.actualMilesToDate.toFixed(1)} mi
- This week planned: ${activePlan.thisWeekPlanned.toFixed(1)} mi
- This week actual: ${activePlan.thisWeekActual.toFixed(1)} mi

### Plan weeks (W = week, P = planned miles, A = actual miles):
${activePlan.weekSummaries.map((w: { weekNumber: number; plannedMiles: number; actualMiles: number }) =>
  `W${w.weekNumber}: P=${w.plannedMiles.toFixed(1)}mi A=${w.actualMiles.toFixed(1)}mi`
).join(' | ')}
`.trim()
    : 'No active training plan.'

  const statsSection = `
## Last 30 Days Stats
- Total runs: ${stats.totalRuns}
- Total miles: ${stats.totalMiles.toFixed(1)} mi
- Avg weekly mileage: ${stats.avgWeeklyMiles.toFixed(1)} mi/week
- Avg pace: ${stats.avgPace ?? '—'} /mi
- Avg HR: ${stats.avgHR ? `${Math.round(stats.avgHR)} bpm` : '—'}
- Longest run: ${stats.longestRun.toFixed(1)} mi
- Long runs (6+ mi): ${stats.longRunCount}
- Short runs (<3 mi): ${stats.shortRunCount}
- Medium runs (3-6 mi): ${stats.mediumRunCount}
  `.trim()

  const runsSection = runs.length > 0
    ? `
## Recent Runs (last 30 days, most recent first)
${runs.slice(0, 20).map((r: { date: string; distance: number; pace: string | null; avgHR: number | null; trainingLoad: number | null; runType: string | null }) =>
  `- ${r.date}: ${r.distance.toFixed(2)}mi @ ${r.pace ?? '—'}/mi` +
  (r.avgHR ? ` HR:${Math.round(r.avgHR)}bpm` : '') +
  (r.trainingLoad != null ? ` Load:${r.trainingLoad}` : '') +
  (r.runType ? ` [${r.runType}]` : '')
).join('\n')}
    `.trim()
    : 'No runs in the last 30 days.'

  function fmtSleep(h: number | null | undefined): string {
    if (!h || !isFinite(h)) return '—'
    const hrs = Math.floor(h)
    const mins = Math.round((h - hrs) * 60)
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`
  }

  function fmtNum(v: number | null | undefined, decimals = 0, suffix = ''): string {
    if (v === null || v === undefined || !isFinite(v)) return '—'
    return `${v.toFixed(decimals)}${suffix}`
  }

  const healthSection = context.healthSummary
    ? `
## Health & Lifestyle Metrics (last ${context.healthSummary.daysOfData} days avg)

### Sleep
- Average sleep: ${fmtSleep(context.healthSummary.avgSleepHours)} per night
- Average time awake: ${fmtNum(context.healthSummary.avgAwakeMins, 0, ' min')} per night
- Most recent night: ${fmtSleep(context.healthSummary.latestSleep)}

### Body
- Current weight: ${fmtNum(context.healthSummary.latestWeight, 1, ' lb')}
- Current BMI: ${fmtNum(context.healthSummary.latestBMI, 1)}
- Avg resting HR: ${fmtNum(context.healthSummary.avgRestingHR, 0, ' bpm')}
- Latest resting HR: ${fmtNum(context.healthSummary.latestRestingHR, 0, ' bpm')}

### Daily Activity
- Avg daily steps: ${context.healthSummary.avgSteps ? Math.round(context.healthSummary.avgSteps).toLocaleString() : '—'}
- Avg exercise minutes: ${fmtNum(context.healthSummary.avgExerciseMins, 0, ' min')}
- Avg move calories: ${fmtNum(context.healthSummary.avgMoveCalories, 0, ' kcal')}
- Avg stand hours: ${fmtNum(context.healthSummary.avgStandHours, 1, 'h')}

### Oral Care
- Avg brushing sessions/day: ${fmtNum(context.healthSummary.avgBrushCount, 1, 'x')}
- Avg brush duration: ${fmtNum(context.healthSummary.avgBrushDuration, 1, ' min')}
`.trim()
    : 'No health metrics data available.'

  return `You are an expert running coach with deep knowledge of distance running, periodization, and performance analytics. You have access to a runner's complete training data and race goals.

Be specific, actionable, and data-driven in your responses. Reference specific numbers from their data. Keep responses concise but comprehensive — use bullet points for recommendations. Be encouraging but honest about areas needing improvement.

${raceSection}

${planSection}

${statsSection}

${runsSection}

${healthSection}

When asked about sleep, weight, steps, or other health metrics, use the actual numbers above. Connect health data to running performance — e.g. poor sleep correlating with slower paces, elevated resting HR suggesting fatigue or illness, low steps on rest days being appropriate vs concerning.

When asked about plan changes, consider the runner's current fitness, race timeline, and adherence patterns. When asked about predictions, use the data provided. Always ground advice in the actual numbers shown above.`
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoachContext {
  runs: {
    date: string
    distance: number
    pace: string | null
    avgHR: number | null
    trainingLoad: number | null
    runType: string | null
  }[]
  activePlan: {
    name: string
    currentWeek: number
    totalWeeks: number
    adherencePct: number
    weeksHitTarget: number
    weeksCompleted: number
    plannedMilesToDate: number
    actualMilesToDate: number
    thisWeekPlanned: number
    thisWeekActual: number
    weekSummaries: {
      weekNumber: number
      plannedMiles: number
      actualMiles: number
    }[]
  } | null
  activeRace: {
    name: string
    raceDate: string
    daysAway: number
    distanceLabel: string | null
    targetPace: string | null
    goalTime: string | null
    predictedTime: string | null
    comparisonStatus: string | null
  } | null
  stats: {
    totalRuns: number
    totalMiles: number
    avgWeeklyMiles: number
    avgPace: string | null
    avgHR: number | null
    longestRun: number
    longRunCount: number
    mediumRunCount: number
    shortRunCount: number
  }
  healthSummary: {
    avgSleepHours: number | null
    avgAwakeMins: number | null
    latestSleep: number | null
    latestWeight: number | null
    latestBMI: number | null
    latestRestingHR: number | null
    avgRestingHR: number | null
    avgSteps: number | null
    avgExerciseMins: number | null
    avgMoveCalories: number | null
    avgStandHours: number | null
    avgBrushCount: number | null
    avgBrushDuration: number | null
    daysOfData: number
  } | null
}
