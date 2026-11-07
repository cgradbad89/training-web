# Phases 3Q–3T — evaluation of the hybrid model, sensitivity and the March 2027 forecast

**Nothing here changes the official estimate** (`experimental-current-hm-v2`), the HR-enhanced estimate, race-anchor policy, saved races, immutable checkpoints, the March 20, 2027 enrollment/capture schedule, or any stored value. The research module (`src/utils/research/hybridEvaluation.ts`) and `scripts/researchHybrid.ts` are never imported by live code (test-enforced) and the live script is read-only.

**Evidence labels.** *Observed* = measured **2026-11-07 17:00 UTC (America/New_York)** by `scripts/researchHybrid.ts` on the owner's data, read-only and bounded: 227 workout parents since 2026-01-01 (field-masked), 3 races, 58 overrides, 4 plans, 66 VO₂ readings since 2026-06-01, and HR-stream chunks for the 20 most recent steady outdoor runs (≤ 40 chunk documents each). Aggregates only: no identifiers, coordinates, per-sample or per-run values appear here; nothing was written; the private capture lived outside the repository and was deleted. *Synthetic* = deterministic invented fixtures in the tests. Coefficients were **not** fitted to any race outcome.

## 1. Six kinds of evidence, kept apart

| Kind | Status | Basis |
|---|---|---|
| Engineering correctness | **Established** | 128 new test cases (127 passing; 1 live-only test skipped by default) covering the engine, physiology, hybrid, forecast, evaluation harness, panel/UI, gates and report builder; all as-of, determinism, order-independence, timezone and leakage properties tested (synthetic). |
| Evidence availability and coverage | **Observed** (§2) | Hybrid available on 48/48 replay days; official v2 48/48; HR-enhanced 13/48. |
| Numerical sensitivity | **Observed** (§4) | Largest single-run influence on the hybrid 32 s (0.41 % of race time); largest day-to-day step 6.2 s (0.08 %). |
| Physiological plausibility | **Observed** (§3) | All screens pass; no sustained aerobic change detectable (t = −1.1). |
| Historical as-of behaviour | **Observed** (§4) | Strict chronological replay 2026-09-21 → 2026-11-07; no later data can enter (tested). |
| Independent predictive accuracy | **NOT EVALUABLE** | **0 independent qualified outcomes** (≥ 5 required; threshold unchanged and not weakened). |

## 2. Evidence and coverage (observed)

| | Count |
|---|---|
| Run-like workouts | 135 (outdoor with complete best-effort segments 93; outdoor with weather 55; with an HR stream 135) |
| Tier 1 confirmed maximal | **0** |
| Tier 2 strong, unconfirmed | 4 (1 recorded race, 1 whole-run effort within 180 days, 2 whole-run efforts 287–293 days old → **expired, no weight**) |
| Tier 3 ordinary training | 99 (counted; never a numerical source) |
| Tier 4 unsuitable | 32 |
| Exclusion reasons | timing discrepancy 28 · heat-inflated HR 15 (no strong label) · treadmill/no route 16 · partial route 3 · inconsistent race record 1 (the April race: duration vs elapsed clocks disagree, still not reconciled) |

Independent evidence used on 2026-11-07: **two items** — the Sep 20 half marathon (recorded, unverified, 48 days) and one strong whole-run effort (≈ 9.7 km, 20 days). Critical speed (method B) is **unavailable** (0 of the ≥ 3 qualifying 2–20-minute efforts), as expected for an athlete who has not time-trialled.

## 3. Current predictions on 2026-11-07 (observed)

| Model | Value | Status | Evidence actually used |
|---|---|---|---|
| Official v2 | 2:11:01 | experimental | race anchor, training-summary volume |
| HR-enhanced v1 | 2:11:01 | `no_change` | race anchor, pace at comparable HR, training summary |
| Capacity A (race equivalence) | 2:11:11 | available | recorded race (VDOT cross-check differs by 0.0 %) |
| Capacity B (critical speed) | — | unavailable | needs ≥ 3 strong 2–20 min efforts |
| Capacity C (recent demonstrated) | 2:11:11 | available (1 item counted) | recorded race; the slower strong effort ignored (maximality asymmetry) |
| **Hybrid v1** | **2:11:17** | provisional · confidence low · evidence limited | demonstrated performance, race history, endurance readiness (+5.8 s) |
| Hybrid assumption range | 2:11:11 – 2:11:17 | not a statistical interval | |

