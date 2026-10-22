# Phase 2 quality and evidence integrity investigation

Investigated October 22, 2026 against approved main `672bdcc8534358344243c6c5ae434b05456a2bea`. The original acceptance artifacts remain under local `audits/manual-performance-acceptance-2026-10-22/`; detailed private diagnostics are under `audits/manual-performance-quality-2026-10-22/`. Raw locations are not committed.

## Verdict and evidence basis

**Investigation complete; two correctness defects corrected; numerical Phase 3 is not ready.** The October 14 run (`9238A5EB-3097-435C-A8D9-F98D41F2033B`) was unresolved because its route crossed the workout start boundary. Heat independently failed the existing comparison policy. Missing HR and a gross distance mismatch were not demonstrated: the old extractor generated those reasons after discarding every interval for the boundary failure.

The 2,303 route records were recovered read-only from the authenticated browser's persisted Firestore cache. Executing only the deployed pure position/time arithmetic on those local values reproduced the saved telemetry SHA-256 exactly: `c6b96eb69a3e0b1c8c6ef69c1e137a5b9d137dada73b94404206a415add7ef34`. This ties the diagnostic interval stream to the saved receipt despite older cache read times. No production Analyze action, fresh production GPS/HR acquisition, or evidence write was performed. Equivalent reimplementations/Node arithmetic produced tiny floating-point differences and different exact hashes; verification therefore used the exact deployed browser reduction, not approximate equality. This is not proof of raw-source immutability or cross-runtime reproducibility.

Production Manual Performance remains enabled. The investigation does not change environment configuration, Firestore rules/indexes, numerical methodology, historical receipts, or automatic processing behavior. Corrections apply to future owner-triggered calculations; no repair calculation was executed.

## Complete run trace

| Stage / predicate | Observed evidence | Accepted range / outcome |
|---|---|---|
| Effective parent and overrides | Completed outdoor running workout; not excluded. Relevant effective parent digest `38085133765e49b88e0cae2b02f85c49855bb63ddae19305d18ee5283d301f0c`. | Valid completed outdoor run; passes. Effective persisted values already include canonical overrides. |
| Workout start/end | `2026-10-14T21:21:09.578Z` to `2026-10-14T22:00:07.845Z`; elapsed **2,338.267 s**. | Increasing, completed UTC timestamps; passes. Local display is October 14 in America/New_York. |
| Active/recorded duration | **2,303.877451 s**, **34.389549 s** shorter than elapsed. | Difference ≤max(60 s, 2% duration), here 60 s; passes. Duration≥1,200 s. |
| Route timestamp bounds | Index0 at `21:21:09.434818Z`, normalized **−0.144 s**; index1 at **0.856 s**. Exactly 1 out-of-bounds point and1 crossing interval. Final point at 2,337.422 s,0.845 s before end. | Every interval must begin≥0 and end≤elapsed. First interval violates the contract; all 2,302 intervals are excluded from observation reduction. |
| Ordering / gaps | Indices0–2302 contiguous; no duplicate/non-increasing times or overlapping intervals. One36 s interval from1,272.422 to1,308.422 s. | Interval duration≤10 s; the36 s gap is excluded from acquisition coverage. No evidence establishes whether it is pause, dropout or both. |
| HR | All 2,303 route points have plausible HR, range109–181 bpm. Route HR supplies all retained interval time; no HR-stream query was needed. | Plausible range60≤HR<210; ≥90% populated-HR coverage. Original HR timestamps/source/age are absent from route documents, so physiological accuracy and independent sample coverage remain unverified. Parent average164.8825 bpm is not the extraction basis. |
| GPS speed / distance | Speeds approximately0.391–3.524 m/s; no intervals exceed7 m/s. After the10 s gap screen, path distance approximately6,290.927 m versus parent6,281.870 m, difference+0.1442%. | 0–7 m/s global plausibility, ±10% parent-distance agreement; acquisition measurements pass. Distance≥3,218.688 m. |
| Acquisition time coverage | 2,301 retained short intervals, approximately2,301.566 s /2,338.267 s = **98.4304%**, populated-HR coverage approximately100%. | ≥90% time/HR; passes before strict structural rejection. These are diagnostic acquisition figures, not accepted aerobic seconds. |
| Terrain | Ascent24.49 m /6.28187 km =3.8985 m/km. | ≤15 m/km; passes whole-run screen. Local grades, descents and elevation accuracy are not established. |
| Environment | Temperature **85.3°F**; dew point69.7°F; wind4.8 mph. | Temperature≤80°F, dew point≤70°F, wind0–15 mph. Temperature fails independently; other values pass. |
| Source samples | 2,303 returned documents,2,302 constructed intervals. | ≥100 samples; passes. Parent flags/counts are not child revisions. |
| Segmentation | Nominal post-warmup windows600–1,200 s and1,200–1,800 s. | Both were **not evaluated** by production because earlier reasons/unresolved state blocked segmentation. No production claim that both failed steady-state tests is justified. |
| Final status | Unknown telemetry, unresolved feature, zero observations/independent workouts. | Appropriate conservative output. No numerical half-marathon estimate or confidence interval. |

