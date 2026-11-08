# Owner procedure — confirming the two 2026 half marathons (not yet performed)

**This procedure is prepared, not executed.** No production record was changed by the implementation. The demonstrated-race policy is deployed; the temporary owner gate below is what makes the editor reachable. Nothing in it may be done by an agent or script: confirmations are owner-attested, append-only records.

## 0. Read first
- **Effort is categorical.** Choose `hard` ("Hard, but not confirmed maximal") or `nonmaximal` — they are treated identically. Never `unknown` for these races (it keeps them out of the estimate) and never `maximal` unless you truly attest a maximal effort.
- **Your subjective effort (about 80 % April, about 90 % September) is history, not an input.** Write it in the *Conditions* text, e.g. "Owner-described effort about 90 % (subjective, not a measurement)". The app never converts it to a time.
- **Finish times are official times, not watch times**, unless they agree. The app refuses a time that differs from the workout by more than max(60 s, 1 %) without a written explanation.
- Confirmations are **append-only**: a mistake is fixed by a correction revision (with a reason), never by deleting.

## 1. The temporary production gate (approved by the owner)
The existing confirmation editor on the Races page is off in Production by default. The owner approved a **temporary, dedicated, owner-only** gate: a Production build with `NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION=true` (exactly the string `true`) shows the *same* editor. It adds no new editor, collection, rule or index. Every save still passes the existing safeguards in `services/raceConfirmations.ts`: the signed-in session must be the verified owner (`folstromjohn@gmail.com`, email verified), the ID token is refreshed and re-checked, the write is a transaction that only appends one nested revision to the existing race document with a **server-timestamp** receipt (never backdated), retries are idempotent, stale or concurrent edits are refused, and Firestore's own rules still apply (Firebase Console is authoritative). The Races page additionally hides the button from any other account.

The gate is independent of the demonstrated-race evidence policy: switching the gate off later does **not** switch that policy off.

## 1a. Owner steps (exactly where to click)
1. Sign in to https://training-web-rho.vercel.app as the owner and open **Races** in the sidebar.
2. On the **DC Half Marathon (2026-09-20)** race card click **Confirm race result**. A dialog titled "Temporary owner confirmation" opens with a notice that starting values were filled in from your description.
3. Check every field against the table in section 2. Make sure the **linked workout** line shows the race's run (use *Link actual run* on the card first if it says None). Press **Save confirmation**.
4. Repeat on the **PNC Alexandria Half Marathon (2026-04-26)** card. Its dialog shows a timing discrepancy (10:29); the prefilled explanation is required — read it, correct it if it is not true, and save.
5. Tell me when both are saved. Do not edit them afterwards; a mistake is fixed with a correction revision (reason required), never by deleting.
Nothing is saved until you press Save, and no agent can press it for you.

## 2. Values to enter
| Field | 2026-09-20 half marathon | 2026-04-26 half marathon |
|---|---|---|
| Official event name | the official event name | the official event name |
| Date, distance | 2026-09-20 · 21,097.5 m | 2026-04-26 · 21,097.5 m |
| Official finish time (seconds) | the **official** time; the watch recorded 7,871 s (2:11:11) — use the official value, and explain any difference over 60 s | **8,130 s (2:15:30)** (owner-attested; equals the watch moving time) |
| Time basis | chip | **other** (not assumed to be chip or gun) |
| Verification | *Owner confirmed* (or *Verified* with an official https result URL) | *Owner confirmed* |
| Source | prefilled: owner confirmation of the official chip time | prefilled: owner attestation; no official results page was checked and the chip-versus-gun basis was not established |
| Effort | `hard` or `nonmaximal` | `hard` or `nonmaximal` |
| Conditions | course, weather and "Owner-described effort about 90 % (subjective)" | course, weather and "Owner-described effort about 80 % (subjective)" |
| Timing explanation | not needed when moving and elapsed time agree | **required**: "The recording began about 10 minutes 29 seconds before the timed start (route paused, standing heart rate); the watch moving time is the official time." |

Confirm the September official time before entering it: the app compares it with the workout's moving time.

## 3. Expected result (verified by dry run)
`src/utils/__tests__/raceConfirmationProcedure.test.ts` drives the app's own builders on synthetic races shaped like these two. After entry, Plan Insights should show:
- **September:** hybrid v1.1 *Provisional* and *confidence low*, labelled "Demonstrated performance, not a maximal-performance prediction", about 2:11 (the race result converted to the half-marathon distance, plus the unchanged terms); the race-day forecast is **withheld** ("only a demonstrated performance … not projected forward").
- **April:** stored as a labelled historical result only. At 196 days it is beyond the 180-day limit and carries **no weight**; the estimate does not change.
- If September shows no demonstrated label, the effort was entered as `unknown`/`maximal`, the confirmation is not yet available as of now, or the policy is switched off (`NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE`).

## 4. After both are saved (cleanup, a separate step)
Verify both saved histories and their server receipt times, that September shows as labelled demonstrated performance and April as expired history, that the forecast is withheld for demonstrated-only capability, and that the workouts are unchanged. Then unset `NEXT_PUBLIC_ENABLE_OWNER_RACE_CONFIRMATION` and redeploy: the editor disappears and the saved records and the demonstrated-race policy stay.

## 5. Rollback
Correction revision with a reason (the previous revision is kept). To stop the policy affecting the display, set `NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE=true` and redeploy.
