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

---

## Phase 1A: Domain Logic Findings

### FIXED — `formatPace` producing "10:60" (pace.ts)
- **Bug:** `Math.round(secPerMile % 60)` could return 60 (e.g., 599.5 % 60 = 59.5, rounds to 60)
- **Fix:** Round total seconds first with `Math.round(secPerMile)`, then extract minutes/seconds with integer arithmetic (`total % 60` always < 60)
- **Same fix applied to `formatDuration`**
- **Added `isFinite` guard** to both functions for NaN/Infinity inputs

### FIXED — `buildQualifyingEfforts` NaN date passthrough (riegelFit.ts)
- **Bug:** `new Date('invalid').getTime()` produces NaN, and `NaN < cutoff` is false, so invalid dates silently passed through
- **Fix:** Added `!isFinite(startMs)` guard before cutoff check

### SAFE — Riegel regression (riegelFit.ts)
- Returns null for < 4 efforts (line 116)
- Returns null when sxx = 0 (zero variance, line 162)
- Returns null when wSum = 0 (line 149)
- R2 clamps to max(0, ...) preventing negative values (line 175)
- Half marathon requires 2+ medium-long runs AND longest >= 6mi (lines 119-128)
- No NaN propagation risk — all division guarded

### SAFE — Efficiency scoring (metrics.ts)
- Returns 0 for zero speed or HR (line 43: `!speedMps || !avgHR` catches zero/falsy)
- Display score clamped to [1, 10] (line 47)

### SAFE — Plan matching (planMatching.ts)
- Handles missing weeks gracefully (line 142)
- 4-pass matching with used-set prevents double-counting

### NOTE — Strava activities service (activities.ts)
- `fetchActivities()` queries global `stravaActivities` collection without uid scope
- This is a documented legacy design — single-user Strava data written by iOS
- Firestore security rules should protect this in production

---

## Phase 1B: Firestore Findings

All service files audited. Results:

| File | Status | Notes |
|------|--------|-------|
| activities.ts | NOTE | Global collection (legacy Strava) — see 1A |
| createdRoutes.ts | CLEAN | uid-scoped, uses stripUndefined() |
| healthMetrics.ts | CLEAN | uid-scoped |
| healthWorkouts.ts | CLEAN | uid-scoped |
| plans.ts | CLEAN | uid-scoped, batch writes atomic |
| races.ts | CLEAN | uid-scoped, uses stripUndefined() |
| routes.ts | CLEAN | uid-scoped, read-only |
| shoes.ts | CLEAN | uid-scoped, uses stripUndefined() |
| userSettings.ts | CLEAN | uid-scoped, merge strategy |
| workoutOverrides.ts | CLEAN | uid-scoped, uses stripUndefined() |

- No onSnapshot subscriptions found (all use getDocs)
- All write operations use stripUndefined() helper where needed
- No batch writes without proper atomicity

---

## Phase 1C: React/Hook Findings

### FIXED — AI Coach streaming not abortable on unmount (coach/page.tsx)
- **Bug:** `handleAsk()` reads from a stream in a while loop. If component unmounts mid-stream, reader continues and attempts state updates on unmounted component.
- **Fix:** Added `AbortController` ref, passed signal to fetch, abort on unmount and on new request

### FIXED — Route detail modal fetch without cleanup (routes/page.tsx)
- **Bug:** `fetchRoutePoints` in useEffect had no cancelled flag
- **Fix:** Added `let cancelled = false` pattern with cleanup return

### FIXED — Health page chart derivations not memoized (health/page.tsx)
- **Bug:** weight90Series, weightAllSeries, allTimeHRSeries, and their derived domains recomputed on every render
- **Fix:** Wrapped in useMemo with proper dependencies

### SAFE — Plan Insights page
- `raceFit` and `fiveKFit` already wrapped in useMemo with correct deps
- All useEffect hooks have proper cleanup flags

### SAFE — Custom hooks (useActivities, useHealthWorkouts)
- Both use `let cancelled = false` pattern correctly
- Proper cleanup functions returned

---

## Phase 1D: TypeScript Findings

`npx tsc --noEmit` — **CLEAN** (0 errors)

TypeScript strict mode is enabled. No unsafe `any` types found in utility files. Type assertions in activities.ts `docToActivity` are acceptable (Firestore data mapping).

---

## Phase 1E: Test Results

### Setup
- Installed vitest + @vitest/ui + happy-dom
- Created `vitest.config.ts` with path alias support
- Added `"test": "vitest run"` to package.json scripts

### Tests Created

**`src/utils/__tests__/riegelFit.test.ts`** (16 tests)
- Empty/insufficient data → null
- Zero variance (same distance) → null
- Invalid dates → filtered out
- Valid diverse efforts → finite fit
- predictSeconds → finite positive number
- formatRaceTime → handles null/NaN/Infinity, formats correctly
- formatRacePace → handles edge cases, correct format

