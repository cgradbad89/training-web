# Manual performance: Firebase owner setup

**NOT APPLIED — PRODUCT OWNER MUST MAKE THIS CHANGE MANUALLY IN FIREBASE CONSOLE.**

Phase 2 writes are disabled by default by `NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE`. The repository's existing rules, emulator rules, indexes, and Firebase configuration were not edited or deployed. The actual Console rules were not supplied or inspected, so this guide cannot assert that the live database is protected by these restrictions.

## Owner actions before activation

1. Open the **malignant-metro** project in Firebase Console. Record the verified owner Firebase Authentication UID for `folstromjohn@gmail.com`; do not infer it from a document path or arbitrary client input.
2. Export a backup of the current Console Firestore rules. Inspect **every** overlapping match for the three paths below, including recursive `/{document=**}`, `/users/{uid}/{document=**}`, and broad authenticated-user or owner-write matches. Firestore allows combine with OR: a narrower denial cannot defeat a broad allow. Exclude these collections from any broad write/read permission that undermines the restrictions below. Do not break the existing iOS/workout rules while making those exclusions.
3. Merge the following helpers and three match blocks into the existing `rules_version = '2'` rules service. The outer service shown establishes context; **do not replace the complete live ruleset with this example**. Replace `REPLACE_WITH_VERIFIED_OWNER_FIREBASE_UID` with the UID verified in step 1. These paths require that UID, matching path UID, verified email token, and the owner email.
4. Test a copy of the **complete resulting ruleset** against a local demo emulator, including overlapping-match tests. The isolated fixture below verifies the proposed restrictions alone and cannot prove that unrelated deployed rules do not override them.
5. Manually publish the reviewed rules through Firebase Console. Verify an intended owner read and denial for unauthenticated, unverified, and unrelated authenticated identities using authorized test records. For a write test, explicitly authorize and use disposable test records; this implementation did not perform production writes or backfill.
6. Authorize activation separately. Only then add `NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE=true` to the intended deployment environment and rebuild. `false`, unset, and every value other than exact lowercase `true` disable updates. No merge/deployment in Phase 2 is authorized to set it true.

## Exact proposed rules

