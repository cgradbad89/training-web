# Current half-marathon estimate reliability · Phase 3E

## Diagnosis and behavior

The experimental tile uses the exact loaded race, workout parent, and canonical override sets. A successful source load establishes that data is available to display. It does not prove training coverage or current synchronization. The panel retains resident evidence with the existing pending or failed refresh disclosure. Initial missing sources still withhold the estimate. Persisted workout and override changes publish through AppData. New parent arrays, races, and overrides trigger a calculation at a new cutoff, independent of the saved Manual Performance summary and the validation schedule.

| Input or adjustment | Reproducible behavior | Classification and correction |
| --- | --- | --- |
| Race anchor | An eligible linked September-style provisional result can supply its recorded time with qualification disclosed. A conflicting clock or explicit exclusion cannot supply an anchor. | Policy preserved. The current card also retains the dated historical reference after expiry. |
| Parent availability | Future, incomplete, excluded and duplicate workouts are screened. A missing sync field converted to the Unix epoch previously looked old enough to be available. | Confirmed defect. V2 rejects the epoch sentinel. Manual workouts still use a real `updatedAt` as their availability surrogate. |
| Sustained preparation | The 56-day recent requirement is three runs over two weeks. Each comparison period requires six runs and four observed weeks at every offset. Totals in the 4/8-week chart differ from robust model inputs. | Policy preserved. The modal displays recent evidence counts, least-covered weekly offsets, and distinct insufficient-history, deadband and zero-support explanations. |
| Comparable pace | Pair eligibility depends on matching route, climb, duration, HR, weather and chronology, and then on week count, ratio consistency, and effective weight. | Policy preserved. The modal displays pair and week counts, effective weight support, and the gate that blocked an adjustment. |
| Rounding | The raw adjustment is applied before rounding the finish. A sub-minute adjustment can change the displayed finish by a minute if it crosses a rounding boundary. | Confirmed presentation defect. Small nonzero changes display in seconds, and the unchanged-minute explanation compares actual rounded finish and baseline. |
| Refresh | An unrelated render previously created a new cutoff and invalidated the memo. A stationary tab did not update at local midnight until another render. | Confirmed lifecycle defect. The panel keeps a stable cutoff across unrelated renders and advances a local-only clock at midnight or after visibility resumes. These events issue no reads. |

The one-time owner-approved diagnostic used a consistent read of the three existing parent collections. The observed result was a supported, very small summary adjustment that left the minute display unchanged. No fresh matching pair qualified. The details are private and are outside Git. Invented fixtures preserve the exact v1 numeric results on fully dated inputs, including a stable baseline near 2:11, ~2:09 with stronger supported preparation, and a different result when an eligible matched run is added. Neither the live diagnostic nor these fixtures establish predictive accuracy.

## September anchor and March race

The 180-day cutoff and the age/freshness weighting are existing engineering safeguards. At day 179 (March 18), the age multiplier has nearly faded out. At day 180 (March 19), a qualifying September 20 anchor can still provide the unadjusted baseline if recent training also qualifies. From day 181 (March 20) the old anchor cannot support a current number. A date, recorded or confirmed status, and recorded time remain visible as historical evidence. Without a replacement the current estimate abstains on March 20 and March 21 even if recent training changes. A newer eligible race or measured maximal effort can supply an anchor through the existing qualification policy. Target pace and race-day forecast remain separate.

## Offline replay and model identity

New checkpoints seal `experimental-current-hm-v2`. V2 corrects the missing-sync sentinel and retains exact linked override observations needed for a versioned race confirmation. Both versions use the same coefficients, thresholds, windows, pairing and rounding. Sealed v1 artifacts use their original estimator and projection on replay. Existing integrity digests are preserved. A study with several model versions must select one with `modelVersion` or be separated into distinct comparisons. The scorer does not combine their errors. Checkpoints remain independent of the live estimator and current capability remains distinct from a race-day forecast.

Reproduction commands for the offline harness are in the [Phase 3D protocol](half-marathon-validation-phase3d.md). Run the new synthetic capture tests with `npm test -- tools/race-validation`. To run the Firestore source test, start the local Auth/Firestore emulators for a demo project, then use:

```sh
PHASE3E_CAPTURE_EMULATOR=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  TZ=America/New_York npm test -- tools/race-validation/capture-source.test.ts
```

## Dormant pilot integration

The one-race enrollment helper pins the Rock and Roll Half Marathon date and America/New_York. The server configuration would supply the authorized owner UID, opaque subject key, existing race ID, commit SHA, reviewed authorization reference, enabled flag and random 32-character-or-longer cron secret. Keep these values outside public configuration. No route, production environment configuration, schedule or credentials are installed by this phase.

| Lead days | Local checkpoint | Deadline (UTC) |
| ---: | --- | --- |
| 28 | February 20, 2027 | 2027-02-21 04:59:59.999Z |
| 14 | March 6, 2027 | 2027-03-07 04:59:59.999Z |
| 7 | March 13, 2027 | 2027-03-14 04:59:59.999Z |
| 1 | March 19, 2027 | 2027-03-20 03:59:59.999Z |

The dormant handler compares a bearer credential before any source or storage call. Non-due days return idle. On due days it checks bucket policy and looks for the original generation. It then uses a field-masked, bounded Firestore read-only transaction for the owner’s workout parents, races and overrides. The server read timestamp must be shared by all three queries, and exact revisions use document update times. Limits are 1,000 workout parents, 100 race records and 1,000 overrides, with one overflow probe per source. Partial scope seals an explicit abstention. Failed, inconsistent, or late reads produce a bounded operational reason. Manual feature receipts remain optional offline evidence. This automatic adapter does not fetch them or child telemetry.

The Google Cloud Storage adapter checks uniform access, enforced public access prevention and a locked retention minimum. Use independently reviewed principals for create-only writing and generation-pinned verification. The adapter uses `ifGenerationMatch=0`, caps objects at 1 MiB, and verifies the stored generation, its original creation time, retention and exact replay. The verifier can rebuild a Phase 3D custody catalog entry from the authenticated generation. For a concurrent create, verify the winner and keep the first original generation. Same-day retry is possible before cutoff. A late or unverifiable generation cannot score, and a missed-window audit reports past slots without verified receipts. Log status, horizon, date and counts. Keep credentials, errors carrying private data and artifact contents out of logs.

## Infrastructure findings and activation

Read-only metadata confirmed the Vercel team is on Hobby and the default Firestore database is in `nam5` with billing enabled. Hobby can invoke a daily cron with an hour-wide window. The proposed 16:00 UTC slot remains within the New York checkpoint day across DST. The GCP bucket inventory returned only Cloud Functions source/upload buckets. Neither establishes a suitable evidence location with independent access and locked retention. Quota headroom and a suitable IAM/storage setup have yet to be verified. Do not repurpose the managed deployment buckets.

The dormant implementation adds no recurring consumption. If activated, allow up to 31 function invocations per active month and four due dates for this race. With no retries, the four due reads total up to 8,412 Firestore documents, zero Firestore writes, four object creates, and ordinarily four bucket metadata checks, eight object metadata lookups and four generation downloads. Monthly totals depend on which dates fall in the same month. At an illustrative `nam5` price of $0.06 per 100,000 document reads, the document component is about $0.005 before index charges. Vercel and storage usage is small at the proposed caps, but free allowance, storage region, long-term retention and retries can change the billed cost. [Firestore pricing example](https://firebase.google.com/docs/firestore/billing-example) · [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Cloud Storage pricing](https://cloud.google.com/storage/pricing)

The next activation review needs an approved private evidence location, a minimum retention window that covers study review, a create-only principal and a separate verifier with generation read access, and a dedicated read-only Firestore identity with verified project and enrollment binding. Review the lifecycle for deletion after the approved retention period. Locking bucket retention is an irreversible owner decision. Confirm permissions and costs and dry-run with synthetic evidence before proposing a production route or cron. [Bucket Lock](https://cloud.google.com/storage/docs/bucket-lock) · [Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)
