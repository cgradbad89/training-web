# Owner procedure — confirming the two 2026 half marathons (not yet performed)

**This procedure is prepared, not executed.** No production record was changed by the implementation. Run it only after the demonstrated-race policy is deployed and verified. Nothing in it may be done by an agent or script: confirmations are owner-attested, append-only records.

## 0. Read first
- **Effort is categorical.** Choose `hard` ("Hard, but not confirmed maximal") or `nonmaximal` — they are treated identically. Never `unknown` for these races (it keeps them out of the estimate) and never `maximal` unless you truly attest a maximal effort.
- **Your subjective effort (about 80 % April, about 90 % September) is history, not an input.** Write it in the *Conditions* text, e.g. "Owner-described effort about 90 % (subjective, not a measurement)". The app never converts it to a time.
- **Finish times are official times, not watch times**, unless they agree. The app refuses a time that differs from the workout by more than max(60 s, 1 %) without a written explanation.
- Confirmations are **append-only**: a mistake is fixed by a correction revision (with a reason), never by deleting.

## 1. The production gate (a decision, not a step)
The confirmation editor on the Races page is **off in Production** (`isRaceConfirmationEnabled()` is true only for a non-production deployment with `NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE=true`). To enter these two records you must choose one, in a separate, explicit decision:
- **A.** Run a non-production build (local or preview) with the opt-in flag, signed in as the owner, pointed at production data (`NEXT_PUBLIC_USE_PROD_FIRESTORE=true` for local development). The write is then an owner action on production data.
- **B.** Ask for a separate pull request that enables the editor in Production.
Also confirm the existing Firestore rules (Firebase Console is authoritative) permit the owner's write to the race document; no rule change is part of this work.

## 2. Values to enter
| Field | 2026-09-20 half marathon | 2026-04-26 half marathon |
|---|---|---|
| Official event name | the official event name | the official event name |
| Date, distance | 2026-09-20 · 21,097.5 m | 2026-04-26 · 21,097.5 m |
| Official finish time (seconds) | the **official** time; the watch recorded 7,871 s (2:11:11) — use the official value, and explain any difference over 60 s | **8,130 s (2:15:30)** (owner-attested; equals the watch moving time) |
| Time basis | chip, gun or other, as the results page states | as the results page states |
| Verification | *Owner confirmed* (or *Verified* with an official https result URL) | *Owner confirmed* |
| Source | explicit attestation text (a bare URL is refused for *Owner confirmed*) | explicit attestation text |
| Effort | `hard` or `nonmaximal` | `hard` or `nonmaximal` |
| Conditions | course, weather and "Owner-described effort about 90 % (subjective)" | course, weather and "Owner-described effort about 80 % (subjective)" |
| Timing explanation | not needed when moving and elapsed time agree | **required**: "The recording began about 10 minutes 29 seconds before the timed start (route paused, standing heart rate); the watch moving time is the official time." |

Confirm the September official time before entering it: the app compares it with the workout's moving time.

## 3. Expected result (verified by dry run)
`src/utils/__tests__/raceConfirmationProcedure.test.ts` drives the app's own builders on synthetic races shaped like these two. After entry, Plan Insights should show:
- **September:** hybrid v1.1 *Provisional* and *confidence low*, labelled "Demonstrated performance, not a maximal-performance prediction", about 2:11 (the race result converted to the half-marathon distance, plus the unchanged terms); the race-day forecast is **withheld** ("only a demonstrated performance … not projected forward").
- **April:** stored as a labelled historical result only. At 196 days it is beyond the 180-day limit and carries **no weight**; the estimate does not change.
- If September shows no demonstrated label, the effort was entered as `unknown`/`maximal`, the confirmation is not yet available as of now, or the policy is switched off (`NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE`).

## 4. Rollback
Correction revision with a reason (the previous revision is kept). To stop the policy affecting the display, set `NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE=true` and redeploy.
