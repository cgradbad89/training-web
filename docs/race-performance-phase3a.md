# Race performance — Phase 3A

Implemented from `8798a3280dad5f1e14c55f6c935f6a5f15b1f2c5` on October 23, 2026. This replaces prediction claims only in explicitly opted-in development/preview builds. Production remains on its existing implementation. Manual Performance Phase 2 remains independent and unchanged.

## Output and evidence contracts

`RacePerformanceResult` separates historical observations, unavailable current capability, unavailable race-day forecast, and research-only distance equivalents. Both numerical estimate fields and confidence intervals are always null. A verified same-distance result displays its actual finish time as historical demonstrated performance; it is never relabeled today's capability. No model can promote itself to validated via a caller-supplied policy.

`Race.performanceEvidence` is an optional typed input contract for an exact confirmed revision: status, kind, known-at instant, race date, nominal meters, finish seconds, effort, conditions, provenance, and optional timing reconciliation. Phase 3A introduces no confirmation write operation, migration, collection, rule or index. Existing unannotated results remain provisional. The UI explains the specific confirmation evidence needed and links to existing race records; it does not claim that the existing race edit form persists the new confirmation contract.

Evidence tiers prioritize an official result, confirmed race/time trial, linked race workout, and an explicitly identified high-effort result. The displayed eligible benchmark respects that hierarchy, then verification status, then recency within the evidence level; the full timeline remains chronological. Status distinguishes verified, owner-confirmed, recorded/unverified, inconsistent and insufficient evidence. Ordinary training runs cannot become race outcomes from their pace. Explicitly nonmaximal efforts never enter the displayed baseline. Exact duplicate IDs collapse; conflicting IDs, excluded links, links reused by multiple races, wrong dates/types/distances and timing conflicts cannot support an eligible benchmark.

The evaluator uses actual race identity, nominal event distance and linked effective workout parents. Nominal distance never rescales recorded finish time to compensate for GPS overdistance. Duration is compared with elapsed time from parent start/end timestamps, and copied/entered timing is checked. An explicit reconciled official result can explain a recorded pause/timing discrepancy; the algorithm never silently picks the faster time.

Integrity-screen defaults are named engineering choices: 5% recorded-distance tolerance, 5m same-distance identity tolerance, timing tolerance of the greater of 60 seconds or 1%, and an older-benchmark label after 90 calendar days. These are not calibration, a personalized uncertainty range, fitness decay, or proof of current capability. The full dated evidence remains visible with reasons.

## Research methods and validation policy

The offline methods are the latest eligible same-distance result, fixed-exponent Riegel (`T₂=T₁(D₂/D₁)^1.06`), a Daniels–Gilbert/VDOT-style oxygen-cost equivalence, and the existing parent-summary-only legacy regression. The exponent is fixed rather than fitted from two same-distance races. VDOT-style numerical inversion is bounded to 1,500–42,195m and 3 minutes–6 hours; those numerical bounds are not an accuracy claim.

