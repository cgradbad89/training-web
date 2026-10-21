# GPS acquisition and cache lifecycle investigation — October 21, 2026

Executive result: **PASS WITH LIMITATIONS**. Controlled synthetic reproduction explains how an Insights tab can transport another tab's raw route queries and cache writes. Independent component regressions also demonstrate inappropriate older route work after navigation/session retirement. The targeted fixes stop those continuations and bound complete route acquisition. The exact initiating tab/lifecycle of the historical production capture remains unknowable from its retained evidence. Manual Performance stays disabled; this report does not authorize reactivation.

## Attribution and actual call chains

| Observed category | Application call chain | Trigger and necessity |
|---|---|---|
| `insights/aggregatedStats` write | Personal Insights → `useAggregatedStats` → `computeAggregatedStats` → `setDoc` | Existing cache maintenance. Main freshness or VO₂ freshness mismatch causes one repair write; a valid cache causes zero writes. This is not Manual Performance publication. |
| Full GPS route reads | Run Detail cache miss → `getRoutePoints` → `fetchRoutePoints`; Runs list timer → `prefetchRoutes` → same cache; fast-finish consumers → `hydrateFastFinishSplits` → same cache | Necessary for a visible Run Detail cache miss, optional prefetch on Runs, or settled legacy prediction consumers. The old helpers could continue starting acquisitions after their owner retired. |
| Workout derived caches | Run Detail route-cache effect → `saveRunDetailCaches` | Fills missing overlay, GAP, zone and simplified-map caches from the complete route. The observed field set matches this writer exactly. |
| Four mile-split cache writes | Run Detail split-cache effect → `mileSplitCacheWrites` → `saveMileSplitCache` | Existing distance/pace/GAP cache maintenance, merging rather than replacing iOS HR fields. No other application caller writes this field set. |
| Other route-related work | Run Detail → `backfillRouteClusterIds` → bounded start-point queries and merge writes; explicit map/modal/export/settings tools and existing training-load enrichment | Separate from the captured derived-cache field set. Lifetime guards cover the automatic consumers changed here. No admin backfill is invoked. |
| Manual Performance | Panel mount → capture verified owner session → load saved `performanceState/current` | One saved document lookup. Review requires Update Performance; raw telemetry requires the second explicit Analyze confirmation. Its existing server-only document-ID queries use a separate 250-document page/budget mechanism. |

The prior raw queries used `orderBy(index)` with no limit. They cannot be new Manual Performance's `orderBy(documentId())`/`limit(250)` acquisition. PR #32 added the panel to Personal Insights but did not change the aggregate hook, Firestore initialization or these route consumers. Run Detail's source was byte-identical to its pre-#32 parent. The aggregate hook's old GPS fallback had already been removed in August.

## Real browser / emulator proof of transport ownership

The app initializes Firestore with `persistentLocalCache({ tabManager: persistentMultipleTabManager() })`. The SDK elects a primary tab that listens for other tabs' query-target and mutation notifications. The primary can send their network requests using its own browser document URL.

A separate loopback-only Vite harness used the **real installed Firebase SDK**, the same persistent cache/multi-tab manager, and `demo-training-route-investigation` on Firestore emulator port 8189. Every document and coordinate was fabricated. An Insights-role tab A established a saved-summary listener first. A Run Detail-role tab B then explicitly read nine synthetic route collections and wrote one workout cache plus four mile caches. Per-tab callsite ledgers and CDP request capture were compared.

| Measurement | Insights tab A | Run Detail tab B |
|---|---:|---:|
| Initiated route queries | 0 | 9 |
| Returned route documents at initiating callsite | 0 | 27 |
| Initiated workout/mile cache writes | 0 | 5 |
| Route query targets transported | 9 | 0 |
| Workout/mile write operations transported | 5 | 0 |
| Separately initiated aggregate maintenance write | 1 | 0 |

All nine route targets and five forwarded writes carried tab A's Insights document URL. The aggregate write was separately initiated in A. This reproduces the confusing combination of route traffic, five Run Detail cache writes and one Insights cache write without any raw route callsite in Insights.

This harness establishes the forwarding mechanism, not the historical initiating tab. It does not reconstruct which tabs were open, whether original writes were initiated before navigation, or the precise original React lifecycle. The old capture retained no application callsite correlation. No production workout data was queried for reproduction.

## Proven defects and corrections

1. **Run Detail split-read rejection after retirement:** the success path checked cancellation, but its catch path proceeded to raw route acquisition. A mounted-page integration test held and rejected that read after unmount: before, one new GPS acquisition; after, zero.
2. **Run Detail synchronous auth retirement and retained page:** a pending route result could create a derived workout cache and mile caches after the session changed or the retained page's pathname changed. Tests now enforce the current exact route and AuthContext epoch before dependent work. Core, supporting evidence, route-ID migration, cache effects and late callbacks share that ownership check. Best-effort persistence additionally rechecks after its internal parent-document read.
3. **Queued Runs prefetch:** cleanup used to clear only the initial timer. Once a batch began, later batches continued after navigation. Prefetch now checks consumer ownership and auth epoch between batches. A three-acquisition shared batch already in flight may complete for another valid consumer; no new batch starts for the retired page.
4. **Fast-finish hydration:** unbounded `Promise.all` prefilters could start raw routes after navigation or logout. Work now runs in batches of three, checks ownership around awaits, and skips retired raw acquisitions and split processing. Runs, Plan Insights and Coach also guard their exact current pathname, including retained mounted pages.
5. **Route-ID and best-effort writers:** asynchronous helper work checks ownership before its next read batch and before a new write commit. A commit already submitted while authorized cannot be recalled.
6. **Training-load enrichment:** the Runs/Workouts hook and its sequential writer now retire route/auth/HR-anchor ownership before later metadata, raw acquisition, commits or UI patches. A changed workout basis arriving during a pass is reconsidered once after settlement; own-result rerenders retain the existing convergence guard. The physiological model is unchanged.
7. **Raw route resource policy:** the shared full-route service now uses server-only pages of at most 250 documents, preserves existing index ordering with snapshot cursors, and defaults to a 25,000-document complete-result ceiling. At the exact ceiling, a one-document probe distinguishes exhaustion from overflow. Overflow or a failed server page rejects the entire result; no truncated route enters memory or creates a complete-looking cache. Run Detail presents the failure honestly.

