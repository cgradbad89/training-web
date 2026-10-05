# Phase 1 training-data reuse and lifecycle correctness

Baseline: `2275f76f98d0d3827d48de21a221e5ccf07ad445` on `main` / `origin/main`, 2026-10-05.

Coach now uses AppData's raw workouts, override map, plans, races and settings,
with the existing effective selector and full/delta reconciliation contract.
Its own 30-day Health read and conditional fast-finish preparation remain local.
Changed canonical inputs invalidate prepared context immediately; effect cleanup
rejects obsolete asynchronous preparation. Context rebuilding does not reset the
URL question submission guard or submit an AI request.

Routes uses canonical raw metadata and settings. Its eligibility pipeline stays
`raw newest 500 -> isRunLike && hasRoute -> geographic clustering`. Created-route
CRUD, geographic distance/start-point thresholds, and demand GPS remain intact.

AppData restores UID ownership on each effect setup, including Strict Mode's
replay. Cleanup still invalidates the request generation and workout coordinator.
Workouts enrichment uses raw non-run source fields; enrichment and Plan Insights
fast-finish hydration require successfully settled settings. A missing settings
document is successful and deliberately selects defaults. Plan Insights only
hydrates for a half-or-longer selected prediction, and associates results with
the exact current race/plan/run/anchor inputs.

GPS resolved/in-flight maps use an explicit JSON `[uid, workoutId]` key. The
existing auth observer advances a memory epoch and clears both maps on logout,
UID change, and auth-provider disposal. Logout/login as the same UID starts a new
epoch. Old requests cannot cache results or remove replacement in-flight entries;
retired prefetch loops stop before starting another batch. Same-session cache and
in-flight reuse remain enabled. No route-start cache or TTL policy was added.

## Mock service invocation evidence

W = workout metadata; P = plans; R = races; O = overrides; H = settings/HR anchors.
Counts are normal mounts under the real AppDataProvider, with all data services
mocked. The baseline was tested in a temporary checkout of the SHA above; current
assertions are in `CoachPage.test.tsx` and `RoutesPage.test.tsx`.

| Surface | Provider, before and after | Page before | Page after |
| --- | --- | --- | --- |
| Coach | W1000 P R O H | W1000 P R O H + Health30 | Health30 |
| Routes | W1000 P R O H | W500 H + createdRoutes + geographic start reads | createdRoutes + geographic start reads |

The baseline mock run confirms two invocations of each Coach training service
and two Routes W/H invocations. Current integrated tests assert one provider
invocation of each service, retain Health30/createdRoutes, and defer full GPS to
its existing demand path. This eliminates five Coach and two Routes service/query
invocations per normal page mount; it is **not measured Firestore billed-read
savings**. Strict Mode development replay is tested separately from these counts.

Focused regressions also reproduce the baseline Strict Mode ownership failure,
unsettled Workouts enrichment, unnecessary Plan Insights hydration, and cross-UID
GPS collision, then pass against the corrected implementation. Tests use mocks;
no production navigation, Firestore writes, or rules deployment is involved.

The shared newest-1000 history, seven-day delta, later-local-day full reconciliation,
queued full promotion, persistence-first publication, prediction/load formulas,
Health bypass, Run Detail narrow reads, and AutoMatch/PR runner policy remain.
Phase 2 session retention and Health cache architecture are deferred by scope.

## Local validation

46 regression tests added; focused affected suites: **124 passed** across 10 files.
`TZ=America/New_York npm run validate -- -- --webpack` passed typecheck, lint
(zero errors, 103 warnings within the 104 ceiling), the complete suite
(1646 passed, 12 skipped; 1658 tests / 153 files), and the production build.
The local default Turbopack build hit the host's compiler-port restriction;
Webpack was selected only through CLI arguments. Repository build scripts and
GitHub/Vercel default production build configuration remain unchanged.
