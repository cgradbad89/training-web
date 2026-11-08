# Keeping Hybrid v1.2 simple — policy study (research only, 2026-11-08)

**Status: research. Nothing was implemented in the study.** (Follow-up: the owner approved the policy evaluated in section 4 and it was implemented as described in `docs/hybrid-v1.1-demonstrated-race-policy.md`.) No production formula, constant, threshold, type, route, collection, rule or index changed (`git diff origin/main -- src/utils/performance src/utils/racePerformance.ts src/types` is empty). "Hybrid v1.2" does not exist in code; this study decides what, if anything, it should contain.
**Historical case study — insufficient independent outcomes for scientific validation** (0 of the required 5 qualified outcomes). Synthetic scenarios only; aggregate figures from the already-committed case study; no workout identifiers, routes or private exports.

## 1. Owner direction and how this study honours it
Prefer the smallest defensible model that behaves consistently over a more elaborate one that looks more accurate on two races.

| Owner requirement | How it was honoured |
|---|---|
| Preserve official times and subjective effort as history (1) | §2. Recorded here only; never a model input. |
| Never turn "80 %" / "90 %" into a time (2) | No function reads a percentage. Test: three different effort descriptions give byte-identical output; a source scan forbids `%`, slider, discount, coefficient and `conditions` in the toolkit. |
| No sliders, individual coefficients or several effort formulas (3) | None. The only effort input is the existing categorical `maximal / nonmaximal / unknown`. |
| Compare strict-maximal with ONE simple alternative (4) | §4: `nonmaximal_lower_bound`, a single rule, zero new constants. |
| A nonmaximal race shows what was achieved, not maximal capability (5) | The rule treats it as an upper bound on the finish time: it can only make an estimate faster, never slower, and stands alone only as a labelled lower bound. |
| No arbitrary discount (6) | The race time enters unmodified. Test: the lone-race number equals the shipped model's number for the same race read as maximal, to 0.05 s, at five dates. |
| Retain the current policy if the alternative cannot be justified (7) | §4 verdict: justified as safe; the benefit is not measurable, so adoption is the owner's call and the default stays strict. |
| No production formula change (8) | None. The alternative is a wrapper around the unchanged estimator. |
| Prioritise the 20-run threshold, the 180-day expiry and taper behaviour | §5–§7, ahead of the race-policy question in importance. |

## 2. Historical record (preserved; not model inputs)
| Race | Finish time | Source | Owner's effort description |
|---|---|---|---|
| 2026-04-26 half marathon | **2:15:30** (8,130 s) | Owner attestation; equals the watch moving time (the 10:29 elapsed gap is the pre-start recording period, see the April reconciliation) | "About 80 %" — subjective, not calibrated |
| 2026-09-20 half marathon | **2:11:11** (7,871 s) | Watch-recorded; `recorded_unverified` in the app (an owner-confirmed official value was not supplied to this study) | "About 90 %" — subjective, not calibrated |

Neither effort figure has a physiological conversion in this repository and none was invented. The stored attestation (`effort`) is a three-valued category, so a free-text description belongs in the confirmation's `conditions` field if the owner enters one.

**Operational warning (current behaviour, §3):** until the policy question is settled, entering a confirmation whose effort is `nonmaximal` or `unknown` makes the hybrid stop using that race at all. Leaving the race unconfirmed keeps it as a low-confidence recorded race.

## 3. Decision criteria, fixed before any result was looked at
For the alternative to be recommended, every one must hold in synthetic tests:
1. **Identity** — with no nonmaximal-attested race the result equals the strict estimate exactly.
2. **Effort-agnostic** — output does not depend on any effort description.
3. **No discount** — the race time enters unmodified; its number equals the shipped treatment of that race.
4. **Never slower** — a nonmaximal race can only help (make the estimate faster), never worsen it.
5. **Continuity** — no new cliff: output is monotone and 1-Lipschitz in the nonmaximal time.
6. **No new age rule** — the 180-day limit is inherited, not replaced.
7. **Known bias direction** — in simulated worlds with a hidden effort gap, the error is never optimistic.
A candidate for the three cliff studies must additionally **remove the step without adding an unvalidated constant**, and be **evaluable** with the unchanged estimator.

## 4. The race-policy question
**Finding A — the current policy penalises honesty.** For the same race and time (hybrid v1.1, as of 2026-10-10):

