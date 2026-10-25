# Read-only race-performance Production release

Baseline: `6955df0dfa7bc5737b09e8701a78758f0abc3b5e`. The owner authorized implementation, protected-main squash merge and Production release of the accepted Phase 3A interface. This authorization excludes confirmation writes, experimental numerical predictions, owner-data corrections, new authenticated acceptance reads and unrelated changes.

## Capability boundaries

| Capability | Production | Development / preview |
| --- | --- | --- |
| `isRacePerformanceDisplayEnabled()` | Enabled in code, regardless of legacy opt-in | Existing exact opt-in retained |
| `isRaceConfirmationEnabled()` | Always disabled | Existing exact opt-in retained |
| `isRacePerformanceResearchEnabled()` | Always disabled | Existing exact opt-in retained; developer-only tools |

The deployment identity remains baked into both client and server by unchanged `next.config.ts`. No Vercel environment or project setting changes are required. The old shared gate name is removed so call sites explicitly identify the capability they authorize. Confirmation and research gates do not derive their authority from display activation.

The Races page hides confirmation controls. `RaceConfirmationEditor` independently renders only a disabled message outside its authorized builds; its hooks/form and supplied save callback are not mounted. `saveRaceConfirmation` rejects before token refresh, document reads or transactions and retains all existing asynchronous session checks. Ordinary race CRUD is unchanged. Research entry points use their independent gate and remain excluded from Next. Phase 3B.2 equations, matching policy and methodology are unchanged.

## User-facing behavior

Plan Insights uses the existing `RacePerformancePanel`: dated historical races and evidence status, explicit timing discrepancies, unavailable current capability, completed-training progress and a stored-goal race-day outlook with numerical forecast withheld. The selected stored race and linked plan supply the outlook and adherence context; actual loaded parents/overrides supply training. No owner acceptance totals are hardcoded. The existing empty-account goal disclosure is retained.

The legacy Race Predictions graph, synthetic planned-workout forward projection, R² confidence and prediction-derived readiness are not selected in Production. Completed unplanned and out-of-plan running remains eligible; canonical exclusions and corrections are applied. Invalid/unknown distance or duration cannot contribute zero-mile sessions. Future planned sessions do not become completed training or improvement credits. Existing long-run, frequency, consistency, matching and load calculations remain unchanged. Small `min-w-0`/word-wrap constraints preserve the accepted layout for narrow containers; weekly tables retain their own horizontal overflow wrapper.

Other existing Phase 3A consumer branches now activate in Production: Run Detail withholds race-time impact and skips prediction-only child hydration; Personal Insights withholds legacy predicted times/confidence; Coach client/context and API withhold legacy forecasts; Settings preserves manual threshold entry while withholding prediction-derived suggestions. The Coach server ignores posted legacy predicted-time/status fields when constructing its system prompt, even from an older client. Existing independent Manual Performance, authentication, route/maps/splits/HR/load functionality remains unchanged.

## Data and scientific limits

No services, collections, rules, indexes, migrations, background jobs, writers or prediction telemetry acquisition are added. The summary view reuses loaded workout/race/override/plan parents. Independent existing application writers and route/map/HR functionality remain as before; normal authenticated application mount is unsuitable for strict no-write smoke testing. This task does not mount it for acceptance.

Existing controlled owner acceptance established that April's duration/elapsed conflict stays visible and September remains recorded/unverified. Those observations are retained as prior evidence, not refreshed measurements. No actual owner records are changed, confirmed or included in this public release report. Historical confirmation chronology remains client-document untrusted; no empirical athlete accuracy or personalized interval is established. Current capability and March 2027 numerical forecasting remain unavailable.

## Verification

Focused regressions exercise Production and preview identities, including Production display with no opt-in; all consumer suppression paths; accidental editor mount; direct save rejection; research isolation; and the actual Plan Insights route with stored-race fixtures, canonical completed/unplanned activity, invalid historical distances, adherence and future-workout exclusion. Existing authentication and Manual Performance regressions remain in the verification set.

Full tests, typecheck, lint and the production build must pass before commit. Normal GitHub CI and Vercel builds must pass the exact PR head before protected squash merge, followed by exact-main CI and Production deployment verification. Desktop/mobile visual checks use the existing isolated harness in synthetic-empty mode without authentication or parent reads; prior accepted owner evidence and route-level integration provide the populated-state checks. No diagnostic route, deployment-protection exception or new preview infrastructure is introduced.

