# Autonomous half-marathon capture: activation readiness · Phase 3F

**Verdict: READY WITH CONDITIONS. The production preflight passed on November 6, 2026 and capture is armed for February 20, 2027.** On November 6, 2026 the owner approved the Google Cloud resources in [Provisioned state](#provisioned-state-november-6-2026). Capture is still not armed. The dormant collector, storage adapter, credential chain, audit tool and synthetic test suite are complete. The route and three crons are in the repository but inert. Remaining activation steps: Vercel environment variables (owner-entered) and the preflight. A short dry run must then prove the four properties that only real infrastructure can show (see [What synthetic tests cannot prove](#what-synthetic-tests-cannot-prove)).

Context: [Phase 3D protocol](half-marathon-validation-phase3d.md) · [Phase 3E reliability and capture](half-marathon-reliability-phase3e.md). The live estimator, the 180-day anchor policy and Phase 3D/3E artifacts are unchanged. Checkpoints (Feb 20, Mar 6, Mar 13 and Mar 19, 2027) never feed the live estimate.

## Provisioned state (November 6, 2026)

Created after the owner approved the plan. All are reversible; retention is **not** locked.

| Resource | State |
| --- | --- |
| API `sts.googleapis.com` | Enabled (required for federation, no charge) |
| Bucket `gs://malignant-metro-hm-capture-evidence` | `us-central1`, Standard, uniform access, public-access prevention enforced, retention 31,536,000 s (365 days), `isLocked` false |
| Custom roles `hmCaptureWriter` (`storage.objects.create`), `hmCaptureVerifier` (`storage.objects.get`, `storage.buckets.get`) | Bound on the bucket only to the writer and verifier accounts |
| Service accounts `hm-capture-reader`, `-writer`, `-verifier` | No keys exist; reader holds `roles/datastore.viewer` at project level |
| Workload identity pool `vercel-training-web`, OIDC provider `vercel` | Issuer `https://oidc.vercel.com/folstromjohn-1883s-projects` (discovery document confirmed), audience `https://vercel.com/folstromjohn-1883s-projects`, condition on immutable claims `project_id`, `owner_id` and `environment == "production"` |
| Impersonation | `roles/iam.workloadIdentityUser` on each of the three accounts for the pool's `attribute.project_id` of this Vercel project only |

Not done: no object written, no Firestore data read, no Vercel variable, route or cron, no billing budget, retention not locked. The attribute condition keys on immutable IDs instead of the `sub` string used in the original plan, so the audience value is `//iam.googleapis.com/projects/969397424975/locations/global/workloadIdentityPools/vercel-training-web/providers/vercel`.

**Finding: the existing app Admin key is a privilege-escalation path to the evidence bucket.** `firebase-adminsdk-fbsvc` (its key is the Vercel variable `FIREBASE_SERVICE_ACCOUNT_JSON`) holds project-level `roles/iam.serviceAccountTokenCreator`, and the default compute, App Engine and cloudservices accounts hold `roles/editor`. Anyone who obtains that key can impersonate an Editor account and administer the bucket, including removing an *unlocked* retention policy. A locked policy would stop this. Capture itself does not use or widen that key. Reducing the key's grants is a separate owner decision that I have not made.

The owner account could not mint tokens for the three accounts, so the real least-privilege check (`testIamPermissions`) has not yet run against the live bucket. The preflight performs it.

## 1. Inventory

| Capability | State before 3F | State now |
| --- | --- | --- |
| Pure scheduler, deterministic seal, v1/v2 replay | Done (3D/3E) | Unchanged |
| Bounded Firestore parent reader | Done (3E) | Now fails closed on project mismatch, reports the enrolled race as `present`/`absent`/`date_mismatch`, adds a one-document probe |
| Create-only GCS adapter | Done (3E), required a locked bucket | Reversible pilot mode, run-time least-privilege check, storage-hash check, verifier-only mode |
| Duplicate / retry / missed handling | Duplicate + same-day retry by re-invocation | Plus in-invocation bounded retry, error-to-duplicate recovery, enrollment rejection |
| Credentials | Caller-supplied tokens | Keyless Vercel-OIDC → workload-identity → service-account impersonation |
| Collector | None | `handleCaptureRequest(Request) → Response` (not mounted), with an authenticated `?mode=preflight` |
| Post-race retrieval | Manual | `auditCaptures` and a read-only runner producing the Phase 3D checkpoint and custody inputs |
| Production route, cron, bucket, identities, env vars | None | **Still none** |

## 2. Storage decision

| Option | Assessment |
| --- | --- |
| **A. Dedicated private Cloud Storage bucket** (recommended) | Native server-assigned `timeCreated` and generation, `ifGenerationMatch=0` create-only writes, enforced public-access prevention, retention policy, per-bucket IAM, free Admin Activity audit logs. No new vendor. Billing is already enabled. |
| B. Existing bucket | Read-only inventory (this session) lists only `gcf-v2-sources-…` and `gcf-v2-uploads-…`, both Cloud Functions deployment buckets with no retention policy and `inherited` public-access prevention. They are managed by deployments and must not be reused. No Firebase default Storage bucket exists in the project. |
| C. Alternatives | Firestore documents are mutable and rule-governed. Vercel Blob has no generation precondition, retention lock or independent timestamp and shares the same vendor account as the collector. A git/issue anchor needs a new write credential and is not server-controlled. None gives equal integrity at lower burden. |

**Chosen:** one regional Standard bucket in `us-central1`, which is the leader region of `nam5` and one of the US regions covered by the Always Free storage allowance. Suggested name `malignant-metro-hm-capture-evidence`.

### Custody and its limits

A SHA-256 digest proves content, not time. Time comes from the bucket: `timeCreated` is assigned by Google, the writer cannot set it, and the verifier requires `capturedAt ≤ timeCreated ≤ cutoff`. A replacement can never take an earlier generation than the original. The adapter additionally checks the storage-computed MD5 against the downloaded bytes, pins the media read to the observed generation, and rejects objects without retention metadata.

What this does **not** give you: independence from the project owner. The owner, or anyone who controls the Google Cloud project, can change IAM, remove an unlocked retention policy and delete objects. A deletion cannot be hidden, because the audit reports a missed slot, and a later re-creation fails the cutoff check. It can, however, remove an unfavorable checkpoint, and an outsider has no way to know it was removed. A locked policy removes that option for the retention period. Neither option timestamps with a third party. If outside credibility ever matters, publish the four integrity digests somewhere public after capture (for example in a dated post); that is a manual, optional step outside this design.

## 3. Retention (recommendation: 365 days, unlocked for the pilot)

Objects are created Feb 20–Mar 19, 2027. A 365-day bucket retention policy keeps each artifact until Feb 2028–Mar 2028. That covers the race, official-result confirmation, post-race analysis (spring 2027) and roughly ten months of follow-up review. Bucket retention is per object age, so no object can be deleted early whatever its creation date. No lifecycle delete rule is recommended; delete manually after review.

| Change | Reversible? |
| --- | --- |
| Create bucket, set an unlocked retention period, grant or revoke IAM, remove the policy while unlocked | Yes (the bucket can be deleted once empty) |
| Increase the retention period | Yes while unlocked; allowed even after locking |
| **Lock the retention policy** | **No.** It can never be removed or shortened, and the bucket cannot be deleted until every object has aged out. |
| Set the project's billing account, delete the project | Outside this design |

An unlocked policy keeps accidental or compromised-writer deletion impossible (the writer lacks delete permission, and nobody can delete a retained object without first removing the policy). It loses only protection against a deliberate action by a full project administrator. For a single-owner pilot that is an acceptable, documented limit. Locking is a deliberate later choice, ideally after the first real checkpoint has verified. The data is private training summaries, so locking also means you cannot erase them for a year.

Every receipt carries `retentionLocked`, so the evaluation can state which guarantee applied.

## 4. Identity and permission design

All identities are keyless. The collector runs on Vercel and exchanges its short-lived OIDC token for Google credentials through Workload Identity Federation, then impersonates one service account per responsibility. No downloadable key is created, so none can leak or need rotation. The existing `FIREBASE_SERVICE_ACCOUNT_JSON` Admin key is **not** used or reused by capture.

| Responsibility | Identity | Permissions | Must not have |
| --- | --- | --- | --- |
| Scheduler | Vercel cron (production deployments only) | Presents `Authorization: Bearer $CRON_SECRET`; the handler authenticates before any I/O | Any cloud identity |
| Firestore capture reader | `hm-capture-reader@malignant-metro…` | `roles/datastore.viewer` (read entities/metadata) | Any write, delete, Auth, Storage or IAM permission |
| Evidence writer | `hm-capture-writer@…` | Custom role `hmCaptureWriter`: `storage.objects.create` on the evidence bucket only | get, update, delete, bucket or IAM administration |
| Evidence verifier | `hm-capture-verifier@…` | Custom role `hmCaptureVerifier`: `storage.objects.get`, `storage.buckets.get` on the bucket only | create, update, delete, administration |
| Owner | Owner account | Administrative control; no routine action | n/a |

Run-time enforcement: on every due invocation the adapter calls Cloud Storage `testIamPermissions` as the writer and the verifier. It fails closed (`storage_policy`) if the writer can get, update or delete, or if the verifier can create, update or delete. This detects drift without trusting the runbook.

Known limits, stated plainly:

- **Firestore IAM cannot restrict an identity to one user's documents.** `roles/datastore.viewer` can read every document in the database, including raw telemetry child collections. The owner binding is enforced in code: project ID, owner UID, subject and race ID all come from server-only configuration, the reader refuses a client bound to another project, queries are `users/{enrolledUid}/…` only, field-masked and capped, and child collections are never touched. Emulator tests prove another user's data and child documents are not read. This is defense in code, not in IAM. A narrower custom role with only `datastore.entities.get` and `datastore.entities.list` may suffice but is unverified; the preflight will say.
- **One Vercel runtime can impersonate all three identities.** Separating writer, verifier and reader reduces what a leaked token can do and enforces create-only semantics, but a compromised function runtime has all three. Independent verification therefore happens out of band (the owner's audit, see §8) and not only inside the collector.
- **`CRON_SECRET` is an application-layer gate.** It is compared in constant time before any work. Vercel captures it per deployment, so rotating requires changing the variable and redeploying.

Owner-account access is the break-glass path: if Vercel OIDC federation fails, disable capture (§9) and fix the provider; no secret needs recovering.

## 5. Cost and quota (verified vs. assumed)

| Item | Status | Finding |
| --- | --- | --- |
| Billing on `malignant-metro` | **Verified** (read-only, this session) | Enabled, account `01A525-…`. A dedicated bucket needs no extra fixed fee or subscription. |
| Firestore database / location | Verified in 3E | `(default)`, `nam5` |
| Existing Firestore reads | **Measured** (Cloud Monitoring, 30 days to Nov 6, 2026) | Daily mean about 64,700 reads, maximum about 439,700, 13 of 30 days above the 50,000 free quota. |
| Capture reads | **Calculated** | A due day reads at most 1,000 + 100 + 1,000 documents plus one overflow probe per source (2,103). Four checkpoints: **8,412 reads**, zero writes. That is under 0.5 % of the peak day and about 3 % of the mean. A typical read is likely a few hundred documents (about 236 days of workouts plus a handful of races/overrides) but this is an estimate: real counts were not read. |
| Incremental Firestore cost | **Assumption** (published `nam5` rate of about $0.06 per 100,000 reads) | At most 8,412 reads ≈ **$0.005** if every read is billable. A preflight costs one read. |
| Retries | **Calculated** | A source read repeats only when no object exists. Worst case with storage down all day: three cron slots × three in-invocation attempts × 2,103 reads × four days ≈ 75,700 reads ≈ **$0.05**. Hard caps: two in-invocation retries, 120 s budget, no retry past the cutoff, no retry on policy or permission failures. Each attempt opens and terminates its own Firestore client (Phase 3G; previously only the last client was terminated). |
| Storage | **Assumption** (published us-central1 Standard ≈ $0.02/GB-month, Always Free allowance) | At most 4 MiB retained: effectively **$0**, under $0.001/month even outside the free tier. |
| Operations | **Assumption** (Class A ≈ $0.005/1,000, Class B ≈ $0.0004/1,000) | Four creates and a few dozen small reads per month: well under $0.01. |
| Vercel plan | Reported Hobby in Phase 3E; the team API in this session did not return a plan field, so this is **unverified today** | Hobby supports 100 cron jobs per project, once-per-day frequency, ±59-minute precision, and a 300 s function limit. The collector completes in seconds. No plan upgrade is required. |
| Billing budget alert | **Unverified** | The Billing Budgets API is not enabled in the project and was left untouched. |
| Cloud Scheduler | Not used | The API is enabled but idle; no job exists and none is needed. |
| Cloud audit logs | Free tier | Admin Activity logs (bucket, IAM and retention changes) are on by default and free. Leave Data Access logs off. |

**Expected incremental cost: under one cent.** Conservative upper bound including worst-case retries and a month of operations: **about $0.10**. Remaining uncertainties: live published rates, whether the account already carries credits, and actual document counts per checkpoint. A $5 budget alert on the billing account is the proposed cap and is an owner action.

## 6. Activation plan (nothing below has been run)

All of it needs explicit owner approval. Reversible steps come first and nothing locks retention.

**Step 1: Google Cloud resources (done November 6, 2026; commands kept for rollback reference)**

```sh
PROJECT=malignant-metro
BUCKET=malignant-metro-hm-capture-evidence

gcloud storage buckets create gs://$BUCKET --project=$PROJECT --location=us-central1 \
  --default-storage-class=standard --uniform-bucket-level-access --public-access-prevention \
  --retention-period=P365D        # do NOT lock; verify retentionPeriod is 31536000 and isLocked is false

gcloud iam roles create hmCaptureWriter   --project=$PROJECT --title="HM capture writer"   --permissions=storage.objects.create
gcloud iam roles create hmCaptureVerifier --project=$PROJECT --title="HM capture verifier" --permissions=storage.objects.get,storage.buckets.get

for NAME in reader writer verifier; do gcloud iam service-accounts create hm-capture-$NAME --project=$PROJECT --display-name="HM capture $NAME"; done

gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:hm-capture-writer@$PROJECT.iam.gserviceaccount.com   --role=projects/$PROJECT/roles/hmCaptureWriter
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:hm-capture-verifier@$PROJECT.iam.gserviceaccount.com --role=projects/$PROJECT/roles/hmCaptureVerifier
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:hm-capture-reader@$PROJECT.iam.gserviceaccount.com --role=roles/datastore.viewer --condition=None
```

**Step 2: keyless Vercel federation.** Confirm the project's Vercel OIDC federation is enabled (Vercel → project → Settings → Security). **Done** (see Provisioned state). The condition uses the immutable `project_id`, `owner_id` and `environment` claims and the three bindings use that project's `attribute.project_id`. Confirm the claims against a real token during the dry run.

**Step 3: Vercel production variables (server-only, mark sensitive, never `NEXT_PUBLIC_`).**

| Variable | Value |
| --- | --- |
| `HM_CAPTURE_ENABLED` | `true` only when ready; unset or anything else keeps capture off |
| `CRON_SECRET` | random, at least 32 characters |
| `HM_CAPTURE_PROJECT_ID` | `malignant-metro` |
| `HM_CAPTURE_OWNER_UID` | the owner's Firebase UID (confirm in Firebase Auth against the verified owner email; Auth is not read at run time) |
| `HM_CAPTURE_SUBJECT` | opaque study key, e.g. `owner-1` |
| `HM_CAPTURE_RACE_ID` | existing `halfMarathonRaces` ID of the Rock and Roll Half Marathon (race date must be 2027-03-20) |
| `HM_CAPTURE_AUTHORIZATION` | opaque reference to the owner's written approval |
| `HM_CAPTURE_BUCKET` | `malignant-metro-hm-capture-evidence` |
| `HM_CAPTURE_RETENTION_MODE` | `unlocked_pilot` (or `locked` after a deliberate lock) |
| `HM_CAPTURE_MIN_RETENTION_DAYS` | `365` |
| `HM_CAPTURE_WIF_AUDIENCE` | `//iam.googleapis.com/projects/969397424975/locations/global/workloadIdentityPools/vercel-training-web/providers/vercel` |
| `HM_CAPTURE_WRITER_SA`, `HM_CAPTURE_VERIFIER_SA`, `HM_CAPTURE_READER_SA` | the three service-account emails |

**Step 4: route and cron (done in the route PR; inert).** `src/app/api/half-marathon-capture/route.ts` and `vercel.json` add the route and the three crons below. Both do nothing while `HM_CAPTURE_ENABLED` is unset: the route returns 404 without any network call, and a test enforces this. The snippets are kept for reference.

```ts
// src/app/api/half-marathon-capture/route.ts
import { handleCaptureRequest } from "../../../../tools/race-validation/capture-service";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const GET = (request: Request) => handleCaptureRequest(request, { env: process.env });
```

```ts
// vercel.ts (crons). Three daily slots; each stays inside the New York checkpoint day in both EST and EDT.
crons: ["0 13 * * *", "0 17 * * *", "0 21 * * *"].map(schedule => ({ path: "/api/half-marathon-capture", schedule })),
```

Three slots because Vercel does not retry a failed cron run and Hobby cannot run more often than daily. Later slots find the first verified object and finish with a `duplicate` result and no Firestore read. Vercel's documentation shows the same path with several schedules as a supported layout; confirm the deploy accepts it.

**Step 5: dry run (zero checkpoint evidence).** Call `GET /api/half-marathon-capture?mode=preflight` with the cron bearer on the production deployment while `HM_CAPTURE_ENABLED=true` (production only, because crons run only there). It proves token exchange for all three identities, bucket privacy/retention, least-privilege matrix and a one-document Firestore read, and creates no object. Expected `{ "status": "preflight_ok" }`. Fix and repeat until it passes. Idle days perform no database access.

**Step 6: arm.** Preflight passing with `HM_CAPTURE_ENABLED=true` is also the armed state; the first real capture is Feb 20, 2027. Run the preflight again during the first week of February 2027 to catch drift.

**First preflight result (November 6, 2026).** Bucket policy and the writer/verifier identities passed against the real project, which proved the keyless token exchange and the least-privilege matrix. The Firestore probe failed because firebase-admin\'s Firestore wrapper accepts only a key or default credentials, never a custom token provider. The collector now builds the underlying `@google-cloud/firestore` client with a workload-identity auth client that impersonates the reader account. Failed preflights report a stage and a numeric status code only. The next failure (gRPC "7 Missing or insufficient permissions" although the token held the datastore read permissions and a REST call succeeded) was traced to google-auth-library 10 returning request headers as a Fetch `Headers` object, which the gRPC layer silently dropped. A wrapper now supplies a plain object and a test checks the gRPC metadata.

**Production preflight passed (November 6, 2026).** `{"status":"preflight_ok","checks":{"policy":true,"identities":true,"firestore":true}}` confirmed the keyless token exchange for all three identities, the private retained bucket, the least-privilege matrix (writer create-only, verifier read-only) and a one-document Firestore read as the reader identity. Variables are set and `HM_CAPTURE_ENABLED=true`. Remaining conditions: confirm the race record's date is 2027-03-20, re-run the preflight in the first week of February 2027, and decide on retention locking, a billing budget alert and the Admin-key grants. Items 1, 2 and 4 below remain unproven until the first real capture or cron run.

## 7. What synthetic tests cannot prove

The in-memory Cloud Storage and token services model create-only preconditions, server times, hashes, permission matrices and retention metadata. They cannot show that:

1. Google reports the status the adapter expects on a create-only conflict for a writer without delete permission. (It may be 412 or 403. The handler recovers from both by confirming the original generation.)
2. Vercel's token claims, issuer and subject match the pool condition, and the token is delivered in the `x-vercel-oidc-token` header the default handler reads. (`oidcToken` is injectable if it is not.)
3. ~~The keyless Firestore client authenticates with the reader identity and `roles/datastore.viewer`, or a narrower role, suffices~~ (proven by the passing preflight) for a read-only transaction under the reader identity, and the real retention and `testIamPermissions` behavior matches the model.
4. A Hobby deployment accepts three same-path cron entries and starts them in the expected hours.

The preflight and one dry run settle these. Real IAM enforcement, locked-retention behavior and billing remain unproven until then.

## 8. Reliability, monitoring and recovery

| Failure | Behavior | Recoverable? |
| --- | --- | --- |
| Cron late or absent | Three daily slots; later slots capture if empty; an absent day with no slot succeeding leaves a missed checkpoint | Yes until the cutoff |
| Same cron delivered twice, or two instances at once | Create-only write; the loser verifies the winner's original generation and returns `duplicate` | Automatic |
| Firestore temporarily unavailable | `source_failed`, retried in-invocation (≤2 retries, ≤120 s) then by later slots | Yes before the cutoff |
| Workload-identity exchange or storage 5xx | `storage_failed`, same retry rules | Yes before the cutoff |
| Credential or IAM drift, public access or retention absent | `storage_policy`, no read, not retried; HTTP 500 | After the owner fixes it, a later slot the same day can capture |
| Query cap exceeded | Captured with explicit partial coverage and the model abstains | No; the abstention is the evidence |
| Unfinished sync | Parent availability is stamped by document revision; a late-syncing workout is excluded | By design |
| Enrolled race record absent | Captured with a recorded limitation | n/a |
| Race date in Firestore differs from enrollment | `enrollment_mismatch`; nothing is sealed | After the owner reconciles |
| Cutoff passed, no object | `missed`; never backdated; audit reports `missed` | No |
| Object deleted, replaced or corrupted later | Audit reports `missed` or `unverified`; hash and generation checks fail | Detection only |

**Monitoring without a new service.** (1) Each invocation emits one payload-free JSON line, `half_marathon_capture`, with status, horizon, date, counts and an opaque generation, and failures return HTTP 500 so they show as errored invocations in Vercel Logs. (2) After each checkpoint date, run the read-only audit:

```sh
PHASE3F_AUDIT=1 PHASE3F_BUCKET=malignant-metro-hm-capture-evidence \
  PHASE3F_VERIFIER_PRINCIPAL=hm-capture-verifier@malignant-metro.iam.gserviceaccount.com \
  PHASE3F_VERIFIER_TOKEN="$(gcloud auth print-access-token --impersonate-service-account=hm-capture-verifier@malignant-metro.iam.gserviceaccount.com)" \
  PHASE3F_SUBJECT=owner-1 PHASE3F_RACE_ID=<race id> PHASE3F_OUTPUT_PREFIX=/private/tmp/hm-audit-$(date +%Y%m%d) \
  TZ=America/New_York npm test -- scripts/auditHalfMarathonCapture.test.ts
```

It lists `verified`, `pending`, `missed`, `unverified` or `unreadable` per slot and writes the checkpoint and custody inputs. The same read-only check could run daily as a scheduled GitHub Actions job whose failure emails the owner; that needs a second federated identity and is **not installed**. (3) Create a $5 billing budget alert (owner action). (4) `gcloud logging read` over Admin Activity logs shows bucket and IAM changes.

## 9. Disable, rollback and post-race procedure

- **Disable now:** set `HM_CAPTURE_ENABLED` to anything other than `true` and redeploy. The route returns 404 and does no work. Remove the route and cron entries in a later PR if desired. Existing artifacts remain.
- **Rollback of resources:** remove the three variable groups, delete the workload-identity pool and service accounts, empty and delete the bucket only after the retention period (an unlocked policy can be removed first). Nothing in Firestore, rules or indexes changes at any step.
- **After the race:** the study needs an independently timed outcome (Phase 3D intake) and the audit outputs.

```sh
# 1. Retrieve verified checkpoints and custody receipts (command in section 8)
# 2. Seal the outcome with the Phase 3D intake file
PHASE3D_MODE=outcome PHASE3D_INPUT=/private/tmp/outcome-intake.json PHASE3D_OUTPUT=/private/tmp/outcome.json \
  TZ=America/New_York npm test -- scripts/validateHalfMarathon.test.ts
# 3. Build study.json from the audit checkpoints plus the sealed outcome, then evaluate with the audit custody file
PHASE3D_MODE=evaluate PHASE3D_INPUT=/private/tmp/study.json PHASE3D_CUSTODY=/private/tmp/hm-audit-<date>.custody.json \
  PHASE3D_OUTPUT=/private/tmp/report.json PHASE3D_MARKDOWN=/private/tmp/report.md \
  TZ=America/New_York npm test -- scripts/validateHalfMarathon.test.ts
```

Three or four dependent comparisons against one race outcome establish custody and coverage, not predictive accuracy. Keep the study design in the Phase 3D protocol.

## 10. Verification performed

| Property | Evidence |
| --- | --- |
| Capture fires only on the four Eastern dates; idle days do nothing | Scan of 40 days × 3 slots: only the four dates produce work; store, source and Firestore seams are never called on idle days |
| DST and cutoffs | Local-day membership of every cron slot and each cutoff, plus spring-forward and fall-back races |
| Authentication, project, owner, race | Disabled/unauthorized/mismatched/invalid-config requests perform zero network calls; emulator proves a wrong-project client is refused before any query |
| Bounded, consistent, partial truthful | Emulator: one transactional read timestamp, foreign-user documents and child collections absent, overflow probe yields `partial` and abstention |
| Provenance and reproducibility | Real Firestore snapshot sealed, stored, read back and replayed; digest-equal custody entries for all four checkpoints |
| Create-only, duplicates, concurrency | Second create keeps the original generation; parallel invocations yield one object; unexpected create errors resolve only through the verified original |
| Late and missed | No backdating; missed slots reported, never fabricated |
| Wrong or over-broad permissions, retention, deletion, tamper | `storage_policy` failures; missing/short/unlocked retention; altered bytes of either length; deleted and re-created objects |
| No sensitive data in logs or responses | Sentinel payload, secret, OIDC and access tokens absent from responses and logs |
| v1/v2 compatibility; unchanged numerics | Existing Phase 3D/3E suites pass unchanged; no estimator, projection, model or formula file was modified |

| Firestore client lifecycle across retries (Phase 3G) | Every attempt's client is disposed immediately after its read, including failed and retried attempts and a throwing `dispose()`; see the [Phase 3G report](half-marathon-capture-verification-phase3g.md) |

Limits are the section 7 list. No production resource, identity, schedule or data access was created or used.
