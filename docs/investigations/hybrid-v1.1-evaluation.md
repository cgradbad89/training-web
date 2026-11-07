# Hybrid v1.1 — baseline audit, evaluation and selection (Phases 3U–3Y)

**Nothing here changes** the official estimate (`experimental-current-hm-v2`), the HR-enhanced estimate, hybrid v1 (`experimental-hybrid-hm-v1`), forecast v1, race-anchor policy, saved races, immutable checkpoints, the March 20, 2027 schedule, Firestore rules/indexes, or any stored value. Research code (`src/utils/research/hybridV11Evaluation.ts`, `scripts/researchHybridV11.ts`) is never imported by live code (test-enforced); the live script is read-only.

**Evidence labels.** *Observed* = measured **2026-11-07 17:00 UTC (America/New_York)** on the owner's data, read-only and bounded, aggregates only (no identifiers, coordinates, per-sample or per-run values; nothing written; private captures lived outside the repository and were deleted): 227 workout parents since 2026-01-01 (field-masked), 3 races, 58 overrides, 4 plans, plus — *measured exactly as production v1.1 performs them* — one 70-day `healthMetrics` window and the stratified HR-stream hydration. *Synthetic* = deterministic invented fixtures in the tests. No coefficient was fitted to any race outcome.

## 1. Baseline audit (recorded before any model change)

| Question | Observed answer |
|---|---|
| Recent performances classed strong | **1** whole-run effort within 180 days (9.7 km, 20 days old, HM-equivalent 2:16:17 — *slower* than the race); 2 more are 287–293 days old (expired); the recorded Sep 20 race. Confirmed maximal: **0**. |
| Why potentially useful workouts are rejected | whole-run only: structured/`tempo`-labelled sessions → "ordinary"; GPS best-effort segments never numerical; heat-inflated HR 15; timing discrepancy 28 (moving vs elapsed); treadmill/no route 16; partial route 3; inconsistent race record 1 (April). |
| Thresholds too restrictive? | The whole-run rule (top-decile HR ≥ 161.6 bpm **and** HM-equivalent ≤ 2:12:50) is deliberately strict and appropriate; the *structural* gap is that nothing but a whole run can qualify. |
| Recent sustained efforts showing a capability change? | None demonstrable: the only newer qualifying effort is slower than the race (consistent with a submaximal effort, not decline); the aerobic trend is flat (−0.85 %/28 d, t = −1.1). |
| Usable physiological signals | trend available (23 runs / 12 weeks, weather adjustable on 55 of 135 run-like workouts); VO₂ **66 readings since June but never supplied to the panel**; streams exist for **all 135** run-like workouts but the live hybrid used whole-workout average HR. |
| Race age / quality effect on influence | The race carried **100 %** of the base (age 48 d, recorded-unverified, quality 0.85): normalised weights make that independent of age and quality. |
| Single-run influence | max 32 s (0.41 %), p90 16 s; 0 availability flips (v1). |
| Production connections | VO₂ → **disconnected**; HR streams → **disconnected**; best efforts → connected but only **14 of 99** workouts carry the *current* computation version (`BEST_EFFORTS_COMPUTATION_VERSION = 2`; 85 are version 1), so the strictly version-gated segment evidence is starved on this account. |

Baseline numbers (reproduced exactly from `scripts/researchHybrid.ts`): official v2 **2:11:01**, HR-enhanced 2:11:01, hybrid v1 **2:11:17** (provisional · low · race share 100 %, endurance +5.8 s, physiology no effect), forecast v1 **2:09:29**.

### Root causes (the stale-race problem)

A combination of **insufficient qualifying evidence** (structural: no sustained-portion evidence, one-sided slower handling, dead VO₂/stream connections) and **no evidence-mass in the weighting** (normalisation). Not a wrong constant: lowering the race weight or the 42-day half-life leaves a lone race at 100 %.

## 2. Methods compared

