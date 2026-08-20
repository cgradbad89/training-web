/**
 * Single source of truth for the AI Coach model and generation limits.
 *
 * The model ID was verified against the Vercel AI Gateway model catalog on
 * 2026-08-20. Keep model selection rationale and pricing in PRD.md.
 */
export const COACH_MODEL = 'anthropic/claude-sonnet-5'

export const COACH_GENERATION_SETTINGS = {
  maxOutputTokens: 1024,
  // Sonnet 5 defaults to adaptive reasoning. Disable hidden reasoning so the
  // concise Coach response receives the full output budget.
  reasoning: 'none',
  // Provider routing and failover belong to AI Gateway, not application code.
  maxRetries: 0,
} as const