| How the race is recorded | Hybrid v1.1 |
|---|---|
| Unconfirmed (recorded from the workout) | provisional · low · 2:15:32 |
| Confirmed maximal | available · moderate · 2:15:32 |
| Confirmed **nonmaximal** | **unavailable** |
| Confirmed, effort **unknown** | **unavailable** |

A confirmation that carries *more* information removes the race, while no confirmation keeps it. This is the strongest independent reason to revisit the policy, and it does not depend on any outcome.

**The one alternative — `nonmaximal_lower_bound`.** Read a confirmed-nonmaximal, otherwise-valid race as evidence of what was achieved:
Let `A` be the shipped estimate with that race's attestation read as maximal. With no such race, the result is the strict estimate unchanged. With one: if strict is unavailable the result is `A`, labelled *lower bound only* (provisional, confidence low); otherwise it is `min(strict, A)`.

| Criterion | Evidence (test in `hybridPolicyStudy.test.ts`) | Result |
|---|---|---|
| 1 Identity | four athletes (maximal + strong effort, unconfirmed, none, effort-unknown) identical to strict | pass |
| 2 Effort-agnostic | "80 %", "90 %", "easy" give equal results; source scan | pass |
| 3 No discount | lone race equals the maximal treatment within 0.05 s at Apr 27, Jun 1, Jul 24, Sep 20, Oct 22 | pass |
| 4 Never slower | a slower nonmaximal race leaves strict (8,000 s) exactly unchanged; the unrestricted pooling would have given 8,215 s | pass |
| 5 Continuity | 19-point sweep of the nonmaximal time against a stale 8,400 s race: monotone, steps ≤ the 50 s grid, flat once slower | pass |
| 6 Age rule | at age 181 the lone result is unavailable, as in production | pass |
| 7 Bias direction | simulated hidden gaps of 0–5 %: error equals the gap, never negative | pass |