| Candidate | Idea | Verdict |
|---|---|---|
| v1 | quality × 0.5^(age/42) × reliability, normalised | race 100 % whenever it is the only qualifying item; slower unconfirmed efforts discarded |
| Shorter half-life / lower race weight | same normalisation | **rejected**: provably cannot reduce a lone race below 100 % (test: share = 1 at every age) |
| Hard age cut-off (e.g. race weight → 0 at day N) | step function | **rejected**: abrupt prediction changes at an arbitrary age; would *fabricate* change when nothing newer exists |
| **Precision-weighted two-group pooling (selected)** | each item = observation with σ² = measurement² + extrapolation² + drift(age)²; races and newer efforts pooled with common-mode terms | continuous, evidence-mass driven, no target percentage, old race unchanged when alone |
| Segments as maximal evidence | treat fast GPS segments like races | **rejected**: a fast segment is a submaximal lower bound, never a maximal test |

## 3. Observed owner results, 2026-11-07

| Model | Value | Notes |
|---|---|---|
| Official v2 | 2:11:01 | unchanged |
| HR-enhanced v1 | 2:11:01 | unchanged |
| Hybrid v1 | 2:11:17 | provisional · low |
| **Hybrid v1.1** | **2:11:26** | provisional · low · evidence quality limited · assumption range 2:11:13–2:11:32 |
| Forecast v1 → **v2** (Mar 20, 2027) | 2:09:29 → **2:09:37** (+8 s) | v2 starts from the v1.1 current capability |

* **Why v1.1 differs from v1 by +10 s, and not by minutes.** The evidence is unchanged: one race (96.7 % of the base, 48 days old) and one slower strong effort (3.3 %, 2:16:17-equivalent). v1 *discarded* that slower effort; v1.1 keeps it as a lower bound, inflates it ×4 for slowness and ×2.9 for being uncorroborated, and it moves the base +10 s. The endurance term adds +5.6 s. **The model correctly reports that nothing newer displaces the race**: `raceDominance: dominant`, `newerEvidenceDisplaced: false`, provisional because "the estimate rests almost entirely on an aging race with no newer corroborating evidence".
* **No fabricated improvement or decline.** Race-only 2:11:11; recent-only 2:16:17; blended 2:11:21 evidence base.
* **VO₂** (production window: 71 documents → 20 usable readings, no discontinuity): recent 47.3 vs prior 47.7 mL/kg/min → *stable* (a measurement of no change, distinct from missing); corroboration inconclusive; **no numerical or confidence effect**. VO₂ now genuinely reaches the production calculation (tested end-to-end; this run is the real-data proof of the same path).
* **HR streams** (production hydration: 16 of 34 eligible runs, **25 chunk documents total**, 0 failures, 0 truncated, 2.0 s read time): **8 usable (good), 8 interval-like** (50 % of the hydrated runs — strides/hill/fartlek structure inside runs labelled "Run"). Interval-like runs leave the steady-state regression; the remaining unstreamed runs are shifted by the measured +1.6 bpm warm-up trimming offset. Effect on the trend: slope **−0.85 → −0.12 %/28 d (t −1.1 → −0.16)** — both "no detectable change" — so physiological contribution stays 0 s; the screening removed noise, not signal. Utilization is partial (8 of 34 comparison runs use trimmed HR; flagged `stream_hr_partial`). The other 18 eligible runs cannot be screened without more reads; we keep the narrower, bounded subset.
* **Sustained segments: none qualify** (0 candidates). Counterfactual (offline, research-only, *not production*): admitting the 85 version-1 best-effort records as if refreshed gives 3 candidates, all rejected for heat-inflated HR (2) or timing discrepancy (1) — so a best-effort refresh would not change today's number; recent training genuinely lacks credible hard sustained efforts.
* **Read and compute cost.** Extra Firestore reads for v1.1: **71 (VO₂ window) + 25 (stream chunks) = 96 per session** (cached in memory: VO₂ 30 min, streams per workout fingerprint; v1: 0). Hard bounds: 70 days, ≤ 16 runs, ≤ 40 chunks per stream, ≤ 400 per session. Compute: hybrid v1 14.4 ms → v1.1 13.3 ms; forecast v1 41 ms → v2 49 ms.

### Stability and sensitivity (observed)