The feature document contains only the compact Phase 1 feature and its normalized, dated effective-workout extraction basis. It never stores duplicate raw GPS/HR samples. Revision increments protect feature updates. Current publication and a new snapshot must match **the complete same record** via `getAfter`; revision increments and prior snapshot linkage are checked against the old current document. Snapshots cannot be updated or deleted, even by the verified owner through the client SDK.

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function performanceOwner(uid) {
      return request.auth != null
        && request.auth.uid == uid
        && request.auth.uid == 'REPLACE_WITH_VERIFIED_OWNER_FIREBASE_UID'
        && request.auth.token.email_verified == true
        && request.auth.token.email.lower() == 'folstromjohn@gmail.com';
    }
    function performanceDigest(value) {
      return value is string && value.matches('^[a-f0-9]{64}$');
    }
    function performanceCurrentPath(uid) {
      return /databases/$(database)/documents/users/$(uid)/performanceState/current;
    }
    function performanceSnapshotPath(uid, snapshotId) {
      return /databases/$(database)/documents/users/$(uid)/performanceSnapshots/$(snapshotId);
    }
    function performanceFeatureValid(d, workoutId) {
      return d.keys().hasOnly(['schemaVersion', 'workoutId', 'revision', 'featureDigest', 'feature', 'workout'])
        && d.schemaVersion == 1 && d.workoutId == workoutId
        && d.revision is int && d.revision > 0 && performanceDigest(d.featureDigest)
        && d.feature is map && d.workout is map
        && d.feature.keys().hasOnly(['workoutId', 'parentDigest', 'sourceInputDigest', 'telemetryDigest', 'extractorVersion', 'qualityPolicyVersion', 'qualityPolicyDigest', 'observedAt', 'extractedAt', 'completion', 'telemetryState', 'status', 'observations', 'reasons', 'quality', 'provenance', 'limitations'])
        && d.workout.keys().hasOnly(['workoutId', 'startedAt', 'endedAt', 'availableAt', 'completion', 'excluded', 'isRun', 'runKind', 'distanceMeters', 'durationSeconds', 'averageHrBpm', 'ascentMeters', 'environment', 'parentDigest', 'telemetry', 'provenance', 'limitations'])
        && d.feature.keys().hasAll(['completion', 'quality', 'provenance'])
        && d.workout.keys().hasAll(['startedAt', 'endedAt', 'availableAt', 'completion', 'excluded', 'isRun', 'runKind', 'distanceMeters', 'durationSeconds', 'averageHrBpm', 'ascentMeters', 'environment', 'provenance', 'limitations'])
        && d.feature.workoutId == workoutId && d.workout.workoutId == workoutId
        && d.workout.startedAt is string && d.workout.endedAt is string
        && (d.workout.availableAt == null || d.workout.availableAt is string)
        && d.workout.excluded is bool && d.workout.isRun is bool
        && d.workout.runKind in ['outdoor', 'treadmill', 'other']
        && d.workout.completion in ['completed', 'incomplete', 'unknown']
        && d.feature.completion == d.workout.completion
        && d.feature.telemetryState in ['complete', 'absent', 'pending', 'failed', 'unknown']
        && d.feature.quality is map && d.feature.provenance is map
        && d.workout.environment is map && d.workout.provenance is map && d.workout.limitations is list
        && d.feature.parentDigest == d.workout.parentDigest
        && performanceDigest(d.feature.parentDigest) && performanceDigest(d.feature.sourceInputDigest)
        && performanceDigest(d.feature.qualityPolicyDigest)
        && d.feature.telemetryDigest == d.workout.telemetry.contentDigest
        && d.feature.telemetryState == d.workout.telemetry.state
        && d.feature.extractorVersion is string && d.feature.extractorVersion.size() <= 100
        && d.feature.qualityPolicyVersion is string && d.feature.qualityPolicyVersion.size() <= 100
        && d.feature.extractedAt is string && d.feature.observedAt is string
        && d.feature.status in ['accepted', 'rejected', 'unresolved']
        && d.feature.observations is list && d.feature.observations.size() <= 100
        && d.feature.reasons is list && d.feature.reasons.size() <= 100
        && d.feature.limitations is list && d.feature.limitations.size() <= 100;
    }
    function performancePublicationValid(d) {
      return d.keys().hasOnly(['schemaVersion', 'revision', 'snapshotId', 'previousSnapshotId', 'publicationDigest', 'payload', 'featureRevisions', 'committedAt'])
        && d.schemaVersion == 1 && d.revision is int && d.revision > 0
        && performanceDigest(d.snapshotId) && performanceDigest(d.publicationDigest)
        && (d.previousSnapshotId == null || performanceDigest(d.previousSnapshotId))
        && d.committedAt == request.time
        && d.featureRevisions is list && d.featureRevisions.size() <= 300
        && d.payload is map
        && d.payload.keys().hasOnly(['result', 'evidenceDigest', 'versions', 'reason', 'historyBasis', 'calculationStartedAt', 'calculationCompletedAt', 'evidenceAsOf', 'provenance', 'coverage'])
        && d.payload.result is map && performanceDigest(d.payload.evidenceDigest)
        && d.payload.evidenceDigest == d.payload.result.evidenceDigest
        && d.payload.versions == d.payload.result.versions
        && d.payload.versions.schema == 1 && d.payload.versions.model == 'manual-performance-v1'
        && d.payload.historyBasis == 'actual_calculation'
        && d.payload.reason in ['analyze_new_workouts', 'reprocess_selected_workouts']
        && d.payload.calculationStartedAt is string && d.payload.calculationCompletedAt is string
        && d.payload.evidenceAsOf is string && d.payload.evidenceAsOf == d.payload.result.asOf
        && d.payload.result.capability.distance == 'half_marathon'
        && d.payload.result.capability.status == 'unavailable'
        && d.payload.result.capability.reason == 'no_validated_estimator'
        && d.payload.result.capability.estimatedSeconds == null
        && d.payload.result.capability.confidenceInterval == null;
    }
    function performanceNextRevision(uid, d) {
      return (!exists(performanceCurrentPath(uid)) && d.revision == 1 && d.previousSnapshotId == null)
        || (exists(performanceCurrentPath(uid))
          && d.revision == get(performanceCurrentPath(uid)).data.revision + 1
          && d.previousSnapshotId == get(performanceCurrentPath(uid)).data.snapshotId);
    }
    match /users/{uid}/performanceFeatures/{workoutId} {
      allow read: if performanceOwner(uid);
      allow create: if performanceOwner(uid) && performanceFeatureValid(request.resource.data, workoutId)
        && request.resource.data.revision == 1;
      allow update: if performanceOwner(uid) && performanceFeatureValid(request.resource.data, workoutId)
        && request.resource.data.revision == resource.data.revision + 1
        && request.resource.data.featureDigest != resource.data.featureDigest;
      allow delete: if false;
    }
    match /users/{uid}/performanceState/{stateId} {
      allow read: if performanceOwner(uid) && stateId == 'current';
      allow create, update: if performanceOwner(uid) && stateId == 'current'
        && performancePublicationValid(request.resource.data)
        && performanceNextRevision(uid, request.resource.data)
        && !exists(performanceSnapshotPath(uid, request.resource.data.snapshotId))
        && getAfter(performanceSnapshotPath(uid, request.resource.data.snapshotId)).data == request.resource.data;
      allow delete: if false;
    }
    match /users/{uid}/performanceSnapshots/{snapshotId} {
      allow read: if performanceOwner(uid);
      allow create: if performanceOwner(uid) && performanceDigest(snapshotId)
        && performancePublicationValid(request.resource.data)
        && request.resource.data.snapshotId == snapshotId
        && performanceNextRevision(uid, request.resource.data)
        && getAfter(performanceCurrentPath(uid)).data == request.resource.data;
      allow update, delete: if false;
    }
  }
}

