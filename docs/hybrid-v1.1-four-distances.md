# Hybrid Performance Model v1.1 — four-distance current-fitness estimates

**Status (2026-11-08):** implemented; experimental; accuracy **NOT EVALUABLE** (0 qualified outcomes at 5K / 10 mi / marathon, 0–1 at the half marathon; the pre-race checkpoints in the owner data are unavailable under strict historical availability). No coefficient was fitted to any outcome.

Personal Insights → Race Readiness → **Predicted Race Times** now shows one table of Hybrid Performance Model v1.1 estimates for the **5K (3.10686 mi), 10 miles, half marathon (13.1094 mi) and marathon (26.2188 mi)**, replacing the legacy Riegel-fit presentation there.

## What the table is — and is not

It answers *"what could I reasonably race **today**, given what I have demonstrated?"* It is a **current-fitness** estimate. It takes no credit for training that has not happened, a taper, weather or a course. The **race-day forecast** for the March 20, 2027 half marathon (Plan Insights → Race-Day Outlook, forecast v2) is a separate output, built on the half-marathon estimate; it, the official v2 estimate, the HR-enhanced estimate and the legacy planned-entry projection are unchanged and keep their own labels.

## One estimator, four targets

`estimateHybridHalfMarathonV11` (`src/utils/performance/hybridPerformanceV11.ts`) already took a target distance; it is now driven by a **target profile** (`hybridTargetProfiles.ts`) for each row. Everything about the *evidence* is shared and unchanged:

| Shared (unchanged) | |
|---|---|
| Evidence qualification | `performance-evidence-v1.1` — confirmed/recorded races, race-labelled runs, strong whole-run efforts (athlete-relative effort screen), sustained segments; partial routes, timing discrepancies, owner-corrected runs and implausible values excluded; one item per workout and per local day; 180-day limit |
| Combination | `performance-capacity-v1.1` precision-weighted two-group pooling; age drift 1 %·√(days/30); common-mode terms; isolated/slower-effort rules; no double counting |
| Physiology | aerobic-trend term (pace at fixed HR), shrunk by precision, ±2 % cap; VO₂ corroborates only |
| Endurance | readiness score (long run / volume / frequency vs the **target** distance); at-target change term ±1.5 % |
| Combination of adjustments | correlated terms never added (larger + ½ smaller); total ≤ 3 % |
| Confidence | insufficient evidence lowers confidence/status, never the number |
| Reporting | evidence mix, sensitivity range (assumption sensitivity, never a statistical interval), flags |
| Time | as-of cutoff; availability timestamps; no future observation can enter |

A profile changes **only** distance-dependent parameters:

| | 5K | 10 miles | Half marathon | Marathon |
|---|---|---|---|---|
| Conversion σ per ln-distance, shorter source | 0.02 | 0.02 | 0.02 | **0.04** |
| Conversion σ per ln-distance, longer source | **0.03** | 0.02 | 0.01 | 0.01 |
| Exponent for longer source (HM→5K) | 1.06 (sens. 1.02–1.10) | 1.06 (1.03–1.09) | 1.06 | — |
| Exponent ceiling at zero readiness (shorter source) | 1.10 | 1.12 | 1.12 | **1.15** |
| Physiology / endurance-change weight | 0.75 / 0.5 | 0.9 / 0.75 | 1 / 1 | 1 / 1 |
| Endurance floor (withhold below) | none | 0.2 | 0.2 | 0.2 **+ durability** |
| "Direct evidence" ratio (for confidence) | within 2× | within 2× | not applied | within 2.05× |
| Finish-time display rounding | 15 s | 30 s | 60 s | 60 s |

The **half-marathon profile equals the pre-existing constants**; a golden regression test (values captured from `origin/main` `f369e678` *before* the change) and a structural-equality test across eight worlds enforce bit-for-bit equality, and the legacy entry point (no profile, used by Plan Insights and the forecast) is untouched.

All values are engineering assumptions in the same sense as the rest of v1.1. Why they differ by distance:

* **5K** is speed/VO₂-limited. A half-marathon result converts to a 5K only with real uncertainty, so the 5K is **provisional / low confidence unless at least half of its base comes from evidence within 2× of 5K** (a 5K–10K race, or a sustained 5K/10K segment). A slow training run is never evidence: only the qualified items above ever enter.
* **10 miles** reuses the same evidence with an interpolated Riegel conversion; a recent *longer* performance (the half) counts toward the endurance floor because it already demonstrates the endurance.
* **Half marathon**: unchanged.
* **Marathon** is durability-limited. It is **withheld** (`insufficient_endurance_preparation`) when the longest recent non-race run is under 12 miles or fewer than four recent weeks are recorded; **provisional and low confidence** when the mean of the three longest weekly long runs is under 16 miles or typical weekly mileage is under 20; and the conversion exponent rises toward 1.15 as readiness falls. Marathon-distance evidence carrying ≥ 50 % of the base demonstrates durability directly and waives these gates. Because a half-marathon base alone is a converted proxy (σ ≈ 2.8 %), the marathon is *provisional* until marathon-distance or corroborating long-effort evidence exists, even when every durability check passes.

## Output contract

`CurrentFitness { version: "experimental-hybrid-v1.1-targets-1", asOf, asOfDate, rows[4], consistency }`. Each row: distance and label, status (`available` / `provisional` / `unavailable`), displayed finish seconds (rounded to the profile increment; exact value in `estimate.seconds`), pace per mile (5 s), confidence (`moderate` / `low` / none), evidence quality (`adequate` / `limited` / `insufficient`), as-of, the unavailable cause and a plain-language reason, provisional reasons, flags and the full v1.1 estimate. Existing v1.1 terminology is preserved. The UI maps `unavailable` → "Insufficient evidence", `provisional` → "Low" plus all applicable restriction explanations, `available` + `moderate` → "Moderate". The column is labelled **Evidence quality** (qualitative, not a calibrated probability). Low-quality `available` rows also explain their restrictions. Both Insights surfaces use structured restriction codes rather than inferring a conflict from low quality; simultaneous restrictions are retained.