**What it does *not* do.** It does not fix the April→September miss: for the lone April race it returns the number the April-anchored reconstruction already produced (2:16:39 on the real data, including that history's +69 s readiness term), because by criterion 3 the number is the shipped model's treatment of that race. Its honest reading there is a *bound* — the later 2:11:11 is faster than the 2:15:30 bound, as a lower bound predicts — which is one observation, not validation. With a stale slower maximal race present, a fresh faster nonmaximal race pulls the estimate only part of the way (8,400 s race + 8,130 s nonmaximal race → 8,205 s, still above the demonstrated 8,130 s), because the shipped model pools races by precision; the rule is deliberately no more aggressive than the shipped treatment of a maximal race.

**Risk the tests cannot remove.** When the nonmaximal race stands alone, the displayed number is slower than true capability by an effort gap nobody can measure (owner estimates of 80 %/90 % are not calibrated). The sign is known, the size is not.

**Verdict.** The alternative is *justified as safe and consistent* (all seven criteria; it removes the penalty of Finding A) but its *benefit is unmeasurable* (0 qualified outcomes). Recommended as the **only** numeric change worth carrying into a future v1.2, and only if the owner prefers "a labelled lower bound" to "no estimate". **If the owner does not, the strict policy stays unchanged and nothing numeric is lost.** The non-numeric fix for Finding A (warn before an effort attestation removes a race from the estimate) is worth doing under either answer.

## 5. Priority 1 — the 20-run minimum for the aerobic trend
Production: the trend needs ≥ 20 eligible steady outdoor runs in a 112-day window. The physiological term it feeds is capped at ±2 % (±162.6 s on 8,130 s).

| Synthetic runner | Finding |
|---|---|
| ≈ 1.3 runs/week, improving 1.5 %/28 d, unchanged otherwise | The trend switches on and off **8 times in 133 days**; **8 steps above 60 s**; the largest equals the whole cap, **162.6 s**, on the day the eligible count fell to 19 |
| ≥ 1.5 runs/week | no step above 10 s over the same months |
| ≈ 1.1 runs/week (17–18 runs) | the trend is never used — a clear −1.5 %/28 d improvement is ignored |

Is the gate protecting precision? Not much of it. For a true −1 %/28 d (12 seeded replicates each), the term averages **−102 s at 21 runs, −117 s at 25, −122 s at 32, −125 s at 42**, and no spurious trend appeared in the flat replicates at any count. The precision shrinkage already built into the term shrinks it by ≈ 18 % at 21 runs; the hard minimum then removes the other ≈ 100 s in one run.

**What cannot be evaluated.** Behaviour *below* 20 runs (a lower minimum, a ramp) is not observable without a parameterised copy of the trend estimator; the shipped one reads a frozen constant. A six-parameter regression on 12–19 runs may be fragile — that is exactly what such a copy would have to test with Monte-Carlo replicates before any number is chosen.

**Verdict: retain.** The cliff is real, large and arithmetic in origin, but no candidate can be validated now, and any candidate adds a constant. Smallest next step if wanted: build a research-only parameterised trend estimator and replicate the table above for n = 12–19.

## 6. Priority 2 — the 180-day expiry
A piece of evidence that passes 180 days is dropped whole. The numeric step equals the share it still held times its gap to the rest.

| Non-race effort (5 mi hard run, equivalent vs the 8,130 s race) | Share of the base at day 170 | One-day step at day 181 |
|---|---|---|
| 8,189 s (0.7 % slower) | 3 % | 2.2 s |
| 7,975 s (1.9 % faster) | 24 % | **38.6 s** (the case study's +37 s) |
| 590 s/mi — never qualified as evidence | — | none |

A lone race goes from an estimate to **no estimate** between day 180 and day 181 (one availability flip).

Why not simply remove the cutoff? Age alone leaves old evidence a lot of precision: a whole-run effort still holds ≈ 60 % of its precision at 180 days and ≈ 40 % at 400; a confirmed race holds ≈ 14 % at 180. Without a cutoff, year-old efforts would keep pulling the number after fitness has changed. The model's own drift term cannot stand in for the cutoff.

**Verdict: retain the 180-day limit.** A fade (linear 150→180 d) would remove the one-day step (≈ 1.3 s/day instead of 38.6 s) but adds two unvalidated constants; the owner asked for neither. Smallest non-numeric aid, if wanted: show "evidence expiring in N days would move the estimate by about X s".

## 7. Priority 3 — taper and endurance readiness
| Scenario | Endurance term |
|---|---|
| Ordinary two-week taper (volume ×0.75/×0.5/×0.3 for 14 days), 6 athlete shapes | **≤ 8.4 s** (always inside the 1.5 % cap) — readiness is built from 8-week medians and the top three long runs, which a 14-day taper barely moves |
| A good block leaving the 8-week window (one 10-mile long run ageing out) | swings **−30 s → 0** over about a week — **> 3× the taper effect** |
| "Taper-neutral" candidate (readiness = max(now, 14 days earlier) through the existing `readinessOverride`) | removes the taper term, but also hides part of a genuine multi-week loss (3 weeks at ×0.25) |

So the +37 s that arrived in the final 14 days of the case study is better explained by long runs and weekly miles rolling off the 8-week window — a rule effect of the same kind as the other two cliffs — than by taper. The model cannot tell a taper, a planned reduction and lost preparation apart; no outcome can calibrate it, and 14 days is the only constant the existing forecast already uses.

**Verdict: retain.** The taper-neutral candidate fixes an effect of ≤ 8 s in regular tapers at the price of blindness to real loss. The worthwhile follow-up is a *disclosure* ("readiness fell in the last 14 days; this can be a taper"), not a number.

## 8. Recommendations (at most four)
1. **Decide Finding A** (owner): either adopt `nonmaximal_lower_bound` as the single numeric v1.2 change, or keep strict. Until then, do not enter `nonmaximal`/`unknown` confirmations for these races, and keep subjective effort in the free-text `conditions`.
2. **Do not change** the 20-run minimum, the 180-day limit or the readiness term in v1.2. Each cliff is quantified above; none has a candidate that is evaluable and constant-free.
3. **Optional, non-numeric:** disclose how close the estimate is to a switch ("one run from losing the trend term", "evidence expiring in N days", "readiness fell in the last 14 days").
4. **Wait for outcomes** (≥ 5 qualified, March 20, 2027 checkpoint) before any retuning; two races cannot choose between these designs.

## 9. Reproduce
```bash
TZ=America/New_York npx vitest run src/utils/research/__tests__/hybridPolicyStudy.test.ts
```
Files: `src/utils/research/hybridPolicyStudy.ts` (research-only; never imported by live code, test-enforced), `src/utils/__tests__/fixtures/policyStudyFixture.ts`, `src/utils/research/__tests__/hybridPolicyStudy.test.ts`. No Firestore access, no reads, no private data.

## 10. Not claimed
No accuracy claim for any variant. No evidence that the strict or the alternative policy is more accurate. No conversion of effort to time. The synthetic worlds (noise 1.2 %, steady cadences, constant temperature) are illustrations of mechanisms, not models of the owner's training.