The first source point is genuine supplied evidence outside the parent boundary, not missing evidence. The web adapter preserves it; neither clipping it nor moving the parent start is justified without an approved source/boundary policy. It is only 144 ms early, so this does not demonstrate a timezone or clock malfunction. The strict rejection is conservative; a future clipping/tolerance design would require explicit semantics, source provenance and tests, and was not implemented.

Offline conditional diagnostics on the digest-matched intervals explain the unevaluated windows without promoting them to observations: 600–1,200 s would pass the window screens (speed CV 0.02014≤0.12, HR SD 2.74591≤6 bpm, drift 4.54592≤8 bpm; mean HR 162.807). At1,200–1,800 s, minute 2 has 24 measured seconds<54 and 79.1667% running<95%; further diagnostic HR SD 6.54272>6 and drift 11.33193>8 also fail, although the actual reducer stops at the minute checks. The remaining 538.267 s cannot form a 600 s window. Heat still rejects the workout even if a future approved boundary policy addresses the early sample.

The local read-only iOS source (`cgradbad89/MEA`, commit `1fa269e478cad74818f16dfa000f12b6470e51c3`) writes HealthKit parent dates and CLLocation timestamps directly. It does not clip route points to parent bounds or sync pause/resume events. Its completion check accepts an end near the workout end **or** sufficient GPS distance; it does not guarantee every point is inside the workout. The emitting iOS build was not persisted, so this explains the schema rather than proving which build produced this run. Apple documents distinct workout duration semantics; the 34.389549 s difference and 36 s route gap are compatible with pausing but cannot establish it. [Apple HKWorkout.duration](https://developer.apple.com/documentation/healthkit/hkworkout/duration)

## Every saved rejection and correction

| Saved v1 reason | Origin and affected scope | Scientific / implementation assessment |
|---|---|---|
| `invalid_or_overlapping_intervals` | One boundary-crossing interval invalidates reduction of all 2,302 intervals. | Legitimate structural contract failure; keep rejection. No overlap was found. |
| `telemetry_completeness_unverified` | Acquisition issues make the whole selected workout unknown despite adequate aggregate coverage. | Legitimate uncertainty; completed parent/user sync confirmation do not prove valid child evidence. |
| `known_extreme_environment` |85.3°F affects the whole workout, preventing both candidate windows. | Appropriate existing comparability screen;80°F is a descriptive engineering heuristic, not a validated physiological threshold. Preserve it. |
| `insufficient_measured_time_coverage` | Structural failure first sets accepted intervals to empty, then reports0 coverage. | Cascaded diagnostic defect: does not show a missing GPS stream. v2 reports null unevaluable coverage and an explicit limitation. |
| `insufficient_measured_hr_coverage` | Same empty interval set yields null HR coverage. | Cascaded diagnostic defect: does not show missing acquired HR. Suppress as an independent failure when measurement reduction is invalid. |
| `measured_distance_disagreement` | Empty reduction produces0 m against parent distance. | Cascaded diagnostic defect: not a measured route-distance disagreement. Suppress until reduction is evaluable. |

Extractor `steady-interval-v2` retains zero accepted seconds and all existing eligibility thresholds. Invalid intervals produce null coverage and `measured_coverage_and_distance_not_evaluated_due_to_invalid_intervals`; heat and structural/unknown-telemetry reasons remain. Existing v1 evidence is preserved. Synthetic fixtures use fabricated positions with the−0.144 s boundary and 36 s gap, plus an independent heat-only control. They reproduce the anomaly without asserting an iOS clock defect or changing production records.

## Receipt linkage and historical truth

The original feature is revision1, extractor v1, policy `observational-v1`; its workout, parent, source-input and telemetry references agree. Offline feature and input digest recomputation passed. Current and immutable snapshot are canonically identical at revision1, snapshot `e07cf00aa7a9274ff400ebbff33fcdf06bac5e31710cc9f875c8815023b2b875`. Numerical fields are null. Calculation started/evidence-as-of is `2026-10-22T21:27:39.027Z`, completed `21:27:47.167Z`, server commit `21:27:47.672Z`; UI correctly displays October22,5:27PM Eastern. Evidence-as-of is the calculation cutoff, not the latest workout timestamp or a guarantee all children existed atomically at that instant.

**Proven linkage defect:** the unresolved extracted workout influenced calculation inputs/digests, but the reusable-observation filter omitted its feature from provenance, `featureRevisions`, and the final transaction. A concurrent replacement could therefore escape the feature revision check. The original summary still truthfully showed unresolved/partial and zero accepted; its empty manifest remains an auditability limitation and is not rewritten.

The corrected workflow separates a compatible dated receipt from an eligible aerobic observation. Every incorporated compatible accepted/rejected/unresolved receipt enters evidence identity, provenance and the final revision/digest check. Selected save results are also compared with the subsequent saved-set refresh; replacement/missing/incompatible receipts abort. Pure quality classification still determines accepted/rejected/unresolved counts. Existing schema and published security configuration support this correction; no rule/index migration is needed. v1 features are incompatible with v2 reuse and require explicit owner reprocessing; existing saved v1 summaries remain readable.

Feature revisions are mutable current extraction records; immutable snapshots contain the revision/digest manifest, not a full archive of every feature revision or raw input. Complete independent reconstruction of old calculations remains unavailable after inputs/revisions change. Same-parent child repairs cannot be detected without rereading children or native generation metadata. Current rules cannot supply a source-generation fence. A dated extraction may remain valid historical evidence while being stale relative to later unseen corrections. Do not label it current verified live telemetry.

An identical same-window recalculation may legitimately leave the prior snapshot and displayed saved timestamp unchanged because extraction/calculation clock changes alone are excluded from stable publication identity. Changed evidence, versions or windows can produce a new revision even if rounded metrics do not move. Derived floating-point hashes are exact implementation receipts, not canonical native-source generation hashes.

Historical race linkage is correct: April26 maps to workout `5EFF4DDC-AB3C-47F3-AEB4-CDD309FEBF98`, duration8,129.865532 s versus elapsed8,759.233 s, a disclosed629.367468 s discrepancy. September20 maps to `C64FF225-1DD7-4BEC-A968-7DA71E3BC0CF`, duration7,870.746366 s versus elapsed7,870.746 s. Dates agree with linked local workout dates. Neither is verified official chip time; GPS overdistance is not normalized into faster race performance.

## Read efficiency

| Application-accounted category | Review | Analyze | Total |
|---|---:|---:|---:|
| Parent workouts |300|600|900|
| Matching overrides |9|18|27|
| Feature lookups, including missing documents |159|318|477|
| Review current lookup |1|0|1|
| GPS child documents |0|2,303|2,303|
| HR-stream documents |0|0|0|
| Feature save transaction |0|1 estimated|1|
| Supporting races |0|3|3|
| Supporting daily health |0|180|180|
| Current/snapshot transaction |0|2|2|
| **Total** |**469**|**3,425**|**3,894**|

GPS acquisition was ten bounded pages (nine × 250 + 53), only for the selected run, below the5,000 budget. Initial legacy page activity, five post-acceptance verification reads and passive reloads are separate. The old final transaction had zero feature checks because the unresolved manifest was empty; the corrected equivalent has one additional required receipt read. Writes were feature 1, current 1, snapshot 1; no performance writes during initial display/review. No Vercel API processing or recurring job is introduced.

This is mixed application accounting: queries count returned documents, direct missing-document requests count lookups, feature transaction retries are estimated, and final transaction callbacks count their reads. Firestore billing, minimum empty-query charges, dependent security-rule reads and index charges were not available. [Firestore pricing](https://firebase.google.com/docs/firestore/pricing)

Potential optimization: combine selected CAS return values with the already refreshed feature set instead of rereading all 159 feature documents, retaining transaction validation of every incorporated revision. This needs a defined evidence-set consistency contract and regression coverage; it is deferred. Parent/override revalidation and post-review refresh remain necessary. Bounded sparse feature queries may reduce missing-document overhead but require billing measurement. Cached GPS must not replace fresh server-only analysis acquisition: local cache was used solely to diagnose an existing digest-matched receipt.

## Measurement limits and Phase 3 prerequisites

This is a steady-running measurement pipeline, not a reliable easy/tempo/threshold classifier. A synthetic steady 190 bpm workout can pass the absolute-HR screens; five-bpm bands are not individual physiological zones. Linked races are excluded from aerobic comparisons, but unlinked races/high-effort runs cannot reliably be distinguished. Whole-run ascent does not control local grade or descent. Gaps/slow minutes screen stop-and-go indirectly without pause events. Populated route HR does not preserve its originating sample timestamps or device quality, even though current local iOS source associates the nearest HR within±10 s. Unknown weather can remain accepted with a limitation, so acceptance does not prove environmental comparability.

Heat-related cardiovascular drift supports treating temperature/humidity as confounders, but does not validate this application's 80°F cutoff. [PSU HEAT experimental study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10393325/)

The software minimum for a descriptive trend is three distinct workouts in the same HR band in each of two comparison windows (at least six contributing workouts). This is not a scientifically calibrated minimum sample size; multiple same-day workouts are separately counted and their independence may be limited. This acceptance supplies zero accepted workouts. Mileage, device VO₂ and two unverified historical race times cannot substitute for missing comparable observations.

Before separately approving numerical Phase 3, require:

1. An owner-approved native synchronization contract for child generation/revision, expected counts, final completion, source/build identity and corrections; retain HR observation timestamps/age and pause-event semantics.
2. An explicit boundary/gap/partial-stream policy validated with synthetic and representative native fixtures; no silent timestamp clipping or threshold relaxation.
3. Repeated independently sourced comparable runs across both windows, with effort, environment, terrain and sensor limitations addressed. Software counts alone do not establish physiological validity.
4. Correctly linked dated race outcomes with trustworthy distance, elapsed/chip-time and effort context, plus an independently approved validation/calibration plan and uncertainty model.
5. A decision on durable feature-version history/raw-source identity if full retrospective reconstruction is required.

No numerical estimator, graph migration, map implementation, historical backfill or scheduled work is included. The approved high-priority on-demand GPS map/hydration item is documented in PRD.md only.

## Validation and delivery

Regression coverage includes unresolved/rejected receipt inclusion, stale selected receipt rejection, transaction conflicts, immutable/duplicate publication, boundary/gap reproduction and truthful unevaluable diagnostics. Local validation: 9 new tests; 2,154 total across 175 files (2,126 passed, 28 opt-in skipped). All 16 isolated emulator cases passed separately. Typecheck passed; tracked-file lint passed with zero errors and 99 pre-existing warnings. Production build passed using the existing local symlink-compatible command `NODE_PATH=/Users/johnfolstrom/Desktop/training-web/node_modules npm run build -- --webpack`; default CI/Vercel build configuration is unchanged. Protected-main delivery details are recorded in the task completion report and local investigation audit.
