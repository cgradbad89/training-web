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

`saveRaceConfirmation` requires the Production-off preview gate, current owner UID, verified normalized owner email, and refreshed matching token claims. It rechecks the session around asynchronous boundaries. An online Firestore transaction reads only the existing race, linked workout parent and override document. It compares the current revision and reviewed observations, validates identity and values again, and appends only the new confirmation fields with `serverTimestamp()`. Concurrent conflicting submissions fail; same-request retries do not append duplicates. Changed payloads cannot reuse a request ID. It never creates a deleted race or writes workout/override records. Transactions fail offline rather than enqueueing a confirmation for later execution. Generic race save helpers reject evidence fields. `saveRace` merges an exhaustive ordinary-field schema with explicit deletions for omitted fields, so stale optional links/results are cleared while concurrent evidence is retained. It remains one write, without a transaction or new online requirement. The ordinary editor still uses `createRace` / `updateRace`; explicit deletion still removes the whole race and its history.

An already submitted commit may finish if the owner signs out immediately afterward; subsequent reads/shared-state publication are retired. A lost acknowledgement may mean a commit succeeded: retry the unchanged request, rather than inventing a new submission. No live Console rules were inspected or changed. Real access under the owner's existing permissions is unverified; repository rules are not authoritative.

### Chronology is deliberately limited

Server receipt timestamps record when saves were acknowledged; they do **not** establish immutable historical chronology in an owner-writable document. The contract explicitly says `chronology: client_document_untrusted`. No client clock, official event date, claimed earlier verification, or owner-entered timestamp is promoted to authoritative availability. Pending/malformed receipts are not usable. Revisions are selected by available-at cutoff; future corrections cannot replace earlier values in an as-of report. Changed race/workout/override observations invalidate the selected projection until reviewed again.

The existing Phase 3A evaluator can use a valid currently available confirmation as a dated historical benchmark and research-equivalence input. Offline evaluation can use it as an outcome label after availability, but never as a purportedly known-before-race predictor input. Reports expose selected revision IDs/receipt times, untrusted-history counts, eligible outcomes, attempts, abstentions and errors only for evaluable comparisons. A legacy contract is not used as fallback when a new history exists but is invalid or unavailable.

## Controlled synthetic acceptance

The developer-only `tools/race-performance-acceptance/synthetic.html` entry uses the real editor with **Synthetic Spring Half** and **Synthetic Autumn Half**, deliberately distinct invented event names, dates, workout IDs and results. Saves and resets operate only on React memory. The spring clocks disagree; autumn clocks agree. Test official and owner confirmation, reconciliation, unknown/nonmaximal effort, and corrections while inspecting dated evidence and retained history. Both numerical outputs remain withheld.

After building Next for its actual editor CSS, run `npx vite --config tools/race-performance-acceptance/synthetic.vite.config.ts` and open `http://localhost:4187/synthetic.html`. No Firebase public config, environment files, sign-in or database connection are used. The config runs a transitive runtime audit before serving; tests also enforce exclusion from application imports and the Next build. This entry is independent of the Phase 3A owner-read harness at port 4186.

The final merge-readiness review removed `/race-confirmation-preview` and `AppAuthBoundary`. RootLayout is identical to main's authentication shell: the eager `AuthProvider` owns its original single observer, loading, session restoration and route handoff. Firebase initialization, persistence, login redirects and protected-route code are unchanged. No new Suspense/hydration boundary or pathname exception remains.

The application editor retains the same `NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE=true` development/preview opt-in; `next.config.ts` bakes `VERCEL_ENV` into the client/server gate and `production` always disables it, even if opted in. No project environment changes are needed. The earlier hosted synthetic preview belongs to the earlier PR head and is not acceptance evidence for the corrected head.

## Phase 3B.2 milestone

