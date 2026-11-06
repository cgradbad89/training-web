# Automatic future-race enrollment · Phase 3H

Status: **implemented, tested and dormant.** Nothing in this phase changes production behavior until the owner sets `HM_CAPTURE_AUTO_ENROLL=true`. The pinned March 20, 2027 enrollment is untouched. No Firestore rule, index, IAM, bucket, schedule, estimator or model change is part of this phase.

## 1. What "active race" means (verified, not assumed)

The saved active goal is `halfMarathonRaces/{id}.isActive`. `setActiveRace` atomically sets exactly one race active and every other inactive. The Plan Insights race picker is client-only state and is never persisted, so it cannot influence enrollment. Gaps found: `createRace` and `saveRace` can write `isActive: true` without clearing other races, so two active races are possible; races carry **no time zone**; and the saved flag has no activation timestamp. The design handles each (conflict policy, a server-side time zone setting, and an owner-supplied `enrolledFrom` for audits). No second definition of "active" was introduced.

## 2. Discovery mechanism: hybrid, stateless, feature-gated

| Option | Verdict |
| --- | --- |
| Scheduled metadata discovery | **Chosen**, with no new storage. Works with the app closed and both Macs off; notices edits automatically |
| Event-driven durable enrollment | Rejected for now: needs a new production persistence collection (owner approval), and a failed or missed client write silently loses a transition |
| Hybrid with durable state | Deferred: same persistence cost for little gain at this scale |

When `HM_CAPTURE_AUTO_ENROLL` is exactly `true`, every **authenticated** invocation runs one query on the owner's own `halfMarathonRaces`: `where isActive == true`, four fields (`raceDate`, `raceDistance`, `customDistanceMiles`, `isActive`), limit 6. It uses the automatic single-field index (no index change), reads no name, result, evidence or workout data, and is bound to the enrolled project and UID before it runs. Unauthenticated requests do no discovery. The historical zero-read idle day no longer holds when the gate is on (see section 7).

## 3. Eligibility and conflict rules

A race is tracked only if it is: saved, owned by the enrolled owner, `isActive === true`, a half marathon (`halfMarathon`, or `custom` within 0.1 mile of 13.109), has a valid stored date, a stable id, and its 1-day checkpoint has not yet passed in the owner-local calendar. Anything else (placeholder, 10K, malformed date, finished race, picker selection) is counted and ignored; no enrollment is invented.

- **One eligible race** other than the pinned one: tracked, using the pinned subject, bucket and identities. Its four dates come from the stored date (28, 14, 7, 1 days before), e.g. September 4, 2027: Aug 7, Aug 21, Aug 28, Sep 3.
- **Two or more eligible races** (excluding the pinned race): **none** is enrolled and the response and log carry `notes:["conflict"]`. The owner resolves it by designating one race active.
- **Pinned race** is always evaluated and is never removed by discovery success, failure, overflow, conflict, deactivation, deletion, a date edit, or a new active race. A race whose id matches the pinned one is never enrolled a second time.
- **Time zone:** races have none, so automatic enrollment uses `HM_CAPTURE_TIME_ZONE` (default `America/New_York`, validated). The pinned race keeps its fixed zone.

## 4. Lifecycle

