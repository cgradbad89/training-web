# Phase 3L — HR drift, efficiency, same-route and VO₂ max audit

**Evidence labels:** *Observed* = measured on the gitignored local export `scripts/snapshots/training-web-snapshot.json`
(exported **2026-09-22 15:56 UTC**; 415 run-like parents, 328 with `hrDriftPct`; aggregate statistics only, no identifiers
printed or committed). *Code-derived* = read from source. *Synthetic* = deterministic test fixtures.
**No live prediction input, gate, coefficient or stored historical value changed.** The export predates the Sep 20
race-anchor window and the Nov 5 diagnostic; nothing here is current-data evidence for those.

## Corrected defects (narrow, tested)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | Efficiency score had no guard for invalid HR anchors. Training Load V2 returns null when `maxHr ≤ restingHr`; `computeHRReserve` alone returns NaN (0/0) or a sign-flipped value, and the settings page validates max (100–230) and resting (30–120) independently, so an equal/crossed pair is enterable. | Synthetic (`efficiencyAnchors.test.ts`) | `hasValidHrAnchors`; baseline and score return the existing "building baseline" state under an invalid pair. Valid-anchor behavior unchanged (existing 73 efficiency tests pass). |
| 2 | VO₂ chart drew a constant reference line at **41.0** labelled "avg" (legend "Average threshold"). Observed readings over the last 12 months span 44.0–51.3, so the line matched nothing in the series. | Code-derived + observed range | Line is now the median of the readings shown, labelled "median"; omitted when there are none. |

## HR drift (`hrDriftPct`)

- **Not computed in this repo.** The iOS app writes it from raw HealthKit samples (`metrics.ts`); `MEA.git` is out of scope. The
  web displays it (Run Detail badge, thresholds by distance bucket) and averages the four most recent long-run values for the
  Plan Insights "Durability Readiness" indicator. It is **not** an input to the v2 estimator (`workoutResearchInput.ts` sets it null).
- **Definition recovered (observed):** `(mean HR second half − first half) / first half × 100`, halves split at the temporal
  midpoint. A time-weighted recomputation from the stored HR stream falls within 1 pp of the stored value for 86/105 runs
  (median |Δ| 0.5 pp; p90 1.2 pp). Mismatches concentrate in streams with 8–16 minute holes.
