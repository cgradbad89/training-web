# Phase 3B.2 — Workout-aware half-marathon research

Implementation starts at main `ce9fe1dd80ff6823ae5f9d3fd78b329a4d6d4c35`. This delivers a deterministic experimental estimator, completed-running signals, an offline evaluator and a separate developer preview. It does not change an application consumer, authentication, legacy predictions, confirmation persistence, Production configuration or the validated `currentCapability` contract. Merge and release require separate owner approval.

## Candidate methods and research evidence

| Method | Calculation | Evidence and limits |
| --- | --- | --- |
| A: race comparator | Most recent eligible confirmed same-distance maximal effort; otherwise a confirmed other-distance fixed Riegel (exponent 1.06) equivalent. Consistent unconfirmed linked race duration is permitted only as visibly provisional current research when no confirmed candidate exists. VDOT-style equivalence is reported separately. | Historical performance is not current capability. April's conflicting clocks cannot become an anchor without reconciliation; September's consistent clocks do not establish official time or maximality. Invalid confirmation history never falls back to an older contract. |
| B: conditional training transfer | `original race-equivalent seconds × median(recent matched pace / pre-race matched pace)`, applied once, then rounded to whole minutes. No compounding or mileage credits. | An explicit, unvalidated hypothesis: matched whole-session average HR represents comparable steady effort, and its pace contrast transfers proportionally to HM performance. This is a scenario, not established adaptation. A slower contrast can produce a slower finish. Unsupported cases return A, with the adjustment withheld. |
| C: established fitness–fatigue method | Investigated Morton–Fitz-Clarke–Banister impulse-response modeling; no finish-time equation fitted. | Requires individual performance/load calibration of gains and time constants. Existing CTL/ATL is not a race-time equation. Two unverified half marathons cannot identify those parameters and independently test them. Numeric output is withheld. |

