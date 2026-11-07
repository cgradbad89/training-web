# Phase 3K / 3M — Fresh comparable-effort diagnosis, transparency audit, offline evaluation

**Estimator, gates, tolerances, coefficients, race-anchor behavior, checkpoints, enrollment: unchanged.**
Evidence labels: *Live-observed* = measured 2026-11-07 on the owner's production data by the read-only
`scripts/researchComparableFunnel.ts` (counts only; bounded to 164 workout parents, 3 races, 58 overrides; no GPS, HR
stream, health-metric or raw-child reads; nothing written). *Historical* = Phase 3I (2026-09-22 export, pooled). *Synthetic*
= test fixtures. *Hypothesis* = not measured.

## 1. The real, date-ordered funnel (live-observed, as-of 2026-11-07 12:50 UTC, America/New_York)

Anchor: the 2026-09-20 half marathon (present, not expired; 48 of 180 days elapsed). Same inputs the capture path reads.

| Gate | Kind | Candidates | Surviving | Excluded | of which missing data |
|---|---|---:|---:|---:|---:|
| Eligible runs | E | 164 | 103 | 61 | 0 |
| Not a race result | E | 103 | 101 | 2 | 0 |
| In pairing windows (56 d before / 35 d after anchor) | P | 101 | 35 | 66 | 0 |
| Steady 20–90 min | P | 35 | 32 | 3 | 0 |
| **Pairs formed (baseline × recent)** | | **247** | | | |
| Valid HR | E | 247 | 247 | 0 | 0 |
| **HR match ±3 bpm** | P | 247 | **44** | **203** | 0 |
| **Duration match ±15 %** | P | 44 | **4** | **40** | 0 |
| Clock consistency | E | 4 | 3 | 1 | 0 |
| Outdoor | E | 3 | 3 | 0 | 0 |
| Same route | S | 3 | 2 | 1 | 1 |
| Terrain match (5 m/mi) | S | 2 | 2 | 0 | 0 |
| Weather available | E | 2 | 1 | 1 | **1** |
| Weather match | S | 1 | 0 | 1 | 0 |
| Same conditions | P | 0 | 0 | 0 | 0 |
| One-to-one matching / Final confidence | E/P | 0 | 0 | 0 | 0 |

Matched pairs **0**, matched weeks **0**, effective pairs **0.0**; the estimator's own diagnostic agrees (`summary`
adjustment method, 0 matched pairs). Verdict: *comparable-effort pace evidence does not contribute (fewer than the required
pairs or recent weeks)*. The funnel is reconciled to the live estimator by the existing oracle tests.

Each gate applied **alone** to all 247 pairs (independent pass rates): valid HR 100 %, **HR ±3 bpm 17.8 %**, duration ±15 %
23.9 %, clock 57.9 %, outdoor 100 %, **same route 21.5 %**, terrain 96.0 %, weather available 14.2 %, **weather match 0 %**,
same condition code 2.4 %.

Trajectory on the same data and anchor, evaluated at earlier instants (workouts after the instant removed; weather and
overrides as stored today): Oct 1 — 19 steady runs, 0 pairs; Oct 15 — 24 steady, 95 pairs → 15 HR → 1 duration → 1 route → 0
weather; Oct 31 — 31 steady, 228 pairs → 41 → 4 → 3 → 2 → 1 weather-available → 0 match; Nov 7 as above. Zero matched pairs at every
instant.

### Bottleneck (what the data say, not an assumption)

1. **Heart rate ±3 bpm** is the first and largest filter: 203 of 247 pairs (82 %) fail there, before any other rule is consulted.
2. **Duration ±15 %** removes 40 of the remaining 44 (91 %).
3. By the time route, terrain and weather are evaluated only 2–3 pairs remain. Even if **every one** were kept, the minimum is
   3 pairs over 3 separate recent weeks (`minimumPairs`, `minimumRecentWeeks`) with > 3 effective pairs for any weight.
   **No weather repair could have produced a contributing pair on this data.**
4. Weather presence is a real but secondary defect: 40 of 94 outdoor GPS runs in the window have weather (43 %); only 1 pair
   was lost to *missing* weather at that gate (1 of 2). It was the dominant defect in Phase 3I's pooled view; on the dated funnel
   it is not.
5. **Seasonal structure (live-observed):** among the 35 baseline×recent pairs where both runs have weather, 0 are within all
   three tolerances (temperature ±5 °F: 7; humidity ±15 %: 17; wind ±3 mph: 22). Median |ΔT| is 10.9 °F — the pre-anchor window
   (median 75.7 °F) is summer, the post-anchor window (67.5 °F) autumn. A pace comparison that requires matched weather across a
   summer anchor and an autumn recent window will rarely be satisfiable even with complete weather. *This is a finding about
   the design interacting with the calendar, not a recommendation to loosen tolerances* (Category B; needs owner approval and
   independent outcomes).

*Not assumed:* that missing weather would have matched if it existed. The temperature, humidity and wind differences above
are measured on the pairs that do have weather.

### Interaction with Phase 3J (tested)

