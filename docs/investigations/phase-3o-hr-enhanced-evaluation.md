# Phase 3O — Evaluation, sensitivity and promotion criteria for the HR-enhanced estimate

**Nothing here changes the official estimate** (`experimental-current-hm-v2`), the race-anchor policy, saved races, immutable
checkpoints, the March 20, 2027 enrollment/capture schedule, or any stored value. The research modules
(`src/utils/research/hrCandidates.ts`, `hrSensitivity.ts`) and `scripts/researchHrEnhanced.ts` are never imported by live code
(test-enforced) and the live script is read-only.

**Evidence labels.** *Observed* = measured 2026-11-07 17:00 UTC (America/New_York) by `scripts/researchHrEnhanced.ts` on the owner's
parent fields (226 workout parents since 2026-01-01, 3 races, 58 overrides; bounded, field-masked, no GPS/HR streams/health
metrics, aggregates only, nothing written or committed). *Synthetic* = deterministic fixtures in `hrRobustness.test.ts`.
*Assumption* = an engineering safeguard, not physiology.

## 1. Six kinds of evidence, kept apart

| Kind | Status | Basis |
|---|---|---|
| Engineering correctness | **Established** | 44 engine tests + 26 robustness tests (synthetic); v2 numerically invariant (serialization before/after); no future leakage; order independence; overrides and race linkage. |
| Evidence availability | **Limited (observed)** | Of the 35 days from anchor+14 to Nov 7: signal evaluable on 13 days (37 %), directional on 4 (11 %), suppressed on 22 (63 %). Reasons (days): too few recent runs in the band 20, too few recent weeks 10, no shared HR range 9, weeks disagree 2. |
| Numerical stability | **Mixed (observed)** | Day-to-day change of the HR-attributable estimate: max 5.5 s (0.07 % of race time). But the live signal sits near its noise threshold (§4), so availability and direction are fragile. |
| Physiological plausibility | **Plausible but unproven** | Direction and size are consistent across several independent candidate formulations on 2026-11-07 (§3); heat, fatigue and surface can each explain part of any gain. |
| Retrospective agreement | **None available** | The only earlier race (2026-04-26) yields no eligible v2 anchor at any lead time before the 2026-09-20 race, so no prediction→outcome pair exists. |
| Independent predictive accuracy | **NOT EVALUABLE** | 0 independent qualified outcomes; ≥ 5 required (`scoreAgainstOutcomes`). No accuracy or superiority claim is made. |

## 2. Candidate comparison (observed, coverage first, accuracy separately)

Same eligible runs, same windows (anchor 2026-09-20; baseline = 56 d ending 8 d before; recent = 42 d ending yesterday).
Percentages are pace change at comparable HR (negative = faster); the efficiency candidate is a trend in %/28 d (positive =
improving). Only the official and selected candidates yield a finish time; the others have **no race-time transform, so their
accuracy is "not assessed", never zero error.**

| Candidate | Oct 15 | Oct 25 | Nov 1 | Nov 7 (sample at Nov 7) |
|---|---|---|---|---|
| v2 official (finish time) | available | available | available | available (0 matched pairs at every instant) |
| Original strict comparable-effort | 0 pairs | 0 pairs | 0 pairs | 0 pairs |
| Similar-HR band (±4 bpm, plain medians, ≥ 5 runs / 3 wk per period) | unavailable (8 / 2 runs) | unavailable (9 / 3) | unavailable (9 / 4) | **−0.4 %** (9 / 5 runs, 6 / 5 wk) |
| Same-route HR-adjusted (≥ 2 clusters with ≥ 2 runs each period) | unavailable (1 cluster) | +0.9 % (2 clusters) | +0.4 % (3 clusters) | **−1.3 %** (3 clusters) |
| Multiweek efficiency (weekly medians, Theil–Sen, ≥ 6 wk) | −0.9 %/28 d | −0.1 %/28 d | +2.1 %/28 d | **+1.8 %/28 d** (8 wk) |
| **Selected: HR effort signal** (raw contrast → used) | unavailable (3 recent runs, different HR range) | −0.1 % → no change | −3.7 % raw → **suppressed**: weeks disagree | **−2.4 %** raw, shrunk to a small favourable signal (12 / 8 runs, 7 / 6 wk) |

