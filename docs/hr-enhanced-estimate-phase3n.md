# HR-enhanced half-marathon estimate — signal engine (Phase 3N)

**Status:** experimental, provisional, not independently validated. The official estimate
(`experimental-current-hm-v2`) is unchanged; the HR-enhanced estimate (`experimental-hr-enhanced-hm-v1`) is an
*adapter beside it*. Evidence labels: *Observed* = measured 2026-11-07 on the owner's data by a bounded, read-only
parent-field pull (226 workout parents since 2026-01-01, 3 races, 58 overrides; counts and aggregates only, no
identifiers, no GPS/HR streams, nothing written, nothing committed). *Synthetic* = deterministic test fixtures.
*Design choice* = an engineering safeguard, not physiology.

## 1. What the existing data supports (source-data audit)

| Field | Origin | Observed coverage (run-like / outdoor / steady outdoor 20–120 min) | Semantics and reliability |
|---|---|---|---|
| `avgHeartRate` | iOS HealthKit average over the whole workout (manual entries: owner-typed) | 100 % / 100 % / 100 % | Whole-session mean, **includes warm-up**; plausible range 40–220 bpm. Reliable as a *relative* within-athlete level; not an effort measurement. |
| `durationSeconds`, `distanceMiles` → pace | iOS moving duration and distance | 100 % | Pace is derived `duration/distance` (recorded `avgPaceSecPerMile` equals it exactly on all 104 steady outdoor runs). |
| `startDate`/`endDate`/`syncedAt` | iOS | 100 % | Drive as-of availability: a run counts only if complete and synced by the cutoff. |
| `displayType` | iOS (“Run”, “Treadmill Run”); owner `runTypeOverride` replaces it | 100 % (116 “Run”, 18 “Treadmill Run”) | The only surface/intent label. Hard-session words (tempo, interval, race, fartlek, hill repeat) are screened out. |
| `hasRoute` | iOS | 86 % of run-like | Presence of GPS; absence is treated as *unknown surface*, never as outdoor. |
| `elevationGainM` | iOS (route) | 100 % of outdoor | Net gain per run; climb/mile is a coarse terrain check (observed 6.6–10.5 m/mi for the middle 80 %; max 19). |
| `routeClusterId` | web (lazy) | 100 % of outdoor | **Not used.** Same cluster ≠ same effort (Phase 3L: median within-cluster HR range 22 bpm). |
| `weather` | web (Open-Meteo, Phase 3J backfill) | 37 % of outdoor, 38 % of steady outdoor | Heat is the dominant confound; coverage is partial, so the signal must degrade rather than assume equal conditions. |
| `hrDriftPct` | iOS | 94 % of outdoor | First- vs second-half HR change **including warm-up** (Phase 3L): not comparable across durations. **Not used.** |
| `efficiencyScore` | legacy iOS / web score | 100 % | Descriptive, surface-mixed baseline (treadmill +9.7 %). **Not used.** |
| Overrides (`workoutOverrides`) | web | 58 (48 excluded, 0 type, 0 distance/duration) | Exclusions and type overrides are inherited from the v2 selector. |
| HR settings (`maxHeartRate`, `restingHeartRate`) | web user settings | n/a | **Current-value anchors that retroactively move %HRR, load and efficiency history. The signal uses raw bpm and never reads them**, so it is immune to invalid or later-changed settings. |

Findings that shaped the design (observed): average HR is present on every steady run, but **run-level noise in pace
at a fixed average HR is large (robust SD ≈ 4.8 %)**, the pooled HR→ln-pace slope is shallow (≈ −0.25 % per bpm,
attenuated by aggregate averaging and mixed conditions), and the 56-day pre-anchor window (median 75.7 °F) is
substantially warmer than the recent window (median 67.5 °F) with weather on only 5 of 16 and 7 of 14 runs. Strict
±3 bpm / ±15 % / same-route / matched-weather pairing found 0 pairs; a pooled HR band finds 12 baseline and 8 recent
supporting runs over 7 and 6 weeks (as of 2026-11-07).

## 2. Candidates considered

| # | Candidate | Verdict |
|---|---|---|
| 1 | **Similar-HR pace, pooled** — compare steady runs inside a shared HR band, with a robust local slope, weighting and no extrapolation | **Selected** (the basis of `hr-effort-signal-v1`). Uses all supporting runs rather than one-to-one pairs; the band replaces ±3 bpm matching. |
| 2 | Same-route effort-adjusted trend | Not selected as the headline: route clusters are loose and few runs share one; kept as a PR 2 comparison. Route identity does not prove equal conditions. |
| 3 | Multiweek aerobic-efficiency trend (weekly robust medians, Theil–Sen) | Its weekly-median, robust, recency-aware ideas are incorporated; the efficiency ratio (speed/HR) assumes a proportional HR→speed relationship and mixes effort with fitness, so the slope-adjusted level is used instead. Compared in PR 2. |
| 4 | HR drift | **Rejected for numeric use**: includes warm-up, duration-dependent, occasional ±40 % artifacts (Phase 3L). An iOS correction is described separately (PR 3 report); it does not block this work. |
| 5 | VO₂ max | **Not used.** Descriptive context only; no VO₂→race-time coefficient exists or is invented. |

