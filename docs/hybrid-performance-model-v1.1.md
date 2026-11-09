# Hybrid Performance Model v1.1 — evidence-weighted current capability (Phases 3U–3Y)

**Status: experimental, provisional, not independently validated.** Nothing here changes the official estimate (`experimental-current-hm-v2`), the HR-enhanced estimate, `experimental-hybrid-hm-v1`, `experimental-raceday-forecast-v1`, race-anchor policy, saved races, immutable checkpoints, or the March 20, 2027 enrollment/capture schedule. Stored v1 results are never reinterpreted as v1.1.

| Contract | Version |
|---|---|
| Evidence qualification | `performance-evidence-v1.1` (extends the unchanged `performance-evidence-v1`) |
| Evidence combination | `performance-capacity-v1.1` |
| Hybrid current capability | `experimental-hybrid-hm-v1.1` |
| Race-day forecast | `experimental-raceday-forecast-v2` (starts from hybrid v1.1) |
| Rollback | `NEXT_PUBLIC_DISABLE_HYBRID_V11=true` → hybrid v1 + forecast v1 display again (independent of every other gate); `NEXT_PUBLIC_DISABLE_PHYSIOLOGY_HYDRATION=true` → removes only the extra VO₂/HR-stream reads |

## 1. The stale-race problem and what actually caused it

On 2026-11-07 the v1 hybrid said 2:11:17 against an official 2:11:01; the 2026-09-20 half marathon carried 100 % of the base and the physiological trend moved nothing. Changing the 42-day half-life or the race quality weight would **not** have fixed that: v1 normalises weights, so a lone race holds a 100 % share at any age or quality. The causes were structural:

1. **Too little newer evidence could qualify.** Only whole-workout efforts counted. A continuous tempo, a progression run, a fast finish, or a hard 10 K inside a long run was invisible: its whole-run pace is diluted, a `tempo` label demotes the workout to "ordinary", and the GPS best-effort envelope was descriptive only. Measured on 2026-11-07: 4 strong items total, 1 within 180 days besides the race.
2. **One-sided treatment.** A slower unconfirmed effort was dropped whenever a race existed, so genuine decline could only enter through the ±2 % physiological term.
3. **No evidence mass.** Normalised weights cannot say "this race is a *less certain* observation of today than it was 100 days ago", nor "five efforts from one block are not five independent measurements".
4. **Dead data connections.** Apple Health VO₂ max and warm-up-trimmed HR streams existed as functions but nothing in production fed them (`vo2Entries` was never supplied; HR used whole-workout averages including the warm-up).

## 2. Evidence (v1.1)

`qualifyEvidenceV11` returns the **unchanged v1 qualification** plus one new intermediate category, `sustained_segment`: a strong but **submaximal lower bound** — the host run's best 5 K / 10 K / 10 mi / half from valid, current-version, complete-route GPS, a *portion* of the run (< 92 %), faster than the athlete's own trailing-year P10 of segment equivalents and clearing a 5 % margin over their median, in a run whose average HR is ≥ 5 bpm over their own median, not heat-inflated, with consistent timing and no owner distance correction. One segment per workout (the longest distance that has a personal reference), one item per local day (race > whole-run effort > segment). A fast segment is never promoted to a maximal test. Potentially informative workouts that fail a rule are counted by reason and shown to the owner.

## 3. Weighting: precision, not decay

Each item is an observation of the half-marathon-equivalent time with internal uncertainty σ² = measurement² + extrapolation² + drift²:

* measurement: confirmed race 1.0 %, recorded race 1.5 %, race-labelled run 2.5 %, whole-run effort 3.0 %, sustained segment 3.5 %;
* extrapolation: 0.02·|ln(target/source)| for shorter sources (the Riegel exponent is uncertain by ≈ ±0.02), 0.01·|ln| for longer sources;
* drift: 1 %·√(age/30 d) — true capacity is a random walk, so an old result is a *less certain* observation of today (the prior spread the physiological term and the forecast already use). It does not make the result faster or slower;
* ×1/0.85 variance when the run has no recorded weather.

