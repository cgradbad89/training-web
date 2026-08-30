/**
 * Single source of truth for the AI Coach model and generation limits.
 *
 * The model ID was verified against the Vercel AI Gateway model catalog on
 * 2026-08-20. Keep model selection rationale and pricing in PRD.md.
 */
export const COACH_MODEL = 'anthropic/claude-sonnet-5'

/** Fixed request-boundary safety limits. These are application invariants, not
 * deployment or product-budget settings. */
export const MAX_COACH_REQUEST_BYTES = 1_048_576
export const MAX_COACH_QUESTION_CHARS = 4_000
export const MAX_COACH_JSON_DEPTH = 12

export const COACH_GENERATION_SETTINGS = {
  maxOutputTokens: 1024,
  // Sonnet 5 defaults to adaptive reasoning. Disable hidden reasoning so the
  // concise Coach response receives the full output budget.
  reasoning: 'none',
  // Provider routing and failover belong to AI Gateway, not application code.
  maxRetries: 0,
} as const
