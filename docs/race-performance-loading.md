# Race Performance loading investigation — 2026-11-03

Baseline: remote `main` and production both pointed to
`1b3a8580253e361ff1aefd6957f59417ebb871c1`. The empty task workspace was
cloned to `training-web`, with a clean working tree and no unrelated files.
Implementation branch: `fix/race-performance-readiness`.
Production alias: `training-web-rho.vercel.app`; baseline deployment:
`dpl_GkoGF4XwNQoAZkb9mx7p8rrTd3Us`, READY, branch `main`, reported source `cli`.
Required checks were `Validate production build` and `Vercel`.

## Confirmed cause

The failure is shared browser logic, **not mobile-specific**. It was reproduced
against untouched main in real headless Chromium and WebKit at both requested
viewport sizes. No authenticated production reproduction was performed.

At baseline, `plan-insights/page.tsx:999` supplied the panel's `sourcesReady`
using an all-success test of workouts, overrides, races and plans. The provider's
`startWorkoutRefresh`, `loadPlans`, `loadRaces` and `loadOverrides` deliberately
set the latest resolution to `loading` even after a successful load. Their error
handlers retain resident values and report `error`. These semantics also protect
other consumers from computing/persisting against unresolved inputs.

Exact baseline locations: `AppDataContext.tsx:380/419` (workout loading/error),
`:515/526` (plans), `:595/606` (overrides); `RacePerformancePanel.tsx:131–132`
(unavailable branch/message); `plan-insights/page.tsx:235/915` (whole-page
plan loading/error) and `:999` (all-success performance gate).

`RacePerformancePanel` returned the reported unavailable message for **either**
loading or error. The page additionally used plan resolution as a whole-page
skeleton/error gate. A plan refresh could unmount the experience despite usable
data; any initial plan error blocked performance calculations that do not use
plans. There is no cross-source Promise.all rejection in the current provider:
independent reads settle separately, but the display gate coupled them again.

| Trigger/result | Resolution | Initial loading | Refreshing | Resident complete source |
| --- | --- | --- | --- | --- |
| Initial training activation | loading | true | false | absent |
| Successful initial result, including empty | success | false | false | available |
| Later refresh begins | loading | false | true | retained |
| Later refresh succeeds | success | false | false | replaced/merged |
| Later refresh rejects | error | false | false | retained |
| Initial request rejects | error | false | false | absent |
| UID or session epoch changes | loading | true on training entry | false | reset |

Ordinary training-to-training navigation retains the owner and does not reload
canonical sources. Health return explicitly revalidates plans/races/overrides/
settings; workouts use the existing 30-second floor and delta/full coordinator.
An eligible foreground visibility event refreshes workouts. Thus focus alone
can produce the exact reported message, and a failed refresh can leave it until
a subsequent successful retry. These triggers apply to desktop and mobile.

Auth ownership was already guarded by keyed UID/session epoch plus generation
and synchronous validity checks. The new display metadata uses those same
owners and does not introduce an independent cache or auth lifecycle.

## Correction

`AppDataContext.sourceHasLoaded` exposes the existing successful-read residency
flags. A successful empty read counts; a targeted mutation does not prove a
complete collection read. The existing resolution/loading/refreshing semantics,
query shapes, mutation protection and error logging are unchanged. Other
resolution consumers were inspected; their settlement gates remain intact.

Plan Insights and the panel now use source-specific display dependencies:

| Display | Required successful source reads |
| --- | --- |
| Current Performance, historical timeline/benchmark | races, workouts, overrides |
| Completed training totals | workouts, overrides |
| Plan-dependent faster-session intent/adherence | training inputs, plans, race linkage |
| Selected event, target and withheld race-day outlook | races |
| Existing plan comparisons | complete performance inputs and plans |

Freshness notices distinguish refresh-in-progress from refresh failure. An
initial unresolved/error source never becomes empty evidence or an estimate;
unavailable plan context does not become zero faster sessions or an absent plan.
Other page analytics are withheld when their performance inputs have never
successfully loaded. Successfully refreshed data updates the display. Removal
of the selected race selects a remaining valid race rather than retaining an
orphaned selection.

No estimator, threshold, formula, scientific validation contract or feature gate
was changed. The experimental disclosure and provisional historical status remain.
Future forecasts and numerical uncertainty remain withheld. Production research
and confirmation stay disabled. The acceptance harness was adapted to the
explicit source-state prop while retaining its original all-or-nothing gate.

Browser evidence also identified existing phone overflow: the sibling bar reached
402px and the picker extended the main content to 426–435px at a 390px viewport.
Small containment classes now bound the existing navigation, main flex child and
picker. Tables retain their local horizontal scrolling; no new navigation UI was
introduced.

