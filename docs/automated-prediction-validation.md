# Prospective prediction validation

## Architecture review (2026-11-10)

Base: `cgradbad89/training-web`, main `5e09290756a7ab579ae2066e4fd3a4683758b028` (PRs #87 and #88 present). Existing collector: `/api/half-marathon-capture`, three daily UTC cron entries, keyless Vercel OIDC → GCP federation → read-only Firestore identity, separate create-only GCS writer and verifier, private retained evidence bucket. Existing v2 checkpoints preserve full input projections and must retain their existing protocol and behavior.

Extend that route and storage adapter with a separately versioned compact validation namespace. Reuse its credentials, authentication, project/owner binding, retention and IAM checks; do not add Firebase collections, rules, indexes, service accounts or paid services. Keep the legacy collector intact. Hydrate one consistent evidence set per due evaluation and reuse it for four distances and all race forecasts. Persist aggregate diagnostics, never raw workouts, routes or HR samples.

Scheduling: reuse the existing 13:00 UTC daily invocation (09:00 EDT); add one 14:00 UTC invocation on the same route (09:00 EST). Gate costly work on the America/New_York 09 hour, Sunday or authoritative day-before-race metadata. Other invocations perform no new work. Preserve the existing 17:00/21:00 jobs. Each added expression is daily and Hobby-compatible. Vercel Hobby permits a one-hour invocation window, so exact 09:00 execution is NOT guaranteed; intended 09:00 and actual timestamps must be stored separately. Do not wait inside a function to bridge that gap. See https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing (verified 2026-11-10).

Production activation is gated separately by `PREDICTION_VALIDATION_ENABLED=true`. Presence of existing write-only HM_CAPTURE variables does not prove their values, IAM validity or activation of this extension. No production writes during development/dry-run. Exact-minute execution remains a platform limitation.

## Contract and storage

Server-only modules: `tools/race-validation/prediction-{schedule,source,models,capture,service,report}.ts`. No dashboard/UI, uploader, model coefficients, confidence thresholds, ordinary auth, saved race or plan writes change.

Storage: existing `HM_CAPTURE_BUCKET`, objects under `prediction-validation/v1/<sha256>.json`. The legacy `half-marathon/v1` namespace stays separate. Each evaluation bundle contains independently identified logical snapshots (`weekly`, `pre_race`, or both); shared predictions are stored once. Snapshot IDs incorporate type, reporting date, race occurrence and evaluation version. Evaluation version hashes the model identifiers, evaluation policy and feature flags. Application Git SHA is stored separately; deploying the same model does not permit overwriting its same-day snapshot. Read old versions as stored; never replay them with current code. SHA-256 seals detect corruption; the GCS adapter pins and checks server-assigned generation, creation time, size and MD5 and uses `ifGenerationMatch=0` for every write.

Each bundle stores intended 09:00 Eastern and actual server evidence timestamp, completion timestamp, target race id/date/distance, pre-race flag, model/policy/application versions, exact unrounded seconds, display-rounded seconds, displayed Personal Insights time/pace, evidence quality, confidence restrictions, reasons, status, evidence cutoff/data-through, cross-distance checks, aggregate evidence mix, race age/share, readiness, physiology adjustment, model-selection diagnostics, VO₂/stream availability, weather coverage and resource accounting. Plan Insights capability, official v2, HR-enhanced and forecast v2 are separate fields. A missing valid linked running plan or a non-half-marathon target produces an explicit unavailable forecast. No fallback race/date is invented. Forecasts retain the app's zero assumed fitness gain and unknown weather/course assumptions.

The collector reads one trailing 365-day workout-parent query (needed for the model's own reference distribution), races, overrides, plans, and a 70-day VO₂ window. It uses the app's `selectStreamCandidates` and `HrStreamEvidenceStore` to hydrate selected HR chunks in the same read-only transaction; no route or GPS query occurs. All distances and forecasts reuse these inputs. Parent overflow probes fail the capture rather than silently truncating required evidence. Optional stream bounds use the existing app behavior and explicitly mark incomplete coverage. The existing store's 400-chunk budget can overshoot by up to two concurrent 40-chunk reads; this is inherited behavior, not a strict 400-read guarantee. Queries use existing single-field indexes; no index/rule deployment is needed.

The GCS bucket policy and identity grants are verified before use. Retention mode is inherited, with `storage.retentionLocked` preserved in captures. `unlocked_pilot` is weaker: an owner can remove its retention policy and delete old objects. Neither the runtime writer nor the verifier can overwrite/delete. No new infrastructure or paid plan is introduced; existing GCS usage remains subject to its existing billing/free allowances. Retain historical bundles and claim/failure receipts under the existing minimum retention configuration (default 365 days, minimum 120); no automatic deletion or fabricated backfill is installed.

## Scheduling, concurrency and failure recovery

Only the Eastern 09 hour can run costly scheduled validation. Sunday is weekly; saved `isActive=true` race metadata supplies other day-before-race captures. Up to ten active races are supported, using only masked date/distance/active/link/cancellation metadata; overflow fails explicitly. Deactivation, deletion, or cancellation flags prevent new enrollment. Rescheduling creates a new occurrence; existing history is untouched. Enrollment is checked again in the consistent evidence read. The verified current saved event is March 20, 2027 → March 19, 2027 at intended 09:00 EDT (13:00 UTC); future changes to that record take precedence.

One immutable attempt claim precedes full hydration. A race/weekly collision and multiple races share one evaluation. Across all duplicate/concurrent requests there are at most two claimed attempts per Eastern day and evaluation version. A failed attempt has a separate immutable, sanitized failure receipt; one further attempt is allowed. An unfinished claim blocks overlapping work for 330 seconds (longer than the 300-second route limit); a later authenticated invocation within the 09 hour can use the remaining attempt after that lease. The platform itself does not guarantee retry delivery. No background loop, daily full evaluation, automatic backfill, or cross-day retry is used. If the hour closes, preserve a miss/failure instead of backdating a new estimate. A stored but unsuccessfully acknowledged generation is recovered by read-and-verify.

The new 14:00 UTC cron uses the existing route; the 13:00/17:00/21:00 legacy invocations and legacy checkpoint protocol remain in place. On legacy checkpoint days the old v2 artifact may still require its own evaluation, distinct from this compact Hybrid bundle. The route maximum is now 300 seconds, matching Hobby Fluid Compute's documented maximum (https://vercel.com/docs/functions/limitations). No account plan change is made or assumed. Runtime logs include sanitized statuses/counts only.

## Developer operations

All modes use `GET /api/half-marathon-capture` with `Authorization: Bearer <CRON_SECRET>`; load the secret from an existing secure environment, never paste it in a ticket, command argument, URL, saved report or browser bundle. Wrong/missing credentials fail before database/storage reads. The extension also requires the existing valid `HM_CAPTURE_*` configuration and both:

- `PREDICTION_VALIDATION_ENABLED=true` (server-only; default disabled).
- `PREDICTION_VALIDATION_START_DATE=YYYY-MM-DD`, the actual activation/reporting start date. Never set it to fabricate a history. Record a version's activation boundary when changing model/feature flags.

Modes:

- `?mode=validation-preflight`: verifies private retained storage/identities and minimal authoritative race metadata. No writes/full model hydration.
- `?mode=validation-dry-run`: one read-only current evaluation, usable at any time, with compact predictions, diagnostics, reads, duration, process CPU and payload size. No claims, captures or other production writes. This explicitly does not prove the write path.
- `?mode=validation-report&from=YYYY-MM-DD&to=YYYY-MM-DD`: verifier-only report (default last 28 days, maximum 90 dates, no dates before configured activation). It includes successful/incomplete captures, pending/missed weekly records, failed/interrupted attempts, consecutive changes, large shifts (at least 120 seconds or 3%), before/after diagnostics, versions and outcome comparisons. Optional `version=<evaluationVersion hash>` reads another recorded policy version without recalculation. To compare versions, pass the retrieved stored bundles to `summarizePredictionHistory`; no new evidence reads are needed. Reports are private research artifacts and may contain health-derived aggregate statistics.

No routine manual run is required after activation. When investigating a miss, inspect the report and Vercel cron/runtime logs. At most one remaining attempt can be used in the original Eastern 09 hour. After the hour, do not rerun the model for that historical slot. Missing weekly records are observations relative to the configured activation/version range, not proof that a particular deployment was enabled. A pre-race cron invocation that never ran leaves no claim: after race deletion/rescheduling this system cannot reconstruct that historical enrollment. Do not infer it from current metadata or claim complete pre-race failure coverage.

Reports expose evidence digest changes, independent evidence counts/mix, race-anchor age/share, readiness, physiology/model-source changes, missing weather, confidence restrictions and application/model version changes. These observations can support an investigation; they do not isolate a causal contribution when inputs changed together. No data is exported to a public page. No raw routes, HR samples, complete workout records, credentials or owner UID are in validation bundles.

## Qualifying actual-race validation

During each scheduled evaluation, the existing `buildRaceEvidence` pipeline qualifies actual outcomes using original recorded effort. The prediction-only assumption treating hard/nonmaximal races as maximal is NEVER used to qualify outcomes. Only verified/owner-confirmed, maximal, internally consistent results enter comparisons. Ordinary training runs and strong efforts do not become actual race outcomes.

Read stored predictions before the race and match race-day forecasts to the exact race id/date and distance. Current fitness requires the same distance (25m tolerance) and a maximal result within seven calendar days after capture; same-day/post-race snapshots are excluded. Store signed seconds error (prediction minus actual), absolute percentage error, direction, calendar-day lead, estimator version and original evidence quality. Keep forecast and current-fitness comparisons separate. Return `insufficient_qualifying_outcomes` until three distinct qualifying races exist; do not publish aggregate accuracy statistics or recalibrate coefficients automatically. Corrections remain observations in later bundles; original snapshots are never rewritten.

Limitations: seven days and 25m are conservative evaluation policy choices, not model coefficients or proof of comparable course/weather. Outcomes outside the loaded 365-day history cannot be newly qualified; preserve already captured outcomes for older comparisons. The current half-marathon outcome path is extended to other target distances through the existing distance-qualified evidence pipeline, not a second matching algorithm.

## Controlled verification and measured resources (2026-11-10)

Production-equivalent read-only evaluation used the existing local Admin credential, NOT deployed WIF. Three controlled full reads were used: initial test (console metrics suppressed), saved metrics, and exclusion investigation. A final seven-document diagnostic compared collector normalization with the application's `docToHealthWorkout` and confirmed parity. No Firestore/GCS writes were made in any production check.

Latest measured single evaluation:

| Measurement | Observed |
|---|---:|
| Workout parent documents | 258 |
| Race documents | 3 |
| Override documents | 58 |
| Plan documents | 7 |
| Health metric documents | 71 |
| Selected HR chunk documents | 22 |
| Minimal discovery documents | 1 |
| Total document reads (including query minimums) | **420** |
| Firestore writes / GCS writes | **0 / 0** |
| Local evidence+model wall duration | **2,309 ms** |
| Local process CPU (not Vercel billed active CPU) | **597 ms** |
| Serialized compact prediction payload | **29,175 bytes** |
| Complete stored snapshot size / hosted function duration | Not measured: no production snapshot was written and deployed route not invoked |

Independent prior measured run: 1,513 ms wall / 468 ms process CPU, same 420 reads and 29,175 payload bytes. These are point observations, not guaranteed limits. Snapshot tests verify the exact serialized size field against stored bytes. Runtime duration/CPU persisted in a bundle cover capture through calculation and exclude final storage IO and the legacy collector; actual complete function duration/billed CPU must be checked in Vercel after activation. Failed-query read accounting is explicitly incomplete and successful query counts are lower bounds in that case. Failure receipts preserve partial counts. Claims/captures: normally two GCS objects per evaluation; a failure then recovery adds two more (four total); two failures create four receipts and no successful snapshot. Existing GCS authentication/policy/read operations are shared, not Firestore writes.

Projection using today's 420-read full evaluation (419 evidence + one daily metadata read), 52 weekly evaluations/year, one active metadata document/day, no retries/pre-race extras: **22,153 validation document reads/year (~1,846/month average)**, **zero Firestore writes**, 104 GCS claim/capture objects/year, approximately 1.6–2.0 MB/year of compact payload plus claims. A 30-day month with four/five Sundays is about 1,706/2,125 reads; each extra pre-race day adds about 419 evidence reads, and a weekly/pre-race collision adds no full hydration. Four UTC cron entries produce 120 invocations in a 30-day month (the legacy three already produced 90); only the matching Eastern 09 invocation does new metadata work. Projected local model work at this point observation is about 120 seconds wall / 31 seconds process CPU per year, excluding GCS, scheduler overhead, legacy captures, retries and reports. The added 14 UTC invocation also performs the legacy collector's active-race metadata discovery when auto-enrollment is enabled: at today's one active race, add approximately 365 legacy discovery reads/year (~30/month), for about 22,518 incremental reads/year (~1,877/month). These are projections, not billed usage or a dollar quote. Incremental charges are expected to remain within existing allowances at this scale but have NOT been verified from billing; no paid infrastructure or plan change is authorized.

Live data limitation: all four estimates were unavailable and the forecast was withheld. Both stored historical race confirmations fail the existing observation-integrity check: one changed `observations.workout.endDate`, the other `observations.workout.syncedAt`. Collector and application normalization matched, including `America/New_York`. This is existing data, not permission to rewrite confirmations, weaken rules, or invent predictions. The owner can review the linked observations and explicitly re-confirm through the existing workflow if appropriate. The new system accurately preserves unavailable states until then.

### Timestamp parity correction (2026-11-11)

The prior diagnostic's normalization conclusion was incorrect: it passed Admin SDK timestamp objects to both adapters, rather than giving the application adapter browser SDK timestamps. A bounded read-only comparison found the two differing fields were each exactly one millisecond apart; the raw nanoseconds show Admin `toDate()` rounding while browser `toDate()` truncates. The remaining recorded observations matched, including workout identity and performance fields. The collector now converts workout parent timestamps with the same browser conversion already used by the research loader. The confirmation token and its exact integrity comparison remain unchanged; actual changes to observations still invalidate it. The diagnostic now constructs real browser SDK timestamps. Neither confirmation nor workout data was rewritten. The original perceived-effort details remain stored, and the prediction-only maximal-anchor assumption remains separate from outcome qualification.

## Activation, rollback and delivery gate

Implementation remains DISABLED unless both new server-only settings above are configured and deployed. Existing variable names were verified in Vercel without reading secret values; `CRON_SECRET` and HM variables are write-only and cannot be retrieved for an authenticated hosted check. No new setting, secret rotation or production snapshot write was performed during implementation. Current Vercel API metadata did not expose the account billing plan or scheduler configuration; document-supported Hobby compatibility is verified, actual deployed timing/authentication remains to be checked.

After required checks, merge and successful deployment:

1. Owner sets the two server-only variables using the actual activation date and redeploys. Reuse the existing secret and WIF identities. No Firebase Console rule/index changes are required.
2. Verify the deployed cron entries at 13, 14, 17 and 21 UTC and the correct main SHA; verify the platform/Fluid Compute configuration. Exact 09:00 precision is unavailable on Hobby.
3. Run authenticated `validation-preflight`, then `validation-dry-run` from a secure owner environment. Compare counts and unavailable/reasons with the app on identical inputs. Stop for unexplained amplification or failed parity.
4. Allow the first scheduled Sunday/pre-race capture in the Eastern 09 hour. Check one verified capture generation (with one claim), expected logical snapshot IDs/types, exact stored size, Firestore reads, actual Vercel duration/CPU and no unexpected writes. Repeat the same authenticated invocation in the hour to prove a read-only duplicate; do not change dates or manufacture an earlier snapshot.
5. Only after that verification describe the extension as active/successfully executed. A deployed cron entry or passing synthetic test alone is insufficient.

Disable only the extension with `PREDICTION_VALIDATION_ENABLED=false` and redeploy; existing predictions and the legacy checkpoint collector keep operating. Preserve the bucket/history. Remove only the added 14 UTC entry in a later disabling PR if desired. Never roll back by deleting retained evidence, rewriting history, changing Firebase rules, or rotating the shared legacy secret unnecessarily.

## Local delivery validation

Production build passed on the first attempt with the existing `.next` temporary-directory symlink and `NODE_PATH` guidance. Typecheck passed. `lint:ci` passed with 99 pre-existing warnings and no errors; explicit lint of every new TypeScript file passed without warnings. Full US-Eastern suite: **4,088 tests in 287 files — 4,031 passed, 57 skipped, zero failed**. Added 62 tests (60 pass, two explicit production opt-ins skipped in routine/CI runs), plus eleven test cases from splitting the existing golden-contract scenario loop. Existing PR #88 numerical golden contracts pass unchanged. Route tests verify both collectors, legacy preflight isolation, preserved cron entries and the added standard-time invocation. Production read-only opt-ins were run separately as documented above; routine tests never access production.

CI follow-up: the first required GitHub run passed all numerical golden checks and all new tests, but the pre-existing test that combined twelve conflict-classification scenarios exceeded Vitest's five-second per-test limit on the hosted runner. That test now enumerates the same scenarios as individually named tests, preserving every assertion and golden value. The split adds eleven test cases without changing production code, model thresholds or global timeouts.
