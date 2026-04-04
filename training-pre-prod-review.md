# Training Web App — Pre-Production Review

## Phase 0: Security Audit

### RISK 1 — Direct client-side API call
**SAFE** — Anthropic SDK imported only in `src/app/api/coach/route.ts` (Next.js API route, server-side only). No client-side files import `@anthropic-ai/sdk` or call `api.anthropic.com`.

### RISK 2 — NEXT_PUBLIC_ prefix on API key
**SAFE** — No `NEXT_PUBLIC_ANTHROPIC` found in any file or env config.

### RISK 3 — Key in source code
**SAFE** — No `sk-ant-` strings in source files. Key exists only in `.env.local` which is gitignored. `.env.local` is NOT tracked by git (verified via `git ls-files`).

### RISK 4 — Key logged to console
**SAFE** — No `console.log` calls near API key usage. The route has `console.error('Coach API error:', error)` which logs the error object but not the key.

### RISK 5 — Key passed as client-side prop
**SAFE** — API key is only referenced in the server-side route file. No Server Component passes it as a prop.

### RISK 6 — API route missing authentication
**MANUAL STEP REQUIRED** — The `/api/coach` POST handler has NO authentication check. Anyone who discovers the endpoint can call it and incur Anthropic API charges.

`firebase-admin` is not installed and `FIREBASE_SERVICE_ACCOUNT_JSON` is not configured in `.env.local`.

**Action required:**
1. Obtain service account JSON from Firebase Console → Project Settings → Service Accounts → Generate New Private Key
2. Add as `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel env vars and `.env.local`
3. Install `firebase-admin`: `npm install firebase-admin`
4. Create `src/lib/firebaseAdmin.ts` with `initializeApp` + `cert` setup
5. Add `Authorization: Bearer <idToken>` verification to the top of the POST handler in `src/app/api/coach/route.ts`
6. Update `src/app/(app)/coach/page.tsx` to send `Authorization` header with Firebase ID token

### RISK 7 — Rate limiting / cost protection
**FLAGGED** — No rate limiting on `/api/coach`. In-memory rate limiting is ineffective on Vercel serverless (stateless invocations). Requires Vercel KV or Upstash Redis for stateful rate limiting.

**Mitigation:** `max_tokens` is capped at 1024 in the API call, limiting per-request cost. Once RISK 6 auth is implemented, only authenticated users can call the endpoint.

### RISK 8 — Prompt injection
**SAFE** — User input (`question`) is passed only in `messages[{role: 'user', content: question}]`. The system prompt is built entirely from server-side context data. User content is not concatenated into the system prompt.

### Summary
- API key is server-side only: YES
- API key is gitignored: YES
- API route has auth: NO (MANUAL STEP REQUIRED)
- max_tokens capped: YES (1024)
- Prompt injection: SAFE