## 3. The selected signal (`hr-effort-signal-v1`, `src/utils/hrEffortSignal.ts`)

Question answered: *has pace at a comparable heart rate changed since the race anchor?*

1. **Eligible runs.** Completed runs already accepted by the v2 selector (overrides, exclusions, duplicates, as-of
   availability inherited unchanged), minus race results, hard-labelled sessions, runs outside 20–120 minutes,
   implausible pace/distance, indoor or route-less runs (counted, never used), missing/invalid HR, terrain outliers
   (> 10 m/mi from the median climb) and pace/HR artifacts (residual > 4 robust SDs, floor 3 %).
2. **Two periods.** Baseline = the 56 days ending 8 days before the anchor (taper excluded); recent = the last 42
   days ending *yesterday*, never reaching the anchor day. Recent runs fade out linearly over days 28–42 so the window
   moves smoothly.
3. **Shared HR band, no extrapolation.** Band = pooled median HR ± 8 bpm. Only runs inside it count. If the periods
   occupy different HR ranges the signal is suppressed (`no_hr_overlap`).
4. **Effort adjustment.** Each run is normalized to the reference HR with a robust (Theil–Sen), bounded
   (−1.2 %…0 per bpm) within-period slope. Because aggregate average-HR attenuates that slope, the contrast is also
   computed with a doubled slope and the **smaller magnitude is kept** (zero if the signs differ). A faster run at a
   proportionally higher HR therefore yields **no** favourable signal (tested on noise-free synthetic data).
5. **Robust levels.** Weekly medians (a single run cannot dominate a week), combined by a weighted median with
   weights `min(runs, 3) × recency`.
6. **Uncertainty shrinkage.** The contrast is soft-thresholded by one standard error (the larger of run-level and
   between-week scatter, noise floor 3 %), and at least 65 % of recent weeks must lie on the contrast's side of the
   baseline. Noisy or sparse evidence yields less, never a spuriously exact value.
7. **Continuous strength.** Strength = runs × weeks × weather × HR difference × duration mix, each a ramp (no
   cliff-edge guards): runs 5→10 per period, weeks 3→5, median-HR difference 2→8 bpm (suppressed at 8), median
   duration ratio 1.25→2 (suppressed at 2). **Weather:** both periods covered (≥ 50 % and ≥ 3 runs) and within 5 °F →
   full; fading to zero at 15 °F; otherwise (partial coverage) strength is halved. Missing weather is never treated as
   equal conditions.
8. **Surface.** Treadmill/indoor and route-less runs are excluded from the numeric signal and only counted. Indoor
   pace is not measured reliably by these parents (the same position the v2 pairing takes).

## 4. Conversion to race time (`src/utils/hrEnhancedPerformance.ts`)

Everything is explicit, bounded and provisional — **not a validated calibration**.

* `f_hr = clamp(0.5 × shrunk pace change, ±2 %)` — 0.5 is the transfer fraction v2 already uses for its matched-effort pace
  evidence.
* `w = 0.5 × signal strength × freshness` (freshness = v2's own anchor-age and recency fade).
* `move = w × (f_hr − f_official)`, kept **only in the direction the HR evidence points** (a favourable signal smaller than
  the official improvement does not pull the estimate back; absence of a larger gain is not evidence against the official
  gain). It is a *blend*, not a sum — v2 states correlated signals are not added.
* `|move| ≤ 1.5 %` of the race-equivalent baseline (≈ 2 min for a 2:11 half), reported with the cap, whether applied, and the
  uncapped value.
* A signal that is unavailable, stale, or inside its noise threshold returns the official number (`status: unavailable | no_change`).

The official `CurrentHalfEstimate` is passed through by reference and never modified (tested by serialization before/after).

## 5. Output contract

`HrEnhancedEstimate` (`src/types/hrEnhancedPerformance.ts`): official and candidate seconds/minutes/pace, signed
difference (candidate − official, unrounded seconds), signal direction, supporting runs per period, observation weeks per
period, the exact baseline/recent windows, evidence quality (`adequate | limited | insufficient`), unavailable cause, reason
codes and a sentence, cap details, blend weight, official/HR-implied/candidate fractions, the full signal diagnostics,
model version, signal version, as-of timestamp, race-anchor identity, and `researchStatus: "experimental_provisional"`,
`validated: false`.

## 6. What this does not claim

* No improvement in predictive accuracy: there are no independent qualified outcomes (see the PR 2 evaluation).
* Average HR is a whole-session mean including warm-up; same HR is not the same physiological effort.
* The shallow slope means HR-difference corrections are conservative-by-construction but imprecise.
* All thresholds are engineering safeguards; PR 2 reports how results depend on them.

## Reproduce

`npx vitest run src/utils/__tests__/hrEnhancedPerformance.test.ts` (synthetic fixtures only).
