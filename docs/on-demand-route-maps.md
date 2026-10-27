# On-demand route maps — focused GPS read reduction

Implemented against `origin/main` baseline `1d04351e` on October 27, 2026.
This completes two items from the approved on-demand GPS backlog, not the
entire feature. No production workout data, database scripts, rules, indexes,
schemas, metadata migrations or iOS changes are involved.

## Baseline and changed initiators

- `src/app/(app)/runs/page.tsx` scheduled `prefetchRoutes` 500 ms after a ready
  Runs view, selecting up to 20 recent routed runs. The shared helper acquired
  complete routes in batches of three with 300 ms between batches. The page
  effect, timer, pathname-only guard and unused imports are now removed. No
  replacement prefetch was added. The shared utility remains available and
  tested; repository inspection found no other application callers.
- `src/app/(app)/routes/page.tsx` mounted `StaticRouteMap` in every recorded-run
  card. Its visibility observer invoked `getRoutePoints` and loaded OSM tiles.
  Cards now render a token-styled icon/text placeholder and native **View Map**
  button. They instantiate neither a preview renderer nor a visibility observer.
  The button stops click propagation and opens the existing Route Detail modal
  for the unchanged geographic cluster's representative run.
- Route Detail still calls `getRoutePoints`, sharing complete same-session data
  and pending acquisitions through `routeCache.ts`. Closing/reopening or navigating
  away/back does not re-acquire a valid complete cached route. The existing loading
  placeholder now has an accessible status; a failed acquisition has a visible
  error and can be retried by explicitly closing/reopening. Empty GPS keeps the
  existing unavailable message. Templates remain disabled until coordinates exist.
- `StaticRouteMap.tsx`, `routeCache.ts`, `routeClustering.ts` and
  `services/routes.ts` were inspected and remain unchanged. UID/session isolation,
  bounded server pagination and failure behavior remain in the shared mechanism.

## Preserved states and actions

Runs retains loading/empty/filtered views, year/month/distance/load/PR filters,
newest-first weekly sorting, summary statistics, calendar/week navigation,
shoe assignment, refresh/export, duplicate/excluded controls and individual-run
navigation. The current list has no user-selectable sorting control; its existing
ordering is tested after reordered input. Raw-input training-load enrichment and
all training calculations are untouched.

Routes retains source loading/unavailable/empty and clustering states; distance
filters; the newest-500-raw-record source selection; pace-selected representatives;
distance/run-count/best-pace/HR/date statistics; pace sparklines and trend drawer;
similar-run expansion and individual-run links; Route Detail close/backdrop,
loading/missing/error/map states and other-run navigation; GPS templates; and
created-route drawing, selection, editing, saving, deletion and existing previews.
The existing one/two/three-column responsive grid and modal dimensions remain;
the placeholder's centered native button uses the existing theme and focus tokens.

## Verification matrix

| Action | GPS start queries | Full GPS acquisition |
|---|---|---|
| Open Runs | Unchanged | Removed automatic prefetch; independent enrichment unchanged |
| Wait, scroll, filter, update list or return to Runs | Unchanged | No delayed/restarted prefetch |
| Open Routes | Existing geographic clustering allowed | No recorded-run preview acquisition |
| Scroll/intersect/filter recorded-run cards | Existing clustering allowed | No preview acquisition or tiles |
| Open pace trend / expand similar runs | Unchanged | No map acquisition |
| Click View Map | As currently necessary | Selected representative, through existing shared cache |
| Close/reopen pending or cached map | Existing cache behavior | Join pending work / reuse complete cached data |
| Open Run Detail | Unchanged | Existing hydration and repair unchanged |

Focused Vitest coverage uses synthetic workouts, mocked Firestore/service
boundaries and the real shared route cache/geographic clustering. Runs tests spy
on `prefetchRoutes` independently of the intentionally mocked enrichment hook.
Routes tests assert no `getRoutePoints`, full acquisition, automatic preview,
image or fetch calls before explicit map requests; simulate card intersection and
scrolling; and cover representative selection, cache/pending reuse, close/reopen,
navigation, loading, missing GPS, fetch failure/retry, late results, template saves
and created-route editing/deletion. Existing geographic parity, start-cache,
route-service pagination and enrichment tests are retained.

Validation: 84 focused tests pass. The full `TZ=America/New_York npm test`
suite passes with 2,567 passed / 31 skipped = 2,598 tests across 201 files
(11 added tests; six Runs lifecycle cases updated). `npm run typecheck` and
`npm run lint:ci` pass (99 existing warnings, no errors). `npm run build` passes.
The existing `.next` symlink targets temporary storage; local build recovery
required clearing corrupted generated Turbopack cache and supplying
`NODE_PATH="$PWD/node_modules"` for generated PostCSS module resolution.
No build configuration or dependency changes were needed.

A temporary localhost-only browser harness imported the actual Routes page,
trend components, clustering and shared cache with synthetic data/service
boundaries and an offline map-renderer stand-in. At 390×844 and 1280×900,
cards and the modal fit without horizontal overflow. Initial cards generated
zero synthetic full acquisitions; View Map generated one for the selected
representative, and close/reopen left that count at one. A fresh browser load
had no console errors. This checks responsive interaction, not live map tiles,
Firebase authorization or owner-data behavior. Production read savings cannot
be quantified from synthetic verification. No production database reads or
writes were executed.

## Explicitly deferred

- Routes automatic geographic start-point queries.
- Runs and Workouts training-load enrichment.
- Run Detail automatic route hydration and cache repair.
- Legacy prediction and activity-modal GPS consumers.
- Parent-document geographic metadata.
- Historical route metadata preparation.

Start queries remain necessary to the current grouping (±0.5 miles / 300 m,
with the existing missing-coordinate fallback). Created-route previews still use
their existing waypoint/tile behavior. Other consumers can still acquire full
GPS automatically, so observing traffic on Runs or another tab alone cannot
attribute it to the removed prefetch/preview paths. The owner-observed daily read
volume is context, not a measured savings estimate or acceptance result.
