# April → September 2026 historical case study (research only)

> **Update 2026-11-08 — April result reconciled.** The owner attests the April official finish was **2:15:30**. The "elapsed 2:25:59" scenarios below are **refuted and obsolete**; read "Update: reconciled rerun" first. The earlier text is kept as the record of the first analysis.

**Historical case study — insufficient independent outcomes for scientific validation.** Aggregate findings only: no workout identifiers, routes, per-run values or raw exports are stored in the repository. The detailed owner report and chart were produced privately.

## Update: reconciled rerun (2026-11-08)
**April finish.** The attested official time (2:15:30, owner attestation only; no official-timing source was supplied or checked) equals the watch moving time. The 10:29 elapsed gap is explained by preserved data (bounded read of one workout): the route has points at the very start, then none for ≈10½ minutes while heart rate sits at standing levels, then movement resumes and runs to the end of the recording — the recording began before the timed start. Original workout measurements are unchanged. The existing `official_race` confirmation with a `timingReconciliation` explanation represents this correctly; no integrity rule was changed. **An official time alone does not create an anchor:** maximal effort and conditions must also be attested (`maximal_effort_not_confirmed`). The confirmation is only *known* from its real instant (strict replay), so it cannot exist in April–September; reconstruction uses it as a labelled, research-only anchor from the day the linked run reached the database.

**Rerun (research-only anchor).** Hybrid v1.1 / v1 final pre-race estimate 2:16:39 (**+328 s** vs 2:11:11), official v2 / HR-enhanced +302 s; identical to the earlier moving-time counterfactual at the end (mid-summer differences ≤ 12 s). Strict and as-saved replays remain unavailable throughout. 0 of 5 required qualified outcomes.

**Exact decomposition of the final estimate** = April base 8,130 s (100 % evidence share) + physiology 0 (trend available, no detectable change) + endurance readiness +69 s (0.06 × Δreadiness 0.65→0.37 × 0.5). So **~79 % of the miss (259 s) is the anchor itself** — nothing qualified to move it — and **~21 % (69 s) is the readiness term**, of which about half arrived in the final 14 days (taper) and half from an August training gap. The readiness term cannot tell a taper or a planned reduction from lost preparation.

**July step.** The +105 s move on a single day is two simultaneous hard thresholds: the last non-race effort passes 180 days (+37 s) and the eligible-run count for the aerobic trend drops from 20 to 19 as one run leaves the 112-day window (+65 s, a −97 s term disappears), plus +2 s. The trend availability flickered across the 20-run minimum several times over the summer; leave-one-run-out at the final instant is only 23 s, so the discontinuity is boundary-specific and rule-introduced, not new evidence.

**Newer evidence.** Of 49 post-April runs ≥ 3 mi, two met the hard-effort test; one was rejected by the heat screen and one by the moving/elapsed tolerance (and adds nothing even if that screen is ignored). Stripping weather changes v1.1 by −70 s only because the heat screen then admits the first run and shifts the evidence reference date used by the readiness term — an evidence-set effect, not weather physics. 88 % of stored best-effort summaries are version 1; treating them as current still qualified no segment; recomputation was not justified (thousands of route reads per run, bounded benefit, unchanged rejections).

**No contemporaneous indicator pointed to the improvement:** device VO₂ max medians rose through July and fell back by September; the heart-rate trend at the end was flat-to-slightly-worse. One race cannot show whether this is model error or race-day variance.

**Recommendations (unchanged in kind):** (1) enter the April confirmation including effort and conditions, then confirm September; (2) a design review — not implemented — of the 180-day expiry and 20-run minimum cliffs, the moving/elapsed tolerance for ordinary runs, and a readiness term referenced to a single evidence date and blind to taper, validated on synthetic scenarios and ≥ 5 independent outcomes; (3) defer any heat-screen or threshold change until more races exist.

## Purpose and rules
Replay how the shipped estimators (official v2, HR-enhanced, Hybrid v1, Hybrid v1.1, Forecast v2) would have behaved between the 2026-04-26 PNC Half Marathon and the 2026-09-20 DC Half Marathon, and compare the last pre-race estimate with the recorded DC result (2:11:11). Nothing was tuned: no formula or coefficient changed, and no outcome was used to select any parameter. Read-only; no write, backfill, processing job, saved-analysis publish, Firestore rule/index change or new collection.

## Replay kinds (never mixed)
| Kind | Rule | Result in this case |
|---|---|---|
| `strict_historical` | A record counts only if its own timestamp proves availability (`syncedAt`, override `updatedAt`, race `createdAt`, weather `fetchedAt`, confirmation revision time). Production `asOfMode: "historical"` race rules. VO₂/HR summaries withheld. | **Unavailable at every checkpoint.** Neither race has a confirmation revision. Before 2026-04-02 the database held no workouts (bulk import). |
| `retrospective_reconstruction` | Present-day records; later workouts, races, overrides, confirmations and VO₂ excluded; back-filled workouts assumed available at completion (counted per row). **Not** a prediction that existed then. | **Unavailable at every checkpoint after 2026-04-26** when the April record is taken as saved. |
| `counterfactual_*` / `hypothetical_*` | Research-only edits: April clocks forced to agree (moving 2:15:30 or elapsed 2:25:59), April removed, or stale best-effort versions relabelled current. | The only source of numbers below. Never an officially verified race. |

`truncateAsOf` (existing) filters only workouts by `endDate` + `syncedAt`; it does not truncate races, overrides, weather or VO₂, and its sync gate would drop every pre-April workout. `src/utils/research/historicalBacktest.ts` adds those rules.