| | v1 | v1.1 |
|---|---|---|
| Available on the 48-day replay (Sep 21 → Nov 7) | 48/48 | 48/48 |
| Max day-to-day step | 6.2 s (0.08 %) | **38 s (0.49 %)** |
| Mean day-to-day step | 2.3 s | 3.9 s |
| v1.1 − v1 over the replay | — | mean +10.5 s, max 48 s; faster on 6 % of days |
| Leave-one-run-out (20 runs) | max 32 s (0.41 %) | max 33 s (0.42 %); max single *evidence* item 11 s |
| Leave-one-week-out (8 weeks) | — | max 31 s (0.39 %); 1 availability flip |
| Race share over the replay | 100 % | 100 % → 86 % (min) → 96.7 % |

The larger daily step is real and comes from one borderline whole-run effort crossing the **v1 strong-effort qualification** threshold on 2026-10-21 and leaving it on 2026-10-29 (the athlete's own reference distribution moves daily). v1 hid this because it discarded every slower effort; v1.1 makes the effect visible and bounded (< 0.5 %, damped by down-weighting and the corroboration rule). It is not an instability introduced by the weighting, and it stays well under the 1.5 % single-workout limit the tests enforce.

**Assumption sweeps** (seconds vs the policy result): efforts' common-mode ×0.5/×2: +0.8 / −2.8; race common-mode ×0.5/×2: −3.8 / +11.6; age drift ×0.5/×2: −5.5 / +13.7; measurement ±25 %: +3.7 / −2.4; races only: −22 (the one slower effort is the only newer evidence); VO₂ removed: 0; streams removed: 0 (but trend slope −0.85 vs −0.12 %/28 d); weather stripped: +23 s (trend flagged `weather_unadjusted`); forecast readiness 0.3→0.9: −2 s → −127 s.

**Plausibility:** speed 2.7 m/s; evidence base within 0.3 % of race-only; physiology bounded ±2 %; total adjustment ≤ 3 %. **Chronological correctness:** no later workout, VO₂ reading or weather can enter an earlier calculation (tested; leakage count reported per replay row). **Independent accuracy: NOT EVALUABLE — 0 independent qualified outcomes (≥ 5 required; criteria unchanged and not weakened).**

## 4. Synthetic scenarios (deterministic fixtures — **not** owner data)

Athlete: recorded HM 2:11:11 (age 100 d unless stated), three runs a week, long run 8 mi, at the fixed as-of 2026-11-07. Forecast columns use a fixture plan with no adherence history (default 50 %), so readiness at taper start is *lower* than today's; compare v1 with v2 only. The illustrative "faster capability" in A is a test input, never an output target.

| Scenario | v1 | v1.1 | Δ vs race | race share | status · confidence | forecast v1 → v2 |
|---|---|---|---|---|---|---|
| C  old race, easy running only | 2:11:11 | 2:11:11 | 0.00 % | 100 % | provisional · low | 2:12:48 → 2:12:48 |
| A  100-d race + 3 corroborated strong efforts | 2:08:06 | 2:09:16 | −1.45 % | 49 % | available · moderate | 2:08:06 → 2:11:17 |
| A′ 100-d race + 3 sustained tempo segments | **2:11:09** | **2:09:08** | −1.56 % | 53 % | available · moderate | 2:12:48 → 2:11:09 |
| D  100-d race + ONE anomalous fast effort | 2:07:14 | 2:09:37 | −1.19 % | 85 % | provisional · low | 2:09:10 → 2:11:21 |
| B  100-d race + decline (slower at same HR + 3 slower hard efforts) | 2:13:28 | 2:14:55 | +2.84 % | 73 % | provisional · low | 2:14:18 → 2:16:11 |
| B′ slow *easy* runs only (HR proportionally lower) | 2:11:11 | 2:11:11 | 0.00 % | 100 % | provisional · low | = |
| E  100-d race + HR-efficiency gain (−4 % pace at HR) | 2:09:02 | 2:09:02 | −1.64 % | 100 % | provisional · low | 2:10:39 → 2:10:39 |
| F  100-d HM race + verified 10K (58:00, 14 d)† | — | 2:10:42 | −0.36 % | 100 %† | available · moderate | — |
| G  faster efforts but worse pace-at-HR | 2:09:11 | 2:10:54 | −0.22 % | 49 % | provisional · low (conflict reported) | 2:09:11 → 2:12:31 |
| H  no race, 3 strong efforts | 2:07:28 | 2:07:30 | −2.81 % | 0 % | provisional · low | 2:07:28 → 2:07:30 |
| H′ no race, 3 tempo segments | **unavailable** | 2:06:54 | −3.26 % | 0 % | provisional · low | — → 2:06:54 |
| fresh (10-d) race + 3 strong efforts | 2:09:16 | 2:09:49 | −1.04 % | 64 % | available · moderate | 2:11:17 → 2:11:44 |

† both races pool in the race group, so "race share" is 100 %; each carries ≈ half (tested: neither is ignored).

Reading: where newer evidence is corroborated (A, A′, H, F) v1.1 moves by evidence mass, partway and not to the efforts; a lone anomalous effort moves it 1.2 % (v1: 3.0 %); an old race alone never moves (C); slower evidence moves it only with corroboration and less than the equivalent faster evidence (B: +2.8 % needs both a trend and three slower hard efforts); slow easy running is not decline (B′); physiology without performance does not touch the base (E); contradictory signals are reported and keep confidence low (G); tempo/progression segments, invisible to v1 (A′: v1 stays 2:11:09, H′: v1 unavailable), now inform the estimate.

## 5. Selection gate (6E)

| Requirement | Result |
|---|---|
| Engineering tests pass | yes (see delivery report) |
| Data connections work | VO₂ and streams flow service → hook → panel → estimate (tested), and were measured live (96 reads) |
| No future leakage | tested at estimator and replay level; v1.1 as-of replay deterministic and order-independent |
| Evidence qualification defensible | v1 rules unchanged; segments are submaximal lower bounds with HR support, athlete-relative margins, one per workout/day |
| Improves stale-race / newer-evidence handling | yes in A, A′, F, H, H′ (see §4); and no fabricated change in C, D, B′ |
| No unacceptable single-workout instability | leave-one-out max 0.42 % (v1 0.41 %); daily step 0.49 % explained above |
| Read/compute costs bounded | 96 reads/session (bounded to ≤ 71 + 400); computation ≈ unchanged |
| Official estimators unchanged | golden-value invariance test against pristine `origin/main` (official v2, HR-enhanced, hybrid v1, forecast v1) |

**v1.1 is selected for experimental display**, labelled experimental and provisional, with v1 retained for comparison and independent rollback. **No claim of scientific superiority**: with 0 qualified outcomes the models cannot be ranked. On the owner's current data the two hybrids differ by 10 s because they rest on the same single race — the same result as Phase 3T, now with the reason made visible.

## 6. What is still needed to improve predictive accuracy

1. **Qualified outcomes** (≥ 5 independent, across ≥ 3 anchors): the March 20, 2027 race is the first possible one.
2. **Credible newer hard evidence**: one confirmed hard 10K/HM or one or two 3–15 min time trials. Today there is no recent sustained effort for any model to learn from.
3. **Current-version best efforts**: only 14 of 99 workouts carry `computationVersion = 2`; the existing route-read/backfill pipeline (not run here) must refresh the rest before segment evidence can ever apply historically.
4. **Weather on more runs** (55 of 135): without it the aerobic trend cannot separate heat from fitness.

## Reproduce

* Synthetic: `npx vitest run src/utils/performance src/utils/research src/services scripts/researchHybridV11.test.ts`.
* Live (read-only, ≈ 100 documents beyond the Phase 3Q–3T reads): `HYBRID_RESEARCH=1 HYBRID_RESEARCH_AS_OF=2026-11-07T17:00:00.000Z HYBRID_RESEARCH_OUT=/path/report.json TZ=America/New_York npx vitest run scripts/researchHybridV11.test.ts` (add `HYBRID_RESEARCH_CACHE` / `HYBRID_V11_PROD_CACHE` to reuse private captures stored **outside** the repository).
