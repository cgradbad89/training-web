# April → September 2026 historical case study (research only)

**Historical case study — insufficient independent outcomes for scientific validation.** Aggregate findings only: no workout identifiers, routes, per-run values or raw exports are stored in the repository. The detailed owner report and chart were produced privately.

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
- **April 26 — PNC Half Marathon:** recorded moving duration 2:15:30 vs watch elapsed 2:25:59 (**+10:29**; tolerance 1:28) → `inconsistent` (`duration_elapsed_discrepancy`), plus unconfirmed effort/conditions. Distance +2.0 % (within 5 %). The HR stream is continuous across the whole elapsed window, so the pause cannot be located from HR. No official result in the app. **The finish time cannot be reliably established; ineligible as an anchor.** The race record predates the race; the linked workout was synced 2026-04-27, so the link could not exist earlier.
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
