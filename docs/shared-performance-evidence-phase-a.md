# Shared performance evidence — Phase A

Implemented locally from `main` / `origin/main` at
`c301fb1c00e86971b5ae8bdd1bf47f97465921d3`. The remote main reference was checked
read-only. This delivery contains definitions, pure adapters, tests and documentation;
it does not integrate a consumer, change persisted records, or authorize release.

## Architecture decision and boundary

The owner-supplied Unified Race Performance Architecture Audit recommends a shared
evidence layer before a canonical numerical model. Personal Insights' manual system
is the foundation for dated measured observations. Its bounded extraction and
publication remain independent of Plan Insights' parent-summary experiment and of
the existing `insights/aggregatedStats` maintenance path.

Measured observations, qualified historical race benchmarks, experimental current
capability, and a future race-day forecast are different concepts. Sharing evidence
does not validate any estimate. Current validated capability and future numerical
forecast remain withheld. No validated numerical branch exists in the new contract.

The new files are `src/types/sharedPerformanceEvidence.ts` and
`src/utils/sharedPerformanceEvidence.ts`. Their only runtime dependency is the
contract's version constant. Existing model/result types are imported with
`import type`; no calculator, gate, service, SDK, auth observer, hook or extractor
is loaded through the adapters. They do not inspect environment variables, read a
clock, acquire evidence, compute hashes, evaluate qualification or publish data.

Nothing imports these modules from an application consumer or barrel. Current page
rendering, queries, writes, gates, calculations, storage schemas/paths and iOS sync
are unchanged. There is no new provider, cache, endpoint, listener, job, migration,
dependency or GPS/HR processing path. Phase A therefore adds no runtime IO or
processing cost to the application.

## Contract and adapters

`SHARED_PERFORMANCE_EVIDENCE_VERSION` is `shared-performance-evidence-v1`. Each
adapter returns a `SharedEvidenceRead<T>` with optional caller-supplied owner/epoch,
retrieval information, applicability assessment, and a dated evidence value.
These owner fields are context, not authentication or authorization checks.

| Adapter | Supplied input | Preserved output |
| --- | --- | --- |
| `adaptSavedManualPerformance` | Existing `SavedPerformanceCurrent` shape or an older receipt with a complete analysis result | Complete measured result; linked recorded race/workout observations; coverage; provenance; warnings/limitations; model/extraction/quality versions; publication and feature revision identity |
| `adaptRacePerformance` | Existing `RacePerformanceResult` | All observations, historical benchmarks, eligibility flags, timing, provenance, confirmation chronology and research equivalents; validated capability and forecast stay withheld |
| `adaptExperimentalCurrentPerformance` | Existing `CurrentHalfEstimate`, plus the caller's existing gate result | Original native numerical values, anchor, training windows, contributions, gaps, assumptions and model identity; insufficient evidence becomes explicitly withheld |
| `withholdValidatedCapability` / `withholdRaceDayForecast` | None | Null numerical fields, unvalidated status and the existing withholding reason |
| `createWithheldRaceDayOutlook` | Optional supplied goal/context | Goal retained separately; numerical forecast remains null regardless of target |

The adapters detach their output from supplied records/context. They do not mutate
inputs, round or convert numerical estimates, rescale GPS race distance, deduplicate
observations, reinterpret eligibility, or change publication hashes/revisions.

The manual input type is structural so the pure layer need not import the Firebase
types on `SavedPerformanceCurrent`. Existing persisted types, parsers and writers
are unchanged. Optional metadata supports projection of older read inputs; it does
not relax persistence validation or authorize writing an incomplete record.

An SDK `committedAt` object is neither invoked nor copied. A future authorized IO
boundary may normalize a known receipt to a UTC string and supply `context.committedAt`.
Without that supplied fact it remains null, rather than using the calculation or
retrieval clock. The complete analysis, its versions and evidence digest remain on
`value.analysis`; publication-specific versions/digests remain separate.

## Missing evidence, coverage and freshness

| Supplied result | Supplied retrieval | Availability |
| --- | --- | --- |
| Present | Any status | `available`, with retrieval/error preserved independently |
| Null | `success` | `absent` |
| Null | `error` | `unavailable` |
| Null | `not_loaded`, `loading`, or unknown | `not_loaded` |

Thus an initial source failure never becomes an empty successful analysis. A
failed refresh can retain dated resident evidence without asserting it is current.
Gate-off experimental output is an explicit withheld result and carries no supplied
estimate or numerical adjustment; the adapter itself does not evaluate the gate.

Source retrieval success does not establish workout coverage, telemetry completeness,
or current applicability. Manual coverage is copied from the saved result, including
partial/unknown states. Race/current outputs lack an explicit query coverage receipt,
so their shared coverage remains unknown. An eligible race's `availableAsOf` remains
on that observation and is not promoted to a global ingestion watermark.

The calculation cutoff, calculation start/completion, source retrieval time, and
publication receipt are separate. No missing field is populated from the current
date. Manual results retain their own timezone; race/current timezone can be supplied
explicitly because it is absent from those result objects. Current-estimate
`dataThrough` is retained as a date key with unknown workout ID. Saved summaries
cannot establish the latest included workout from a race date or feature ID list.

