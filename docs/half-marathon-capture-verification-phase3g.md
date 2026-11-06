# Autonomous half-marathon capture: cleanup and production verification · Phase 3G

Date: November 6, 2026. Base: `5882a3a8` (Phase 3F, production preflight passing). Scope: one code correction plus read-only production verification. Nothing in Firebase rules/indexes, the bucket, Vercel variables or the schedule was changed by the code change. One owner-approved IAM removal followed (section 4.1).

## 1. Recovery

The Phase 3G commit produced by Codex Cloud (`e884cef80d5903011638f7915f711577b283af1c`) could not be recovered. It is not a local object, `git fetch` of the SHA is refused, GitHub reports no such commit, and no branch, PR or local patch exists. The correction was therefore re-derived from the documented scope and from the code, not copied.

## 2. Correction: Firestore client cleanup across retries

`handleCaptureRequest` kept a single `handle` variable and reassigned it inside `readSource` on every call. `runScheduledCapture` calls `readSource` once per attempt (up to three per invocation), so after a transient `source_failed` retry only the **last** `@google-cloud/firestore` client was terminated; earlier clients (gRPC channel, auth client) stayed open until the function instance was recycled.

`readSource` now opens its own client and disposes it in a `finally` as soon as the read has produced plain data. A failing `dispose()` is swallowed and never changes the capture result. The preflight path (one client) is unchanged.

Regression test (`capture-readiness.test.ts`, "disposes the Firestore client of every attempt"): source fails once then succeeds (2 opened / 2 disposed); every attempt fails (3 / 3, no object stored); client that cannot be opened; `dispose()` that throws does not mask a successful capture. Against the pre-fix code the first case fails with `{ opened: 2, disposed: 1 }`.

No estimator, schedule, retry bound, storage, identity or enrollment logic changed.

## 3. Verification (read-only, as the project owner via gcloud)

| Check | Result |
| --- | --- |
| Stored Rock and Roll race | One record, race date **2027-03-20**, ID begins `a5fcefd6`; two other races are dated 2026 |
| Owner | Owner email is verified in Firebase Auth; the race belongs to that UID |
| Configured `HM_CAPTURE_RACE_ID` / `OWNER_UID` | **Verified (2026-11-06, owner-run preflight on main `2eac31e8`).** The variables are write-only, so the check compares them server-side: the authenticated response `{"status":"preflight_ok","checks":{"policy":true,"identities":true,"firestore":true,"enrollment":{"pinned":"present","autoEnabled":false}}}` shows the armed race id exists under the armed owner, its stored date equals 2027-03-20, and it is a half marathon. No identifier was returned. The same response, taken after the Token Creator removal, shows token exchange for all three identities, the bucket policy and the Firestore read still pass |
| Crons registered | Three entries on `/api/half-marathon-capture` at `0 13`, `0 17`, `0 21` UTC on the production deployment, which serves main `5882a3a8` |
| Cron executions | **Verified once (follow-up, 2026-11-06).** Hobby keeps one hour of runtime logs, so history is not retrievable. The 21:00 UTC slot was observed at **21:34:59 UTC**: `GET /api/half-marathon-capture`, HTTP 200, log `{"event":"half_marathon_capture","status":"idle"}`. That branch is reached only after the bearer secret matches (authenticated) and before any storage, token or Firestore call (idle, no collection). State ladder: configured yes, registered yes, executed yes (one observed run), authenticated yes, successful n/a (no due checkpoint). The 13:00 and 17:00 slots were outside log retention and are unverified |
| Idle invocations do no Firestore or storage work | Proven in tests: idle days make zero storage, token-exchange and Firestore calls (40 days × 3 slots scan; single-request idle test). Not observed in production logs (see above) |
| Evidence bucket | US-CENTRAL1, public access prevention **enforced**, uniform bucket-level access, 365-day retention **unlocked** (as designed), 7-day soft delete, no objects (first capture 2027-02-20) |
| Bucket IAM | Writer: custom role with only `storage.objects.create`; verifier: only `storage.buckets.get` + `storage.objects.get`. Remaining entries are the GCS default legacy roles for project Owners/Editors/Viewers |
| Capture identities | Reader has `roles/datastore.viewer` only. Each of the three accounts can be impersonated only through the Vercel pool principal bound to this project |
| Workload-identity provider | Condition pins project ID, team ID and `environment == "production"`, so Preview deployments cannot obtain capture tokens |

## 4. Security finding: Firebase Admin account holds Token Creator

Project IAM contains `roles/iam.serviceAccountTokenCreator` for `firebase-adminsdk-fbsvc` at **project scope**. The role grants `getAccessToken`, `signBlob`, `signJwt` and `implicitDelegation` on every service account in the project. The project has three Editor-role accounts (default compute, App Engine, Cloud Services), so a holder of an Admin key can mint an Editor token, and can also impersonate the three capture accounts directly, bypassing the production-only workload-identity condition. Editors own the evidence bucket through the default legacy roles, and the unlocked retention policy can be removed by an owner-level principal. The concern is therefore real, but it requires possession of an Admin key.

Context: the Admin account has two non-expiring user-managed keys (created 2026-02-27 and 2026-11-02). One is presumably the Vercel `FIREBASE_SERVICE_ACCOUNT_JSON`; the local `GOOGLE_APPLICATION_CREDENTIALS` points at a file that does not exist, so a local key copy is not in use.

