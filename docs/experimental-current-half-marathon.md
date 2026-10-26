# Experimental current half-marathon estimate — Production release

Authorized October 25, 2026, from main `2c0f8fb6a47b48b33aa54fb3fabf72b45f9d7153`. This release supersedes the earlier requirement for independent personalized validation **only for the explicitly experimental, read-only current HM card**. It does not promote a validated contract, research UI, confirmation persistence, Coach estimate or future race forecast.

## Data path and anchor

`PlanInsightsPage` passes existing loaded raw workout parents, races and canonical overrides to `RacePerformancePanel`; all four source resolutions (including plans) must succeed. `isExperimentalCurrentEstimateEnabled()` independently names the read-only experiment and follows the accepted display rollout: Production on; development/preview exact opt-in. The pure `estimateCurrentHalfMarathon` imports no services, SDK, settings, streams, plan or persistence. No query, background job, schema, collection, rule, index, authentication or environment setting changes.

Reuse Phase 3B.2's completed-parent selector: positive distance/duration, valid completed timestamps, known summary/correction availability, canonical owner exclusions/overrides, deterministic deduplication and conflicting-ID rejection. Unplanned, out-of-plan and treadmill runs contribute. Missing HR/route/weather does not invalidate volume. Ordinary pace never becomes a race. Implausible adjustment summaries (>26.3 miles or derived pace outside 3–30 minutes/mile) are omitted from adjustment and disclosed. Individual training distances are capped at the nominal HM distance for robust weekly features; medians suppress isolated long-run outliers.

Reuse Phase 3A race integrity and confirmation evidence. Among anchors no older than 180 local calendar days, prefer verified maximal same-distance, owner-confirmed maximal same-distance, consistent provisional same-distance, then eligible confirmed different-distance evidence; recency resolves each rank. Provisional anchors require linked completed race parents, consistent duration/elapsed clocks and no identity/confirmation conflict or explicit nonmaximal effort. They are always labeled recorded/unverified; official time, maximality and conditions are not inferred. April's clock discrepancy remains excluded without explicit reconciliation. Other distances use the existing fixed Riegel `A = T × (21097.5 / sourceMeters)^1.06`; same-distance times retain nominal-distance identity rather than GPS rescaling.

At least three eligible non-race training runs across two recent calendar weeks (within 56 days) are required to display a number. No anchor or insufficient training gives an explicit insufficient-evidence reason. A conservative numerical sanity screen permits baseline HM times of 45 minutes through six hours; it is an engineering bound, not an accuracy claim.

## Explicit formula and coefficients

All coefficients below are engineering choices, **unvalidated, unfitted to owner races**, not published physiological constants or personalized confidence intervals.

Let `A` be baseline race-equivalent seconds. Compute robust weekly mileage `M`, running days `F`, and typical weekly longest distance `L` for baseline and current training. Each summary takes medians over six trailing seven-day blocks, then averages those medians across seven daily offsets. Unobserved weeks are omitted, not filled with inactivity. Baseline latest block ends eight days before the race, omitting the final seven-day taper; its smoothed six-week scope spans 48 days. Current latest block ends yesterday, excludes race days/linked race workouts, and only uses full blocks after the anchor. Today's completed runs appear in totals immediately, then enter numerical adjustment gradually. Both periods need six runs and at least four observed weeks at every offset, with positive mileage/frequency. Otherwise summary adjustment abstains; the supported race baseline can still display numerically.

Define:

```
S(x) = sign(x) × clamp((abs(x) − 0.15) / 0.50, 0, 1)
V = S(M_current / M_baseline − 1)
F = S(F_current / F_baseline − 1)
E = sign(L_current − L_baseline)
    × clamp((abs(L_current − L_baseline) − 1 mile) / 4 miles, 0, 1)
```

Positive endurance credit is withheld if robust volume or frequency falls below 85% of baseline. Longer runs alone do not automatically establish faster speed; their small bounded contribution represents an endurance-preparation hypothesis.