`comparableEffortWeatherRecovery.test.ts` (synthetic): (a) with no weather the same pairs fail only at the weather gate, all
as missing data, and the adjustment method is not `matched_effort`; (b) once weather with `fetchedAt` ≤ as-of exists, the same
pairs pass and the estimate becomes `matched_effort`, with unchanged policy version, anchor and baseline; (c) weather retrieved
**after** an instant is invisible at that instant and visible later (evidence timestamps preserved; no checkpoint rewritten);
(d) acquired weather outside tolerance still fails the match gate — no threshold is relaxed.

Consequence for Phase 3J: newly acquired weather *can* now reach the unchanged estimator, but on the current data it is
unlikely to change any number; recent runs gain weather only after an app visit.

## 2. Prediction-evidence transparency audit (3M-E1)

| Evidence | Plan Insights | Run Detail | Finding |
|---|---|---|---|
| Current estimate & rounding | Whole-minute estimate; adjustment shown to 0.01 s in details | Impact tile (same estimator) | Details show a 0.01 s adjustment "before rounding" — more precision than the evidence supports; left (labelled, in the details dialog). |
| Race anchor | Name, date, status, age, "Older benchmark" | via the same estimator | Clear. |
| Training volume / recent training | Miles since race, 4/8-week miles, eligible runs/weeks | via estimator | Clear. |
| Comparable-effort evidence | "Matched: N pairs across W weeks (E effective)" + a reason | zero-impact text | The reason said only "Too few qualifying … pairs", implying the runner simply trained too little. **Changed:** it now states the pairing rules (HR ±3 bpm, duration ±15 %, same route/terrain/weather — read from the live policy constants, not copied) and that, without enough pairs, the evidence has no effect. No numerical effect is shown or implied. |
| Missing/excluded evidence | Evidence limitations + excluded-by-reason | — | Clear. |
| Zero-impact runs | Run Detail impact tile | explains no adjustment | Clear since Phase 3I. |
| Insufficient history | "Not enough sustained evidence…" | — | Clear. |

Run Detail and Plan Insights share the single estimator (no second formula); the wording lives in the shared panel copy.
Nothing in the UI shows an effect from VO₂, HR drift, efficiency or weather that the estimator does not use; the VO₂ card is
now explicitly "not a race prediction".

## 3. Offline evaluation harness (3M-E3) — `src/utils/research/signalEvaluation.ts`

`evaluateSignalsAsOf` returns, for an explicit as-of instant and data truncated to what was knowable then, the **availability**
and sample sizes of: the frozen v2 baseline (the only candidate that yields a finish time), comparable-effort evidence,
same-route efficiency trend (clusters of ≥ 3 steady runs spanning ≥ 14 days, EF Theil–Sen % per 28 d), stored HR-drift trend
(usable values from ≥ 40-minute runs), and the VO₂ 28-day median. `scoreAgainstOutcomes` scores only against qualified
outcomes strictly later than the instant, and returns **`NOT EVALUABLE`** with no statistics until ≥ 5 independent qualified
outcomes exist; above that it stays "descriptive only", ranks nothing, and states that candidates without a finish-time
transform are *not assessed* rather than scored as zero error. Leakage guards (tested): later workouts removed; weather fetched
after the instant treated as absent; later VO₂ removed; appending future data changes nothing; a non-later outcome throws.
Never imported by live code (test-enforced); no production configuration involved.

**Result today: accuracy NOT EVALUABLE** — there are 0 prospective qualified outcomes and one in-sample anchor.

## 4. March 20, 2027 outcome path (3M-E4) — verified, no gap that needs new code

Existing tooling (Phase 3D–3H) already: schedules four checkpoints at 28/14/7/1 days (Feb 20, Mar 6, Mar 13, Mar 19 for a
Mar 20 race; pinned by the enrollment/scheduled-capture tests), seals outcomes with independent-timing and maximal-effort
qualification (`sealOutcome`), requires custody receipts for real data, partitions each horizon separately, refuses pooling,
reports availability separately from error, compares the experimental estimate with same-anchor/same-distance/Riegel/VDOT and
arithmetic component removal (including `noComparablePace`), and states that a single outcome is a sanity check. Run it after
the race with `PHASE3D_MODE=outcome` then `PHASE3D_MODE=evaluate` (docs/half-marathon-validation-phase3d.md). This harness adds
the candidate-availability view at those same four instants; nothing about the schedule, enrollment, snapshots or estimator
was touched. One race outcome cannot establish that any variant is better.

## 5. Experimental roadmap (needs future outcomes unless noted)

1. *Engineering, now:* none required for correctness; weather acquisition is live (3J).
2. *Needs outcomes:* after Mar 20, 2027, score the four checkpoints with `evaluateStudy`; run `evaluateSignalsAsOf` at the same
   instants to attach availability context.
3. *Needs owner approval + validation (Category B):* a season-aware or continuous heat-index replacement for matched-weather
   tolerances; HR/duration tolerance review. More pairs ≠ better prediction.
4. *Research without outcomes:* a duration-normalized, warm-up-trimmed drift variant evaluated for stability across repeated
   same-route runs; surface/terrain-stratified efficiency baselines.

## Reproduce

`FUNNEL=1 FUNNEL_OUT=/path/out.json npx vitest run scripts/researchComparableFunnel.test.ts` (needs the owner's local
credential in `.env.local`; read-only; prints counts only).