**Is the permission required?** No. The only Admin SDK use in the application is `getAuth().verifyIdToken` (`src/app/api/coach/route.ts`), which validates against Google's public keys and needs no IAM permission. Nothing calls `createCustomToken`, `signBlob` or any impersonation API (the only `iamcredentials` code is the capture collector, which impersonates through workload identity, not the Admin key). The Admin SDK's default `roles/firebase.sdkAdminServiceAgent` contains no `iam.serviceAccounts.*` permission, so the Token Creator binding is an extra grant, not a Firebase default requirement.

**Smallest reversible reduction (owner approval required; not applied):**

```bash
gcloud projects remove-iam-policy-binding malignant-metro \
  --member="serviceAccount:firebase-adminsdk-fbsvc@malignant-metro.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Rollback (restores the exact previous state):

```bash
gcloud projects add-iam-policy-binding malignant-metro \
  --member="serviceAccount:firebase-adminsdk-fbsvc@malignant-metro.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Dependency tests after the change: sign in to production and use AI Coach (`verifyIdToken`); run `npm run snapshot:export` (Admin Firestore reads); run `GET /api/half-marathon-capture?mode=preflight` (uses workload identity, expected unaffected). If custom tokens are ever needed, grant Token Creator on that one account only, never project-wide.

### 4.1 Remediation (owner-approved, verified)

The owner approved the removal and ran it on **2026-11-06 at 21:35:55 UTC** (Cloud Audit Log `SetIamPolicy`: `REMOVE roles/iam.serviceAccountTokenCreator` for `firebase-adminsdk-fbsvc`, principal the project owner; no later re-addition). The finding above is retained as the historical record.

Verified afterwards (read-only):

- Effective policy: the project has no parent organization or folder, so nothing is inherited. `firebase-adminsdk-fbsvc` holds only `roles/firebase.sdkAdminServiceAgent` and `roles/firebaseauth.admin`; neither contains any `iam.*`, `signBlob`, `getAccessToken` or `actAs` permission. No Token Creator binding exists for any principal at project scope.
- Direct grants: none of the Editor accounts or the Admin account has a service-account-level policy. The three capture accounts are impersonable only through `roles/iam.workloadIdentityUser` for the Vercel pool principal bound to this project; the provider condition still pins project, team and `environment == "production"`.
- The capture collector remains keyless: nothing under `tools/race-validation` imports `firebaseAdmin` or `FIREBASE_SERVICE_ACCOUNT_JSON`.
- Smoke test covered: the owner-run preflight above (after the removal: keyless token exchange, bucket policy, Firestore read all pass); login page 200; capture route 401 without bearer; a bearer-authenticated cron run returned `idle` (that run preceded the removal by about one minute, so it shows the route, not the post-removal state). **Not covered: an authenticated AI Coach request (`verifyIdToken`).** `verifyIdToken` uses Google's public keys and needs no IAM permission, so no break is expected, but the owner should send one coach message to confirm.

Rollback (restores the exact previous state):

```bash
gcloud projects add-iam-policy-binding malignant-metro \
  --member="serviceAccount:firebase-adminsdk-fbsvc@malignant-metro.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

### 4.2 Firebase Admin key audit (no key changed)

| Key (prefix) | Created | Evidence |
| --- | --- | --- |
| `7dd5a7…` | 2026-02-27 | Predates the Vercel variable, which was created 2026-08-20. Superseded when the variable was replaced on 2026-11-02 |
| `d718b0…` | 2026-11-02 19:44 UTC | Matches the last update of `FIREBASE_SERVICE_ACCOUNT_JSON` (production and preview, write-only), the only consumer found |

Both are user-managed and never expire. Dependencies: Vercel production uses `FIREBASE_SERVICE_ACCOUNT_JSON` for `verifyIdToken` only. Local scripts (`scripts/*.ts`) use Application Default Credentials; the machine's ADC is the owner's own user credential, `GOOGLE_APPLICATION_CREDENTIALS` points at a nonexistent file, and no key file exists on the machine, so no local workflow depends on either key. Which key the variable holds cannot be read (write-only), so the mapping above is inferred from dates. Key last-authentication telemetry would settle it but requires enabling the Policy Analyzer API, which was not done.

Recommendation (needs owner approval, not applied): disable `7dd5a7…` (reversible), watch AI Coach and production sign-in for a week, then delete it. Rollback of the disable: `gcloud iam service-accounts keys enable <KEY_ID> --iam-account=firebase-adminsdk-fbsvc@malignant-metro.iam.gserviceaccount.com`. Deletion is not reversible. Afterwards rotate `d718b0…` on a schedule. Do not disable `d718b0…` before confirming it is not the variable's key.

Follow-up hardening, separate decisions: delete whichever Admin key is not in use and rotate the other; do not lock bucket retention yet (it is irreversible and the pilot is deliberately unlocked).

## 5. Cost and usage

Idle days cost three function invocations each, with no Firestore reads or storage operations. The Phase 3F bounds are unchanged (at most 8,412 reads for four checkpoints, about $0.005). The cleanup removes only leaked client resources, not reads. Hobby cron timing imprecision does not matter for correctness: each slot only needs to fall inside its New York checkpoint day.

## 6. Phase 3H (automatic future-race enrollment)

Can proceed safely as design and offline tests only. It must not activate: enrollment is deliberately server-owned, single-race and single-owner, and broadening it widens the production data-collection scope, the bucket contents and the Firestore read pattern. A safe Phase 3H would keep the explicit owner approval per race, reuse these identities and bounds, and require the Token Creator reduction above first, since more automated reads raise the value of the Admin key. Activation needs the owner's approval.