| Event | Behavior |
| --- | --- |
| New race created and activated | Tracked from the next invocation; only checkpoints due on or after that day are produced |
| Activated late | Earlier horizons are never created (`dueCheckpoints` fires only for today's local date). The audit labels them `not_enrolled` when `enrolledFrom` is supplied, otherwise `missed` |
| Deactivated or deleted before a checkpoint | Remaining checkpoints are not captured; the audit labels them `canceled` when `canceledAt` is supplied. Existing evidence is still verified and never erased |
| Race completed | After the 1-day checkpoint day it is ineligible; sealed evidence remains |
| Date corrected | Checkpoint keys include the stored date, so a new date is a new target with new object names. Old objects are never touched or reinterpreted. Evidence for the two dates is never pooled; the audit must be run per date |
| Distance corrected to non-half | Stops tracking; evidence remains |
| Two races due the same day | Both captured, as two distinct sealed objects |
| Metadata read fails, overflows or conflicts | Pinned race still captured; nothing new enrolled; note recorded |
| Cron delivered twice, concurrent runs, storage 5xx | Unchanged Phase 3F behavior: create-only, one original generation, bounded retry that never crosses the cutoff |
| Owner or project mismatch | Fails closed before any query, as before |

A caller can narrow with `?race=` to a race the server already tracks and can never introduce or select another; anything else is `rejected`.

## 5. What did not change

Checkpoint schedule, keys, object names and storage adapter; v1/v2 replay; the pinned March keys (asserted equal to the pre-Phase-3H names); retry bounds; the current estimator, its coefficients and 180-day anchor policy; Current Performance. A snapshot with no current estimate still stores an explicit abstention. No target pace or planned mileage is used. Race-day forecasts remain withheld and real predictive accuracy remains unvalidated; four checkpoints of one race are one outcome, never four.

## 6. Observability and audit

Logs contain only status, an opaque 12-character enrollment reference, horizon, checkpoint date, counts, failure category and opaque generation. They never contain race ids, the owner id, dates of the discovered race, names, tokens or workout data (asserted by tests). `?mode=preflight` now adds `checks.enrollment`: `pinned` is `present`, `absent`, `date_mismatch`, `not_half_marathon` or `unavailable`, plus discovery counts when the gate is on. A definite mismatch makes preflight fail; it never prints an id, date or UID. This is the supported way to verify the configured March race id, since the Vercel variable is write-only.

Audit statuses: `not_due`, `pending`, `verified`, `missed`, `unverified`, `unreadable`, plus `not_enrolled` and `canceled`. `auditEnrolledCaptures` audits many races independently. The runner `scripts/auditHalfMarathonCapture.test.ts` accepts `PHASE3H_RACE_DATE`, `PHASE3H_TIME_ZONE`, `PHASE3H_ENROLLED_FROM`, `PHASE3H_CANCELED_AT`.

## 7. Reads and cost (calculated; actual usage not yet measured)

| Item | Amount |
| --- | --- |
| Idle-day metadata reads, one tracked race | 3 invocations × 1 query. A query returning one document is 1 read; an empty result is billed as 1 read. About **1,100 to 2,200 reads per year** |
| Idle-day worst case (limit 6, overflow) | 3 × 6 × 365 = **6,570 reads per year** |
| Added per-invocation work | One extra keyless client open and two token calls per invocation, about 1,100 per year. Effect on Hobby function time not measured; expected negligible |
| Checkpoint-day reads | Unchanged: at most 2,103 per due checkpoint, 8,412 per tracked race |
| Two overlapping races | Up to 16,824 reads for the year plus discovery |
| Retry worst case | Unchanged bound: about 75,700 reads per race |
| Money | Discovery at about $0.06 per 100,000 reads is **under $0.005 per year**; a second race adds about $0.005. Neither is material, and both sit far below the free daily allowance |
| Storage | Same bucket; at most about 4 MiB per race-year |

No recurring job, paid service, bucket or credential is added.

## 8. Activation (requires owner approval; not done)

Prerequisites: this PR deployed (done); March preflight shows `enrollment.pinned: "present"` (**confirmed 2026-11-06**, main `2eac31e8`, with `autoEnabled: false`). Then:

1. Optionally set `HM_CAPTURE_TIME_ZONE` (otherwise `America/New_York`).
2. Set `HM_CAPTURE_AUTO_ENROLL=true` in Vercel Production and redeploy.
3. Call `GET /api/half-marathon-capture?mode=preflight` with the cron bearer; expect `preflight_ok`, `enrollment.autoEnabled: true`, and `discovery.eligible` of 0 or 1.

Rollback: unset `HM_CAPTURE_AUTO_ENROLL` and redeploy; behavior returns exactly to the pinned single-race collector and zero idle-day reads. Evidence already written is unaffected. There is no overlap risk with the pinned path because both run through the same handler and the pinned race is never enrolled twice.

## 9. Not included

- **Status in Races/Plan Insights.** Deferred on purpose: a client cannot read the private bucket, so any "automatic validation active" text would be a local inference, which the project forbids presenting as confirmation, and the feature is not activated. Revisit after activation with a server-provided status.
- A durable enrollment registry (new collection) and automatic notifications: need approval.
- Any change to the numerical model.

## 10. Verification performed

Resolver matrix (eligibility, DST-local final-checkpoint day, conflict, pinned preservation, no double enrollment, no backdating, same-day distinct keys, date-edit keys); handler lifecycle through the real collector and fake bucket (dormant default, one bounded read on idle days, no storage on idle days, March kept on discovery failure/overflow/conflict, September tracked with no env change, duplicates, retries, narrowing and rejection, no identifier leakage, client disposal); a 365-day simulation of 1,095 cron runs (8 sealed objects, zero idle storage calls, 1,095 discovery reads, both races audited `verified`); a real-Firestore-emulator test of the metadata reader (query shape, four-field mask, owner scoping, malformed documents, no private fields). Not verified against production: no production resource was touched.