## Cross-distance consistency (checked, never forced)

Between adjacent available rows the implied Riegel exponent `ln(T₂/T₁)/ln(D₂/D₁)` must lie in 1.00–1.20 (pace never decreases with distance). Outside it, both rows are flagged `inconsistent_with_adjacent_distance` and downgraded to provisional / low; **the numbers are not clamped**. Observed on the owner's data: 1.054–1.084 on every one of 49 daily replays.

## Race anchors (Phase 1 verification)

The owner's confirmed April (2:15:30, ≈80 % effort) and 2026-09-20 (2:11:11, ≈90 %) results are prediction anchors via the shared adapter `treatConfirmedRacesAsMaximal` (PR #85, already in `main`; verified by its tests, 37 passing, and by the new tests). The stored attestations are never modified; the adapter re-reads `hard`/`nonmaximal` as `maximal` in a COPY handed to the estimators; `unknown` stays unadmitted; the labelled demonstrated-race policy remains the rollback fallback. The Personal Insights table uses exactly this adapter.

## Data and cost

No new collection, field, rule, index or write. The table computes in memory from the already-loaded shared data (`AppDataContext` races/workouts/overrides) and reuses the page-level, session-scoped VO₂ / HR-stream stores Plan Insights uses (`usePhysiologyEvidence`, bounded: observed 71 + 22 reads per session, shared between the pages). It is enabled by the same gate as the hybrid v1.1 row (`isExperimentalHybridV11Enabled`); with `NEXT_PUBLIC_DISABLE_HYBRID_V11=true` Personal Insights shows the previous "Numerical race predictions unavailable" card (Production) or the legacy fit (gate off).

## Evaluation (owner data, read-only aggregates, as of 2026-11-08)

`scripts/researchHybridTargets.ts` (env-gated, read-only; aggregates only). Observed:

| Distance | Time | Pace/mi | Status / confidence | Evidence |
|---|---|---|---|---|
| 5K | 28:30 | 9:10 | provisional / low | 60 % a 6-mile effort (21 d), 40 % the September race (49 d); sensitivity 26:52–29:34 |
| 10 miles | 1:37:30 | 9:45 | provisional / low | 96 % race, 4 % effort; physiology −60 s |
| Half marathon | 2:10:00 | 9:55 | provisional / low | identical (7,796.829 s) to the pre-existing v1.1 on the same inputs |
| Marathon | unavailable | — | insufficient endurance preparation | readiness 0.10, longest recent run 9.2 mi, 10.3 mi/week |

* Half-marathon parity with the pre-existing estimator: **identical** (to the millisecond; the pre-change code path was run on the same loaded data).
* Stability over 49 daily as-of replays since 2026-09-21: largest day-to-day step 0.69 % (5K), 1.01 % (10 mi), 1.05 % (half) — the half figure is the pre-existing v1.1 behaviour (the 20-run and 180-day cliffs in `docs/hybrid-v1.2-policy-study.md`), inherited, not introduced.
* Cross-distance exponents 1.054–1.084; 0 inconsistent days.
* **Accuracy: NOT EVALUABLE.** Strict as-of checkpoints before the April and September races are unavailable (no race record or confirmation existed yet — see `docs/april-september-backtest-case-study.md`), so there is no prediction/outcome pair; the existing counterfactual replay put the half-marathon estimate +328 s (+4.2 %) slower than the September result. No qualified 5K, 10-mile or marathon outcome exists. Small samples are never presented as accuracy.
* Optimism / pessimism screens (unit-tested): the marathon is never faster than the unadjusted Riegel (1.06) conversion of the half (×0.999 tolerance) and sits 2.05–2.30× the half-marathon time across the test athletes; a less-prepared athlete's marathon is slower than a better-prepared one's from the same half result; 5K and 10-mile estimates equal the Riegel conversion to within 0.5 % when only a half-marathon race exists (the 5K is flagged provisional for exactly that reason).

## Known limitations

* **Marathon:** half-marathon ability is a proxy, not proof. The marathon is withheld or provisional by design; the 12 / 16-mile and 20-mile-per-week thresholds and the 1.15 exponent ceiling are engineering assumptions with no outcome evidence. A real marathon (or a long, steady 20-mile effort evidenced as such) is the only way to make it `available`.
* **5K** from a half-marathon base is a long conversion (σ ≈ 4–6 %); the sensitivity range (about ±5 %) is the honest width. A recent 5K–10K race or sustained segment is what tightens it.
* Effort qualification is distance-agnostic (HM-equivalent top-range screen against the athlete's own year); a fast 5K tempo may be classed against HM-equivalent pace.
* All four rows share one evidence set, so their errors are correlated; the table is not four independent predictions.
* Accuracy is unverified; confidence labels describe *evidence quality*, not a calibrated probability.

## Intentionally retained legacy behaviour

* The standalone `fitRiegel` presentation remains only as the gate-off compatibility path (local development without the experiment); it is not rendered where the hybrid v1.1 gate is on.
* Plan Insights numerical results, forecast v1/v2, official v2, HR-enhanced and hybrid v1 are unchanged. Plan Insights v1.1 shares the corrected evidence-quality explanations.

Recovery validation and browser/Admin timestamp parity are documented in [the v1.1 technical reference](hybrid-performance-model-v1.1.md#9-research-timestamp-parity-and-recovery-validation-2026-11-08). Historical observed evaluation values above remain audit findings, not a newly verified owner-data result.