The shared route cache still deduplicates simultaneous same-session requests and reuses completed routes across navigation. Auth retirement stops the next server page and prevents old results repopulating the cache. Navigation alone can allow a bounded already-started shared acquisition to complete; its retired page cannot consume the result for a new cache write. This is a deliberate reuse/cancellation policy, not an assertion that Firestore requests already sent can be cancelled.

Legacy aggregate-cache maintenance is preserved. The actual freshness conditions include computation version, latest workout, HR anchors, active race, overrides/loaded-workout input revision, local date/year, and separate VO₂-key/history checks. A valid cache is reused. A necessary repair may finish after navigation; no numerical model, scheduling policy or freshness semantics changed.

## Controlled React integration matrix and counts

Actual Personal Insights, `useAggregatedStats`, the panel and manual services run against instrumented synthetic Firestore/auth/context boundaries. Only chart rendering is stubbed. All three tabs, both feature-gate values, and fresh/main-stale/VO₂-stale/missing cache states were exercised. Gate choice does not change unrelated acquisition behavior. Every case has **zero raw route/HR or manual extraction calls**.

Fixture: three runs (two recent, one 90 days old), two latest-metric documents, three history metric documents and two mile-split documents for each recent run.

| Fitness/Performance state | Direct document lookups | Query targets | Returned query documents | Aggregate writes |
|---|---:|---:|---:|---:|
| Fresh | 2 | 1 | 2 | 0 |
| Main stale | 2 | 3 | 6 | 1 |
| VO₂ stale only | 2 | 2 | 5 | 1 |
| Missing | 2 | 4 | 9 | 1 |
| Workouts tab, any state | 1 | 0 | 0 | 0 |

The two direct lookups in aggregate-enabled cases are aggregate and saved current. The VO₂ freshness query is limited to 14 documents. Main repair reads recent mile splits for at most 40 runs, verified using a 45-run fixture. Remount/tab reuse after a successful repair produces no repeated split queries or repair writes. Clicking Update Performance with the small fixture reads three bounded parents, three feature lookups and current (seven documents, no telemetry). No Analyze action is simulated as an implicit mount.

| Retired-operation reproduction | Before | After |
|---|---:|---:|
| GPS acquisition after failed pending detail split read/unmount | 1 | 0 |
| Derived workout / split writer calls after pending detail route/session retirement | 1 / 1 | 0 / 0 |
| Hydration raw acquisitions after retirement, nine-run fixture | 9 | 0 |
| Hydration split computations after retirement | 9 | 0 |
| Additional prefetch raw acquisitions after first three/navigation | 6 | 0 |
| Valid active detail cache creation | Preserved | One complete acquisition and normal cache writes |
| Revisit with valid persisted detail caches | Preserved | Zero additional raw acquisitions/cache writes |

These are instrumented operation/returned-document counts, **not Firestore billing**. The real multi-tab fixture returned 27 route documents and acknowledged five cache writes; it is separate from the application integration boundary. Empty queries, cache behavior, rule-dependent accesses, index charges and retries can change billed usage. The original production returned-document and committed-write counts remain unavailable.

## Preserved behavior, limits and reactivation recommendation

- No Manual Performance source, gate or physiological model changed. Numerical HM estimate and confidence interval remain unavailable. There is no scheduler, backend processor, new collection, rule/index deployment or historical backfill.
- Run Detail still creates and reuses legitimate complete route, GAP, zone, map and mile caches. Source fields, iOS split-HR merge preservation and existing analytics remain intact.
- Source completeness is not an immutable ingestion generation. Concurrent iOS child edits during pagination cannot be ruled out. Existing completion/cache semantics remain; the new ceiling addresses bounded acquisition and honest overflow, not scientific ingestion certification.
- Multi-tab transport forwarding is normal SDK behavior and remains enabled. These changes do not provide a new cross-device transaction fence for legacy derived caches. Do not infer application initiation from a transport tab's URL.
- The separate `mileSplitsCache` retains its existing UID-scoped lifetime. Page/session guards prevent stale dependent processing; redesign of that cache's persistence/freshness is outside this targeted remediation.
- Already-submitted authorized legacy writes may finish after navigation. The fixes prevent later inappropriate work and new commits after ownership checks; they cannot recall server requests already in flight.

Keep `NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE=false` in Production. After review and separate owner authorization, a future one-run acceptance can distinguish legacy aggregate/cache activity from Manual Performance by application callsite, collection and query shape. Use a fresh isolated tab or record all same-origin tabs; capture per-operation ownership in the controlled environment. Preserve the previously selected October 14 run for that later acceptance. **Do not reactivate as part of this task.**

Validation totals, protected-main PR, final commit/deployment and operational evidence paths are recorded in the task completion report. The ordinary Vercel/GitHub build process remains unchanged.