The original [Morton, Fitz-Clarke and Banister study (1990)](https://pubmed.ncbi.nlm.nih.gov/2246166/) describes a calibrated impulse-response approach. It supports investigating training effects, not copying universal finish-time coefficients. [Fokkema et al. (2020)](https://repub.eur.nl/pub/127621) studied associations between volume/long runs and half-marathon/marathon outcomes; cohort association does not establish this athlete's causal seconds-per-mileage response. The [2014 half-marathon cohort study](https://pmc.ncbi.nlm.nih.gov/articles/PMC4041935/) combines training speed and body-fat measurements and reports substantial individual errors; those measurements/calibration are unavailable here. These methods were compared for data suitability rather than ranked by apparent complexity. No external cohort is presented as personalized validation.

### Fixed screening choices for B

`WORKOUT_RESEARCH_POLICY` records engineering screening choices, not empirically calibrated physiology. Baseline runs are in the 56 local days before the anchor; recent comparison runs are after the anchor and within 28 local days of the requested as-of date. Each run participates once in deterministic closest-context matching. At least three independent pairs spanning three recent calendar weeks are required.

Pairs require 20–90-minute sessions, duration difference no greater than 15%, average HR 40–220 with difference at most 3 bpm, the same supplied route cluster, climb-per-mile difference at most 5 m, and duration/elapsed agreement within the larger of 60 seconds or 1%. Available weather must have the same WMO condition code, temperature within 5°F, humidity within 15 points and wind within 3 mph. Weather receipts cannot be later than either capture or as-of. Treadmill sessions contribute training but cannot supply an outdoor pace transfer: incline/equipment comparability is unavailable. Explicit race/tempo/interval/fartlek/hill-repeat labels do not qualify as steady comparisons. Generic labels still leave intensity distribution unknown; opt-in assumptions remain essential.

The median ratio must be 0.85–1.15 and the full pair-ratio spread no greater than 0.10. Outliers cause abstention, not clipped improvement. Anchors older than 180 days cannot receive this transfer. None of these screens establishes equivalent physiological effort or validates the transfer coefficient. Future work must pre-register/calibrate them before independent testing. Finish minutes and five-second pace rounding are presentation limits, not accuracy intervals.

## Completed history and source integrity

The selector uses positive measured distance/duration, completed timestamps, summary availability and canonical overrides/exclusions. It includes easy, long, tempo, interval, race-pace, recovery, unplanned, out-of-plan and treadmill running. Repeated IDs/identical activity observations collapse; conflicting parents reject before an override can hide the conflict. Missing measurements never become zero. Missing GPS, HR or recorded pace does not prevent a valid run contributing volume, duration, frequency or endurance context. Calculated pace is explicitly duration/distance.

Every eligible supplied run remains inspectable. The primary descriptive window is 56 local calendar days: four-week and prior-four-week mileage, duration, sessions/running days, Monday-start weekly progression, longest run, frequency of runs at least six miles, consistency, observed gaps, and pre-/post-anchor context. Recorded type is supplied metadata, not effort inferred from fast pace. These features affect coverage, context and pairing eligibility; only accepted matched-pace ratios can change B numerically. No seconds coefficients are assigned to mileage, endurance or consistency. Empty weeks cannot establish inactivity when source coverage is incomplete.

The parent-only JSON projection ignores routes, HR streams, mile splits, enrichment caches, credentials, settings and planned sessions. It supports normalized parents or existing snapshot exports, preserves invalid historical parents as explicit exclusions, validates fixed capture/as-of timestamps and IANA timezone, and does not assume omitted race/override collections are empty. Collection coverage is scoped to the supplied query, never certified lifetime training completeness.

## Controlled October 25 owner evidence

The owner explicitly authorized one bounded memory-only session in the existing `localhost:4186` acceptance harness. It read 800 workout parents, three race records, 57 overrides and bounded active/linked plan parents. Six Firestore Lite read RPCs were observed: four bounded collection queries and two linked plan reads. The returned-source counts sum to approximately 864 parent records; this is an operation count, not an exact billing measurement. No child reads, mutations, queue, native persistent store or normal application shell was activated. One IndexedDB and two Storage capability attempts were denied before native calls; no forbidden network request was attempted. The Firebase session was disposed and its tab closed after capture. No second read was made.

The private report records retained/excluded run counts, actual date range and mileage, recent recorded types, available measurements, four-/eight-week context, pair eligibility and all three model outputs. Actual source parents and newly measured owner training details are intentionally excluded from this public repository. Two historical distance-unknown parents remain explicit exclusions and outside the current modeling windows. All-time real-world completeness is unproven, including documents lacking the query's `startDate` field.

The current research result remained the provisional September comparator, with B's training adjustment withheld. The previously documented April clock conflict and September unverified status remain unchanged. No official result, maximality, conditions or confirmation chronology was invented. C and the March 20, 2027 forecast remain withheld.

The capture used the earlier acceptance adapter, which omitted route-cluster/weather summaries. Consequently zero qualifying pairs can be established from this snapshot; this does **not** prove those fields are absent in Firestore or that fitness did not improve. The developer adapter now preserves those already-read summary fields for a separately authorized future review, adding no request. This limitation is retained in the private input/report and numerical adjustment is withheld even with explicit scenario opt-in. Raw parents, identities, exact source diagnostics and the private offline report remain outside Git under `/private/tmp/training-3b2-*`.

The older September 22 ignored archive separately supplied 786 workout parents but omitted races/overrides. Its 413 usable running parents cannot justify numeric A/B because those missing collections cannot be assumed empty. No forecast or historical accuracy was manufactured from that archive.

## Chronological evaluation and stability

An estimate may use only completed observations and revisions available by both capture and as-of. Historical dates are local calendar boundaries, including daylight-saving transitions. A current export requested at an earlier cutoff can show filtered descriptive observations, but **all numeric replay is withheld**: current mutable parents cannot reconstruct earlier revisions. Client-writable confirmation chronology remains `client_document_untrusted`. A known-at timestamp does not establish independent historical integrity.

The evaluator compares snapshots captured before a held-out race-day cutoff. Only invented fixtures receive simulated numeric error metrics. Actual owner accuracy is null: zero verified outcome labels and zero independently established real pre-race comparisons were available. There is no personalized MAE, bias, uncertainty interval or validated improvement rate. Later snapshots and later outcome/correction information cannot leak into inputs.

`docs/workout-race-research-simulations.json` is a reproducible invented-data report, not owner performance validation. Its one constructed held-out comparison gives A error/bias +5 minutes and B zero; the earlier baseline outcome has no preceding snapshot and abstains. Therefore A/B each make one of two attempted simulated predictions (50% abstention); C abstains in both. These results test arithmetic/chronology only and provide no evidence B predicts this runner better.

| Invented perturbation | A minutes | B minutes | Interpretation |
| --- | ---: | ---: | --- |
| Baseline: six matched pace pairs, median ratio 0.96 | 130 | 125 | Explicit conditional five-minute difference |
| Add ordinary 9:29/mile run without comparable effort evidence | 130 | 125 | Volume changes; no accepted pace contribution |
| Add strong higher-HR tempo | 130 | 125 | Descriptive session; increased effort is not fitness proof |
| Complete longer endurance run | 130 | 125 | Longest run changes; no unsupported endurance credit |
| Add consistent running over several weeks | 130 | 125 | Frequency changes; no invented per-session coefficient |
| Remove recent weeks of supplied running | 130 | 130 | Pace support disappears; return dated comparator |
| Add a new confirmed maximal half marathon | 124 | 124 | New anchor; old transfer is not compounded |
| Advance 51 days without new observations | 130 | 130 | Comparison window expires; no invented decay curve |

A separate slower matched-pace case returns B=135 minutes, demonstrating that the model is not forced to improve. Magnitude/spread, capture bounds, incomplete inputs, stale anchors and missing comparability cause explicit abstention.

The legacy weighted log-distance/log-time fit was reproduced on invented points using unchanged `riegelFit`. Adding a three-mile 9:29/mile observation changes a 7,865.26-second HM fit to 7,870.63 seconds: **5.37 seconds slower**. Ordinary training observations alter normalized weights and the fitted intercept/slope because training pace enters as performance evidence. Aging real observations 56 days and adding 32 synthetic planned easy runs moves the underlying fit to 9,261.42 seconds (about 2:34:21). This isolates the weighted-fit mechanism; it is not a replay of the final anchored/consistency-adjusted Production chart. Production algorithms are unchanged. B has no planned-workout input and only traceable paired observations can cause its conditional adjustment.

## Preview and isolation

Run `npx vite --config tools/race-performance-acceptance/research/vite.config.ts`, then open `http://localhost:4188/`. The invented example requires no credentials, network, backend, storage or Next build. Its six matched pairs produce A=2h10m, B=2h05m, C withheld. Review all inputs, missingness/exclusions, training bars, exact pair contributions, assumption toggle, explicit as-of form and run/week removal sensitivity. Removal is a same-snapshot counterfactual, not a historical forecast. An earlier-date selection withholds numbers and excludes later observations. JSON imports stay in process memory; reset restores invented data. Actual records must never be included in an uploaded/static preview artifact.

The full emitted standalone graph is audited to reject application shell/services/Firebase, network, storage and mutation APIs. The owner harness retains its existing independent runtime guards/read facade. All tools stay excluded from Next. Production always rejects the existing feature opt-in, and the application has no new research imports or preview route. No dependency, deployment environment, schema, rule, index, collection, automatic job, writer, GPS/HR processing or confirmation workflow change is required. The normal PR Vercel preview is the unchanged application; research review is the separate localhost tool, not an application route.

Commands and offline report reproduction are in `tools/race-performance-acceptance/README.md`. Build/test results and exact draft PR head/checks are recorded in the delivery report.

## Requirements before promotion

1. Separately authorize and perform actual race confirmation access acceptance. Reconcile April's clocks and check September's official result or explicit owner attestation; record nominal distance, time basis, effort, conditions and provenance. Do not backdate availability. This implementation submits no confirmations.
2. Establish independently trustworthy pre-race input/override/confirmation snapshots under a separately reviewed data/access design. Current owner-writable receipts are insufficient. No storage/rules change is proposed or made here.
3. Obtain independently measured comparable performance observations and additional maximal outcomes. Whole-session mean HR, route clusters and weather do not certify steady effort, identical terrain or sensor quality. If comparable pairs are unavailable, keep B's adjustment withheld rather than relaxing controls to force a number.
4. Pre-register target population, windows/screens, candidate equations/coefficients, acceptable MAE/bias/large-error behavior, abstention/coverage thresholds and required comparison sample before calibration. This phase does not invent a scientifically justified numeric sample size or acceptable-error threshold.
5. Keep calibration and untouched chronological test outcomes separate. Demonstrate reproducible incremental accuracy over A across the intended freshness/coverage domain; report matched counts, directional failures, outliers and sensitivity to race age. Two half marathons and constructed simulations do not meet this requirement.
6. Validate current capability and fixed-lead-time future forecasts separately. Establish uncertainty coverage independently before showing intervals. Completed training and goals cannot establish future adherence or March 2027 accuracy.
7. Obtain separate owner review for dormant merge, any real-data write acceptance, and eventual Production activation. Keep existing application consumers and validation gates unchanged until those decisions are explicit.

## Delivery file inventory

| File | Change | Purpose |
| --- | --- | --- |
| `CLAUDE.md` | Modified | Refresh verified test-suite counts. |
| `PRD.md` | Modified | Document experimental calculation, isolation and backlog status. |
| `tools/race-performance-acceptance/README.md` | Modified | Research preview, offline evaluation and scope instructions. |
| `tools/race-performance-acceptance/loader.ts` | Modified | Preserve already-read route/weather parent context. |
| `tools/race-performance-acceptance/loader.test.ts` | Modified | Guard summary-context preservation. |
| `tools/race-performance-acceptance/main.tsx` | Modified | Display research from the existing parent load. |
| `tools/race-performance-acceptance/safety.ts` | Modified | Permit only the new audited pure helpers. |
| `tools/race-performance-acceptance/tsconfig.json` | Modified | Typecheck standalone research sources. |
| `tools/race-performance-acceptance/vite.config.ts` | Modified | Explicit local-only gate identity for research. |
| `src/types/workoutRaceResearch.ts` | Created | Separate unvalidated input/result contracts. |
| `src/utils/workoutRaceResearch.ts` | Created | Deterministic selection, signals, A/B/C comparison and contributions. |
| `src/utils/workoutRaceResearchEvaluation.ts` | Created | Chronological synthetic comparison and input-removal sensitivity. |
| `src/utils/workoutResearchInput.ts` | Created | Parent-only offline projection and availability validation. |
| `src/utils/__tests__/workoutRaceResearch.test.ts` | Created | Evidence, comparability, missingness, chronology and stability regressions. |
| `src/utils/__tests__/fixtures/workoutRaceResearchFixture.ts` | Created | Invented dated workouts/races only. |
| `scripts/evaluateWorkoutRaceResearch.ts` | Created | No-network offline report runner. |
| `scripts/evaluateWorkoutRaceResearch.test.ts` | Created | Projection regressions and explicitly requested local archive evaluation. |
| `scripts/racePredictionStability.ts` | Created | Reproduce legacy mechanism and seven candidate perturbations. |
| `scripts/racePredictionStability.test.ts` | Created | Fixed reproducible invented calculations. |
| `tools/race-performance-acceptance/research/ResearchPanel.tsx` | Created | Gated model comparison, input inspection, dates and explanations. |
| `tools/race-performance-acceptance/research/ResearchPanel.test.tsx` | Created | Production rejection and interactive research regressions. |
| `tools/race-performance-acceptance/research/main.tsx` | Created | Standalone memory-only file import/reset. |
| `tools/race-performance-acceptance/research/fixtures.ts` | Created | Invented review example. |
| `tools/race-performance-acceptance/research/index.html` | Created | Separate developer entry, outside Next. |
| `tools/race-performance-acceptance/research/style.css` | Created | Responsive model cards, tables and training bars. |
| `tools/race-performance-acceptance/research/vite.config.ts` | Created | Audited localhost server/static build without environment files. |
| `tools/race-performance-acceptance/research/safety.ts` | Created | Emitted runtime graph acquisition/persistence audit. |
| `tools/race-performance-acceptance/research/safety.test.ts` | Created | Standalone/owner isolation and Next-exclusion regressions. |
| `docs/workout-aware-race-research-phase3b2.md` | Created | Methods, sources, privacy, limitations and acceptance requirements. |
| `docs/workout-race-research-simulations.json` | Created | Reproducible invented results; no owner data. |