```
ageSupport = clamp((180 − anchorAgeDays) / 90, 0, 1)
runSupport = clamp((42 − daysSinceLastSuppliedTrainingRun) / 28, 0, 1)
support = min(1, daysSinceAnchor / 56, currentPeriodSessions / 12)
          × ageSupport × runSupport
summaryFraction = clamp(−support × [0.02 × (0.75 V + 0.25 F) + 0.005 E],
                        −0.025, +0.025)
```

The 15% relative and one-mile endurance deadbands suppress small variation; relative signals reach full strength at 65% change, endurance at five miles. Correlated volume/frequency are blended into one 2% budget, not compounded. Endurance adds at most 0.5%; summary total cannot exceed ±2.5%. No cumulative mileage credits or monotonic-improvement constraint. Missing weeks alone cause reduced support/abstention, not a deconditioning penalty. Fading removes support for a prior adjustment and is disclosed; it is not a fitted fitness-decay curve.

The existing matched-effort method remains optional evidence, rather than a prerequisite. Reuse independent closest-context pairs with existing HR (≤3 bpm), duration, route, elevation, weather, steady-label, magnitude and spread screens, at least three pairs across three weeks. Only the current Production caller extends pair search to 35 days; the research method keeps its original 28-day default. Each pair fades linearly from full weight at age 28 days to zero at 35 days. Let `N` be their summed effective weight:

```
paceWeight = clamp((N − 3) / 3, 0, 1)  # zero at three, full at six effective pairs
paceFraction = clamp(0.5 × (medianPaceRatio − 1), −0.03, +0.03)
               × ageSupport × runSupport
fraction = (1 − paceWeight) × summaryFraction + paceWeight × paceFraction
```

Without qualifying matched evidence, `paceWeight=0`. This convex blend replaces summary evidence progressively; it never adds independent full credits for correlated fitness signals. Average HR is an explicitly unvalidated effort proxy. Faster higher-HR sessions, missing weather or treadmill equipment cannot supply a comparable outdoor pace transfer. They retain valid summary mileage/endurance evidence.

Final `finishMinutes = round(A × (1 + fraction) / 60)`; displayed pace derives from those minutes and rounds to five seconds/mile. Unrounded contributions sum exactly to the unrounded adjustment; rounding is disclosed. Structured output includes anchor/source quality, baseline, finish/pace, method, component seconds/explanations, baseline/current training, recent 4/8-week context, source gaps, assumptions, version and cutoff. `validated` is literally false. No confidence interval or future-forecast field is returned.

## Scientific context and limits