## Race integrity
- **April 26 — PNC Half Marathon (superseded by the update above):** recorded moving duration 2:15:30 vs watch elapsed 2:25:59 (**+10:29**; tolerance 1:28) → `inconsistent` (`duration_elapsed_discrepancy`), plus unconfirmed effort/conditions. Distance +2.0 % (within 5 %). The HR stream is continuous across the whole elapsed window, so the pause cannot be located from HR. No official result in the app. **The finish time cannot be reliably established; ineligible as an anchor.** The race record predates the race; the linked workout was synced 2026-04-27, so the link could not exist earlier.
- **September 20 — DC Half Marathon:** recorded 2:11:11, elapsed = moving (clocks agree), distance +1.5 %, synced the same day → `recorded_unverified` (a credible *recorded* outcome, not an official or confirmed one).
- No duplicate or overlapping run records, multi-race links or overrides affect either race.

## Results (counterfactual: April accepted at the recorded moving time, 2:15:30)
| Checkpoint | v2 | v1 | **v1.1** | v1.1 race share | Main change |
|---|---|---|---|---|---|
| Apr 27 (race available) | 2:15:30 | 2:15:19 | **2:14:46** | 0.84 | first estimate |
| Jun 1 | 2:15:30 | 2:15:48 | **2:14:50** | 0.83 | readiness |
| Jul 13 | 2:14:23 | 2:12:59 | **2:12:27** | 0.77 | physiology trend (−96 s) and readiness (−52 s) |
| Jul 20 → Jul 27 | 2:14:10 → 2:14:57 | 2:12:54 → 2:13:10 | 2:12:33 → **2:14:32** | 0.92 → 1.00 | **+119 s in a week**: last non-race evidence ages past 180 d; trend loses its 20-run minimum |
| Aug 1 | 2:15:30 | 2:13:12 | **2:14:35** | 1.00 | April flagged stale (97 d) |
| Sep 1 | 2:15:58 | 2:15:41 | **2:15:41** | 1.00 | readiness 0.61 |
| Sep 13 | 2:15:56 | 2:16:18 | **2:16:18** | 1.00 | readiness 0.45 |
| Sep 19 | 2:16:15 | 2:16:35 | **2:16:35** | 1.00 | readiness 0.39 |
| Sep 20 05:00 (last valid) | 2:16:13 | 2:16:39 | **2:16:39** | 1.00 | readiness 0.37 (+69 s) |

Elapsed-time counterfactual (April = 2:25:59): v1.1 2:24:19 (Apr 27) → low 2:21:21 (Jul 13) → 2:27:14 (Sep 20).

## Prediction error vs recorded 2:11:11 (predicted − actual; + = slower)
| Model | Production / strict | April = moving time | April = elapsed time |
|---|---|---|---|
| Official v2 / HR-enhanced | unavailable | +302 s (+5:02) | +935 s (+15:35) |
| Hybrid v1 / **v1.1** | unavailable | **+328 s (+5:28)** | +963 s (+16:03) |
| Forecast v2 (Sep 19; plan state unprovable) | unavailable | +324 s | +958 s |

Pre-April (independent test of the April race): **unavailable** in every variant (no earlier race anchor; three unconfirmed whole-run efforts are below v1.1's minimum). No zero or invented value is reported.

## Interpretation
- **No evidence that v1.1 behaved better than the original model:** v1 and v1.1 produced identical numbers from Aug 3 and identical errors; v1.1 only adds transparency (race share, low confidence, aging flags).
- **Anchoring was by absence of evidence, not by choice:** after April no qualifying whole-run effort or sustained segment existed at any checkpoint (ordinary training is not performance evidence by design). 88 % of stored best-effort summaries are computation-version 1 and are ignored; with versions relabelled current, the 2–3 candidate segments were still rejected (heat-inflated HR, host-run timing discrepancy).
- **Direction/magnitude:** the July improvement (−2:19, 1.7 %, vs the Apr 27 estimate) was plausible in direction, but it disappeared on data thresholds; the Aug–Sep slowdown (+69 s) came from falling endurance readiness (fewer runs), opposite to the recorded outcome. One event cannot tell whether that is model error or race-day variance; the recorded outcome is not latent capability.
- **Forecast v2 added nothing beyond current capability** (identical at Sep 19; the plan's state at each instant is unprovable because it was edited later).
- **HR streams** changed the trend slope (+0.41 → +0.86 %/28 d) but crossed no detection threshold; **weather** stripping moved v1.1 by −73 s; VO₂, segments and overrides moved nothing; leave-one-run/week-out shifts ≤ 31 s.
- **Calibration:** two candidate outcomes, **0 qualified**, 5 required; thresholds not weakened.

## Justified follow-ups (no numerical change from this case)
1. *Immediate, data/ops:* obtain the official April result/pause explanation and use the existing race-confirmation flow when activated; this alone lets the only anchor be assessed.
2. *Immediate, design review:* observed independently of the outcome — hard-threshold steps (+119 s/week), the moving/elapsed screen rejecting ~18 % of runs (38/213) including a race, and stale best-effort versions silently removing an evidence route.
3. *Needs more observations:* any smoothing of expiry/threshold weights or readiness handling; requires ≥ 5 qualified independent outcomes.

## Reproduce (private data stays outside the repository)
```bash
BACKTEST=1 BACKTEST_OUT=/private/report.json BACKTEST_SAVE_CACHE=/private/capture.json BACKTEST_STREAM_CACHE=/private/streams.json \
  TZ=America/New_York npx vitest run scripts/researchAprilSeptemberBacktest.test.ts
```
Reads: two bounded captures (~913 documents each), a 37-document race probe, and HR-stream chunks (≤40 per run) only for runs production hydration would select (~140). No GPS route points were read (≈2,150 reads total, ≈$0.001). Synthetic tests: `src/utils/research/__tests__/historicalBacktest.test.ts`, `scripts/researchAprilSeptemberBacktest.test.ts`.
