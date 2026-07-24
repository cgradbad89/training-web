'use client'

import { useEffect, useState, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { fetchHealthWorkouts } from '@/services/healthWorkouts'
import { fetchAllOverrides } from '@/services/workoutOverrides'
import { fetchPlans } from '@/services/plans'
import { isRunningPlan } from '@/types/plan'
import { fetchRaces } from '@/services/races'
import { fetchHealthMetrics } from '@/services/healthMetrics'
import { fetchUserSettings } from '@/services/userSettings'
import { buildCoachContext } from '@/utils/coachContext'
import { parseLocalDate, daysUntil } from '@/utils/dates'
import { resolveMaxHr, resolveRestingHr } from '@/utils/trainingLoad'
import { applyOverride } from '@/types/workoutOverride'
import {
  BotMessageSquare, Send, Loader2, RefreshCw, ChevronRight
} from 'lucide-react'

// ── Suggested questions ──────────────────────────────────────────────────────

const SUGGESTED_QUESTIONS = [
  'How am I tracking toward my race goal?',
  'Where am I falling short on my training plan?',
  'Should I increase my mileage this week?',
  'What does my pace trend suggest about my fitness?',
  'How can I improve my long run performance?',
  'What should I focus on in the next 2 weeks?',
  'How is my sleep affecting my running performance?',
  'Is my resting heart rate suggesting I need more recovery?',
  'How should my daily step count relate to my training load?',
  'How does my current fitness compare to my race goal?',
]

// ── Main page ────────────────────────────────────────────────────────────────

export default function CoachPage() {
  const { user } = useAuth()
  const userId = user?.uid ?? ''

  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [context, setContext] = useState<ReturnType<typeof buildCoachContext> | null>(null)
  const [question, setQuestion] = useState('')
  const [response, setResponse] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [provider, setProvider] = useState<'gemini' | 'anthropic'>('gemini')
  const [hasAsked, setHasAsked] = useState(false)
  const responseRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Abort in-flight stream on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  // Load all training data on mount
  useEffect(() => {
    if (!userId) return
    setLoading(true)
    let cancelled = false

    Promise.all([
      fetchHealthWorkouts(userId, { limitCount: 500 }),
      fetchAllOverrides(userId),
      fetchPlans(userId),
      fetchRaces(userId),
      fetchHealthMetrics(userId, 30),
    ]).then(([workouts, overrides, plans, races, healthMetrics]) => {
      // Apply overrides
      const runs = workouts
        .filter(w => w.isRunLike)
        .map(w => applyOverride(w, overrides[w.workoutId] ?? null))

      // Find active plan and race (running plans only — coach is running-focused)
      const runningPlans = plans.filter(isRunningPlan)
      const activePlan = runningPlans.find(p => p.status === "active") ?? runningPlans[0] ?? null
      // Race dates are date-only strings — local-midnight parsing via the shared
      // helpers keeps the coach's "days away" consistent with Races/Plan Insights.
      const upcomingRaces = races
        .filter(r => daysUntil(r.raceDate) >= 0)
        .sort((a, b) => {
          return parseLocalDate(a.raceDate).getTime() - parseLocalDate(b.raceDate).getTime()
        })
      const activeRace = upcomingRaces.find(r => r.isActive) ?? upcomingRaces[0] ?? null

      const buildContext = (maxHr: number, restingHr: number) =>
        buildCoachContext(
          runs,
          activePlan,
          activeRace,
          overrides,
          healthMetrics,
          maxHr,
          restingHr
        )

      if (cancelled) return
      setContext(
        buildContext(resolveMaxHr(undefined), resolveRestingHr(undefined))
      )
      setLoading(false)

      fetchUserSettings(userId)
        .then(settings => {
          if (!cancelled)
            setContext(
              buildContext(resolveMaxHr(settings), resolveRestingHr(settings))
            )
        })
        .catch(err => console.error('[Coach] fetchUserSettings failed:', err))
    }).catch(err => {
      if (cancelled) return
      setError(err.message)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [userId])

  // Auto-ask if a question was passed via URL param
  useEffect(() => {
    if (!context || asking || hasAsked) return
    const prefilled = searchParams.get('q')
    if (prefilled) {
      setQuestion(prefilled)
      handleAsk(prefilled)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context])

  // Auto-scroll response as it streams
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight
    }
  }, [response])

  async function handleAsk(q?: string) {
    const questionToAsk = q ?? question
    if (!questionToAsk.trim() || !context || asking) return

    setAsking(true)
    setResponse('')
    setError(null)
    setHasAsked(true)
    if (q) setQuestion(q)

    try {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      // Get current user's Firebase ID token
      const { getAuth } = await import('firebase/auth')
      const currentUser = getAuth().currentUser
      const idToken = currentUser ? await currentUser.getIdToken() : null

      if (!idToken) {
        setError('You must be signed in to use AI Coach.')
        setAsking(false)
        return
      }

      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          question: questionToAsk,
          context,
          provider,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Failed to get response')
      }

      // Stream the response
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error('No response stream')

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        setResponse(prev => prev + text)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setAsking(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent
                        rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center
                        justify-center">
          <BotMessageSquare className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-textPrimary">AI Coach</h1>
            <select
              value={provider}
              onChange={e => setProvider(e.target.value as 'gemini' | 'anthropic')}
              className="text-xs bg-surface border border-border rounded-lg px-2 py-1 text-textSecondary outline-none focus:ring-1 focus:ring-primary/20"
            >
              <option value="gemini">Gemini 2.5 (Default)</option>
              <option value="anthropic">Claude Sonnet</option>
            </select>
          </div>
          <p className="text-xs text-textSecondary mt-0.5">
            Based on your last 30 days of training
          </p>
        </div>
        {context && (
          <button
            onClick={() => window.location.reload()}
            className="ml-auto p-2 rounded-xl hover:bg-surface
                       text-textSecondary transition-colors"
            title="Refresh training data"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Context summary */}
      {context && (
        <div className="bg-surface rounded-2xl border border-border p-4 mb-6">
          <p className="text-xs font-semibold text-textSecondary uppercase
                        tracking-wide mb-2">
            Training Context Loaded
          </p>
          <div className="flex flex-wrap gap-3 text-xs text-textSecondary">
            <span>
              {context.stats.totalRuns} runs ·{' '}
              {context.stats.totalMiles.toFixed(1)} mi (30 days)
            </span>
            {context.activePlan && (
              <span>
                {context.activePlan.name} — Week{' '}
                {context.activePlan.currentWeek}/
                {context.activePlan.totalWeeks}
              </span>
            )}
            {context.activeRace && (
              <span>
                {context.activeRace.name} in{' '}
                {context.activeRace.daysAway} days
              </span>
            )}
            {context.healthSummary && (
              <span>
                {context.healthSummary.daysOfData} days health data
                {context.healthSummary.avgSleepHours
                  ? ` · ${Math.floor(context.healthSummary.avgSleepHours)}h ${Math.round(
                      (context.healthSummary.avgSleepHours % 1) * 60
                    )}m avg sleep`
                  : ''}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Response area */}
      {hasAsked && (
        <div
          ref={responseRef}
          className="bg-card rounded-2xl border border-border p-5 mb-5
                     min-h-32 max-h-[500px] overflow-y-auto"
        >
          {asking && !response && (
            <div className="flex items-center gap-2 text-textSecondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Analyzing your training data…</span>
            </div>
          )}
          {response && (
            <div className="prose prose-sm max-w-none text-textPrimary
                            whitespace-pre-wrap text-sm leading-relaxed">
              {response}
            </div>
          )}
          {error && (
            <p className="text-danger text-sm">{error}</p>
          )}
        </div>
      )}

      {/* Question input */}
      <div className="bg-card rounded-2xl border border-border p-3 mb-5
                      focus-within:ring-2 focus-within:ring-primary/20">
        <textarea
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAsk()
            }
          }}
          placeholder="Ask anything about your training…"
          rows={2}
          className="w-full text-sm text-textPrimary bg-transparent resize-none
                     outline-none placeholder:text-textSecondary"
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-textSecondary">
            Press Enter to send · Shift+Enter for new line
          </p>
          <button
            onClick={() => handleAsk()}
            disabled={!question.trim() || asking || !context}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                       bg-primary text-white text-xs font-semibold
                       hover:bg-primary/90 disabled:opacity-40
                       transition-colors"
          >
            {asking ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </div>

      {/* Suggested questions */}
      {!hasAsked && (
        <div>
          <p className="text-xs font-semibold text-textSecondary uppercase
                        tracking-wide mb-3">
            Suggested Questions
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SUGGESTED_QUESTIONS.map(q => (
              <button
                key={q}
                onClick={() => handleAsk(q)}
                disabled={asking || !context}
                className="flex items-center gap-2 text-left p-3 rounded-xl
                           bg-surface border border-border text-sm
                           text-textSecondary hover:text-textPrimary
                           hover:border-primary/30 hover:bg-primary/5
                           transition-colors disabled:opacity-40 group"
              >
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-primary
                                         opacity-0 group-hover:opacity-100
                                         transition-opacity" />
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