Keep numerical current capability, uncertainty intervals and the March 20, 2027 forecast unavailable. First confirm the actual race results, then define an independently trustworthy availability basis (for example, immutable pre-race snapshots under a separately reviewed storage/access design). Pre-register same-distance and fixed Riegel/VDOT research comparisons, eligibility, chronological cutoffs and error tolerances; accumulate independent later maximal outcomes. Two historical half marathons cannot identify personalized improvement, independently validate a fit, or estimate interval coverage. No external cohort or fabricated owner result is supplied by this phase.

## Earlier synthetic acceptance (before final shell correction)

- Final opted-in preview production build passed (`next build --webpack`; `NODE_PATH` used for the existing local `.next` symlink). Typecheck passed.
- Full Vitest suite after the successful final build: **2,434 passed, 29 skipped, 2,463 total across 194 files**; 116 tests added versus main. Existing skipped/emulator cases were not claimed as live acceptance.
- CI lint passed with 99 existing warnings and no errors; new files passed explicit ESLint without warnings.
- Browser acceptance used only invented, in-memory data: official autumn confirmation became a dated benchmark; correction required a reason and retained revision 1; spring confirmation failed without timing reconciliation, then became an owner-confirmed benchmark after explanation. Both numerical outputs stayed withheld.
- A fresh direct-entry browser network audit observed only localhost static/page assets, no Firebase requests, and no browser warnings/errors. Static import-graph tests separately verify the synthetic path has no runtime persistence dependencies.
- Persistence authorization, stale/concurrent/duplicate saves, read receipts, identity mismatches, original-observation preservation, correction cutoffs and no-look-ahead cases were tested with mocks or synthetic fixtures. No real database write/access verification was performed.

## Final merge-readiness review

Reviewed expected head `cd0bdb09c51d4c16e90347ba3a6f1c72ad4d3d84` against main `aac430a96819a09e000c3ed0384b73aaf31172a0`.

- Root authentication shell restored exactly to main. Targeted SSR/hydration tests exercise one eager observer, initial loading, owner restoration, route navigation without observer remount, sign-out redirect, and cleanup with both Production and preview deployment identities. Existing authorization and AuthGuard tests cover rejected identities and protected access. These are mocked Firebase lifecycle checks; no live Production login was performed.
- Ordinary persistence regressions exercise all optional schema field deletions on legacy full saves, create/update/link/unlink/delete, preservation of concurrent and malformed evidence, and rejection of direct/dotted evidence writes. The Production ordinary-editor regression retains confirmation history and makes no confirmation write even with the opt-in set.
- No application authentication/Firebase/persistence modules, workout write services, feature gate implementation, Firestore rules/indexes, project configuration or real records were changed. The existing owner race-document path is reused; dormant merge requires no data, rules or index migration. Deployed Console permissions remain a separate acceptance requirement.
- Historical confirmation chronology remains `client_document_untrusted`; historical predictor inputs abstain. Current capability and future numerical forecast outputs remain unavailable.

Real-data acceptance still requires separate authorization: inspect the two actual stored race/workout links, obtain checked results or explicit owner attestations, resolve the April timing discrepancy, verify effort/conditions, then test the explicit transaction/receipt under existing deployed owner access in an opted-in non-Production session. Confirm correction retention and that workout observations remain unchanged. This review does not authorize those writes or Production activation.

Final local validation used a clean copy of tracked sources plus the explicit correction files under Node 22.23.2, excluding pre-existing untracked audits and numbered source copies without modifying them. Typecheck passed; CI lint passed with the existing 99 warnings and no errors; changed TypeScript/TSX passed strict ESLint. Full suite: **2,428 passed, 29 skipped, 2,457 total across 193 files**. This review adds six regressions and removes twelve obsolete route/boundary tests; editor/fixture/synthetic tests moved with the developer tool. The production build passed with `npm run build -- --webpack`, the documented local fallback; default local Turbopack was blocked first by font network access and then by its worker port-binding restriction. GitHub CI must pass its unchanged default build on the corrected head. The local build used Production identity with the opt-in set to verify the hard-off configuration. The standalone Vite config loaded successfully against the built CSS and passed its full import audit with environment-file loading disabled.