Items pool in two groups — races, and newer efforts — by inverse variance, each group with a **common-mode** term (1 % races, 1.5 % efforts) that does not average away (submaximal effort and conditions are shared across a block). Groups are then precision-weighted. Everything below is emergent, not hard-coded:

* a race is re-weighted continuously as it ages and as credible, mutually consistent newer evidence accumulates; there is no percentage target at any age;
* with no newer evidence the race keeps 100 % and the number does not move — only its uncertainty grows (test: 20-day and 150-day races give an identical base);
* one effort cannot displace a race, and an isolated one (> 4 % from everything else, no peer within 3 %) is variance-inflated 1/0.35× in either direction until a second independent effort corroborates it;
* **asymmetry**: an unconfirmed effort slower than the pass-1 estimate keeps its information at 4× variance (a submaximal effort looks slow); a *segment* slower than the estimate is ignored; races are symmetric;
* newer evidence needs no race: ≥ 2 contemporary items in different weeks including one that converts reliably;
* the 180-day currency limit is unchanged (an explicit, documented transition — not a silent cliff that matters once newer evidence exists).

Diagnostics reconcile with the calculation: `Σ effectiveShare = 1` and `exp(Σ share·ln eq) = base` (tested); `raceOnly`, `recentOnly` and `displacement = base − raceOnly` are reported. Race dominance labels (≥ 70 % dominant, ≤ 30 % minor) are presentation only. The combined "uncertainty" is an internal weighting quantity, **not** a statistical interval.

## 4. Physiology, VO₂ and streams

