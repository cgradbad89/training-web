# Phase 3I — Comparable-effort, heart-rate and VO₂ max evidence audit

**Status:** research-only. No estimator, replay, snapshot, capture or enrollment behavior changed.
**Evidence labels:** *Observed* = measured on a real local export (aggregate counts only, no identifiers).
*Synthetic* = deterministic fixtures. *Code-derived* = read from source, not measured.

## Limits of this audit (read first)

- The only real data available without a fresh production read is the gitignored local export
  `scripts/snapshots/training-web-snapshot.json`, exported **2026-09-22 15:56 UTC** (786 workout parents,
  2,825 health-metric days). It predates the Sep 20 anchor's post-race window and the Nov 5 diagnostic.
  A fresh `snapshot:export` reads ~135 MB of private data from production and was **not** run.
- The export contains no races and no overrides, so the real-data funnel below is a **pooled pairwise** view
  (disjoint halves of the steady runs in the last 120 days), not the estimator's dated baseline×recent funnel.
  The dated funnel is implemented and verified on synthetic data (`comparableEffortFunnel.ts`); it has not been
  run on live data. **The cause of the Nov 5 zero-pair result is therefore not verified directly.**
- **INSUFFICIENT INDEPENDENT EVIDENCE TO ESTABLISH PREDICTIVE IMPROVEMENT.** There is no completed prospective
  outcome and no recorded March checkpoint; one in-sample provisional anchor cannot validate any signal.

## C. Comparable-effort eligibility funnel

Rules are those of `comparableContext` / `pairResearchRuns` / `estimateCurrentHalfMarathon` (v2). Kind: S =
scientifically motivated, E = engineering safeguard, P = provisional assumption.

### Observed — pooled pairs, 53 steady eligible runs in the 120 days before the export, 702 pairs

| Gate | Rule | Kind | Candidates | Surviving | First-failure |
|---|---|---|---:|---:|---|
| Valid HR | avg HR 40–220 | E | 702 | 702 | 0 |
| HR match | within 3 bpm | P | 702 | 113 | 589 |
| Duration match | within 15% | P | 113 | 30 | 83 |
| Clock consistency | elapsed ≈ duration (±max 60 s, 1%) | E | 30 | 17 | 13 |
| Outdoor | not treadmill/indoor | E | 17 | 17 | 0 |
| Same route | same `routeClusterId` | S | 17 | 9 | 8 |
| Terrain match | climb within 5 m/mi | S | 9 | 8 | 1 |
| Weather available | present and fetched ≤ as-of | E | 8 | 2 | 6 |
| Weather match | temp ±5 °F, humidity ±15%, wind ±3 mph | S | 2 | 0 | 2 |
| Same conditions | same condition code | P | 0 | 0 | 0 |

Applied **alone** to all 702 pairs: HR match 16.1%, duration 22.4%, clock 51.4%, same route 10.7%, weather
available 27.4%, weather match 3.6%, same conditions 6.0%. Missing HR is not a factor (53/53 steady runs have
it). 15/53 steady runs (28%) individually fail clock consistency.

**Reading:** the gates are individually defensible but jointly multiplicative. HR ±3 bpm and duration ±15%
remove ~97% of pairs before route, terrain or weather are considered; weather presence then removes most of the
rest. Pooled pairs are not date-ordered, so the first-failure counts overstate HR/duration (random pairs differ
in effort by construction); the **zero pass-all** and the weather/route collapse are the robust findings.

### Structural data-coverage finding (code-derived, confirmed by observed coverage)

Weather is fetched and persisted **only when a GPS run's detail page is opened** (`runs/[id]/page.tsx`, weather
backfill). Observed run weather coverage by month: Mar 0/12, Apr 2/14, May 0/12, Jun 13/17, Jul 12/17, Aug 4/8,
Sep 2/10. The weather gate therefore selects runs the owner happened to view, not runs that meet a physiological
criterion. Route clusters are far better covered (75–100% of runs per month since March; 94% of steady runs in the last 120 days). This is a **Category C** item.

### Synthetic — verified

`src/utils/__tests__/comparableEffortFunnel.test.ts` (23 tests): gate counts reconcile exactly
(candidates = previous survivors; excluded = candidates − surviving); matched/effective pairs and weighting
equal the live estimator's diagnostics; each of the ten pairwise gates agrees with the live
`pairResearchRuns` (oracle test); missing data is separated from mismatch; no anchor / expired anchor stops
cleanly; output contains counts and rules only.

### Dominant causes (ranked, with confidence)

1. Joint intersection of HR ±3 bpm × duration ±15% × same route × weather match — **observed (pooled)**.
2. Weather presence depends on Run Detail views — **observed + code-derived**.
3. Short evidence window after the anchor (35-day recent window; steady ≈ 3 runs/week; needs ≥ 3 pairs over
   ≥ 3 weeks and > 3 effective pairs) — **code-derived**; not measured on current data.

## D. Heart-rate evidence assessment (coverage observed; formulas not audited)

