# Phase 3J — Weather data reliability

**Status:** implemented (client-side, bounded, owner-session-driven). Historical recovery is **non-executing**.
**Live prediction formula, gates, thresholds and race-anchor behavior: unchanged.**

## The old problem (code-derived, confirmed by the Phase 3I coverage observation)

Weather was fetched and persisted only inside `runs/[id]/page.tsx`, after the owner opened a GPS run's detail page.
The comparable-effort weather gate (`comparableContext` / `weatherOk`) therefore selected the runs the owner happened
to view. Observed on the 2026-09-22 local export: 35 of 415 run-like workouts had weather.

Why it was page-bound: workout parents carry no start coordinate (it is the `route` subcollection's first point), the
web app does not ingest workouts (the iOS app writes them), and the only server code (the Vercel cron
`/api/half-marathon-capture`) deliberately holds **read-only** Firestore access via impersonated credentials.

## The new automatic path

`WeatherBackfillRunner` (mounted in `(app)/layout.tsx` next to `PRComputerRunner`) runs one bounded pass whenever the
authenticated owner has the app open and the shared workouts pool changes:

1. `selectWeatherCandidates` picks up to **3** outdoor GPS runs per pass (newest first, last **60 days**, **12** per
   browser session) that have no `weather`, ended ≥ **6 h** ago, are not excluded, and are not on cooldown.
2. For each: read **one** route document (first GPS point — never the track), request one Open-Meteo hour slot, then
   `saveWeatherForWorkoutIfAbsent` (transaction: writes only if the document exists and holds no `weather`).
3. Calls are spaced 1.5 s; HTTP 429 stops the pass and pauses all provider calls for 2 h; failures back off
   (1 h → 6 h → 24 h → 3 d → 7 d; missing start point 12 h → 3 d → 14 d → 30 d) in a per-browser ledger
   (`localStorage`, size-bounded, tolerant of unavailable storage).

Run Detail keeps its weather backfill but now shares the in-tab claim registry, validates coordinates, and uses the same
save-if-absent transaction, so it can no longer replace an existing observation.

### Honest limitation (explicit)

This is **processing triggered by authenticated application use**, not unattended background processing. A run that is
never followed by an app visit gets no weather until the next visit. A true unattended path would need a server write
credential or a new scheduled job — both infrastructure/IAM decisions reserved to the owner (see Owner action W1).

### Guarantees (each covered by a test)

| Requirement | Mechanism |
|---|---|
| Correct start time/location | first route point + `workout.startDate` (UTC instant; hour slot floored in UTC; DST-independent) |
| Outdoor GPS runs only | `isRunLike`, `hasRoute`, not treadmill/indoor (honors `runTypeOverride`), not excluded, not manual |
| Idempotent / preserve existing | eligibility skips any stored `weather`; write is a transaction that re-checks |
| No fabrication | all six fields of the hour slot must be present, else nothing is stored; (0,0)/out-of-range coordinates rejected |
| Bounded | pass 3, session 12, 60-day window, ledger ≤ 400 entries |
| Retry/cooldown, 429 | ledger ladders; provider pause |
| Duplicate/concurrent protection | in-tab claim registry; transaction at the database |
| Auth respected | runs only inside `AuthGuard`; owner merge-write (no rule change); retired sessions abort via `isCurrent` + `AbortSignal` |
| No track download | `getRouteStartPoint` reads one route document |
| Diagnostics | counts only (`[WeatherBackfill] pass {selected,saved,…}`); no coordinates/ids |

### Data-provenance finding

The archive endpoint's default `best_match` model fills the most recent days with forecast-analysis values (a
same-day query returned all 24 hours), whereas `models=era5` returns nulls for runs younger than ~5 days. Stored
snapshots do not record which source produced them. The 6 h settle delay keeps the run's hour in the past; it does not
make recent values reanalysis. Not changed here (it would silently redefine weather inputs); recorded for Phase 3K+.

## Cost (steady state)

At ~4 runs/week: ≈ 0.6 weather requests/day — 0.006 % of the free tier (10 000/day, 600/min, 5 000/h,
non-commercial). Per newly acquired run: 1 API call, 1 route-doc read, 1 workout read + 1 write in the transaction.
Worst case for a permanently failing run inside the 60-day window: ≈ 11 attempts (transient ladder) or ≈ 5
(no start point), each ≤ 1 API call + 1 read. Per-session ceiling: 12 runs. No new service, schedule or paid dependency.

## Historical recovery status — **plan only, not executed**

`scripts/recoverWeather.ts` (owner-run, dry-run by default, `RECOVER_MAX` ≤ 200, newest-first, spaced, stops at the
first 429, parents + one route doc per attempt, transactional never-overwrite). It was **not run** against production.

Sizing on the 2026-09-22 export (aggregate, no identifiers; the live count is higher by ≈ 6 weeks of runs and must be
re-measured with the dry-run): 415 run-like → 35 already have weather, 43 indoor, 242 without route (mostly pre-GPS),
**95 recoverable** (14 inside the automatic window, **81** older). Cost to recover all 81: 81 API calls (0.8 % of one
day's allowance), 81 route reads, 81 workout reads + writes.

Recovered snapshots carry `fetchedAt = recovery time`. The funnel's weather gate (`fetchedAt ≤ as-of`) therefore makes
them visible only to computations and checkpoints **after** recovery; replays as-of earlier dates correctly ignore them,
and no stored checkpoint is touched. That means recovery changes what the live estimator can see — the one reason it is
left for an owner decision (W2) rather than executed.

Exact plan: `RECOVER=1 npx vitest run scripts/recoverWeather.test.ts` (dry-run), review counts, then
`RECOVER=commit RECOVER_MAX=100 npx vitest run scripts/recoverWeather.test.ts`.

## Tests

`src/utils/__tests__/weatherBackfill.test.ts` (policy, ledger, DST, recovery planning),
`src/services/__tests__/weatherBackfill.test.ts` (pass: new runs, existing weather, no GPS, 429, cancellation, duplicates,
concurrency, reruns), `src/services/__tests__/saveWeatherIfAbsent.test.ts`, `src/lib/weather.test.ts` (detailed result,
429, abort, DST), `src/components/__tests__/WeatherBackfillRunner.test.tsx` (acquisition with no Run Detail visit),
`scripts/recoverWeather.test.ts`; existing Run Detail suites updated for the renamed save and still pass.