**`src/utils/__tests__/pace.test.ts`** (19 tests)
- formatPace: zero, negative, NaN, Infinity → "--:--"
- **Regression test: 599.5 sec/mi → "10:00" not "9:60"**
- formatDuration: NaN/negative/Infinity → "0:00"
- **Regression test: 59.6 → "1:00" not "0:60"**
- **Regression test: 3599.7 → "1:00:00" not "59:60"**
- mpsToSecPerMile: zero/negative → 0
- parsePaceString: valid/invalid formats

**`src/utils/__tests__/metrics.test.ts`** (16 tests)
- efficiencyDisplayScore: zero inputs → 0 (not NaN)
- Both zero (0/0) → 0 (not NaN)
- Clamped to [1, 10] range
- distanceBucket, driftLevel, trainingLoadLevel thresholds

### Results
```
Test Files  3 passed (3)
     Tests  51 passed (51)
  Duration  276ms
```

---

## Phase 1F: Security/Data Findings

| Check | Result |
|-------|--------|
| Anthropic key in client files | SAFE (server-only) |
| Debug console.log calls | NONE found in source |
| NEXT_PUBLIC_ usage | Firebase config only (safe) + hub URL |
| Hardcoded UIDs/IDs | NONE found |
| User PII logged | NONE found |

---

## Phase 2: Backend Improvements Implemented

1. **formatPace/formatDuration ":60" fix** — Round total first, then extract minutes/seconds
2. **isFinite guard on date parsing** — buildQualifyingEfforts rejects NaN dates
3. **AbortController on AI Coach streaming** — Proper cleanup on unmount, aborts in-flight requests
4. **Route modal fetch cleanup** — Cancelled flag prevents state updates after unmount
5. **Health page chart memoization** — weight90Series, weightAllSeries, allTimeHRSeries wrapped in useMemo
6. **Test suite** — 51 tests covering riegelFit, pace, and metrics edge cases

---

## Phase 3: UI Improvement List (prioritized)

### HIGH Priority

| # | Area | Issue | Suggested Fix |
|---|------|-------|---------------|
| 1 | **AI Coach** | API route has no authentication — anyone can call `/api/coach` | Add Firebase Admin SDK token verification (see Phase 0, RISK 6) |
| 2 | **Plan Insights** | No contextual AI insights button | Add "Ask AI Coach" button that navigates to /coach with pre-filled question about plan adherence |
| 3 | **Personal Insights** | No contextual AI insights button | Add "Ask AI Coach" button with pre-filled question about trends |
| 4 | **Plan Insights** | Empty state when no plan exists — blank charts, no guidance | Show prominent CTA: "Create a training plan to see insights" |
| 5 | **Multiple Pages** | Errors silently swallowed with `.catch(console.error)` | Add user-facing error banners on dashboard, plan-insights, personal-insights, runs |

### MEDIUM Priority

| # | Area | Issue | Suggested Fix |
|---|------|-------|---------------|
| 6 | **All Charts** | Missing ARIA labels on Recharts components | Add `aria-label` and `role="img"` to chart containers with summary text |
| 7 | **AI Coach** | Streaming response area not announced to screen readers | Add `role="log"` and `aria-live="polite"` to response div |
| 8 | **Workouts** | TabStrip lacks ARIA roles for tab navigation | Add `role="tablist"`, `role="tab"`, `aria-selected` |
| 9 | **Routes** | Route detail modal shows blank if fetch fails | Show "Route data unavailable" fallback instead of empty map |
| 10 | **Plan Insights** | Hardcoded 200px chart heights | Use responsive height: `h-[200px] md:h-[280px]` |
| 11 | **Races** | Goal race toggle lacks ARIA toggle state | Add `role="switch"` and `aria-checked` |
| 12 | **AI Coach** | No error banner when context load fails | Show "Failed to load training data" with retry button |

### LOW Priority

| # | Area | Issue | Suggested Fix |
|---|------|-------|---------------|
| 13 | **Health** | Verify resting HR status colors display correctly | Manual visual check — code thresholds look correct |
| 14 | **Navigation** | Desktop sidebar icons lack aria-labels | Add `aria-label={label}` to sidebar Link components |
| 15 | **Personal Insights** | PR table shows "—" everywhere with no data | Show "Complete more runs to see PRs" message |
| 16 | **Dashboard** | Weekly stats show "— mi" when no plan | Show "No plan active" instead of dash for planned miles |
| 17 | **AI Coach** | No conversation history — each question is standalone | Consider adding message history within session |

---

## Summary

- **Critical issues found and fixed:** 3 (formatPace ":60" bug, stream cleanup, NaN date passthrough)
- **Issues requiring manual action:** 2 (API route auth — RISK 6, rate limiting — RISK 7)
- **Improvements implemented:** 6 (pace fix, date guard, stream abort, route cleanup, health memoization, test suite)
- **Tests added:** 51 (all passing)
- **Build status:** PASSING
- **Deployed:** YES (pushed to main, auto-deploys to Vercel)
- **Commit:** `f55bf2e`
