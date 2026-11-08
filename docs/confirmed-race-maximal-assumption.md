# Confirmed races as maximal prediction anchors — the owner-approved assumption

**Status: implemented (experimental, provisional, not independently validated).** The owner chose a simpler model: for forecasting and current-performance estimation, a confirmed half-marathon result classified `hard` or `nonmaximal` is treated as a **maximal-effort anchor**, accepting some prediction inaccuracy in exchange for usable, consistent estimates. No effort percentage, coefficient, slider or discount exists; the subjective "about 80 % / 90 %" notes are never read by any model.

## Why it was needed
Saving a `hard` or `nonmaximal` confirmation made official v2, HR-enhanced and hybrid v1 lose their race anchor (their anchor accepts only a maximal confirmation or an unconfirmed recorded race). The demonstrated-race policy had fixed only hybrid v1.1 and forced it to a labelled, forecast-withheld result. One shared assumption restores all five estimators.

## What was built (one adapter, three call sites)
`treatConfirmedRacesAsMaximal(races)` (`src/utils/performance/confirmedRaceAssumption.ts`) returns a COPY of the races in which the effort of a `hard`/`nonmaximal` confirmation (legacy `performanceEvidence` and every `confirmationHistory` revision) reads `maximal`. It is applied only to the races handed to the estimators — the Plan Insights panel (official v2, HR-enhanced, hybrid v1, hybrid v1.1, forecast v2) and the two Run Detail impact hooks — behind `isConfirmedRaceMaximalAssumptionEnabled()`. A source-scan test fails if an app surface feeds races to an estimator without it, or if research/validation code uses it.

- **Stored records are untouched.** The Firebase confirmations, finish times, notes, history and timestamps are never modified (the adapter copies; the input is never mutated — tested).
- **True classification is retained** wherever it matters: dated race evidence in Plan Insights (`evaluateRacePerformance`), research harnesses, validation and the evidence-reporting paths never call the adapter and still report `hard`/`nonmaximal` and `eligibleForEquivalence: false`.
- **Nothing else relaxes.** `maximal` and `unknown` are untouched; race identity, timing reconciliation, historical availability (revision available as of the cutoff), conditions, the 180-day limit and every other integrity check run unchanged inside the estimators — the adapter cannot make an invalid confirmation valid. Strict historical replays still abstain.
- **Estimators, coefficients, the 20-run threshold, readiness and forecast formulas: unchanged.**
- **Demonstrated-race policy kept, no conflict.** With the assumption on, such races arrive as ordinary confirmed races (hybrid v1.1 shows its normal path; the forecast follows its ordinary rules). The policy remains the fallback when the assumption is switched off, and for any case the adapter does not cover.
- **One line of explanation** in Estimate Details when at least one race was re-read: "Confirmed race efforts are treated as maximal for prediction purposes."

## Rollback
`NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION=true` and redeploy restores the previous behaviour exactly (hybrid v1.1 returns to the labelled demonstrated-race result; the forecast is withheld for demonstrated-only capability). `NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE` is independent and untouched.

## Read-only comparison on the owner's records (offline, 2026-11-08; 433 workouts, 3 races read, nothing written)
| Estimator | Before confirmations | As saved (before this change) | With the shared assumption |
|---|---|---|---|
| Official v2 | 2:10:49 | insufficient evidence | **2:10:49** |
| HR-enhanced | 2:10:49 | no estimate | **2:10:49** |
| Hybrid v1 | 2:11:09 | unavailable | **2:11:09** (available) |
| Hybrid v1.1 | 2:11:18 (provisional, low) | 2:11:19 (demonstrated only) | **2:11:16** (provisional, low; normal path) |
| Forecast v2 | 2:11:18 | withheld (demonstrated only) | **2:11:16** (provisional) |

April (2026-04-26, 196 days) stays expired for current capability; September (49 days) is the anchor. Switching the demonstrated-race policy off with the assumption on changes nothing. Accuracy is still NOT EVALUABLE (0 qualified outcomes) and the assumption knowingly treats a race run below maximal effort as maximal, so estimates will tend to be slower than true capability.