## Automated and browser evidence

`RacePerformanceLoading.test.tsx` adds 24 real-provider/page integration cases:
initial pending → success/error; empty successes; delayed refresh and success;
updated workouts and removed selected races; per-source failed refresh and
recovery; partial initial failures; unrelated settings failure; incomplete
targeted patches; retired initial and refresh reads; same-UID/new-UID sessions;
390/1280-width Health-return remounts; and foreground delta failure. Each case
asserts zero retired prediction, projection, best-effort extraction or fast-finish
hydration calls under the production display gate. Existing gate, numerical
experiment, provider and hydration suites remain part of verification.

Browser runs used Playwright with **Chromium 156.0.8078.4** and **WebKit 27.2**,
headless, America/New_York, at **390 × 844** (touch/mobile) and **1280 × 800**.
Both baseline and corrected four-case matrices passed their expected assertions.
The corrected experience was verified through:

- Normal Auth emulator Google-popup sign-in and actual Next.js page entry.
- Race selection, weekly disclosure/table use and reload.
- Health navigation/remount with a delayed override query.
- Rejected background override request, resident content and visible stale notice.
- Successful revalidation/recovery and an updated workout delta.
- Simulated foreground visibility event with delayed Firebase response.
- Initial plan failure with independent performance sections still visible.
- Initial override failure with no fabricated estimate or empty history.
- Delayed initial workout loading/skeleton and successful recovery.
- Fixed mobile tabs and More-sheet navigation.
- Document width exactly 390px/1280px, including expanded weekly tables.
- Zero `route`, `hrStream` or `mileSplits` query targets in captured traffic.

The unchanged emulator setup ran Auth :9099 and Firestore :8080 with the explicit
project **`demo-race-performance-loading`**. All workout/race/plan records were
invented. The application used `NODE_ENV=development` (emulator connection) with
`VERCEL_ENV=production` (read-only release gates). No development instance used
production Firebase. Emulator-only transient rules denied the selected source
for fault injection; no repository rules, production rules/indexes or owner data
were modified. No snapshot export/import was used. Network guards blocked
production Firebase hosts; Google's Auth popup static library was allowed.

Screenshots, sanitized query/error ledgers and the local browser runner are kept
outside the Git checkout in the task workspace's `race-performance-evidence`
directory and `/private/tmp/race-loading-browser/verify.mjs`. Representative
screenshots are `before-webkit-mobile-failed-refresh.png`,
`after-webkit-mobile-failed-refresh.png`, `after-webkit-mobile-initial-core-error.png`
and `after-webkit-mobile-verified.png`. These contain synthetic data only.

## Limits and follow-up

Final local validation: **24 new / 2,821 total tests; 2,782 passed, 39 opt-in
skipped, zero failures across 208 files**, run after the successful build with
`TZ=America/New_York`. Focused affected suites passed 127 tests. Typecheck,
tracked-file lint (100 existing warnings, zero errors), and explicit lint of the
new test and changed provider/panel/banner/acceptance files passed. The two
existing Plan Insights `Date.now()` render warnings were not changed.
`npm run build -- --webpack` compiled and prerendered successfully. The initial
default build could not fetch Google Fonts in the sandbox; the network-enabled
default retry hit the documented local Turbopack port-binding restriction. The
documented webpack fallback passed on the third attempt. Repository build and CI
configuration are unchanged; required remote checks still exercise their normal
default build paths. Delivery/production SHA and branch cleanup are reported in
the task completion report.

Headless desktop WebKit with a mobile viewport is not physical iPhone Safari.
Visibility was simulated; actual Safari suspension, OS process eviction,
network handoff and iPhone persistence behavior remain owner-device acceptance.
The computer-use integration was unavailable (locked Mac and browser access
disabled in Work settings). There was no authenticated production browser
session, so the November 3 production request's precise Firebase error/source
cannot be identified. Server-side Vercel logs cannot establish client success.
Injected emulator permission errors demonstrate the lifecycle, not deployed
Console permissions; no rules change is indicated by this investigation.

Firestore's existing `getDocs`/persistent-cache contract is preserved; success
means a successful SDK read, not independent proof of server freshness. Loaded
workout history remains bounded to 1,000 and same-day deltas retain their existing
seven-day overlap. None of these observations validates a race-day forecast.

Recommended next task: investigate **Manual Performance Analysis mobile update
reliability** separately, preserving its explicit manual-run boundary. Complete
physical iPhone acceptance of this repair as part of that follow-up or earlier.
