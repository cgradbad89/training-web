# Hybrid performance model — Phases 3Q–3T

> **Superseded for display by [Hybrid Performance Model v1.1](hybrid-performance-model-v1.1.md)** (evidence-weighted weighting, VO₂/HR-stream integration, forecast v2). This document describes `experimental-hybrid-hm-v1` / `experimental-raceday-forecast-v1`, which remain unchanged, reproducible and available as the rollback.

**Status:** experimental, provisional, **not independently validated**. The official estimate (`experimental-current-hm-v2`) and the HR-enhanced estimate (`experimental-hr-enhanced-hm-v1`) are unchanged and remain operational beside it. Nothing here populates a validated contract (`RacePerformanceResult.currentCapability` / `raceDayForecast` stay `unavailable`), a saved race, an immutable checkpoint, an enrollment or a capture schedule. No Firestore rule, index, collection, migration, iOS change or new service was needed or made.

Evidence labels used below: *Published* = stated in a source I read (see §7). *Engineering assumption* = a bounded safeguard chosen here, not fitted to the owner's data and not a physiological constant. *Observed* = measured on the owner's data by the read-only evaluation (`docs/investigations/phase-3q-3t-evaluation.md`).

## 1. The two questions, kept apart

| Question | Output | Module |
|---|---|---|
| **Current capability** — how fast could this athlete reasonably race a half marathon *today*? | `experimental-hybrid-hm-v1` (`HybridPerformanceEstimate`) | `src/utils/performance/hybridPerformance.ts` |
| **Race-day forecast** — what could they reasonably run on a stated future date? | `experimental-raceday-forecast-v1` (`RaceDayForecast`) | `src/utils/performance/raceDayForecast.ts` |

The forecast starts from the hybrid result and never replaces it; both are shown separately in Plan Insights.

## 2. 3Q — independent performance-capacity engine (`performance-capacity-v1`)

### 2.1 Evidence qualification (`evidenceQualification.ts`, `performance-evidence-v1`)

| Tier | Meaning | Source | Base quality |
|---|---|---|---|
| 1 `confirmed_maximal` | Owner-confirmed / verified maximal race or time trial | Phase 3A `eligibleForEquivalence` | 1.00 |
| 2 `strong_unconfirmed` | Strong, maximality unconfirmed | (a) recorded race with consistent clocks (the rule v2 already uses for a provisional anchor) 0.85; (b) race-labelled run not linked to a race 0.60; (c) outdoor whole-run effort whose HM-equivalent time **and** average HR are in the top of the athlete's own trailing-year distribution **and** clear a margin over their typical run 0.45 | |
| 3 `ordinary_training` | Counted, never a numerical source | everything else valid | — |
| 4 `unsuitable` | Incomplete/unreliable | partial route, timing discrepancy (moving duration vs elapsed), implausible pace/distance, owner-corrected distance/duration, inconsistent race record | — |

Rules that matter:

* **Ordinary pace is never maximal.** Average heart rate and pace-equivalent must both stand out *relative to the athlete's own runs*, with absolute margins (≥ 12 bpm and ≥ 6 % faster HM-equivalent than the median run). A first version used percentiles alone; its unit test showed that selects the noisy tail of ordinary running (12–22 ordinary runs classed as strong), so the margins were added. *(Engineering assumption.)*
* **Fastest GPS segment ≠ maximal test.** `bestEfforts` segments form a descriptive lower-bound curve only (`curve`), labelled with their host workout's tier. They never enter the numerical estimate.
* **Correlation.** Every effort from one workout shares a cluster and counts once; at most one independent item per local day is kept (strongest wins).
* **Heat.** A strong-looking run above 80 °F is ordinary (heat inflates HR). Missing weather lowers quality ×0.85 and is flagged; it is never treated as favourable.
* **Expiry.** Evidence older than 180 days is *listed as expired and carries no weight*.
* Treadmill/no-route, missing/invalid HR, hard-structure labels (tempo/interval/fartlek), owner overrides, abnormal GPS speed (best-effort segments outside 3:00–20:00/mi), stale or incomplete best-effort freshness basis, duplicates and as-of availability are all handled and tested.

### 2.2 Estimators (`capacityMethods.ts`)