| Signal | Observed coverage (steady runs, 120 d) | Usefulness | Principal limitation |
|---|---|---|---|
| Average HR | 53/53 | Usable as a screen | Whole-session mean; cardiac drift, heat and fatigue confound ±3 bpm "equal effort" |
| Same-route cluster | 50/53 | Usable baseline | Same cluster ≠ same effort or conditions; clusters are concentrated (10.7% pair pass) |
| Elevation gain | 50/53 | Usable | Net gain only; no grade profile |
| `hrDriftPct` | 53/53 | Uncertain | Computation contract and artifact rate **not inspected**; duration/time-series quality unknown |
| Efficiency score | present on ~51% of all parents | Uncertain | Derived and HR-reserve adjusted; calibration to race pace unknown |

Not assessed: configured max/resting HR changes over time, sensor artifacts, and how drift/efficiency are
computed. No raw HR/GPS child collections were read.

## E. VO₂ max evidence assessment (observed, aggregates only)

- **Pipeline:** `users/{uid}/healthMetrics/{YYYY-MM-DD}` field `vo2_max`, read through `buildVo2History`
  (`vo2History.ts`, 180-day bounded window; non-positive values dropped; sorted by date). Doc id equals `date`
  for every doc (0 mismatches). Provenance beyond "Apple Health export via the iOS app" is **not verifiable
  here**; units are ml·kg⁻¹·min⁻¹. This is an **Apple Watch estimate, not a laboratory measurement**.
- **Coverage:** 325 positive readings, 2018-12-16 → 2026-09-20; median spacing 2 days; 13 gaps > 14 days, 6 > 30
  days, one 1,332-day hiatus. Last 12 months: 124 readings (9–17/month), max gap 22 days.
- **Quality:** 290 unique values; 9 consecutive duplicates; median step 0.14, 8 steps > 2.0 (max 6.3) —
  discontinuities that look like device/model changes or gaps; cause unknown.
- **Level/trend (last 12 months):** range 44.0–51.3; 28-day medians 49.0 → 48.5 → 50.1 → 50.5 → 50.8 → 48.0
  over the final year to Sep 20 (n = 9–16 per window).
- **Suitability:** dense enough recently for a 28-day rolling median; **not** suitable for per-run effects.
  With one in-sample anchor, **incremental predictive value cannot be tested**. No VO₂→finish-time transform is
  proposed or implied.

## F. Research evaluation

| Candidate | Evidence | Result |
|---|---|---|
| Base v2 | unchanged | baseline; no independent outcome |
| + comparable-effort pace | funnel above | availability findings only; accuracy **not evaluable** |
| Same-route pace at comparable HR | pooled counts | availability only |
| Efficiency / HR-drift trends | coverage only | formulas not audited; not evaluable |
| VO₂ rolling trend | coverage above | availability only; not evaluable |

No accuracy, bias or improvement claim is made for any candidate.

## Findings classified

- **Category A (delivered):** the research-only funnel tool and tests; this report. No live number changed.
- **Category B (not implemented; needs owner approval + validation):** loosening HR/duration tolerances
  (more pairs ≠ better prediction; validate physiological comparability first); replacing "same condition code"
  with a continuous heat index; VO₂ coefficients; smoothing/cap changes; anchor lifespan; race-day forecasting.
- **Category C (recommendation only):** background weather backfill independent of page views; richer HR
  time-series summaries on the parent; persisted check-point outcomes.

## G. Prioritized roadmap

| # | Item | Predictive value | Evidence | Complexity | Cost | Overfit risk | Needs owner | Needs outcome data |
|---|---|---|---|---|---|---|---|---|
| 1 | Weather backfill not tied to page views (C) | Medium — unlocks the weather gate | Strong (observed) | Medium | Low–medium API/reads | Low | Yes | No |
| 2 | Re-run the dated funnel on a fresh owner-authorized export | Diagnostic | — | Low | One bounded owner read | None | Yes | No |
| 3 | Same-route efficiency, evaluated as a descriptive trend first | Medium | Weak | Low | None | Medium | No | Yes |
| 4 | HR-drift contract audit | Unknown | None yet | Low | None | Medium | No | Yes |
| 5 | VO₂ 28-day trend as a descriptive companion | Low–medium | Weak | Low | None (bounded read exists) | High | Yes | Yes |
| 6 | Comparable-effort threshold review (B) | Unknown | Weak | Low | None | **High** | **Yes** | **Yes** |
| 7 | 180-day anchor limit (B) | Availability, not accuracy | — | Low | None | Medium | **Yes** | Yes |
| 8 | Future race-day forecasting vs current capability (B) | High | None | High | None | High | **Yes** | **Yes** |

**After the March 20, 2027 half marathon:** score the Feb 20, Mar 6, Mar 13 and Mar 19 checkpoints against the
qualified outcome with the existing replay; report availability and error separately; one outcome supports a
sanity check, not model selection. Do not tune on it and then evaluate on it.

**Not delivered in Phase 3I:** the multi-candidate offline comparison harness. With no independent qualified
outcome it could only produce coverage numbers, which the funnel already provides; building it first would
invite unsupported accuracy claims.
