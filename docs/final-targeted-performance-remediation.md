# Final targeted performance and canonical-state remediation

Baseline: fetched `main` / `origin/main`
`f4acab54180fed4bb415a30e30f3a9b004bbc952`, 2026-10-05.
Repository: `/Users/johnfolstrom/Desktop/training-web`.
Remote: `https://github.com/cgradbad89/training-web.git`.
Implementation branch: `codex/final-performance-remediation`.
Preflight found no tracked/staged changes and nine unrelated untracked owner
files; their exact inventory and SHA-256 were recorded outside the repository.
CLAUDE.md, PRD, Phase 1/2A/2B documentation and affected tests were inspected.

## Dashboard

`getWeekEnd(selectedWeekStart)` returned a new Date each render. That identity
was an effect dependency: fresh Health array -> state/render -> fresh week-end
Date -> identical range query. The effect now uses primitive local from/to dates
plus UID/session epoch. The week-end Date is memoized for downstream derivations.
There is no terminal "already fetched" flag. Week changes, including return to
a previously selected week, and session replacement fetch normally. Late results
require both the live effect and synchronous AuthContext epoch guard. The Today
and ring-goal reads use the same session guards.

Dashboard Health's pre-existing freshness policy is mount/week navigation;
workout manual/focus/return refresh continues through AppData unchanged. Workout
or override changes update canonical training derivations without requerying an
unchanged Health date range. This does not add a Dashboard midnight/focus policy.
Strict Mode deliberately starts one read per effect generation (two development
setups), rejects the retired result, and never loops after the live response.

## Shoe assignments

Runs and Shoes previously updated only their rule-overlaid display maps; the
raw manual map remained stale. A later canonical workout refresh re-evaluated
auto-rules and restored the stale manual value. Both surfaces now await persistence,
patch the raw map, and derive display/rule counts from it with useMemo. Manual
null remains an explicit removal and defeats matching rules. Failure logs through
the existing console path and retains the prior canonical assignment. Successful
Save Auto-Assignments and shoe deletion's persisted assignment clearing also
publish to the raw source. Mutation publication and assignment reads reject
retired mount/session owners. Run Detail was already persistence-first and is
covered by success/failure form re-derivation tests; its production code is unchanged.

Shoe data remains page-owned. A subsequent surface reads the persisted manual
map normally; no shared shoe provider, new collection or broader architecture
was introduced.

## Route-start memory

The small coordinate cache lives beside the existing full GPS cache. Keys encode
`[uid, workoutId]`; resolved and in-flight maps share the GPS memory epoch cleared
by the authorized AuthContext observer on logout, UID replacement and disposal.
Same-UID logout/login also advances that epoch. Duplicate authorized observations
retain ordinary navigation reuse. Late retired work cannot publish or remove a
replacement in-flight entry. A queued query checks retirement before starting.
Geographic preparation snapshots the same epoch and stops before another batch
after retirement; this narrow adjacent guard preserves clustering semantics.

Up to **500 successful coordinate pairs** are retained with least-recently-used
eviction, matching Routes' raw newest-500 bound. Null, query failure and invalid
coordinates are **not cached**: they can reflect delayed GPS ingestion and must
remain retryable. Identical pending requests still coalesce even if they settle
empty or fail. No persistent browser storage or negative-result TTL is added.
Full GPS is checked first, including its existing empty-array behavior; requesting
full GPS after a cached start performs its normal full read and never treats the
coordinate as a complete route. Clustering and full GPS retention are unchanged.

The Firestore imports used by the start lookup are static, like the existing
full-GPS service (which already imports those modules); the query itself remains
deferred to demand. This also avoids a Vitest concurrent dynamic-import/mock
resolution artifact exposed by distinct-start integration tests.

## Exact mocked operation proof

The actual baseline SHA was exported to a temporary directory. The three page
harnesses ran against its unchanged application source with baseline assertions,
then ran against the remediation source with corrected assertions. Dashboard's
other Health requests are held pending to isolate exactly six fresh week responses.
The baseline Routes test serializes mocked start lookup scheduling to avoid the
old dynamic-import/mock artifact; the current test exercises normal parallel
batching. No production data was read or mutated for this evidence.

| Reproduction | Audited source | Remediation |
| --- | --- | --- |
| Stable Dashboard week after six fresh responses/render cycles | 7 identical week queries | 1 required query; 0 automatic repeats |
| Runs raw assignment A -> persisted B -> canonical workout re-derive | display B -> A | raw/display B -> B, across six re-derivations |
| 50 routed runs, two real Routes page visits, one representative GPS demand between visits | 50 + 49 = 99 start queries | 50 + 0 = 50 start queries |
| 50 simultaneous consumers for one scoped start | no start in-flight reuse | 1 underlying query |

Counts are application/mock query operations, not independently measured billed
Firestore reads, production latency or financial savings.

## Validation and preserved scope

Focused tests cover stable/same/changed week, workout manual refresh, rapid renders,
failure retry, UID/epoch retirement, Strict Mode and genuine unmount; manual shoe
change/removal/failure, auto-save/failure, subsequent cross-surface consistency,
retired Runs/Shoes writes and Run Detail; successful/empty/failed start lookups,
concurrent same/distinct keys, full GPS precedence, LRU bound, UID/same-UID epoch,
late success/failure, two Routes visits and rapid exit/re-entry.

**48 new regressions**; the five targeted files pass **73 tests**. The affected
Phase 1/2A/2B regression set passes **373 tests / 23 files**. Branch production
build and full suite pass: **1,799 passed, 12 pre-existing skipped, 1,811 total /
158 files**. Typecheck passes; tracked-file lint passes with **0 errors / 99
warnings** under the 104 ceiling, and explicit lint of new tests adds none.

Phase 1 canonical Coach/Routes reuse, raw-first-500 eligibility, Workouts enrichment,
Plan Insights hydration and GPS/AppData safety are preserved. Phase 2A lazy training
retention, Health pause, return freshness and mutation guards remain. Phase 2B's
independent bounded canonical Health cache, authoritative/YTD/empty coverage,
inactive isolation, session retention and page-local All-time remain.

Local production validation uses the Phase 1/2A/2B host-compatible command
`TZ=America/New_York npm run build -- --webpack`; GitHub/Vercel use their normal
configured builds. Ignored `.next` output uses a temporary-directory symlink to
avoid Desktop cloud-sync conflict artifacts. Network permission is required for
the unchanged Google Fonts fetch. No tracked build config/dependency changed.

No Firestore rules, production test writes, owner files, Tier 2 optimizations,
new dependencies or broad architecture changes are part of this remediation.
No additional optimization implementation is currently justified by the completed
audit evidence. Protected-main delivery and final merged SHA are reported with
the release verification, after both required GitHub/Vercel checks pass.