* **A — race/sustained-performance equivalence.** The single most reliable qualifying performance converted to the target distance. Riegel (`T₂ = T₁(D₂/D₁)^b`, fixed `b = 1.06` by default, *Published* population-style relationship, not fitted) with a Daniels–Gilbert VDOT cross-check reported alongside.
* **B — critical speed.** Two-parameter distance–time model `D = CS·t + D′`, fitted only from ≥ 3 independent strong efforts of 2–20 min spanning ≥ 2.5× in duration, with R² ≥ 0.98, slope SE ≤ 5 %, 20 ≤ D′ ≤ 1000 m, 1.5 ≤ CS ≤ 7.5 m/s, and no effort slower than CS. **It never returns a half-marathon time**: CS is a severe-domain parameter; extrapolating it to a ~2-hour event needs endurance evidence this engine does not have. *(Published: the 2026 scoping review recommends ≥ 3 maximal trials of ~3–15 min, notes time-to-exhaustion at CS ≈ 16.5–20 min, recommends two-parameter models, and says events ≥ 10 km should not be fit trials.)* In practice this is almost always *unavailable* for a recreational runner who has not time-trialled — and says so.
* **C — recent demonstrated capacity (primary).** Recency-, quality- and extrapolation-weighted log-mean of the target-equivalent times of all independent items: `w = quality × 0.5^(age/42 d) × reliability(distance ratio)`. Reliability is 1 up to a 1.25× distance ratio, falls linearly to 0 at 6× (a 5K source ≈ 0.38, a mile ≈ 0). Two guards: **(i) isolated-fast discount** — an unconfirmed whole-run effort > 4 % faster than everything else with no similar peer is down-weighted ×0.35 (more likely unrepresentative than a capability jump; found necessary when one fast run moved the estimate 5.3 %); **(ii) maximality asymmetry** — an unconfirmed effort implying a *slower* time than a race anchor is ignored (a submaximal effort looks exactly like that and says nothing against the race; genuine decline is the physiological trend's job and the anchor expires).
* **Minimum evidence for a number:** a race within 180 days, *or* ≥ 2 strong efforts in different weeks within 120 days including one that converts reliably. Evidence is `adequate` only with a confirmed maximal performance or ≥ 3 independent items; otherwise `limited` (→ provisional).
* Supported targets: 5K, 10K, half marathon. Marathon is explicitly unsupported.

Responsiveness is tested: two strong contemporary efforts move the estimate > 1.5 % while v2 (stable training) stays on its race baseline; with an expired race and two strong efforts the capacity engine answers where v2 returns `null`.

## 3. 3R — physiological evidence

* **HR-stream quality** (`hrStreamQuality.ts`, `hr-stream-quality-v1`): invalid-sample and spike removal, coverage/gap screening, warm-up/HR-lag detection (smoothed HR reaches 92 % of the later sustained median, clamped 2–12 min), warm-up-trimmed mean, longest stable segment, post-warm-up HR slope (bpm/10 min; reported as an HR slope only — pace constancy is unknown, so it is *not* called drift), interval-like detection. The stored `hrDriftPct` is not used. Pure; the page never reads HR streams (bounded reads only).
* **Aerobic efficiency trend** (`aerobicTrend.ts`, `aerobic-trend-v1`): one Huber-IRLS regression `ln pace = a + b·(HR−HR₀) + c·ln(duration/45 min) + d·climb [+ e·temp] + g·t` over 16 weeks; `g` is the fractional pace change per 28 days at fixed HR/duration/climb/temperature. Needs ≥ 20 runs over ≥ 6 weeks; artifacts > 4 robust SD removed; must clear |t| ≥ 2 **and** survive dropping any calendar week. Temperature enters only when ≥ 60 % of runs have weather (otherwise `weather_unadjusted`, SE ×1.5, "heat could explain part of this" listed as unsupported); a negative (hotter = faster) coefficient is rejected as non-physiological. Treadmill/no-route runs are counted, never used.
* **Separation of claims** (`interpretation`): *observed* (pace at fixed HR changed x % per 28 d), *plausible* (aerobic fitness/economy; VO₂ corroboration agrees/disagrees), *not supported* (any race-time change, causation, VO₂ as a lab value or race-time converter).
* **VO₂ max** is corroboration only: two 28-day medians; a ≥ 2 ml·kg⁻¹·min⁻¹ step between consecutive readings makes it inconclusive; no conversion to time.
* **Relationship to the HR-enhanced work:** built upon, not duplicated. The two-window `hr-effort-signal-v1` is retained as is; the hybrid uses its direction only to modulate variance (disagreement ×1.5), never as an added correction.
* **iOS assessment (no change made, none required):** everything above is derivable web-side from existing fields (`hasHRStream` + `hrStream` chunks already provide per-sample HR). A materially better signal would need per-workout **pace-stream + HR-stream alignment** (to make a true constant-pace drift measure) and a per-workout **steady-segment mask**; neither is needed for this release and neither blocks it.

## 4. 3S — hybrid current-capability estimate (`experimental-hybrid-hm-v1`)

| Family | Role | Counted how |
|---|---|---|
| Demonstrated performance | BASE | method C, exponent set by endurance readiness (below) |
| Physiological trend | Change **since the demonstrated evidence's weighted date** | shrunk by precision |
| Race history | Informational | races enter *once*, inside the base |
| Endurance readiness | (a) sets the exponent for evidence shorter than the target; (b) bounded change term for evidence at ≈ target distance | see below |

**Rules (all engineering assumptions):**

1. Exponent for evidence shorter than the target: `b = 1.06 + 0.06·(1 − readiness)` (1.06–1.12). Demonstrated speed is not endurance; this is how low preparation costs *time* rather than *confidence only* where physics says it should, bounded. Unknown readiness keeps 1.06 and lowers confidence — no invented penalty.
2. Physiological change `f_obs = 0.5·g·T` (`T = min(days since evidence, 112)/28`; 0.5 is the transfer fraction v2 already uses). Influence `s = τ²/(τ²+σ²)` with `τ = 1 %·√(days/30)` (prior spread of true capacity change) and `σ²` = squared SE of `f_obs` plus ±50 % transfer error, ×1.5 when VO₂ or the HR signal disagree. Cap ±2 %.
3. Endurance change `f_E = −0.06·clamp(ΔP, ±0.5)·share(base at ≈ target)·0.5`, cap ±1.5 %, `ΔP` = readiness now − readiness at the evidence date. Readiness (`enduranceReadiness.ts`) = 0.5·long-run + 0.3·volume + 0.2·frequency (break-points in the file; smoothed over 7 daily offsets; races excluded; < 4 observed weeks → *unknown*, not *unprepared*).
4. Correlated adjustments are not added: same sign → larger + ½·smaller; opposite sign → net sum and a `contradictory_signals` flag. Total |adjustment| ≤ 3 %.
5. No cliff guards: a first version withheld the number below a readiness threshold and flipped availability on 16 of 48 real days; endurance *support* is now `max(readiness, share of base demonstrated at ≈ target distance)`, readiness is smoothed, and the same replay shows 48/48 available with a 6 s maximum day-to-day step.
6. **Uncertainty:** qualitative confidence (`low` | `moderate`; never higher) plus an **assumption-sensitivity range** (exponent 1.06 vs 1.10, 25–75 % transfer, with/without strong unconfirmed efforts). Labelled *not a statistical interval*; no calibrated interval exists.

**Fallbacks (explicit, tested):** no qualifying evidence → `no_performance_evidence`; only an expired anchor → `anchor_expired_no_contemporary_evidence` (and a strong contemporary pair restores an estimate with the anchor listed as expired); thin evidence → `insufficient_independent_evidence`; recent race but no usable HR → numeric with the physiological family `unavailable`; useful physiological trend but no maximal evidence → unavailable (a trend is **never** converted into a finish time); insufficient endurance support → `insufficient_endurance_preparation` (capacity shown separately); contradictory sources → provisional, low confidence, flagged; missing weather → `weather_unadjusted`, SE inflated, listed under *Missing information*.

## 5. 3T — race-day forecast (`experimental-raceday-forecast-v1`)

* Planned workouts are **planned actions**, not completed performances or guaranteed adaptations: never converted to synthetic efforts. `fitnessGainAssumed: 0`.
* The only plan-dependent effect is endurance preparation, projected at the start of taper (race − 14 d) with planned distances scaled by the athlete's own recent plan adherence (cap 85 %; unknown → 50 %), pushed through the hybrid's own bounded rules (`readinessOverride`).
* **Taper:** both meta-analyses report *standardized* mean differences (2023: 14 studies, TT SMD −0.45, ≤ 21-day taper with 41–60 % volume reduction at unchanged intensity/frequency; 2007: 27 studies, 2-week taper, effect 0.59 ± 0.33). These are population effect sizes and cannot be converted into a personal race-time percentage, so taper is listed as context with **no numeric credit**. (I also deliberately did *not* use a remembered "≈ 2 %" figure: the pages report SMDs, not percentages.)
* **Weather/course:** no forecast or climatology provider is integrated and no course profile exists → `weather: climatology_unavailable | forecast_unavailable`, `course: unknown`. Nothing is invented.
* **Uncertainty:** symmetric capacity-drift allowance `1 %·√(days/30)` plus the assumption scenarios; the age the newest evidence will have on race day is disclosed (it exceeds the 180-day currency limit for the March race — the forecast says so).
* **Withheld, with cause,** when the date is invalid/past, the horizon exceeds 270 days, current capability is unavailable, or endurance preparation is unknown/too low.
* **Evaluation of the existing forecast path** (`planEntryToSyntheticEffort` → `predictRaceTime`): planned entries become synthetic efforts at their *easy* planned pace and are refit. On a fixed synthetic athlete the legacy projection rises monotonically from 2:20:00 (no plan) to 2:33:30 (16 planned weeks, +9.7 %) with no change in the athlete (tested). The new forecast is invariant to additional planned easy volume beyond the bounded readiness effect (tested).

## 6. UI (Plan Insights)

* `HybridEstimateRow` — "Experimental — Hybrid Performance Model", beside the official and HR-enhanced rows: finish, pace, status (Available/Provisional/Unavailable), signed difference vs official, assumption range and confidence, a plain-language top-factors sentence, an expandable *How this estimate is built* (families with influence, evidence counts, missing information, assumptions in the details dialog). Reuses the existing estimate-details dialog and design tokens.
* `RaceDayForecastRow` in *Race-Day Outlook*, visibly separate from capability; scenarios, uncertainty and caveats in an expandable.
* Independent kill switches (build-time; redeploy to apply): `NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE=true` (also removes the forecast) and `NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST=true`. Both ride the official current-estimate gate and cannot appear where it is off. They never alter saved races, official values or checkpoints.
* No new read: pure functions over the already-loaded races/workouts/overrides/plan. Measured on the owner's data: official 20 ms, HR-enhanced 6 ms, hybrid 11–16 ms, forecast 44 ms.

## 7. Sources

Read and verified (via Europe PMC, the PubMed pages being behind a bot check): Anderson et al., *Sports Medicine* 2026, scoping review of critical speed and D′ in running (PMC13388421); Bosquet et al. 2007, *Effects of tapering on performance: a meta-analysis* (PMID 17762369); *Effects of tapering on performance in endurance athletes: a systematic review and meta-analysis* 2023 (PMID 37163550). Carried over from earlier phases: Riegel (fixed exponent; PMC6239296), Daniels–Gilbert VDOT equivalence, Fokkema et al. 2020 and Vickers & Vertosick 2016 (population association of volume/long runs with performance — motivation only, no coefficient taken).

**Parameters with published support:** the form of the two-parameter CS model and its trial-duration guidance; the existence and direction of taper effects (as SMDs). **Everything else is an engineering assumption:** the 42-day half-life, quality weights, extrapolation reliability, strong-effort margins, readiness break-points and weights, the exponent range, the 0.5 transfer fraction, the shrinkage prior, the caps (±2 %, ±1.5 %, ±3 %), the plan-adherence caps, the drift allowance.

## 8. What this does not claim

* No claim of improved predictive accuracy. Accuracy is **NOT EVALUABLE**: 0 independent qualified outcomes (≥ 5 required; unchanged). No coefficient was fitted to any race outcome and no outcome is used both to choose and to validate.
* The Sep 20 race is *recorded, unverified*; a model agreeing with it is not evidence of accuracy.
* Average HR remains a whole-session mean; same HR is not the same effort.

## 9. Reproduce

* Unit/scenario tests: `npx vitest run src/utils/performance src/utils/research src/components/insights`.
* Live (read-only, bounded, aggregates only; needs the owner credential in `.env.local`): `HYBRID_RESEARCH=1 HYBRID_RESEARCH_AS_OF=… HYBRID_RESEARCH_OUT=/path/report.json npx vitest run scripts/researchHybrid.test.ts` (`HYBRID_RESEARCH_SAVE_CACHE=` / `HYBRID_RESEARCH_CACHE=` keep a private capture **outside the repository**).
