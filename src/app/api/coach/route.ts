import Anthropic from '@anthropic-ai/sdk'
import { NextRequest } from 'next/server'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function POST(req: NextRequest) {
  // Verify Firebase Auth token
  const authHeader = req.headers.get('Authorization')
  const token = authHeader?.split('Bearer ')[1]

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    const { getAuth } = await import('@/lib/firebaseAdmin')
    await getAuth().verifyIdToken(token)
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid token' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    const { question, context } = await req.json()

    if (!question || !context) {
      return new Response(
        JSON.stringify({ error: 'Missing question or context' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Build structured system prompt with all training context
    const systemPrompt = buildSystemPrompt(context)

    // Stream response from Claude
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    })

    // Return as a ReadableStream for streaming to client
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(
              new TextEncoder().encode(chunk.delta.text)
            )
          }
        }
        controller.close()
      },
    })

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error: unknown) {
    console.error('Coach API error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
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
${runs.slice(0, 20).map((r: { date: string; distance: number; pace: string | null; avgHR: number | null; efficiencyScore: number | null; runType: string | null }) =>
  `- ${r.date}: ${r.distance.toFixed(2)}mi @ ${r.pace ?? '—'}/mi` +
  (r.avgHR ? ` HR:${Math.round(r.avgHR)}bpm` : '') +
  (r.efficiencyScore ? ` Eff:${r.efficiencyScore.toFixed(1)}` : '') +
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
    efficiencyScore: number | null
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
