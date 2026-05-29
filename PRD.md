# PRD — Training Web Dashboard

> **Source of truth** for domain knowledge, data model, business logic, external services, and backlog.
> Maintained by Claude Code — update after every session that changes any of the items below.

---

## Section 1 — App Overview

**Purpose**: Personal running and fitness dashboard for a single authenticated user. Syncs workouts from Apple Watch via iOS HealthKit, visualizes training load, manages race goals and training plans, and provides an AI coaching interface.

**Auth**: Google OAuth via Firebase Auth. A single owner email (`folstromjohn@gmail.com`) gates the HubBanner nav links.

**Hosting**: Vercel (production: https://training-web-rho.vercel.app)

### Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | 16.2.1 |
| Runtime | Node.js / Vercel serverless | — |
| Language | TypeScript | ^5 |
| UI | React | 19.2.4 |
| Styling | Tailwind CSS | ^4 |
| Charts | Recharts | ^3.8.1 |
| Icons | lucide-react | ^1.7.0 |
| Maps (GPS view) | Leaflet | ^1.9.4 |
| Maps (route draw) | @react-google-maps/api | ^2.20.8 |
| Database | Firebase Firestore | ^12.11.0 |
| Auth | Firebase Auth | ^12.11.0 |
| Admin SDK | firebase-admin | ^13.7.0 |
| AI | @anthropic-ai/sdk | ^0.82.0 |
| Testing | Vitest | ^4.1.2 |
| Test DOM | happy-dom | ^20.8.9 |

### Project Identifiers

| Key | Value |
|---|---|
| GitHub repo | https://github.com/cgradbad89/training-web |
| Firebase project | malignant-metro |
| Vercel project ID | prj_4SL79DFdWu56fzRrLSzxCQeA8fRd |
| Vercel team ID | team_tsBCiUJBISkxn8eXQuT6EXkx |
| Production URL | https://training-web-rho.vercel.app |

---

## Section 2 — Page Inventory

| Page | Route | Status | Summary |
|---|---|---|---|
| Root | `/` | Done | Redirects unauthenticated users to `/login` |
| Login | `/login` | Done | Google sign-in button via Firebase Auth |
| This Week | `/(app)/dashboard` | Done | Weekly training overview: runs, workout cards, health tiles, training load, plan progress |
| Runs | `/(app)/runs` | Done | Paginated run list with week navigator, shoe assignment, training load badges |
| Run Detail | `/(app)/runs/[id]` | Done | GPS map, mile-split charts/table, workout metrics, shoe picker, override controls |
| Workouts | `/(app)/workouts` | Done | Non-running activity list with duplicate detection and exclusion |
| Plans | `/(app)/plans` | Done | Running + workout plan management; week calendar; auto-match completion tracking |
| Plan Editor | `/(app)/plans/[id]/edit` | Done | Edit running plan entries (distance, pace, run type, notes) |
| Workout Session | `/(app)/workout/[planId]/[weekIndex]/[weekday]/[[...sessionIndex]]` | Done | Workout plan session detail: exercise list, sets/reps/weight, completion toggle |
| Health | `/(app)/health` | Done | Daily health metrics (weight, resting HR, steps, sleep, brushing) with trend charts |
| Races | `/(app)/races` | Done | Race goal CRUD, active race toggle, associate an actual run with a race result |
| Shoes | `/(app)/shoes` | Done | Shoe inventory, per-shoe mileage, auto-assign rules editor |
| Routes | `/(app)/routes` | Done | GPS route viewer (Leaflet) + Google Maps route drawing tool |
| Personal Insights | `/(app)/personal-insights` | Done | Riegel race predictions, PR table, pace trends, workout trends, CTL/ATL/TSB charts |
| Plan Insights | `/(app)/plan-insights` | Done | Running plan adherence, weekly mileage vs plan, predicted vs goal finish time |
| AI Coach | `/(app)/coach` | Done | Chat with Claude using full training context; streaming response |
| API: Coach | `/api/coach` | Done | Server-side Anthropic call; requires Firebase ID token; max_tokens=1024 |

---

## Section 3 — Data Model

All user collections live under `users/{uid}/…`. Exception: `stravaActivities` is a legacy global collection.

### `stravaActivities/{activityId}`
Legacy Strava data synced from iOS. **Not uid-scoped** (single-user legacy design).
Key fields: `id`, `name`, `type` (ActivityType), `start_date`, `distance_m`, `moving_time_s`, `avg_speed_mps`, `avg_heartrate`, `pace_sec_per_mile`, `gear_id`, `efficiencyScore`.

### `users/{uid}/healthWorkouts/{workoutId}`
Primary workout data written by iOS HealthKitSyncService.
Key fields: `workoutId`, `activityType` (raw HK string), `displayType` (human-readable), `startDate` (Timestamp), `endDate`, `durationSeconds`, `sourceName`, `isRunLike` (boolean, pre-computed on iOS), `hasRoute`, `calories`, `avgHeartRate`, `distanceMiles`, `distanceMeters`, `avgPaceSecPerMile`, `avgSpeedMPS`, `hrDriftPct`, `cadenceSPM`, `elevationGainM`, `prBadges` (string[]). Fields `efficiencyRaw` and `efficiencyScore` are legacy; no UI reads them.

### `users/{uid}/healthWorkouts/{workoutId}/route/{pointIndex}`
GPS route points subcollection. Fields: `index`, `lat`, `lng`, `altitude`, `timestamp` (Timestamp), `speed`.

### `users/{uid}/healthWorkouts/{workoutId}/mileSplits/{mile}`
Per-mile split HR from iOS. Fields: `mile` (number, 1-indexed), `avgBpm`. **Partial implementation** — iOS sync for HR-per-mile not yet complete; subcollection may be empty.

### `users/{uid}/healthMetrics/{YYYY-MM-DD}`
Daily health snapshots (one doc per calendar date). Fields: `date`, `weight_lbs`, `bmi`, `resting_hr`, `steps`, `exercise_mins`, `move_calories`, `stand_hours`, `sleep_total_hours`, `sleep_awake_mins`, `sleep_start` (ISO string), `sleep_end` (ISO string), `brush_count`, `brush_avg_duration_mins`, `syncedAt`.

### `users/{uid}/healthMetrics/hourlyHeartRate`
Special singleton document (not a date-keyed record). Fields: `hourlyAvgBpm` (Record<"0"–"23", number>), `sampleCount`, `updatedAt`, `periodDays`.

### `users/{uid}/settings/prefs`
UserSettings singleton. Fields: `uid`, `displayName`, `email`, `weightThresholdGreen` (default 173 lbs), `weightThresholdYellow` (default 180 lbs), `defaultTargetPaceSecPerMile` (default 600 = 10:00/mi), `createdAt`, `updatedAt`.

### `users/{uid}/settings/healthGoals`
HealthGoals singleton. Optional per-metric goal objects: `weight` (WeightGoal with tolerance band), `bmi` (BMIGoal with min/max range), `restingHR`, `steps`, `sleep`, `brushing`, `exerciseMins`, `moveCalories`, `standHours`, `awakeMins`, `avgBrushMins` (all MetricGoal with `warningPct`/`dangerPct`). Field `updatedAt` is a Firestore serverTimestamp.

### `users/{uid}/plans/{planId}`
Training plans. `planType` field discriminates: `"running"` (default when field absent) or `"workout"`. Entire plan in one document — no subcollections.
- Running: weeks[].entries[] are `PlannedRunEntry` (distanceMiles, paceTarget, runType, etc.)
- Workout: weeks[].entries[] are `PlannedWorkoutEntry` (exercises[] with sets/reps/weight, or duration_mins for duration-only sessions). `category` field on entries enables category-aware auto-matching.
- Legacy `planType: "pilates"` docs are unsupported; code renders a delete prompt.

### `users/{uid}/halfMarathonRaces/{raceId}`
Race goals (general; name predates multi-distance support). Fields: `id`, `name`, `raceDate`, `raceDistance` (5K/10K/halfMarathon/marathon/custom), `customDistanceMiles`, `location`, `targetPaceSecondsPerMile`, `isActive`, `linkedPlanId`, `actualRunId`, `actualRunDate`, `actualRunDistanceMiles`, `actualRunDurationSeconds`, `actualRunAvgPace`.

### `users/{uid}/shoes/{shoeId}`
Running shoe inventory. Fields: `id`, `name`, `brand`, `model`, `colorway`, `purchaseDate`, `startMileageOffset`, `retirementMileageTarget`, `notes`, `isRetired`, `addedAt`, `autoAssignRules` (ShoeAutoAssignRule[], inline array). Legacy rules subcollection (`shoeAutoAssignmentRules`) still exists for backward compat.

### `users/{uid}/shoeAssignments/manual`
Singleton document. Flat map `{[workoutId: string]: shoeId | null}`. Manual assignments always win over auto-assign rules.

### `users/{uid}/workoutOverrides/{workoutId}`
Override layer; never modifies the source healthWorkouts doc. Fields: `workoutId`, `userId`, `isExcluded`, `excludedAt`, `excludedReason`, `distanceMilesOverride`, `durationSecondsOverride`, `runTypeOverride`, `updatedAt`. Deleting this document fully restores original data.

### `users/{uid}/createdRoutes/{routeId}`
User-drawn map routes. Fields: `id`, `name`, `waypoints` (lat/lng array), `snappedPath` (Directions-API-snapped polyline, optional for older docs), `distanceMiles`, `createdAt`, `updatedAt`.

### `users/{uid}/dismissedDuplicates/{docId}`
Dismissed duplicate workout pairs. Prevents re-surfacing the same duplicate warning after a user dismisses it.

---

## Section 4 — Domain Invariants

1. **User scoping**: All data lives under `users/{uid}/…`. The only exception is `stravaActivities`, a legacy single-user global collection.
2. **Week boundaries**: Monday-start throughout. `weekStart()` in `src/utils/dates.ts` uses `(day + 6) % 7`. Matches iOS `WorkoutViewHelpers` convention.
3. **Workout overrides are non-destructive**: `workoutOverrides` docs layer on top of `healthWorkouts` at display time via `applyOverride()`. The source document is never written by the web app.
4. **planType backward compat**: Existing RunningPlan docs lack `planType`. `src/services/plans.ts` defaults to `"running"` on every read path. Never rely on `planType` being present.
5. **setActivePlan type isolation**: Activating a running plan deactivates only other running plans. Workout plans are independent. Uses atomic batch write.
6. **Plan auto-match (running)**: 4-pass best-fit matcher in `src/utils/planMatching.ts`. Tolerance = `max(0.5, plannedMiles × 0.3)`. A per-week `used` set prevents double-counting the same workout against multiple plan entries.
7. **Shoe assignment priority**: Manual assignments (in `shoeAssignments/manual`) always win over auto-assign rules. `evaluateAutoAssignRules()` skips any workout already in `existingAssignments`.
8. **stripUndefined requirement**: All Firestore writes pass through `stripUndefined()` = `JSON.parse(JSON.stringify(obj))`. Firestore rejects `undefined` values.
9. **Auth guard**: All `(app)/*` routes require a valid Firebase Auth session. The `AuthGuard` component enforces this. No Firestore call should occur without a confirmed `uid`.

---

## Section 5 — Key Calculations & Business Logic

1. **Pace formatting** (`src/utils/pace.ts`): `formatPace(secPerMile)` rounds total seconds first (`Math.round(secPerMile)`), then extracts minutes/seconds with integer arithmetic. Fixes the "10:60" rounding bug. Same pattern in `formatDuration`.

2. **HR Drift** (`src/utils/metrics.ts`): `((secondHalfAvgHR - firstHalfAvgHR) / firstHalfAvgHR) × 100`. Computed on device; requires ≥20 min or ≥2.0 mi. Thresholds by distance bucket — short (<3 mi): good ≤5%, ok ≤10%; medium (3–6 mi): good ≤7%, ok ≤12%; long (6+ mi): good ≤10%, ok ≤15%.

3. **Cadence** (`src/utils/metrics.ts`): Thresholds — short: good ≥170 spm, ok ≥160; medium: good ≥168, ok ≥158; long: good ≥165, ok ≥155.

4. **Training Load (TRIMP)** (`src/utils/trainingLoad.ts`):
   - Formula: `TRIMP = durationMinutes × zoneMultiplier(avgHR) × factor`
   - `MAX_HR = 185 bpm`
   - Zone multipliers (running zones): Z1 Recovery <60% ×1.0 | Z2 Aerobic 60–70% ×1.5 | Z3 Tempo 70–80% ×2.5 | Z4 Threshold 80–90% ×4.0 | Z5 Max ≥90% ×6.5
   - Strength activities use shifted zone bands (Z5 starts at 80%, not 90%)
   - Post-TRIMP scaling factors: running/cardio = 1.0 | HIIT/OTF = 0.75 | strength (lifting/cooldown) = 0.25 | mindful (yoga/pilates/barre) = 0.20
   - `STRENGTH_LOAD_FACTOR` was bumped from 0.20 → 0.25 (validated against Strava Relative Effort)
   - `computeTrainingLoad()` returns null when HR or duration is missing/invalid

5. **Training load ratio** (`src/utils/metrics.ts`): `ratio = acute7d / chronic30d`. Thresholds: <0.8 = "deload" | 0.8–1.1 = "stable" | 1.1–1.4 = "building" | >1.4 = "aggressive".

6. **CTL/ATL/TSB (PMC)** (`src/utils/trainingLoadSeries.ts`): EWMA with `CTL_DAYS=42` (fitness), `ATL_DAYS=7` (fatigue), `TSB=CTL−ATL` (form). α = 1 − exp(−1/τ). Rest days fill with load=0. Seed CTL/ATL at 0; pass a start date ≥3×CTL_DAYS before display window for convergence.

7. **Riegel race prediction** (`src/utils/riegelFit.ts`): Weighted WLS regression in log-log space: `ln(time) = a + k × ln(distance)`. Recency: 5-week half-life (0.5^(days/35)). Tier weights: RACE=3.0, QUALITY=1.75, BASELINE=1.0. Individual weights normalized then capped at 5.0. Half marathon gate: ≥4 efforts + 2+ medium-long runs (≥4 mi in last 35 days) + longest ≥6 mi — bypassed when a RACE-tier anchor ≥ target distance exists. Sanity filters: pace 4:30–15:00/mi, ≥0.5 mi, ≥5 min.

8. **Mile split segmentation** (`src/utils/mileSplits.ts`): Cumulative haversine distance over GPS route points. Timestamps interpolated linearly at mile boundaries. Final partial mile skipped if <0.05 mi.

9. **PR computation** (`src/utils/prComputation.ts`): Pace = `durationSeconds / distanceMiles` (not the stored `avgPaceSecPerMile`, which can be null on older sync rows). Band PRs and specific-distance PRs (5K, 5 mi, 10K, 15K, 10 mi, HM).

10. **Shoe auto-assign** (`src/utils/shoeAutoAssign.ts`): Rule specificity score: scope≠"any" +10, minDistance +5, maxDistance +5, startDate +3, endDate +3. Highest score wins. Manual assignments always take precedence.

---

## Section 6 — Known Sharp Edges

1. **No per-point HR in GPS route data**: The `route` subcollection has no HR field per point. Per-split HR requires iOS to bucket `HKQuantitySample` HR into the `mileSplits` subcollection (not yet complete). Always check for empty mileSplits before displaying per-mile HR. `src/utils/mileSplits.ts`

2. **Firestore subcollection security rules**: Every subcollection needs an explicit Firestore security rule. Missing rules produce permission-denied failures, which can be silent or surface as empty data. Always add rules when adding a new subcollection. (`src/lib/firebase.ts` comment)

3. **stravaActivities is not uid-scoped**: `fetchActivities()` in `src/services/activities.ts` queries the global `stravaActivities` collection with no uid filter. This is a legacy design. Do not add uid filtering without a migration plan.

4. **Legacy efficiencyRaw / efficiencyScore**: These fields are on the `HealthWorkout` type and in Firestore documents for backward compat with iOS, but no current UI reads them. Training Load (TRIMP) replaced the old efficiency metric. `src/types/healthWorkout.ts`

5. **STRENGTH_LOAD_FACTOR history**: The constant was 0.20 before being bumped to 0.25. Any analytics comparing load scores from before the bump against scores after will see a ~25% step-change for strength activities.

6. **Temporary debug console.log**: `getActivityContext()` in `src/utils/trainingLoad.ts` has an unflagged `console.log("[trainingLoad] activityType:", ...)` that was never removed after production validation.

7. **React hooks before early returns**: All hooks must appear before any conditional `return`. Guards like `if (!uid) return null` must come after all `useState`/`useEffect`/`useMemo` calls. Violating this causes React error #310.

8. **planType backward compat**: RunningPlan docs in Firestore have no `planType` field. Every `plans.ts` read path defaults to `"running"`. Any new code reading plans must apply this default.

9. **Legacy pilates plans**: Documents with `planType: "pilates"` exist in some Firestore instances. The code detects them and renders a "delete me" prompt. No write path creates them. `src/types/plan.ts:LegacyPilatesPlan`

10. **mileSplits subcollection may be empty**: The `users/{uid}/healthWorkouts/{id}/mileSplits` subcollection is read in `runs/[id]/page.tsx` and `personal-insights/page.tsx`, but iOS HR-per-mile sync is incomplete. Gracefully handle empty results.

11. **Riegel NaN date passthrough (fixed)**: `buildQualifyingEfforts` once allowed runs with NaN `startDate` through the cutoff check (`NaN < cutoff` is false, so they passed). Fixed with `!isFinite(startMs)` guard. `src/utils/riegelFit.ts`

---

## Section 7 — Feature Backlog

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Per-mile HR from iOS | High | Backlog | iOS must bucket `HKQuantitySample` HR by mile and write to `mileSplits` subcollection. Web read infrastructure already in place. |
| `/api/coach` rate limiting | High | Backlog | Needs Vercel KV or Upstash Redis — in-memory rate limiting is stateless on Vercel serverless. Auth check added (post pre-prod review). |
| Fall 2026 plan activation | High | Backlog | `seedSeptHMPlan()` in `src/lib/seedData.ts` seeds a Sept 2026 half marathon plan. Must be manually triggered after April 2026 race. |
| Firestore rules version control | Medium | Backlog | Rules managed in Firebase console only. No `firestore.rules` file in this repo. |
| Non-running plan types (strength/OTF/yoga/cycling) | Medium | In Progress | WorkoutPlan type + service + auto-match logic complete. Plan editor only supports RunningPlan today. iOS activityType strings for auto-match documented in `src/types/plan.ts:WORKOUT_CATEGORY_HK_TYPES`. |
| Remove debug console.log | Low | Backlog | `getActivityContext()` in `src/utils/trainingLoad.ts` has unflagged production debug log. |
| AI Coach contextual entry points | Low | Backlog | Plan Insights and Personal Insights lack "Ask AI Coach" buttons with pre-filled questions. |
| UI accessibility improvements | Low | Backlog | Charts need ARIA labels, tab bars need ARIA roles, toggles need role="switch". See `training-pre-prod-review.md` Phase 3. |

---

## Section 8 — External Services & Keys

| Service | Purpose | Credential(s) — env var names only |
|---|---|---|
| Firebase / Firestore | Primary database, real-time listeners | `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` |
| Firebase Admin SDK | Server-side ID token verification for `/api/coach` | `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON blob, server-side only) |
| Google Auth | User authentication (Google OAuth via Firebase) | Uses Firebase config above |
| Google Maps | Route draw (Maps JS API + Directions API + WALKING mode + Places Autocomplete) | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` |
| Anthropic / Claude | AI Coach — model: `claude-sonnet-4-20250514`, max_tokens 1024 | `ANTHROPIC_API_KEY` (server-side only, never `NEXT_PUBLIC_`) |
| HealthKit iOS sync | Syncs Apple Watch workouts, health metrics, GPS routes to Firestore | iOS repo: `cgradbad89/MEA.git` — do not modify from this repo |
| Hub App | Sibling app nav links in HubBanner top bar | `NEXT_PUBLIC_HUB_URL` |