* **Aerobic trend** is the v1 regression (pace at fixed HR, duration, climb, temperature over 112 days), unchanged, with the same ±2 % cap and precision shrinkage, measured *since the evidence's effective (share-weighted) date* so a recent effort that already contains an improvement is not counted twice.
* **VO₂ max** (Apple Health, device estimate) is read through one 70-day window query of the same shape as the existing personal-insights history (`date ≥ cutoff orderBy date`, `vo2_max > 0` client-side — no new index), screened (10–100 mL/kg/min, ≤ as-of date, discontinuity ≥ 2), and **corroborates only**: a disagreeing direction raises the physiological uncertainty ×1.5 and caps confidence at low; an agreeing one is disclosed but adds no numerical term and no confidence upgrade. No-readings, sparse, stable and available are distinct states; a failed load is disclosed and leaves the number unchanged. Direct numerical influence would need a separate validated VO₂→race-time relationship that does not exist here.
* **HR streams** are hydrated on demand for ≤ 16 trend-eligible runs that have a stream, chosen **evenly across the 112-day window** (selecting only recent runs would pair trimmed HR with recent runs and untrimmed with old ones, which the trend would misread as fitness change — tested to shift the slope by > 0.4 %/28 d under v1's policy). ≤ 40 chunk documents per stream (a stream that reaches the bound is discarded as truncated), ≤ 400 chunk reads per session, 3 in parallel. Interval-like streams leave the steady-state regression; runs without a stream are shifted by the median (trimmed − parent) offset measured on the streamed runs (≥ 5 needed), so partial hydration cannot create or hide a trend.
* All state is in-memory, per user and sign-in (`uid:sessionEpoch`), deduplicated in flight, TTL'd (VO₂ 30 min; stream summaries per workout change fingerprint), summaries only (no raw samples kept), failures reported and cooled down (permission errors never retried). Nothing is persisted or scheduled; no collection, index, rule or migration changes.

## 5. Endurance, load and fatigue — what was evaluated and rejected

`endurance-readiness-v1` (50 % long run, 30 % weekly miles, 20 % frequency) is **retained unchanged**: it sets the exponent for evidence shorter than the target and a ±1.5 % change term for at-target evidence — disjoint uses, so no double counting inside v1.1. CTL/ATL/TSB, weekly load trends, intensity distribution, recovery patterns and long-run-at-comparable-effort were **not** added as numerical terms: mileage, load, HR trend and readiness largely restate the same training exposure; high load is not improved capability; TSB/ATL are *temporary* states that the model must not turn into permanent speed changes; and with zero independent qualified outcomes no coefficient can be justified. They stay out of the number, and a temporary readiness change in the forecast affects only the exponent/endurance term, never demonstrated speed.

## 6. Conflicts, confidence, provisional

Conflicts are reported, never summed away: `recent_performance_vs_aerobic_trend` (recent efforts say faster, pace-at-HR says slower, or the reverse) and `recent_speed_vs_endurance_preparation` (recent efforts faster, readiness fell ≥ 0.15). Either forces `provisional` and `low` confidence. `provisional` also when evidence quality is limited, a group's items disagree, readiness is unknown, or a race over 42 days old dominates the estimate (even when newer evidence has some influence). Both Personal Insights and Plan Insights explain every applicable restriction from the structured `confidenceRestrictions` field, using the shared pure `currentFitnessFormat.ts` formatter. Precision, corroboration, within-group conflict, cross-signal conflict, opposing adjustments, readiness, race age, distance conversion, marathon durability, VO₂ disagreement and demonstrated performance are distinct reasons; multiple reasons render together. Low evidence quality alone never implies conflict, and an `available` result can still be `low` because readiness is below 0.5 or VO₂ disagrees. Confidence is qualitative (`low` / `moderate`), displayed as evidence quality rather than a calibrated probability; the range is an assumption-sensitivity range (exponent 1.06 vs 1.10, physiological transfer 25–75 %, common-mode and drift halved/doubled, measurement ±25 %, with/without segments), never an interval.

## 7. Race-day forecast v2

Starts from the v1.1 estimate and re-evaluates the **same estimator** at each readiness scenario, so no separate race anchor can enter. Planned runs remain planned actions (never performances, `fitnessGainAssumed: 0`); taper, weather, course and future VO₂ get no numeric credit; the reported `currentCapabilityModel` makes the lineage explicit. Current capability and the forecast remain distinct outputs. A real change in current capability propagates (tested); a temporary readiness change moves only the endurance terms.

## 8. Not claimed

No scientific superiority, no calibrated accuracy: there are 0 independent qualified outcomes (≥ 5 required; criteria unchanged). v1.1 is selected for *experimental display* because it handles the stale-race and corroborated-newer-evidence scenarios better, is transparent, and is bounded in reads and computation — not because it is known to be more accurate.

## 9. Research timestamp parity and recovery validation (2026-11-08)

The read-only research loader now converts Admin SDK workout timestamps using the browser SDK's `seconds * 1000 + nanoseconds / 1e6` Date conversion before the shared parent mapper. Admin `toDate()` rounds milliseconds; the browser conversion truncates the resulting floating-point value, which can itself cross a millisecond boundary near 999,999 ns. Explicit boundary tests use both real SDKs. Manual parents still use `updatedAt`; uploaded parents still use `syncedAt`. Private captures preserve seconds/nanoseconds so confirmation receipt availability can continue rounding upward independently; legacy `{__ts}` captures remain readable. Synthetic April/September confirmations retain timing, true effort attestations and owner notes through loading and cache round trips. No stored data or uploader behavior changes.

The `codex/hybrid-confidence-parity` recovery uses the owner's explicit one-time exception to `CLAUDE.md`'s local production-build requirement: three prior local build failures and independent loopback tests hit environment `EPERM`. No additional local production build or localhost probe is permitted. Local focused/full tests, typecheck and `lint:ci` remain mandatory before commit; GitHub Actions **Validate production build**, Vercel and all required hosted checks must actually run and pass before merge. This is not a standing exception or a successful local build claim.

Numerical contracts captured by executing pristine `0a6c85f55194fca6715fdea6d85d583cd62f2078` model modules against deterministic synthetic fixtures are frozen in `hybridConfidenceParity.json`. Tests compare all four distances, current HM v1.1, forecast v2 scenarios, official v2, HR-enhanced, rounding, uncertainty ranges, classifications and readiness/age boundary cases. Formulas, physiological adjustments, 42/180-day gates and readiness thresholds are unchanged. Expanded weather-stability experiments remain deferred; existing audit findings are preserved and historical observed results above have not been recomputed on owner data.
