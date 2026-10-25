# Race result confirmation — Phase 3B.1

Implemented from main `aac430a96819a09e000c3ed0384b73aaf31172a0`. Delivery is a draft PR and controlled synthetic preview. No real race confirmations, workout modifications, Production activation, migrations, rules/index deployments, backfills or numerical forecasting are authorized by this work.

## Owner workflow

In an opted-in development/preview build, open **Races**, locate the actual stored event, and choose **Confirm race result**. The form shows its linked workout ID, original recorded duration, start/end elapsed duration, and previously entered result separately. If the linked workout is missing, load/link the correct run first. Confirmation cannot silently substitute a workout or change the event date/distance; correct a genuinely wrong race identity through the ordinary editor, then reopen confirmation.

1. Verify the official event name/date and nominal distance (a half marathon is 21,097.5 m).
2. Enter the checked finish time separately; choose chip time when available, gun time or another explicitly explained basis otherwise. The form never fills this from the shorter workout clock.
3. Choose **Official result · checked against source** with the exact official results URL, or **Owner-confirmed · explicit attestation** with what the owner personally knows and how. A URL is an owner-reviewed source, not automated verification by this application. Consistent clocks do not verify a result.
4. State whether the effort was maximal and describe relevant conditions/limitations. Unknown or nonmaximal effort is recordable but does not qualify for a benchmark. Missing conditions/source are rejected.
5. Explain any timing disagreement, including the difference between the checked official time and recorded clocks. A discrepancy blocks saving without an explanation.
6. Save explicitly. Only an acknowledged, resolved server receipt is published to shared races. Later changes use **Review result confirmation**, require a correction reason, and retain every earlier revision. Stale data requires reopening/review; no forced overwrite is provided.

### The two known races — actions still required

- **April 26, 2026 — PNC Half Marathon:** inspect the actual stored link `5EFF4DDC-AB3C-47F3-AEB4-CDD309FEBF98`. The previously observed approximately 2:15:30 duration and 2:25:59 elapsed differ by approximately 10:29. Obtain the actual official result or attest explicitly; do not assume 2:15:30 is chip time. Explain why those clocks disagree and which checked result is being confirmed. Verify maximal effort and conditions. These values are context from prior acceptance, not hardcoded UI defaults or new measurements.
- **September 20, 2026 — DC Half Marathon:** inspect actual link `C64FF225-1DD7-4BEC-A968-7DA71E3BC0CF`. Prior acceptance observed approximately 2:11:11 with consistent elapsed timing. Supply the official source or explicit owner attestation and confirm effort/conditions; clock agreement alone remains unverified.

Real-data submission and its access acceptance need separate owner authorization. The next product action is entering these checked results in the prepared editor, not another GPS investigation.

## Persistence and provenance

`Race.confirmationHistory` is a version-1 map in the existing `users/{uid}/halfMarathonRaces/{raceId}` document. It stores the current revision ID and predecessors, independent request IDs, original race/workout/override observations, an exact comparison token, checked result/source/effort/conditions, correction reason, and `availableAt` server receipt. Previous revisions and original workout/result fields remain unchanged. The map has a 50-revision / 700 KB ceiling; reaching a limit fails without trimming evidence.

`saveRaceConfirmation` requires the Production-off preview gate, current owner UID, verified normalized owner email, and refreshed matching token claims. It rechecks the session around asynchronous boundaries. An online Firestore transaction reads only the existing race, linked workout parent and override document. It compares the current revision and reviewed observations, validates identity and values again, and appends only the new confirmation fields with `serverTimestamp()`. Concurrent conflicting submissions fail; same-request retries do not append duplicates. Changed payloads cannot reuse a request ID. It never creates a deleted race or writes workout/override records. Transactions fail offline rather than enqueueing a confirmation for later execution. Generic race save helpers cannot overwrite the evidence fields.