[Fokkema et al. (2020)](https://repub.eur.nl/pub/127621) reports population associations between weekly volume/long endurance runs and race performance. It motivates considering preparation; it does **not** establish the numerical coefficients above, causal personal improvement, or seconds per training mile. [Vickers and Vertosick (2016)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5000509/) is the prior race-equivalence context; a fixed distance exponent is not individual validation. No study is claimed to validate this implementation. Existing research and confirmation docs remain historical descriptions of their own phases; this explicit release authorization relaxes their earlier current-output prohibition without relaxing source integrity.

## Acceptance and verification

The existing private October 25 parent capture is available locally. The optional no-network runner reuses `normalizeWorkoutResearchExport`; it requires all supplied collection scopes and writes reports only to an explicitly provided local path:

```sh
CURRENT_HALF_INPUT=/private/tmp/training-3b2-owner-research-input.json \
CURRENT_HALF_OUTPUT=/private/tmp/current-half-owner-report.json \
TZ=America/New_York npm test -- scripts/evaluateCurrentPerformance.test.ts
```

This is prior captured data, not a new live-account read. It reproduces 423 eligible runs and the September provisional approximately 2:11:11 anchor, with **~2:11 / ~10:00 per mile**, zero numerical training adjustment, 40.2 versus 46.2 miles in the four-week windows. Four observed weeks are not available across every smoothed current offset, so training adjustment abstains with an explanation while the supported numerical baseline displays. No official result, owner attestation, personalized accuracy or live-account display observation is invented. Private parents/reports remain outside Git.

Invented fixtures demonstrate a 2:11:11 baseline remaining ~2:11 with stable training, moving to ~2:09 under sustained stronger preparation, and slowing under sustained reduced training. Tests cover frequency, endurance, matched effort, higher HR, ordinary-run noise, duplicates/order/conflicts, exclusions/corrections, missing context, treadmill running, long-run outliers, frequency spikes, taper, local dates/DST, stale captures and future/sync cutoffs. Sensitivity tests sweep matched pace ratios, bounds and rolling expiries. Component totals must reconcile numerically. Real accuracy remains unmeasured.

UI tests exercise the actual Production Plan Insights route with parent fixtures and zero prediction-child hydration; historical 2:11:11 remains distinct, goal pace remains a separate display input, and March 2027 forecast remains withheld. The card shows model-generated rounded finish/pace and provisional status, with collapsed “Why this estimate?” and model assumptions. Training tables are collapsed and keep their own overflow container. Browser desktop/mobile checks use the existing isolated tooling and invented data without authentication or Firestore access.

Confirmation editing and direct persistence remain independently hard-disabled in Production; the Phase 3B.2 research UI stays disabled there. Validated `RacePerformanceResult.currentCapability` stays null. Coach, Settings, Personal Insights and Run Detail never import or receive the new number. Existing auth and other automatic application workloads are untouched; this release adds none. A normal authenticated Production mount can trigger pre-existing writes, so deployment verification must distinguish static/exact-SHA checks plus integration tests from observed live owner UI.

## Local release checks and file inventory

Production Webpack build passed with `VERCEL_ENV=production`, the legacy opt-in false, and the documented local `NODE_PATH` workaround for this checkout's external `.next` symlink. Full post-build suite: 2,545 passed / 31 skipped / 2,576 total across 200 files; 49 new cases (including the explicitly invoked optional offline capture runner). Root/tool typechecks and strict changed-file lint passed; repository CI lint retains 99 existing warnings, no new ceiling. `git diff --check` passed. Desktop 1,265 px cards measured 505 px each; mobile 390 px document/client/scroll widths all measured 390 px, including the expanded explanation. No browser warnings/errors. The temporary invented-data harness was closed/stopped and viewport overrides cleared. Screenshots and private capture report remain only under `/private/tmp/current-half-*`.

Modified files:

- `CLAUDE.md` — refresh verified suite counts.
- `PRD.md` — domain invariant and backlog for the authorized experimental current estimate.
- `src/app/(app)/plan-insights/__tests__/PlanInsightsHydration.test.tsx` — exercise actual Production route with numerical output and existing source/hydration boundaries.
- `src/components/insights/RacePerformancePanel.tsx` — model-derived current estimate, distinct history, expandable explanation and compact responsive training section.
- `src/components/insights/__tests__/RacePerformancePanel.test.tsx` — populated/insufficient Production render, explanation and responsive structure.
- `src/lib/racePerformanceGate.ts` — explicitly name the read-only current-estimate capability independently of writes and developer research.
- `src/lib/__tests__/racePerformanceGate.test.ts` — assert Production estimate-on with confirmation/research-off for all legacy flag values.
- `src/utils/workoutRaceResearch.ts` — expose existing selector/pairing reuse with unchanged research defaults and optional current-only fade window.
- `tools/race-performance-acceptance/safety.ts` — allow the audited pure current estimator in the existing isolated acceptance graph.
- `tools/race-performance-acceptance/safety.test.ts` — permit only the pure capability module while retaining service/provider restrictions.

Created files:

- `src/utils/experimentalCurrentPerformance.ts` — separate deterministic unvalidated estimate/result contract and bounded numerical contributions.
- `src/utils/__tests__/experimentalCurrentPerformance.test.ts` — 44 scenario, integrity, stability, sensitivity and explanation cases.
- `src/utils/__tests__/fixtures/currentPerformanceFixture.ts` — invented sustained-training histories; no owner records.
- `scripts/evaluateCurrentPerformance.test.ts` — optional no-network evaluation of an existing supplied parent capture.
- `docs/experimental-current-half-marathon.md` — formula, coefficients, sources, boundaries and release evidence.

Protected PR checks, exact merged main SHA and matching READY Production deployment are verified during delivery and recorded in the final report. These checks do not establish personalized scientific accuracy or observed authenticated live-account rendering.