- **Warm-up inflates short-run drift (observed):** mean HR over minutes 5–15 exceeds minutes 0–5 by a median **9.3 bpm**
  (101 runs). Median stored drift is 5.2 % for runs under 40 min but 2.1 % once the first 10 minutes are trimmed; for 40–70 min
  runs 6.5 % → 4.2 %; for 70 min+ 3.7 % → 3.0 %. Drift is therefore **not comparable across durations** and partly measures
  warm-up. (The stored value's `abs()`-based badge also rates a large *negative* drift "good".)
- **Artifacts (observed):** among 105 stream-backed runs, 2 carry |drift| > 25 % (+40.8 %, −43.5 %), both on ~20–24 minute
  runs; none had HR samples outside 40–220 bpm, so the cause is sampling holes/lock-on lag, not out-of-range values.
  No interval/short-run contamination found: none of the 328 stored values is under 15 minutes.
- **Delivered:** `src/utils/research/hrDriftAudit.ts` — deterministic time-weighted drift, warm-up-trimmed variant, explicit
  refusal for short windows/sparse streams/long holes, artifact exclusion, and `assessStoredHrDrift` (parent-level screens).
  Research-only, not imported by live code (test-enforced). **Not delivered:** any change to the displayed value or to the
  readiness indicator — thresholds there are scientific choices needing validation.

## Efficiency score

- Formula (code-derived): EF = speed/avg HR, scored against the runner's own trailing 60-day, date-anchored, self-excluding baseline
  with a linear EF-on-%HRR effort adjustment (flat fallback), ±15 % ≙ ±50 points, optional ±5 cadence points. Anchored per run;
  adding later runs never changes earlier scores. HR anchors are the *current* settings, so changing them moves history (same as load).
- **Can efficiency be separated from intensity/environment? Only partly (observed, last 365 days, 201 runs):**
  %HRR explains **8.6 %** of EF variance; residual SD is 9.2 % of expected EF, i.e. ≈ **31 score points** of in-sample spread.
  Residuals correlate with elevation gain per mile (r = −0.33, n = 170), duration (−0.21), temperature (−0.21, n = 35 only) and
  distance (−0.15). **Treadmill runs score +9.7 % vs −1.1 % outdoors** (21 vs 180 runs) because one baseline mixes surfaces.
  Pace is not grade-adjusted, and weather is absent for most runs (see Phase 3J).
- **Conclusion:** the score is a reasonable descriptive within-athlete index but a month-to-month "improvement" is not
  separable from terrain, surface, heat or duration mix. Changing it (surface-stratified baselines, grade/heat covariates) would
  rewrite historical scores and introduces coefficients → provided as a research direction, **not** changed live.

## Same-route comparisons

- **Cluster correctness (observed, 130 GPS runs):** stored `routeClusterId` equals the recomputed id for 119/119 stored values.
  36 clusters, 21 singletons, largest sizes 22/19/15/14. Against the Routes-page pairwise rule (±0.5 mi, ≤ 300 m start):
  **12 % of qualifying pairs are split across ids** (mile-bucket/grid straddling) and **7 % of same-id pairs violate the rule**
  (a bucket spans up to ~1 mile). Both mechanisms are pinned by `routeClusterId.characterization.test.ts`.
- **Same cluster ≠ same effort (observed, 8 clusters with ≥ 4 runs):** median within-cluster pace CV 4.3 %, **median avg-HR
  range 22 bpm**, median distance range 0.8 mi, duration CV 6.9 %. Terrain is only net gain per run; weather and workout type
  are unaccounted for. This is why the comparable-effort gates (HR ±3 bpm, duration ±15 %, terrain, weather) exist, and why
  the cluster alone cannot support a pace-at-equal-effort claim.

## VO₂ max (Apple Health estimate)

- **Pipeline (code-derived + observed):** `healthMetrics/{date}.vo2_max`, doc id = `date` (0 mismatches), ml·kg⁻¹·min⁻¹,
  `buildVo2History` drops non-positive values and sorts; 180-day bounded read; same-date duplicates impossible by id. It is a
  device estimate, **not** a clinical measurement; `summarizeDeviceVo2` (as-of aware) already labels this in the performance panel.
- **Variants compared (observed, last 12 months, 124 readings, successive-difference SD of the smoothed series):**
  raw 0.49 · 28-day median 0.46 (98 % coverage at ≥ 3 readings) · 28-day mean 0.39 · 14-day median 0.53 · 42-day median 0.30.
  The raw series is already smooth, so a 28-day median is a modest, honest summary rather than a noise filter; longer windows
  add lag. 13 gaps > 14 days overall (2 in the last year, max 22 d); 8 steps > 2.0 overall (1 in the last year).
- **Trend direction is not reliable (observed):** Theil–Sen slope per 28 days is −2.03 / −0.98 / +0.03 for 60 / 90 / 120-day
  windows. No slope is shown to users. (`theilSenSlopePer28d` exists for research and refuses short, sparse, or gapped windows.)
- **Delivered (UI):** the existing Cardio Fitness chart gains a dashed trailing **28-day median** (needs ≥ 3 readings, no
  future data, null — not interpolated — otherwise), a data-derived median reference line, a "latest reading N days old" note when
  > 30 days stale, and the caption "Apple Watch estimates, not a lab measurement. Descriptive only — not a race prediction."
  No new collection or read; no per-run attribution; no race-time conversion.
- **Interpretation:** reliable enough for descriptive tracking; potentially complementary to v2 only if shown to add information
  after confounds; not evaluable today — it shares pace/HR inputs with running data (device-derived, not independent), and one
  in-sample anchor cannot test it. Required: several completed, qualified race outcomes with as-of VO₂ available, scored out of
  sample against the frozen v2 baseline.

## Signal reliability ranking (for further research; availability ≠ accuracy)

| Signal | Coverage (observed) | Main threat | Verdict |
|---|---|---|---|
| Average HR | ~100 % of steady runs | cardiac drift, heat, sleep, caffeine confound ±3 bpm "same effort" | Usable as a screen; not proof of equal effort |
| Same-route pace at comparable HR | 130/415 runs have GPS start; few survive all gates | cluster looseness, weather, surface | Worth further research once weather coverage is repaired |
| Efficiency score | 201 scorable runs/12 mo | terrain, surface, heat, duration mix (R² 8.6 %) | Descriptive only |
| HR drift | 328/415 (79 %) | warm-up, sampling holes, duration dependence | Needs duration-normalized variant before any use |
| VO₂ 28-day median | 98 % of recent reading dates | shared inputs, step discontinuities | Descriptive companion only |

## Reproduce

`npx vitest run src/utils/research src/utils/__tests__/vo2Trend.test.ts src/utils/__tests__/efficiencyAnchors.test.ts
src/utils/__tests__/routeClusterId.characterization.test.ts`. The observed statistics came from one-off analysis of the local
export; the export itself must not be committed.