```

Firestore rules cannot recalculate SHA-256, physiological metrics, source completeness, or a client-supplied 300-element feature manifest. The browser transaction re-reads **every feature used by the calculation**, checks its revision/digest, and compares current's revision before publication. The rules enforce access, bounded collection/field shapes, manual model capability limits, revision transitions, immutable snapshots, server commit time, and atomic matching publication partners. They do not establish the scientific truth of a malicious owner client. The trusted single owner remains the authorized calculation client.

## Indexes and exemptions

No composite index is required. The implementation uses direct document gets by workout ID, one direct `performanceState/current` read, and direct snapshot reads inside publication transactions; it does not query/filter/order the stored nested metrics.

Recommended **owner-managed single-field index exemptions**, applied manually under Firestore Database → Indexes → Single field, using collection group scope:

| Collection group | Field path | Exemption |
| --- | --- | --- |
| `performanceFeatures` | `feature` | Disable ascending, descending, and array indexes for this map and its descendants |
| `performanceFeatures` | `workout` | Disable ascending, descending, and array indexes for this map and its descendants |
| `performanceState` | `payload` | Disable ascending, descending, and array indexes for this map and its descendants |
| `performanceState` | `featureRevisions` | Disable ascending, descending, and array indexes |
| `performanceSnapshots` | `payload` | Disable ascending, descending, and array indexes for this map and its descendants |
| `performanceSnapshots` | `featureRevisions` | Disable ascending, descending, and array indexes |

These reduce index fanout for nested observations/coverage and prevent index-entry growth on compact JSON documents. Disabling a map's indexing exempts its subfields unless an explicit descendant override exists; inspect and remove conflicting descendant overrides if appropriate. Each serialized application record is capped at 700,000 UTF-8 bytes, below Firestore's document limit; index exemptions are still recommended because byte limits do not independently bound index-entry counts. Do not apply these exemptions to other existing collections.

## Isolated emulator verification

The independent fixture is `scripts/performance-security/`. It uses a `demo-` project, loopback-only Firestore on port 8187, a synthetic pinned owner UID, unsigned emulator-only JWTs, and REST requests. It uses existing Firebase CLI/Vitest dependencies. It does not use Firebase Admin credentials, production reads, or production writes. Its reset request deletes only the demo emulator's test database. The suite refuses execution unless explicitly enabled and `FIRESTORE_EMULATOR_HOST` is exactly `127.0.0.1:8187`.

Run from the repository root:

```sh
npx firebase emulators:exec --project demo-training-performance --config scripts/performance-security/firebase.json --only firestore 'PERFORMANCE_SECURITY_EMULATOR=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 npx vitest run scripts/performance-security/security.test.ts && PERFORMANCE_SECURITY_EMULATOR=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8187 npx vitest run scripts/performance-security/persistence.integration.test.ts'
```

Run the two emulator files sequentially as shown: each clears the same isolated demo database before its tests; running them in parallel would interfere. The integration suite uses the actual Firebase client SDK and actual persistence service, Phase 1 extraction and calculation; only the application Firebase instance and owner-token verification boundary are substituted with the isolated emulator connection. No Firestore reads, transactions, or timestamps are mocked. Ordinary `npm test` skips the emulator-only cases; they must be run with the command above. Gate denial is covered separately by `src/lib/__tests__/performanceGate.test.ts` and the persistence/workflow tests, since a browser build gate is deliberately not an authentication/security-rules bypass or server-side authorization claim.

Verification result, October 21, 2026: **9 emulator security tests and 6 real Firebase SDK integration tests passed**. They covered owner feature access, unauthenticated/unrelated/unverified denial and UID isolation, feature revision/field rejection, atomic partner requirements, matching publication acceptance, immutable snapshot update/delete denial, unrelated-user mutation denial, stale/mismatched/fabricated-estimate rejection, and multiple genuine receipts on one date. The SDK integration tests additionally verify actual compact features and Phase 1 payloads round-trip, server commit timestamps, deterministic retries, one winner under concurrent distinct publications, preserved current after stale or changed-feature failures, and disabled-client writes. A stale competing transaction may be rejected with `permission-denied` at rule evaluation before the SDK callback retries; it still preserves the winning publication and requires a refreshed review. The first attempt was blocked by sandbox loopback binding; the same isolated command passed in the approved unrestricted execution environment. Production Console configuration remains unverified.

## Publication invariant and retry behavior

- All mutations use Firestore online transactions; no `setDoc`/batched offline mutation queue exists. Offline errors leave the saved current record intact and require an explicit manual retry.
- Each extraction writes a feature with compare-and-set revision and semantic digest. A later extraction clock alone reuses the existing receipt; changed evidence requires its expected prior revision.
- The authenticated Firebase User object, owner token claims, and application session epoch are captured before work. Guards run around awaited reads and within transactions. Sign-out/account change invalidates work; signing back in with the same UID starts a new epoch. The UID used in document paths must equal the live authenticated UID.
- The summary is calculated from the saved feature set. Before publication, one transaction verifies each used feature receipt, compares the captured current revision, creates an immutable deterministic snapshot, and updates current atomically. A competing publisher or changed feature aborts the stale publication and requires opening/reviewing the selection again. Feature writes that already succeeded remain reusable.
- Snapshot ID is SHA-256 of the expected current revision plus stable publication identity. The stable identity excludes actual calculation/extraction clocks and the Phase 1 digest containing those clocks, while retaining dated windows, source/evidence membership, versions and result. A new run can create a receipt even if rounded metrics do not change. Repeated same-meaning calculations return the original current receipt and actual timestamp.
- Lost acknowledgement after a successful transaction can be retried safely: matching current identity returns unchanged and does not create a second snapshot. If another different publication won afterward, the stale request conflicts rather than overwriting current. Multiple meaningful same-day calculations produce distinct linked receipts.
- Up to 300 saved feature references may be verified in a publication, within the application's bounded parent selection. Rules validate the current/snapshot pair with a small fixed number of document accesses; they do not read all 300 references. Transaction retries can add billed reads.
- No parent metadata, user readiness checkbox, or cache receipt proves children have not changed since extraction. Manual reuse is a dated extraction basis with an explicit limitation; forced reprocessing reads selected current telemetry. Source changes outside the saved features (for example a race link changed while processing) are not globally fenced. This intentionally does not add a source journal or change iOS synchronization.

## Disable and rollback

Set `NEXT_PUBLIC_ENABLE_MANUAL_PERFORMANCE=false` (or remove it) and rebuild/redeploy to stop new updates in the delivered client. Existing already-open enabled builds can still attempt owner-authorized writes; to revoke those immediately, the owner must remove the new write permissions in Console after reviewing affected paths. The build gate is operational rollout control, not a security boundary. Saved-result reads can remain authorized. Preserve current, immutable snapshots, and reusable features; no destructive data migration is required. Do not use a broad allow rule as a rollback shortcut.

Activation remains deferred pending owner review, manual Console changes, full-rules verification and explicit authorization. No production Firestore performance records were read or written by this work.