The default applicability is `not_assessed`. A caller may supply a separately
established assessment, but adaptation performs no age check, revision comparison,
invalidation, or recomputation. Historical evidence remains dated when source inputs
change. Parent availability watermarks and unrecorded quality-policy digests stay
null. Individual non-race workout observations cannot be reconstructed from aggregate
results and remain null.

`verified` race status is represented as `reported_verified`; owner confirmation
remains `owner_confirmed`. Neither adapter independently verifies an external source.
Original statuses, confirmation source, revision/chronology and benchmark eligibility
remain on the copied observation. Manual linked durations stay unverified and their
benchmark qualification is not assessed by this layer.

## Existing differences intentionally preserved

The owner's audit diagrams and inconsistency matrix describe independent parent,
manual, and aggregate paths. Phase A leaves that flow intact. In particular:

- Plan uses shared newest-1,000 parents; manual review uses newest-300 before run filtering.
- Plan's long-run context uses six miles and 28-day comparisons; manual preparation
  uses eight miles with a 56-day long-run window.
- Plan race integrity uses max(60 seconds, 1%) timing tolerance; manual observations
  use max(60 seconds, 2%) and a different copied-duration check.
- Different-ID identical observations have different current duplicate policies.
- Missing source timestamps can become epoch dates in the existing date adapter.
- Parent-only changes and silent child-only corrections have different detection limits.

These are not reconciled here. In particular, the missing-timestamp fallback,
race-anchor rules, numerical coefficients, selection, extraction thresholds and
manual publication logic remain unchanged. Stored snapshots retain results and
references; they are not a complete independently replayable source archive.

## Phase B handoff proposal — not implemented

1. An authorized Personal Insights consumer performs its existing saved-result read
   or receives the successfully published manual result.
2. A future lazy store retains that result and retrieval context under the exact
   authorized UID and authentication session epoch. It must reject unknown ownership,
   retire asynchronous results after replacement, and clear on logout, including a
   same-UID logout/login. The adapters do not enforce this lifecycle.
3. Plan Insights reads only that resident value by default. There is no additional
   Firestore read, feature scan, telemetry acquisition, analysis or snapshot publication.
4. A cold Plan visit says evidence is not loaded in this session, rather than claiming
   no saved analysis exists. Only a successful supplied null lookup establishes absence.
5. Plan retains its existing gated current-HM calculation and parent-only fallback.
   A manual publication alone must not alter that experimental numerical result.

Before Phase B, the owner must decide whether to permit an optional one-document
cold read of `performanceState/current` when Plan Insights is visited first. That
adds a read in Plan-only sessions and is not assumed cost-neutral. Also decide
revalidation/cross-tab behavior, user-facing freshness wording, and how to present
known changed inputs without rewriting historical results. Automatic analysis,
polling, source scans, GPS/HR backfills and new persisted collections are excluded.

Numerical use of manual steady features, canonical race qualification changes,
independent historical validation, trustworthy evidence retention, and any future
race-day forecast require separate work and owner approval. Goal/context must never
become a current-capability input or be relabeled a numerical forecast.

## Verification

Focused tests cover existing/legacy saved results, publication/version identity,
partial coverage, initial failures versus absence, resident refresh failures,
dated evidence/applicability, confirmation distinctions, experimental gating,
withheld outputs, target separation, detached inputs and numerical/eligibility
characterization against existing pure calculators with invented fixtures.

The dependency tests inspect emitted runtime imports and scan application source
for consumers/barrel exports. They ensure the new layer remains pure and unwired.
Network/clock/timer guards exercise adaptation only; test fixtures make no Firebase
requests. Local results:

- Focused suite: **34 passed**. A separate no-emit TypeScript check of the new
  contract, adapters and tests also passed.
- Full post-build `TZ=America/New_York npm test`: **2,822 passed / 39 skipped /
  2,861 total**, across 209 files (198 passed, 11 skipped). Data-access/backfill and
  emulator opt-ins were explicitly unset. No opt-in real-data acceptance ran.
- `npm run build -- --webpack`: **passed**, compiled and prerendered all pages.
  The first default `npm run build` attempt hit the documented sandbox Turbopack
  compiler IPC port-binding restriction (`Operation not permitted`); the second
  attempt used the existing Webpack fallback. Build configuration was unchanged.
- `npm run typecheck`: **passed**. The initial attempt found four numbered
  generated `.next/types/* 2.ts` conflict copies; only those copies were removed
  under CLAUDE.md's documented generated-artifact cleanup rule. No source or
  Desktop synchronization configuration was changed by that cleanup.
- `npm run lint:ci`: **passed**, 100 existing warnings / zero errors. Explicit
  ESLint of all three new TypeScript files with `--max-warnings 0` passed.
- Source dependency checks passed. The shared contract marker and adapter-specific
  withheld reason were absent from emitted application JavaScript in
  `.next/static/chunks` and `.next/server/app`.
- `git diff --check`: **passed**. No pre-existing calculation, type, service,
  page, gate, schema, rule, index, configuration or synchronization file changed.

There are no application runtime IO/processing changes and no commits, pushes, PRs,
merges or deployments. Production permissions, device behavior and scientific
accuracy are not inferred from these local checks.