An already submitted commit may finish if the owner signs out immediately afterward; subsequent reads/shared-state publication are retired. A lost acknowledgement may mean a commit succeeded: retry the unchanged request, rather than inventing a new submission. No live Console rules were inspected or changed. Real access under the owner's existing permissions is unverified; repository rules are not authoritative.

### Chronology is deliberately limited

Server receipt timestamps record when saves were acknowledged; they do **not** establish immutable historical chronology in an owner-writable document. The contract explicitly says `chronology: client_document_untrusted`. No client clock, official event date, claimed earlier verification, or owner-entered timestamp is promoted to authoritative availability. Pending/malformed receipts are not usable. Revisions are selected by available-at cutoff; future corrections cannot replace earlier values in an as-of report. Changed race/workout/override observations invalidate the selected projection until reviewed again.

The existing Phase 3A evaluator can use a valid currently available confirmation as a dated historical benchmark and research-equivalence input. Offline evaluation can use it as an outcome label after availability, but never as a purportedly known-before-race predictor input. Reports expose selected revision IDs/receipt times, untrusted-history counts, eligible outcomes, attempts, abstentions and errors only for evaluable comparisons. A legacy contract is not used as fallback when a new history exists but is invalid or unavailable.

## Controlled synthetic acceptance

`/race-confirmation-preview` uses the real editor with **Synthetic Spring Half** and **Synthetic Autumn Half**, deliberately distinct invented event names, dates, workout IDs and results. Saves and resets operate only on React memory. The spring clocks disagree; autumn clocks agree. Test official and owner confirmation, reconciliation, unknown/nonmaximal effort, and corrections while inspecting the dated evidence and retained history. Both numerical outputs remain withheld.

The server returns not-found before importing the preview when `isRacePerformanceEnabled()` is false. The exact preview path, with the gate enabled, skips the lazily imported root AuthProvider so Firebase/persistent caching are not initialized on direct entry. Other routes retain the normal owner authorization provider. Enter this preview directly in a fresh browser session: switching from an already running application cannot undo earlier Firebase initialization.

The same `NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE=true` opt-in is used; `next.config.ts` bakes `VERCEL_ENV` into the client/server gate and `production` always disables it. The controlled deployment uses a per-deployment build-command override only, with no project environment changes. Preview tests audit the transitive runtime graph for Firebase/services/contexts/network/storage dependencies. Mocked transaction tests do not access Firestore.

## Phase 3B.2 milestone

Keep numerical current capability, uncertainty intervals and the March 20, 2027 forecast unavailable. First confirm the actual race results, then define an independently trustworthy availability basis (for example, immutable pre-race snapshots under a separately reviewed storage/access design). Pre-register same-distance and fixed Riegel/VDOT research comparisons, eligibility, chronological cutoffs and error tolerances; accumulate independent later maximal outcomes. Two historical half marathons cannot identify personalized improvement, independently validate a fit, or estimate interval coverage. No external cohort or fabricated owner result is supplied by this phase.

## Validation at delivery

- Final opted-in preview production build passed (`next build --webpack`; `NODE_PATH` used for the existing local `.next` symlink). Typecheck passed.
- Full Vitest suite after the successful final build: **2,434 passed, 29 skipped, 2,463 total across 194 files**; 116 tests added versus main. Existing skipped/emulator cases were not claimed as live acceptance.
- CI lint passed with 99 existing warnings and no errors; new files passed explicit ESLint without warnings.
- Browser acceptance used only invented, in-memory data: official autumn confirmation became a dated benchmark; correction required a reason and retained revision 1; spring confirmation failed without timing reconciliation, then became an owner-confirmed benchmark after explanation. Both numerical outputs stayed withheld.
- A fresh direct-entry browser network audit observed only localhost static/page assets, no Firebase requests, and no browser warnings/errors. Static import-graph tests separately verify the synthetic path has no runtime persistence dependencies.
- Persistence authorization, stale/concurrent/duplicate saves, read receipts, identity mismatches, original-observation preservation, correction cutoffs and no-look-ahead cases were tested with mocks or synthetic fixtures. No real database write/access verification was performed.