Post-deployment checks use metadata, unauthenticated HTTP and static client assets to establish exact SHA/READY, released display content, hidden developer paths and independent gate behavior. They do not claim authenticated Production UI acceptance or execute automatic app writers. Final results and exact deployment identities are recorded in the delivery report.

Local verification completed on the release sources: Production build with the legacy opt-in false passed; the post-build full suite reported 2,497 passed / 30 skipped / 2,527 total across 198 files (16 additional cases). Root and developer-tool typechecks passed. CI lint retained 99 pre-existing warnings and no errors; targeted gate/editor/panel checks passed strict lint. Existing auth and Manual Performance integration checks passed. The browser harness stayed unauthenticated with zero read RPCs, zero forbidden requests and no warning/error logs. Desktop width was 1,265 px; at a 390 px mobile viewport the 375 px document had a matching 375 px scroll width, with table overflow contained inside its own wrapper. Temporary viewport overrides were reset and the harness was closed/stopped. Screenshots remain local under `/private/tmp/training-display-*.png`; they show synthetic-empty layout, not owner-data or authenticated Production acceptance.

The actual local Production Webpack gate module was evaluated in an isolated JavaScript context (no SDK/application execution): its display export returned true and confirmation export false with the old opt-in false. Production bundles contain no Phase 3B.2 research marker or interface title. Preview identity is built separately with the existing exact opt-in true; the deployment uses the repository's unchanged standard Next build in CI/Vercel.

## Files in the focused release

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Refresh verified suite count. |
| `PRD.md` | Document display activation and independent capability boundaries. |
| `docs/race-performance-production-release.md` | Record release scope, verification and limitations. |
| `src/app/(app)/coach/__tests__/CoachPage.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `src/app/(app)/coach/page.tsx` | Select accepted read-only behavior through the explicit display gate. |
| `src/app/(app)/personal-insights/__tests__/PersonalInsightsPage.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `src/app/(app)/personal-insights/page.tsx` | Select accepted read-only behavior through the explicit display gate. |
| `src/app/(app)/plan-insights/__tests__/PlanInsightsHydration.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `src/app/(app)/plan-insights/page.tsx` | Select accepted read-only behavior through the explicit display gate. |
| `src/app/(app)/races/page.tsx` | Use independent confirmation-control authorization. |
| `src/app/(app)/runs/[id]/__tests__/RunDetailLifecycle.integration.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `src/app/(app)/runs/[id]/page.tsx` | Select accepted read-only behavior through the explicit display gate. |
| `src/app/(app)/settings/__tests__/SettingsPage.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `src/app/(app)/settings/page.tsx` | Select accepted read-only behavior through the explicit display gate. |
| `src/app/api/coach/__tests__/route.test.ts` | Verify capability separation and actual Production consumer behavior. |
| `src/app/api/coach/route.ts` | Select accepted read-only behavior through the explicit display gate. |
| `src/components/insights/RacePerformancePanel.tsx` | Keep accepted panel responsive and remove implementation-phase copy. |
| `src/components/races/RaceConfirmationEditor.tsx` | Fail closed on accidental disabled/Production mounts. |
| `src/lib/__tests__/racePerformanceGate.test.ts` | Verify capability separation and actual Production consumer behavior. |
| `src/lib/racePerformanceGate.ts` | Separate read-only display, confirmation and research gates. |
| `src/services/__tests__/raceConfirmations.test.ts` | Verify capability separation and actual Production consumer behavior. |
| `src/services/raceConfirmations.ts` | Require independent write authorization before any work. |
| `src/utils/__tests__/coachContext.test.ts` | Verify capability separation and actual Production consumer behavior. |
| `src/utils/coachContext.ts` | Select accepted read-only behavior through the explicit display gate. |
| `tools/race-performance-acceptance/research/ResearchPanel.tsx` | Require the independent experimental-research gate. |
| `tools/race-performance-acceptance/research/main.tsx` | Require the independent experimental-research gate. |
| `tools/race-performance-acceptance/synthetic.test.tsx` | Verify capability separation and actual Production consumer behavior. |
| `tools/race-performance-acceptance/synthetic.vite.config.ts` | Keep existing synthetic editor explicitly opted in on its local origin. |
| `tools/race-performance-acceptance/syntheticEditor.test.tsx` | Verify capability separation and actual Production consumer behavior. |
