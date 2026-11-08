# HR-enhanced display evaluation — 2026-11-08

**Recommendation: keep HR-enhanced out of the headline display, accessible as an advanced comparison in Estimate Details.** Keep legacy Hybrid v1 there too. Neither model is deleted. This is a presentation decision, not a ranking of predictive accuracy.

## Bounded evidence reviewed before changing the UI

No Firestore, GPS, HR-stream or health-metric reads; no database writes; no new historical backtest. This review uses the existing Phase 3O report, the Hybrid v1.1 evaluation, the confirmed-race assumption report and one local, previously generated aggregate backtest. The private source stays untracked.

| Evidence | Measured result | Limits |
|---|---|---|
| Existing Phase 3O daily summary, Sep 20 anchor +14 days through Nov 7 (35 days) | HR signal evaluable 13/35 (37%), directional 4/35 (11%), suppressed 22/35 (63%). Reported HR effect at most 0.07% of race time; daily HR-attributable step at most 5.5 s. | Directional evidence does not necessarily move the estimate: the adapter also checks sign consistency with the official adjustment. The retained report does not provide an exact nonzero-estimate count or median difference for these 35 days. These observations predate the Nov 8 confirmations/assumption. |
| Cached April reconstruction, `owner_confirmed_retro` variant, Jun 8–Sep 20 | 45 sampled checkpoints, 34 with both numerical estimates; **33/34 differ**, all faster than official; median absolute difference **22.85 s**, mean **20.24 s**, maximum **37.9 s**. | Retrospective reconstruction with the owner-attested April 2:15:30 result and maximal effort assumed. Not known-then predictions, not 34 independent observations, not a random daily sample, and not a post-confirmation production replay. Seconds were already rounded to 0.1 s in the source. |
| Strict historical variant of the same cache | **0/45 paired numerical estimates**. | Cannot establish historical divergence frequency. Do not pool strict and reconstructed results or counterfactual variants. |
| Existing Nov 7 Hybrid v1.1 evaluation | Official and HR-enhanced both 2:11:01; v1.1 2:11:26. Stream screening changed aerobic slope from −0.85 to −0.12%/28 d, neither detectable; physiological time contribution stayed zero. | One observed instant, before the Nov 8 estimator assumption. |
| Existing Nov 8 confirmed-race assumption report | Official and HR-enhanced both 2:10:49; Hybrid v1 2:11:09; v1.1 2:11:16. | Previously recorded owner-data result, not newly queried here. |

Cache: `audits/april-reconciliation-2026-11-08/backtest-v2.private.json`, generated `2026-11-08T14:00:00.000Z`, SHA-256 `6a5d6bda69ffe67b1fa54aaa9fc9deab1faae76342cff083deef93109cb95207`. Aggregate calculation: for each timeline row in `owner_confirmed_retro`, retain non-null `official.seconds` and `hrEnhanced.seconds`; compute HR minus official, count absolute differences > 0.000001 s, then mean/median/max absolute difference. No raw owner records are published by this report.

## Qualification, credibility and overlap

The 33 nonzero reconstructed differences demonstrate that the adapter allowed HR to influence its result at 33 of the 34 paired sampled checkpoints. The cache contains estimate seconds, not the HR support/strength diagnostics needed to audit those observations independently. Therefore it cannot establish the credibility of each of those 33 HR effects or the frequency of qualified-but-zero effects. The Phase 3O qualification counts above answer signal availability for a different, explicitly identified window.

Phase 3O's observed Nov 7 signal used 12 baseline / 8 recent runs across 7 / 6 weeks. Several alternative parent-HR formulations agreed on improvement at that instant, while Nov 1 disagreement caused suppression. Coverage, shared HR range, weekly agreement, noise shrinkage, terrain/duration/artifact screens and weather attenuation are useful safeguards. They do not establish equal effort or remove heat, fatigue and surface confounding. The reported threshold sensitivity (direction changes in 2/14 perturbations and availability in 1/14) counsels against a competing headline number. The exact current strength and credibility of earlier reconstructed differences remain unverified.

HR-enhanced is **not an identical calculation** to Hybrid v1.1. It compares pace at similar parent average HR in pre-anchor and recent windows and blends toward an HR-supported adjustment of Official v2. Hybrid v1.1 combines performance evidence, endurance readiness and a calibrated multiweek aerobic trend, with bounded stream screening and VO₂ corroboration. The signals overlap conceptually but can disagree because of windows, screening and combination. The advanced HR row retains its window, support counts, direction, fallback reason and assumptions. Run Detail's separate HR impact tile remains intact, as do research tools. Hiding the headline therefore loses no existing diagnostic capability in enabled builds; it requires opening details. When official is unavailable, the existing HR comparison remains unavailable and is not invented.

**Predictive accuracy is not assessed.** The prior studies report no independent qualified validation outcomes. The subsequent owner-approved maximal-effort modeling assumption does not create independent validation. Neither reconstruction differences nor agreement with the same anchor establish comparative accuracy. Further independent outcomes are needed to rank models; they are not needed to simplify the display.

## Dependency audit and scope

- `RacePerformancePanel` computes Official v2, HR-enhanced, Hybrid v1, v1.1 and the forecast once per existing memo dependencies. HR-enhanced reuses the official result. Preserve this entire computation path and its gates.
- `hybridPerformance.ts` and `hybridPerformanceV11.ts` consume supplied official/HR/v1 numbers for comparison fields, not as extra fitness evidence. Preserve those fields and outputs. Forecast v2 starts from v1.1 and re-evaluates that estimator for readiness scenarios; rollback still computes forecast v1 from v1.
- Legacy v1 is currently visible under the v1.1 rollback gate and as a comparison inside v1.1's expandable explanation. Move those display-only results into the single collapsed comparison section. Keep rollback calculations and forecast lineage unchanged.
- Plan Insights' dated race timeline, historical charts, saved performance documents/snapshots and retired research workflow remain unchanged. Run Detail's official and HR impact calculations/displays remain unchanged. The panel remains pure with respect to acquisition; opening/expanding details adds no reads or model work.
- Preserve April 26, 2026 **2:15:30**, September 20, 2026 **2:11:11**, stored confirmation classifications, and the active prediction-only maximal-effort assumption. No records are edited in this task.

Sources: [Phase 3O HR evaluation](phase-3o-hr-enhanced-evaluation.md), [Hybrid v1.1 evaluation](hybrid-v1.1-evaluation.md), [confirmed-race assumption](../confirmed-race-maximal-assumption.md), and the private cached aggregate identified above.