Reading: on Nov 7 all four candidates that can speak agree the direction is *improving*, with magnitudes from −0.4 % to −2.4 %.
On Nov 1 they disagreed (same-route +0.4 % declining, efficiency +2.1 % improving, selected raw −3.7 % but inconsistent) —
which is exactly why the selected signal requires cross-week agreement. Strict pairing found nothing at every instant.
Coverage is the selected signal's advantage (it uses 20 runs where strict pairing found 0 pairs); that is evidence
*availability*, not accuracy.

## 3. Why the selected candidate over the alternatives

* Similar-HR band without a slope or shrinkage: simplest, but depends strongly on the band width (§4) and treats a 2-run week as
  evidence; it lacks a way to separate a higher HR from a faster pace. Used as the reference formulation.
* Same-route: few clusters have runs in both periods (1–3 of 6–8), and a cluster id does not hold conditions fixed.
* Multiweek efficiency (speed/HR): assumes speed scales proportionally with HR, so it mixes effort with fitness; useful as a
  corroborating trend, not as the signal.
* Selected: pooled band + bounded slope sensitivity + weekly medians + one-SE shrinkage + continuous strength. Chosen on
  engineering defensibility (bounded influence, no extrapolation, honest uncertainty), **not** because it produced the largest
  adjustment (it usually produces a smaller one than the others).

## 4. Sensitivity and robustness

