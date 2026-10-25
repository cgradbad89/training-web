# Isolated Phase 3A owner acceptance

Local developer infrastructure; no Next route, API route or Production import. This renders the actual `RacePerformancePanel` and pure Phase 3A helpers. It never mounts the application shell. Next's build TypeScript config excludes this directory; static tests reject application imports of it. No dependency or remote configuration changes are required (Vite is already installed with Vitest).

## Run

1. Build the application so `.next/static/css` contains the actual panel styling.
2. Save the **published public Firebase client configuration** as a JSON file outside the repository. Required fields: `apiKey`, `authDomain`, `projectId`, `appId`; project must be `malignant-metro`. Do not copy private credentials, existing browser credentials, Admin keys or environment files. The config server reads only the explicitly supplied file, with Vite environment-file loading disabled.
3. Run:

   ```sh
   ACCEPTANCE_PUBLIC_CONFIG=/absolute/path/public-config.json npx vite --config tools/race-performance-acceptance/vite.config.ts
   ```

4. Open only `http://localhost:4186/`. This dedicated origin must not have been used for the normal Training Web app. The guard refuses any other origin; the server binds localhost with a strict port. Do not edit/reload the harness during authentication. HMR is disabled.
5. Click **Sign in as owner** and use the existing authorized Google owner account. Authentication is temporary. After verified owner authorization, click **Read bounded owner parents** once.
6. Stop on blocked authentication or materially relevant source diagnostics. The narrowly documented historical-distance exception below may permit scoped reporting; it never certifies full history. Do not substitute zeros or open the normal shell. Dispose the session and close the tab when finished. Stop the server with Ctrl+C.

## No-write boundary

- `bootstrap.ts` installs guards **before** dynamically importing the main module/Firebase SDK. The static audit validates that ordering and follows the entire runtime graph.
- `connection.ts` rejects preexisting Firebase apps and creates a uniquely named app. Auth uses only `inMemoryPersistence`. SDK handles remain private; callers receive sign-in/read/dispose functions.
- **Firestore Lite** provides server reads with no offline cache, IndexedDB persistence, local mutation queue or replay mechanism. This is a stronger equivalent of a memory-only full-SDK cache. Only explicitly allowlisted read exports enter the facade. No mutation, transaction, listener, emulator or Admin API is imported.
- Native IndexedDB open/delete and browser Storage set/remove/clear are denied before SDK initialization. Firebase heartbeat/auth capability probes may be denied and fall back to memory; denied counts are not successful opens or writes. Tests spy on native functions to prove they remain uncalled.
- Fetch/XHR allow only inspectable, bounded owner parent `runQuery`/single linked-parent `batchGet` Firestore RPCs. Unknown/mutation RPCs, alternate Firestore endpoints, another owner/project and child streams fail closed. Requests are recorded as collection/cap labels, never tokens, payloads or headers. This is defense in depth; Lite and the audited application graph prevent persistent queues independently.
- `next/link` is replaced with an inert shim so the panel cannot navigate to the normal app. No root auth provider, AppDataProvider, auto-matching, PR computation, enrichment or sync service enters the graph.

## Read bounds and completeness

Only `users/{verifiedOwnerUid}` parents: newest 1,000 `healthWorkouts` ordered by `startDate`, 100 `halfMarathonRaces`, 1,000 `workoutOverrides`, 20 active `plans` query results. Each collection reads one extra document to detect overflow. Up to 100 missing linked race workout parents and 20 linked plans are individually read. No routes, HR streams, settings or unrelated collections are requested.

Diagnostics preserve server timestamps, counts, caps, loaded oldest/newest workout dates, malformed records and confirmed-absent links. Workout documents missing `startDate` are outside the canonical date-ordered query; loaded history is never asserted to be exhaustive real-world training. Caps, materially relevant malformed parents and source errors withhold the owner panel and dispose the session. A running parent's missing/nonnumeric duration or distance cannot become zero.

### Narrow historical-distance exception

The **Inspect exactly two invalid parents** action reads only the two owner-authorized workout IDs, without collection or child reads. Its raw records remain in browser memory for diagnosis. The normal bounded refresh independently rechecks the current rejected records; an earlier diagnosis cannot grant a stale exemption.

Only those two explicit IDs, with both distance fields absent and otherwise valid required identity, running type, positive duration and timestamps, can qualify. Scope proof requires complete race/override/plan reads, no override or race/plan reference, and dates strictly before the union of both reporting clocks AND every selectable plan's earliest elapsed nonrest entry minus the canonical one-day matching tolerance. This conservatively prevents older matches from propagating through the matcher's global used-workout set. A changed date, dependency, field defect, reporting clock, unknown malformed ID or incomplete source fails closed.

Rejected identities, raw field classifications and original invalid source diagnostics remain available. The UI states exactly how many parents are excluded and marks full-history completeness unproven. Only the reporting windows and unaffected race evidence may be evaluated with the valid parents. No distance is inferred from duration, HR, calories or another field. Scope proof recomputes for the declared clocks and covers every selectable plan.

The actual component also has clearly labelled synthetic-empty and unavailable-source selectors. These are component-state checks, not owner-data evidence. The saved-window comparison uses October 22 end-of-day Eastern and obeys existing known-at revision exclusions. Owner outputs are produced only when every required source succeeds. No records are edited.

## Validation

```sh
TZ=America/New_York npx vitest run tools/race-performance-acceptance
npx tsc --noEmit -p tools/race-performance-acceptance/tsconfig.json
npx eslint tools/race-performance-acceptance --max-warnings 0
```

The Vite config runs the transitive import and application-exclusion audits before serving anything. Tests cover unsafe imports, the real panel/full harness graph, actual Next build exclusion, auth authorization/lifecycle, source bounds/completeness and runtime network/storage guards. Full normal-shell integration must be reported separately; this harness cannot establish it.

Actual owner snapshots/screenshots belong in private local evidence files, never in Git. Owner-panel acceptance and merge approval must be reported separately from infrastructure test success. No merge or Production activation is authorized by this tool.

## Phase 3B.1 synthetic editor (no owner data)

After a Next build, run `npx vite --config tools/race-performance-acceptance/synthetic.vite.config.ts` and open `http://localhost:4187/synthetic.html`. This separate entry renders invented races with the real confirmation editor and memory-only saves. It needs no Firebase config, environment file, authentication or backend. Its config audits the complete emitted entry graph before serving. Nothing imports it from `src/`, and it adds no Next route or root authentication exception. The normal application's eager AuthProvider remains unchanged. The earlier hosted `/race-confirmation-preview` is retired from the application.

Run `TZ=America/New_York npx vitest run tools/race-performance-acceptance/synthetic` for synthetic workflow and isolation regressions. The TypeScript command above also covers this entry.