[Vickers and Vertosick's recreational-runner study](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/) supplies relevant population research on race equivalence, not validation of this athlete or of this implementation's fixed exponent. [V.O2's own explanation](https://support.vdoto2.com/2022/03/equivalent-performances/) distinguishes physiological equivalents from predictions and notes the influence of course, conditions and training. Neither supports converting ordinary easy runs or planned miles into a personalized finish-time forecast. No external cohort was invented or imported for this phase.

The research evaluator holds out each eligible outcome and sets the predictor cutoff to the last instant before the target race's local calendar date. Same-day and later results/workouts are excluded. Confirmed evidence must have its exact revision known before the cutoff. Later corrections, unknown confirmation history, delayed workout sync and later overrides cannot be backdated. An outcome's label can be confirmed after its race; it does not enter that race's predictor inputs.

Reports contain attempts, predictions, abstentions/rate, absolute error, signed bias (positive means too slow), cases at least five minutes wrong, eligible source IDs/status, race age groups and verified-only versus owner-confirmed sensitivity. No attempts yields null error/rate rather than a fabricated 0% success or failure. The legacy comparator omits child-derived best-effort segments, synthetic planned runs and consistency credits; it is explicitly not an exact reproduction of the full old live projection. See the companion historical evaluation report and reproducible offline script.

## Summary-only training and presentation

`buildRaceTrainingContext` applies canonical exclusions and overrides before counting completed running parents, deduplicates identical summaries and excludes conflicting identities. It provides eight Monday-start weekly mileage/session/longest-run buckets (current week partial), trailing 28-day mileage/sessions/duration/run days versus the prior 28 days, longest recent run, a descriptive ≥6mi long-run frequency/progression, recorded durations, completed-plan-match tempo/race intent, consistency over completed displayed weeks, canonical plan matching/adherence and local calendar days remaining.

Loaded history coverage is explicitly incomplete. Empty buckets mean no supplied workouts, not verified absence. Future and incomplete workouts cannot enter completed totals. Faster intent requires a supported completed match; a fast pace alone supplies no intent. Future prescriptions create no fitness credit. New summary outputs never modify canonical training-load, plan-adherence or matching calculations.

Plan Insights shows Current Performance, Training Progress, Race-Day Outlook, and separate actual-date evidence timeline entries. The March 20, 2027 Rock and Roll Half Marathon is the declared product goal when no stored race is selected; its placeholder is explicitly labeled, contains no invented result or target, and makes no write. A stored selected race supplies its own identity/date/target. Numerical forecast curves and flat filler lines are absent. The existing plan progress/adherence and load features remain.

## Gate and consumer coverage

`NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE=true` opts a development/preview build in. Unset/false is disabled. `next.config.ts` bakes `VERCEL_ENV` into `NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV` for consistent client/server decisions; `production` always disables Phase 3A even if the opt-in is accidentally present. Production activation requires separate owner authorization and a reviewed gate change. No existing remote environment variable is changed.

| Consumer | Gate enabled | Gate disabled |
|---|---|---|
| Plan Insights prediction card, prediction history, dashed future projection, consistency credit, pace/readiness claims | Replaced with evidence/training/outlook/timeline; legacy prediction and best-effort hydration bypassed | Existing behavior preserved |
| Run Detail race-time impact | Unavailable explanation; legacy impact and prediction hydration bypassed | Existing impact retained |
| Coach client/context | Dated historical benchmark/status plus null current/forecast; legacy model and hydration bypassed | Existing context retained |
| Coach API | Discards posted legacy forecast fields and instructs the model to withhold numerical forecasts | Existing prompt behavior retained |
| Personal Insights race-time/confidence card | Unavailable explanation, no fit | Existing card retained |
| Settings suggested threshold from predicted 10mi pace | Unavailable explanation; manual threshold entry/value retained | Existing suggestion retained |
| Aggregate statistics cache | Existing summary-only legacy values may still be computed/stored; they do not feed enabled prediction UI | Existing behavior retained |

## Read/write and rollout boundaries

The new panel, evaluator, training context and research harness import no Firestore reader/writer. They use already loaded parent workouts/races/overrides/plans, with zero raw GPS or HR child reads, zero new queries, zero writes and zero Vercel functions/jobs. Enabled Plan Insights never starts `hydrateFastFinishSplits`, `buildBestEffortSegments`, legacy prediction trends or synthetic projection. Coach and the replaced Run Detail impact likewise skip that prediction-specific hydration. Unit/integration tests cover enabled/disabled behavior.

This is not a global ban on existing route/HR functionality: visible Run Detail map, splits, GAP/zones, weather/cache/load/PR/route-performance paths can still acquire children; route-cluster start-point backfill remains independent. Personal Insights' existing stale-cache HR-zone aggregation can fetch mile-split child summaries for up to 40 recent routed runs; this is independent of prediction and does not fetch raw routes/full HR streams. Existing navigation-driven Runs/Routes map prefetch, explicit Manual Performance analysis, and unrelated application load/aggregate repair work retain their prior behavior. No background GPS collection, historical backfill, scheduler, native diagnostics or Phase 2.6/2.7 changes are introduced. Existing Manual Performance receipts/snapshots and local audit artifacts are untouched.

The protected-main PR is deliberately left unmerged: the project's Git-connected main branch deploys to Production, and this task explicitly withholds release authorization. Preview verification must distinguish a deployed login/build smoke check from an authenticated owner-data acceptance; neither synthetic UI fixtures nor unit tests establish scientific accuracy.

## Local verification

- 97 added cases, including one explicitly invoked offline runner: full ordinary suite **2,222 passed / 29 skipped / 2,251 total**, across 181 files. The runner separately passed against the existing frozen snapshot. Focused evidence, gate, summary, panel and hydration suite: 105 passed; consumer checks: 86 passed (overlapping existing suites).
- Typecheck passed. `lint:ci` passed with 99 existing warnings (ceiling unchanged at 104); every newly created TypeScript file also passed explicit ESLint. `git diff --check` passed. Independent review corrected duplicate inflation in the research comparator, distinguished longest run from longest ≥6mi run, and confirmed the gate's read boundary.
- The normal local Turbopack build encountered restricted Google Fonts access, then a sandbox port-binding failure. Webpack compiled and typechecked but exposed the pre-existing `.next` symlink's external module-resolution issue. After the owner explicitly authorized one additional attempt beyond CLAUDE.md's three-failure stop, the production build **passed** with `NODE_PATH=/Users/johnfolstrom/Desktop/training-web/node_modules NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE=true VERCEL_ENV=preview TZ=America/New_York npm run build -- --webpack`. The post-build full test suite passed again. No source build configuration, symlink or remote environment was changed for this workaround. Remote CI retains the repository's normal build command.

To reproduce the offline report without reading Firestore or children:

```sh
RACE_EVALUATION_INPUT=scripts/snapshots/training-web-snapshot.json \
RACE_EVALUATION_OUTPUT=/private/tmp/race-performance-evaluation.json \
TZ=America/New_York npm test -- scripts/evaluateRacePerformance.test.ts
```

The input is an existing ignored local archive, not a committed fixture; the report records its hash and fixed exported-at cutoff. A future supplied fixture can instead contain `asOf`, `timeZone`, `races`, `workouts` and `overrides`. Synthetic regression cases exercise nonempty error/abstention calculations and eligibility without claiming they are this athlete's historical results.

## Phase 3B acceptance proposal

1. Add an owner-reviewed confirmation workflow using the existing race document only after separately authorizing persistence: exact official chip result/distance/date/source, maximal effort, conditions and timing reconciliation, with revision timestamps. Reconcile April; confirm September without rewriting historical receipts.
2. Preserve immutable pre-race summary/confirmation revisions or explicit offline evidence snapshots. The two known half marathons alone cannot identify a personalized distance exponent, train and independently test a forecast, or estimate interval coverage.
3. Pre-register freshness/eligibility, same-distance/Riegel/VDOT comparators, error tolerance and useful forecast horizons. Collect additional independent maximal efforts across distances and later half-marathon outcomes. Keep calibration outcomes separate from untouched chronological evaluation outcomes; report pair counts and abstentions.
4. Enable a numerical current estimate only after demonstrated held-out accuracy and acceptable bias/large-error behavior over the eligible domain. Assess any training-context adjustment against the race-only comparator on the same held-out cases and require repeatable incremental accuracy.
5. Validate race-day forecasts at fixed lead times and validate uncertainty coverage separately before the March 2027 outlook can show numbers. Additional time, mileage, consistency, a recovery week or scheduled workouts alone cannot satisfy this requirement.