* Hybrid − official = **+15 s**; hybrid − HR-enhanced = +15 s; hybrid − its own capacity base = +5.8 s. The hybrid is slower than v2 on all 48 replay days (mean +29 s, max +50 s). The models **agree** because there is exactly one race and the strong contemporary effort is slower than it; neither is "closer to the truth" — there is no outcome to compare with.
* **Do the models use different evidence?** Yes in construction (v2/HR-enhanced: anchor + volume heuristics + HR band; hybrid: independent efforts + trend + readiness), but on this athlete's data today all of them rest on the same single recorded race, so their *values* are nearly identical. The independent-evidence design pays off when the anchor expires (v2 and HR-enhanced go silent; the hybrid can still answer from strong contemporary efforts — see §5) or when a faster contemporary effort exists.
* **Physiology:** pace at fixed heart rate, duration, climb and temperature: **−0.85 % per 28 days, t = −1.1, 23 runs / 12 weeks → no detectable change**; weather adjustment estimable (55 of 135 outdoor runs have weather). Trimmed-stream variant on the 20-run sample: −0.76 % per 28 days, same conclusion. VO₂ max: recent 47.3 vs prior 47.7 (20 readings, no discontinuity) → inconclusive. Physiological family: `no_effect`.
* **HR streams (3R.1, observed):** of 20 streams, 14 good, 6 limited, 0 unusable; 6 interval-like (30 %); median detected warm-up at the 120 s floor; **warm-up trimming changes a run's mean HR by a median of +0.9 bpm (range +0.3 to +7.2)** — the parent average HR is a decent proxy for most steady runs, and the stream matters mainly for interval-like or long warm-up sessions.
* **Readiness:** 0.34 (longest run 8.3 mi, ≈ 10 mi/week, 2.7 runs/week; long-run 0.53, volume 0.03, frequency 0.36).

## 4. Sensitivity and as-of behaviour (observed)

* **Leave-one-out** (20 recent or evidence runs removed one at a time): max shift 32 s (0.41 %), p90 16 s, 20.6 s for removing an evidence item, **0 availability flips**.
* **Daily replay** (48 instants): hybrid 48/48 available, status `provisional` throughout; maximum day-to-day step 6.2 s (0.08 % of race time), mean 2.3 s — the estimate moves smoothly as evidence ages, and is not artificially static (range over the period ≈ 46 s).
* **Retrospective sanity check:** as-of dates 35, 21, 14, 7 and 1 days before the Sep 20 race all give *unavailable* for every model: the only earlier race (April) has unreconciled clocks and the earlier strong efforts have expired. No prediction→outcome pair exists, so nothing can be scored.

### What the first real-data pass found, and what changed

A first pass (before the fixes below) gave a hybrid of 2:12:24, available on only 32 of 48 days, with a 94 s maximum daily step. Those were defects, not data limits:

1. **Availability cliff.** A hard readiness cut-off flipped availability between days (the same pattern Phase 3O removed from the HR signal). Fixed: readiness is smoothed over 7 daily offsets and endurance *support* is `max(readiness, share of the base demonstrated at ≈ the target distance)`. Result: 48/48, max step 6.2 s.
2. **A submaximal effort dragged the estimate slower** (+2.3 % on the day it appeared). A slower unconfirmed effort is exactly what a submaximal effort looks like and says nothing against a race. Fixed: it is ignored when slower than the race anchor (flag `slower_unconfirmed_effort_ignored`).
3. The synthetic test for an isolated fast run showed a single unconfirmed run could move the estimate 5.3 %. Fixed: an isolated, uncorroborated, much-faster unconfirmed effort is down-weighted (flag `isolated_fast_effort`).
4. A percentile-only strong-effort rule classified 12–22 ordinary runs as strong in a synthetic test. Fixed: absolute margins over the athlete's typical run.

## 5. Synthetic scenarios (3T.2; deterministic fixtures — **not** owner data)

Athlete: recorded HM 2:11:11 on Sep 20, three runs a week, long run 8 mi. Δ is relative to the baseline hybrid (2:11:12).