### Synthetic single-workout perturbations (established favourable signal, ≈ −56 s HR-attributable)
One new easy run, an unusually fast workout (−30 % pace), a run at HR 178 or HR 118, a treadmill run, a 60 m/mi hilly run, an
erroneous (999) or missing HR, a missing-weather run, a 95-min and a 22-min run: **candidate shift 0 to 1.6 s** each (artifact,
band, terrain, surface and duration screens remove the extreme ones; the rest are down-weighted by the weekly median). A run that is
faster only because HR was higher (HR 164 at the relation's pace) shifts it < 0.4 % of race time.

### Multi-week scenarios (synthetic)
10 % genuine same-HR improvement → favourable, capped (−65.6 s ≤ 1.5 % cap of 118 s); 10 % decline → unfavourable (+65.6 s);
monotone across levels; implausible 20 % gain → rejected as an artifact (falls back to official); hot baseline vs cool recent and
the reverse → suppressed (heat cannot manufacture a headline); weather missing everywhere → ~half the effect (−28 s vs −56 s),
never zero and never assumed equal; no usable HR or an expired anchor → official only; a later race re-anchors the windows
(baseline ends 8 days before the new anchor). Daily cutoff steps (12 days): max 20.6 s.

### Observed on the live data (2026-11-07)
* **Leave-one-out over 132 non-race runs:** largest change any single run causes in the HR-attributable part of the estimate
  **10.5 s** (0.13 %); in the official estimate **45.4 s** (0.58 %, its own volume heuristic); largest swing of the contrast
  2.6 percentage points; **2 of 132 removals flip availability**. The HR component is not more single-run-sensitive than v2.
* **Threshold dependence (14 perturbations, base is "no change", contrast −0.12 %):** availability changes in 1/14 (consistency
  share 0.8), direction changes in 2/14 (noise multiplier 1.5 and consistency 0.8, both because the base is within noise);
  looser settings (band ±5 / ±12 bpm, 28-day window, noise 0.5) produce a favourable result of −0.8 to −4.1 s. **Every setting
  keeps the HR-attributable effect within ±4.1 s (0.05 %).** The qualitative conclusion is stable; the label is not.
* **Hard-guard lesson:** a fixed 4 bpm median-HR cut-off flipped availability between 3.9 and 4.1 bpm on this data; it was replaced
  by a continuous ramp before release.

### Conclusion of the sensitivity work
With ~12 baseline and ~8 recent supporting runs and ~4.8 % run-level noise, only pace-at-HR changes of a couple of percent can clear
the threshold, and the live signal is currently near it. The estimator's conservative design means the displayed effect is small
(seconds) and can change label between neighbouring days. That is the honest state of this data volume, not a defect to tune away.

## 5. Accuracy: NOT EVALUABLE

`scoreAgainstOutcomes` returns `NOT EVALUABLE`: 0 independent qualified outcomes (the Sep 20 race's maximal effort and independent
timing are unverified; the Apr 26 race gives no eligible v2 anchor). No candidate was fitted or selected using any race outcome;
the thresholds are noise-model choices fixed before outcomes were examined, and the same race is never used both to tune and to claim
validation. One qualified outcome would support a sanity check, not model selection (existing guidance).

## 6. Promotion criteria (proposed; NONE ARE CLAIMED MET)

The HR-enhanced estimate may be considered for promotion to the official calculation only when **all** hold, with thresholds fixed
and recorded **before** the outcomes they apply to are observed, and with explicit owner approval:

1. **Evidence coverage:** an evaluable (non-suppressed) HR signal at ≥ 80 % of the 28/14/7/1-day checkpoints, and a directional signal
   at ≥ 40 % of them, across ≥ 3 anchored races. *Today: 37 % evaluable, 11 % directional (one anchor) — not met.*
2. **Independent outcomes:** ≥ 5 independent qualified outcomes (existing `MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY`), from ≥ 3 distinct
   races/anchors, each horizon scored separately, never pooled across horizons. *Today: 0 — not evaluable.*
3. **Error versus official:** paired absolute error not larger than the official estimate's on average, with bias no larger in magnitude,
   and no checkpoint where it is worse by more than 1 % of race time; reported with the paired differences, not a significance claim at
   n < 10.
4. **Stability:** HR-attributable day-to-day step ≤ 0.2 % of race time; single-run influence ≤ 0.3 %; availability flips under single-run
   removal ≤ 5 % of runs; direction unchanged under policy perturbations at ≥ 90 % of checkpoints. *Today: step 0.07 % ✓, single run
   0.13 % ✓, flips 1.5 % ✓, direction changes 14 % of perturbations ✗ — partially met.*
5. **No leakage:** the chronological and as-of tests pass on the promoted code; later data (including weather fetched later) cannot
   influence an earlier result. *Met by tests today.*
6. **Acceptable magnitude:** |candidate − official| within the 1.5 % cap at all checkpoints and within 1 % at ≥ 90 %. *Today ≤ 0.07 %.*
7. **Behaviour across anchors:** results for at least two different race anchors (different seasons) show no systematic
   directional bias attributable to heat. *Not testable today (one eligible anchor).*
8. **Rollback readiness:** official numbers, saved races and checkpoints unaffected; the experimental display can be removed by one
   change without touching them. *Delivered in PR 3.*
9. **Owner approval** to replace the official formula (an owner decision, not an engineering one).

## 7. March 20, 2027 opportunity

The Rock and Roll Half Marathon is already enrolled with four scheduled checkpoints (Feb 20, Mar 6, Mar 13, Mar 19). This phase
changes none of that. After the race, the existing outcome path (`PHASE3D_MODE=outcome`, then `evaluate`) gives one qualified outcome; the
research script above can be rerun at the same four instants to attach the HR-enhanced availability and difference to each
checkpoint. One outcome cannot establish superiority; it is the first of at least five required. Because the snapshot custody
chain is immutable, the HR-enhanced value for those checkpoints should be **recomputed offline from the same inputs**, not stored in
them.

## Reproduce

* Synthetic: `npx vitest run src/utils/research/__tests__/hrRobustness.test.ts` (`HR_ROBUSTNESS_OUT=path.json` writes the table).
* Live (read-only, needs the owner credential in `.env.local`): `HR_RESEARCH=1 HR_RESEARCH_OUT=/path/report.json npx vitest run scripts/researchHrEnhanced.test.ts`
  (`HR_RESEARCH_CACHE=/path/private.json` reuses a local private pull; `HR_RESEARCH_AS_OF=` picks the instant).
