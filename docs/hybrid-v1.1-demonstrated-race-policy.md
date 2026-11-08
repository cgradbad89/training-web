# Hybrid v1.1 — demonstrated-race evidence policy

**Status: implemented (experimental, provisional, not independently validated).** Implements the owner-approved simple policy evaluated in `docs/hybrid-v1.2-policy-study.md`. Hybrid v1.1's numerical calculations are unchanged; the policy only decides which confirmed races may carry a number and how that number is labelled.

## The policy
A **demonstrated race** is a race that passed every check a confirmed-maximal race must pass (valid confirmation available as of the cutoff, race identity, date, distance, timing consistency or an explained discrepancy, conditions stated, not excluded, not linked twice, observations unchanged since confirmation) but whose attested effort is `hard` or `nonmaximal`. `hard` and `nonmaximal` are treated identically. `unknown` is never admitted (it may have been maximal and is not attested). There is no effort percentage, coefficient, slider or discount anywhere.

Let **S** be the strict estimate (the unchanged v1.1) and **A** the same estimator with demonstrated races admitted as `recorded_race`-class evidence (the model's existing "time known, maximality unverified" class). The result is:

| Case | Result | Basis shown |
|---|---|---|
| No demonstrated race | S, bit for bit | `maximal_or_recorded_evidence` |
| S available and S ≤ A (stronger evidence supports a faster result) | S, unchanged | `maximal_or_recorded_evidence` (with a note) |
| S available and A < S | A, **provisional, confidence low** | `demonstrated_performance_included` |
| S unavailable and A available | A, **provisional, confidence low** | `demonstrated_performance_only` |
| Only an expired (> 180 days) demonstrated race | unavailable, with the expiry cause and a note | `maximal_or_recorded_evidence` |

A demonstrated race can therefore only make an estimate faster, never slower.

## What is labelled and how
- `HybridV11Estimate.demonstrated` is always present: `{ basis, eligibleRaces, usedRaces, policyDisabled, note }`.
- The Plan Insights hybrid row shows, when the basis is not maximal evidence: "Demonstrated performance, not a maximal-performance prediction: …" (or "Includes demonstrated performance: …").
- Flags `demonstrated_performance_only` / `demonstrated_performance_included`; the first caveat repeats the label.

## Race-day Forecast v2
A `demonstrated_performance_only` capability is **never silently projected**: the forecast is withheld with the explicit cause `demonstrated_performance_only`. A capability that merely *includes* a faster demonstrated race still forecasts, and its uncertainty list says so. With the policy off the forecast behaves as before.

## Unchanged
The 20-run threshold, the 180-day currency limit, the readiness formula, the physiological model, evidence combination (`performance-capacity-v1.1`), race-integrity checks, `performance-evidence-v1` (v1 never admits demonstrated races: the option defaults off), hybrid v1, forecast v1, the official and HR-enhanced estimates, stored records and Firestore (no reads, writes, rules or indexes).

## Rollback
`NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE=true` and redeploy restores the pre-policy v1.1 exactly (`strictMaximalOnly`; test: identical output apart from the disclosure field). It rides the hybrid v1.1 gate, so `NEXT_PUBLIC_DISABLE_HYBRID_V11=true` also removes it.

## Observations worth knowing
- **Before this policy, an honest effort attestation removed a race** (a confirmation saying `nonmaximal` or `unknown` made the hybrid drop it, while no confirmation kept it as a recorded race). `nonmaximal`/`hard` now keep it, labelled; `unknown` still drops it.
- A race with **no confirmation** still counts through the existing recorded-race path (provisional, low confidence) when its recorded timing is consistent. Entering a `hard` confirmation therefore changes the *label*, and rescues races whose recorded clocks disagree (the April race), but does not change a consistent race's number.
- Confirmations are `client_document_untrusted` in chronology; the policy uses them exactly as confirmed-maximal confirmations are used (the revision available at the cutoff decides; strict `asOfMode: "historical"` replays still abstain).
- The production confirmation editor is off (`isRaceConfirmationEnabled()` is preview-only). The owner procedure is in `docs/race-confirmation-procedure-2026.md`.

## Tests
`src/utils/performance/__tests__/demonstratedRacePolicy.test.ts` (22), `src/components/insights/__tests__/DemonstratedRacePanel.test.tsx` (3), `src/utils/__tests__/raceConfirmationProcedure.test.ts` (6): April and September shapes, the real `confirmationHistory` schema and the legacy shape, confirmation timestamps (future, unresolved, corrupt, later correction), 180-day boundary, strict vs contradictory evidence, hard/nonmaximal parity, forecast behaviour, kill switch, label rendering.