| Scenario | Status (cause) | Δ vs baseline | Reading |
|---|---|---|---|
| Baseline | provisional | 0 | single unconfirmed race → low confidence |
| Faster at same HR, −5 % / −2 % | provisional | −1.07 % / −0.53 % | direction right, bounded by shrinkage and the 2 % cap |
| Slower at same HR, +5 % | provisional | +1.03 % | deteriorations are allowed |
| More volume, no speed gain | provisional | −0.02 % | volume alone does not create speed |
| Short-distance speed, weak long runs (no race) | provisional | −3.27 % | exponent uplift costs time |
| Same speed, well prepared | provisional | −7.67 % | 4.4 % faster than the weak-long-run athlete from the same efforts (fixture efforts imply ~2:01, unrealistically fast by design) |
| Short-distance speed, almost no long runs | **unavailable** (`insufficient_endurance_preparation`) | — | capacity still shown separately |
| Long run 12 vs 6 mi, HM race base | provisional | −0.02 % | race already demonstrates the endurance |
| Training collapses after the race | provisional | +0.13 % | tiny, bounded; no cliff |
| Taper (final-week volume ×0.5) | provisional | 0.00 % | taper is not read as deconditioning |
| New faster race 2:05:00, 13 days ago | provisional | −3.06 % | moves toward it with recency weight |
| Anchor age 179 / 180 / 181 days, nothing else | provisional / provisional / **unavailable** (`anchor_expired_no_contemporary_evidence`) | −0.02 % / −0.02 % / — | clean transition at > 180 d |
| Expired race + two strong efforts | provisional | −1.25 % | numeric without a race anchor |
| Hot recent weeks, weather known (84 °F) | provisional | 0.00 % | heat is not read as lost fitness |
| Hot recent weeks, weather missing | provisional | +1.18 % (cap 2 %) | read as an `observed_decline` and flagged `weather_unadjusted`: heat and fitness cannot be separated without weather, so the slowdown is seen but bounded and listed as unsupported/missing |
| Three HR sensor artifacts | provisional | 0.00 % | robust |
| One fast high-HR run | provisional | −2.73 % | `contradictory_evidence` + `isolated_fast_effort`, low confidence |
| Two corroborating fast efforts | **available** · confidence moderate | −0.74 % | corroboration raises evidence quality |
| Sparse training (2 runs/week, 8 mi long) | provisional | −0.02 % | readiness lowers confidence, not the number |

Where it is uncertain: with a single unconfirmed race the model cannot say more than the race does, and says `low` confidence; critical speed is unavailable without time trials; a pace-at-HR trend cannot separate heat from fitness when weather is missing; no scenario can say whether the *effort* in any run was maximal.

## 6. March 20, 2027 Rock and Roll Half Marathon — forecast (observed, provisional)

| | |
|---|---|
| Days to race / evidence age on race day | 133 / newest strong effort will be 153 days old |
| Current capability (separate output) | 2:11:17, provisional |
| **Central forecast** (plan at the athlete's recent adherence) | **2:09:29**, provisional, experimental |
| Scenarios | maintained 2:11:17 (0 %) · plan at adherence 2:09:29 (−1.36 %, central) · plan completed 2:09:15 (−1.55 %) · lapses 2:11:41 (+0.31 %) · taper: context only, no numeric credit |
| Assumption range | **2:06:31 – 2:14:27** (capacity-drift allowance ±2.1 % over 133 days plus scenarios; *not* a statistical interval) |
| Plan | 64 remaining planned runs / 355 mi, longest 13 mi; recent adherence 93 %, used 85 % (cap) |
| Readiness | now 0.34 → 0.86 at the start of taper if the plan is done at 85 % |
| Course / weather | unknown / `climatology_unavailable` |

**A working experimental forecast was produced, and what it rests on is narrow:** the −1.4 % vs current capability comes *entirely* from the engineering readiness-change term (bounded at ±1.5 %) applied to a projected rise in endurance preparation. **No fitness gain is assumed from planned training**, taper is context only, weather and course are unknown, and the evidence behind current capability will be older than the 180-day currency limit on race day. It should be read as "if the plan is largely done, endurance preparation is better than it was for the September race", not as a prediction of a PR.

## 7. Promotion and next evidence

No promotion is proposed. The Phase 3O criteria (coverage, ≥ 5 independent qualified outcomes across ≥ 3 anchors, paired error vs official, stability, no leakage, owner approval) still govern. The March 20, 2027 race will provide the first possible qualified outcome through the existing outcome path; the hybrid can be replayed offline at the four enrolled checkpoint instants **from the same inputs** (never stored into the immutable checkpoint records). Cheaper, faster evidence than waiting for races: one or two **time trials of 3–15 minutes** (a mile or 3 km all-out and a 10-minute effort) would make critical speed fittable, and one confirmed hard 10K or half-marathon effort moves evidence quality from `limited` to `adequate`.

## Reproduce

* Synthetic report builder and scenarios: `npx vitest run src/utils/performance src/utils/research scripts/researchHybrid.test.ts`.
* Live: `HYBRID_RESEARCH=1 HYBRID_RESEARCH_AS_OF=2026-11-07T17:00:00.000Z HYBRID_RESEARCH_OUT=/path/report.json TZ=America/New_York npx vitest run scripts/researchHybrid.test.ts`.
