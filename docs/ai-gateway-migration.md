# AI Coach Vercel AI Gateway migration

Status: implemented and production-verified on 2026-08-20.

## Architecture and contract

The active path is now:

`/coach` → `/api/coach` → `coachStream.ts` → AI SDK `streamText()` → Vercel AI Gateway → configured model.

The UI has one provider-neutral AI Coach experience. The former Gemini/Claude selector and `provider` request field are removed. Firebase authentication, prompt construction, training context, and client rendering are unchanged.

The HTTP contract remains:

- Request JSON: `{ question, context }`
- Success: HTTP 200, `Content-Type: text/plain; charset=utf-8`, raw streamed text chunks
- Failure: JSON `{ "error": "message" }` with a non-success status

This deliberately does not use the AI SDK UI message protocol.

## Model selection (verified 2026-08-20)

The Vercel AI Gateway catalog and unauthenticated models API were checked before implementation. The selected model is `anthropic/claude-sonnet-5`.

Rationale:

- Coaching quality: Vercel describes Sonnet 5 as improving instruction-following, professional work, document parsing, and long-context memory over Sonnet 4.6. Those characteristics fit concise, data-grounded coaching better than optimizing solely for lowest token price.
- Reliability: the Gateway catalog exposes Sonnet 5 through multiple inference providers, allowing Gateway-level same-model routing/failover without application-visible provider changes.
- Context suitability: 1,000,000-token context window and 128,000-token model output ceiling; the application retains its much smaller explicit 1,024-token output cap. Reasoning is explicitly disabled so Sonnet 5's adaptive hidden reasoning cannot consume that concise-answer budget (a production smoke test caught and corrected this before verification was marked complete).
- Cost: launch pricing is $2 per million input tokens and $10 per million output tokens through August 31, 2026. Published standard pricing is $3/M input and $15/M output afterward. At the application cap, output spend is bounded to about $0.01024 during launch pricing or $0.01536 at standard pricing, plus input tokens.

Configuration is centralized in `src/app/api/coach/coachConfig.ts`; model identifiers and generation limits must not be duplicated elsewhere.

Sources used for the decision:

- Vercel AI Gateway models API: `https://ai-gateway.vercel.sh/v1/models`
- Vercel Sonnet 5 announcement and pricing: `https://vercel.com/changelog/claude-sonnet-5-ai-gateway`
- Vercel AI Gateway pricing: `https://vercel.com/docs/ai-gateway/pricing`

## Error behavior

`coachStream.ts` consumes the AI SDK full stream so Gateway error parts remain observable. It buffers the first text delta before the route commits HTTP 200. Authentication/entitlement errors, model unavailability, rate limits, and provider failures before that point are mapped to controlled application JSON errors. Raw provider messages, bodies, credentials, and request IDs are not returned.

After streaming begins, HTTP status cannot change. A mid-stream failure terminates the raw text stream with a controlled application error and does not restart on a different model.

## Rollback and transitional safety

The migration is reversible by reverting migration commit `b0a89ab` and the follow-up output-budget fix `f6606a2`. Production verification has succeeded, but the following rollback assets are deliberately retained for a separate cleanup change:

- `@anthropic-ai/sdk` and `@google/genai` remain installed.
- `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` remain documented and must not be removed from production configuration.
- The inactive previous provider implementation remains in `src/app/api/coach/coachStream.legacy.ts` and is not imported by the active route.

Do not delete those rollback assets as part of an unrelated change. Remove them together in a dedicated cleanup after confirming the team no longer needs immediate direct-provider rollback.

## Production verification (completed 2026-08-20)

- Vercel deployment `dpl_2d3jz9AQ9MMR5mP5AC1Fw9eRNJ2d` was built from `main` at commit `f6606a2`, completed successfully, and served through `https://training-web-rho.vercel.app`.
- The actual authenticated `/coach` UI loaded the user's training context, showed no provider selector, streamed a grounded answer, and returned the Ask control to its ready state.
- The production `/api/coach` request returned HTTP 200. Runtime logs recorded `finishReason: stop`, 1,800 input tokens, 950 output/text tokens, and zero reasoning tokens; the error-level log scan was clean.
- AI Gateway request `gen_01M0GCBKG026CKSDKV5WJQVT3Z` returned 200 for `anthropic/claude-sonnet-5`, routed through Claude Platform on AWS in `iad1`, with project authentication shown as `training-web`. There were no 403, entitlement, or missing-key errors.
- The first smoke test exposed Sonnet 5 adaptive reasoning consuming the 1,024-token response budget. Commit `f6606a2` explicitly disabled reasoning, and the successful request above verified the correction with 950 visible text tokens and zero reasoning tokens.
- Rollback remains available through the retained legacy implementation and provider dependencies; reverting `f6606a2` and `b0a89ab` restores the previous direct-provider path.

## Recommended follow-up cleanup (separate change)

- Delete `coachStream.legacy.ts`.
- Remove `@anthropic-ai/sdk` and `@google/genai`.
- Remove `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` from Vercel and local documentation.
- Remove the transitional provider entries from the PRD and this document when the rollback assets are deleted.
