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
| Run Detail | `/(app)/runs/[id]` | Done | GPS map, mile-split charts/table (with GAP column), workout metrics, shoe picker, override controls; Elevation/Pace/HR overlay chart; HR zones + threshold-based pace zones; GAP KPI (grade adjusted pace) |
| Workouts | `/(app)/workouts` | Done | Non-running activity list with duplicate detection and exclusion |
| Plans | `/(app)/plans` | Done | Running + workout plan management; week calendar; auto-match completion tracking; Goals tab (custom date-range distance/time/count goals with progress rings) |
| Plan Editor | `/(app)/plans/[id]/edit` | Done | Edit running plan entries (distance, pace, run type, notes) |
| Workout Session | `/(app)/workout/[planId]/[weekIndex]/[weekday]/[[...sessionIndex]]` | Done | Workout plan session detail: exercise list, sets/reps/weight, completion toggle |
| Health | `/(app)/health` | Done | Daily health metrics (weight, resting HR, steps, sleep, brushing) with trend charts |
| Races | `/(app)/races` | Done | Race goal CRUD, active race toggle, associate an actual run with a race result |
| Shoes | `/(app)/shoes` | Done | Shoe inventory, per-shoe mileage, auto-assign rules editor |
| Routes | `/(app)/routes` | Done | GPS route viewer (Leaflet) + Google Maps route drawing tool |
| Personal Insights | `/(app)/personal-insights` | Done | Riegel race predictions, Best Efforts standard-distance records, PR table, pace trends, pace-by-distance trend (mileage-range + time-window selector), workout trends, CTL/ATL/TSB charts |
| Plan Insights | `/(app)/plan-insights` | Done | Running plan adherence, weekly mileage vs plan, predicted vs goal finish time |
| AI Coach | `/(app)/coach` | Done | Chat with Claude using full training context; streaming response |
| Settings | `/(app)/settings` | Done | Athlete profile settings: max heart rate, threshold pace, prediction-based threshold suggestion, run-HR max suggestion, and general preferences |
| API: Coach | `/api/coach` | Done | Server-side Anthropic call; requires Firebase ID token; max_tokens=1024 |

---

## Section 3 — Data Model

All user collections live under `users/{uid}/…`. Exception: `stravaActivities` is a legacy global collection.

### `stravaActivities/{activityId}`
Legacy Strava data synced from iOS. **Not uid-scoped** (single-user legacy design).
Key fields: `id`, `name`, `type` (ActivityType), `start_date`, `distance_m`, `moving_time_s`, `avg_speed_mps`, `avg_heartrate`, `pace_sec_per_mile`, `gear_id`, `efficiencyScore`.

### `users/{uid}/healthWorkouts/{workoutId}`
Primary workout data written by iOS HealthKitSyncService.
Key fields: `workoutId`, `activityType` (raw HK string), `displayType` (human-readable), `startDate` (Timestamp), `endDate`, `durationSeconds`, `sourceName`, `isRunLike` (boolean, pre-computed on iOS), `hasRoute`, `calories`, `avgHeartRate`, `distanceMiles`, `distanceMeters`, `avgPaceSecPerMile`, `avgSpeedMPS`, `hrDriftPct`, `cadenceSPM`, `elevationGainM`, `prBadges` (string[]), `bestEfforts` (map keyed by `1mi`/`5k`/`10k`/`10mi`/`half` → `timeSeconds | null`). Fields `efficiencyRaw` and `efficiencyScore` are legacy; no UI reads them.

### `users/{uid}/healthWorkouts/{workoutId}/route/{pointIndex}`
GPS route points subcollection. Fields: `index`, `lat`, `lng`, `altitude`, `timestamp` (Timestamp), `speed`, `hr` (number | null — per-point heart rate in bpm, added by iOS sync, commit 84dfbf3; null when absent).

### `users/{uid}/healthWorkouts/{workoutId}/mileSplits/{mile}`
Per-mile split HR from iOS. Fields: `mile` (number, 1-indexed), `avgBpm`, `sampleCount` (read path requires `avgBpm && sampleCount >= 2` before using a split's HR). Security rule now in place (see Section 6 #10). The subcollection may still be empty for older runs — read paths in `runs/[id]/page.tsx` and `personal-insights/page.tsx` handle empty results gracefully.

### `users/{uid}/goals/{goalId}`
Custom running goals (`RunningGoal`, `src/types/goal.ts`; service `src/services/goals.ts`). Fields: `label` (string), `metric` (`'distance'` | `'time'` | `'count'`), `target` (number — miles / seconds / count, matching `metric`), `startDate` (ISO `'YYYY-MM-DD'` string), `endDate` (ISO string), `isActive` (boolean; soft-delete sets `false`), `createdAt` (Timestamp), `updatedAt` (Timestamp). Security rule: `allow read, write: if isOwner(uid)` — **must be added manually in the Firebase console** (see Section 6 #10). Progress is computed client-side via `computeGoalProgress` (Section 5).

### `users/{uid}/healthMetrics/{YYYY-MM-DD}`
Daily health snapshots (one doc per calendar date). Fields: `date`, `weight_lbs`, `bmi`, `resting_hr`, `steps`, `exercise_mins`, `move_calories`, `stand_hours`, `sleep_total_hours`, `sleep_awake_mins`, `sleep_start` (ISO string), `sleep_end` (ISO string), `brush_count`, `brush_avg_duration_mins`, `syncedAt`.

### `users/{uid}/healthMetrics/hourlyHeartRate`
Special singleton document (not a date-keyed record). Fields: `hourlyAvgBpm` (Record<"0"–"23", number>), `sampleCount`, `updatedAt`, `periodDays`.

### `users/{uid}/settings/prefs`
UserSettings singleton. Fields: `uid`, `displayName`, `email`, `weightThresholdGreen` (default 173 lbs), `weightThresholdYellow` (default 180 lbs), `defaultTargetPaceSecPerMile` (default 600 = 10:00/mi), `maxHeartRate` (optional user-set bpm), `thresholdPaceSecPerMile` (optional user-set threshold pace), `suggestedMaxHeartRate` (optional last computed bpm suggestion), `suggestedThresholdPaceSecPerMile` (optional prediction-based threshold suggestion), `suggestionsUpdatedAt` (Firestore Timestamp), `createdAt`, `updatedAt`.

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
Singleton document. Flat map `{[workoutId: string]: shoeId | null}`. Manual assignments always win over auto-assign rules. **Auto-assignments are NOT persisted** — `evaluateAutoAssignRules()` derives them in memory; only manual choices (including explicit `null` = "no shoe") are stored here. Both the run listing and run detail pages resolve a run's shoe via the same merge `{ ...autoAssigned, ...manualMap }` (manual wins); the detail page does so through the shared `useResolvedShoeAssignment` hook (`src/hooks/useResolvedShoeAssignment.ts`).

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
7. **Shoe assignment priority**: Manual assignments (in `shoeAssignments/manual`) always win over auto-assign rules. `evaluateAutoAssignRules()` skips any workout already in `existingAssignments` (including explicit `null`), so an explicit "no shoe" survives a matching auto-rule. Auto-assignments are derived (never persisted); both the listing and detail pages must resolve via `{ ...autoAssigned, ...manualMap }` — the detail page uses `useResolvedShoeAssignment` to stay in sync (a prior bug had it read only the manual map, so auto-assigned shoes never showed on the detail page).
8. **stripUndefined requirement**: All Firestore writes pass through `stripUndefined()` = `JSON.parse(JSON.stringify(obj))`. Firestore rejects `undefined` values.
9. **Auth guard**: All `(app)/*` routes require a valid Firebase Auth session. The `AuthGuard` component enforces this. No Firestore call should occur without a confirmed `uid`.

---

## Section 5 — Key Calculations & Business Logic

1. **Pace formatting** (`src/utils/pace.ts`): `formatPace(secPerMile)` rounds total seconds first (`Math.round(secPerMile)`), then extracts minutes/seconds with integer arithmetic. Fixes the "10:60" rounding bug. Same pattern in `formatDuration`.

2. **HR Drift** (`src/utils/metrics.ts`): `((secondHalfAvgHR - firstHalfAvgHR) / firstHalfAvgHR) × 100`. Computed on device; requires ≥20 min or ≥2.0 mi. Thresholds by distance bucket — short (<3 mi): good ≤5%, ok ≤10%; medium (3–6 mi): good ≤7%, ok ≤12%; long (6+ mi): good ≤10%, ok ≤15%.

3. **Cadence** (`src/utils/metrics.ts`): Thresholds — short: good ≥170 spm, ok ≥160; medium: good ≥168, ok ≥158; long: good ≥165, ok ≥155.

4. **Training Load (TRIMP)** (`src/utils/trainingLoad.ts`):
   - Formula: `TRIMP = durationMinutes × zoneMultiplier(avgHR) × factor`
   - `DEFAULT_MAX_HR = 185 bpm` fallback. Consumers resolve `users/{uid}/settings/prefs.maxHeartRate` via `resolveMaxHr(settings)` and pass the resolved value into `computeTrainingLoad()`, `buildDailyLoadMap()`, zone-boundary helpers, badges, dashboard/insights summaries, and AI Coach context.
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

11. **Plan Insights "Recent Trends" window** (`src/app/(app)/plan-insights/page.tsx`): All three Recent Trends KPIs (total miles + run count, avg run distance, longest run) share one cutoff/label derived from the selected race's linked plan. Resolution order: (1) `activePlan.startDate`; (2) earliest week's `startDateLabel` parsed as `"<label> <currentYear>"` (defensive — not on the `PlanWeek` type, read via cast); (3) 30-day fallback with a `console.warn`. Label is `Since plan start · <Mon D>` when resolved, else `Last 30 days`. Previously each KPI used an independent hardcoded 30-day (longest run: 56-day) lookback. The KPIs filter a slice of the already-loaded `runs` array — no extra Firestore read.

12. **Grade Adjusted Pace (GAP)** (`src/utils/gradeAdjustedPace.ts`): **GAP is now RATIO-BASED** — the run-level KPI = `avgPaceSecPerMile × (1 / aggregateFactor)`, i.e. the trusted device pace scaled by a unitless grade ratio. This fixes a systematic GAP-slower-than-pace bug on net-gain runs caused by three issues: (#1) **basis mismatch** — the displayed Pace KPI is the device `avgPaceSecPerMile`, but GAP was previously recomputed on GPS 2D-haversine distance (which runs shorter than device distance → GAP slower even on flat ground); (#2) **Jensen convexity** — summing per-segment `1/factor` over symmetric rolling terrain inflates GAP slow (1/factor is convex); (#3) **dead-band** — the ±1.5% dead-band zeroed gentle sustained net climbs (avg grade often sub-1.5%). The `aggregateFactor` is ONE Minetti factor (`gradeAdjustmentFactor`, Minetti et al. 2002, grade clamped ±30%, floored 0.1) computed from the run's **net smoothed elevation change over total moving horizontal distance** — so symmetric rolling (net ≈ 0) yields ratio ≈ 1 (no slow-bias) and flat ground gives GAP == displayed Pace exactly, while net-uphill → faster and net-downhill → slower. Inputs preserved: 11-point centered altitude smoothing (`ALT_SMOOTHING_WINDOW=11`), the 25 m resampled baseline (`GRADE_BASELINE_METERS=25`), and the ±1.5% dead-band (`GRADE_DEADBAND_PERCENT=1.5`) — but the dead-band now applies **only to per-span noise rejection feeding the chart/table series**, NOT to the run-level aggregate grade. **Moving time/distance** are derived from route points (a segment is moving only if it covers ≥`MIN_MOVING_DIST_M=1.0` m at ≥`MIN_MOVING_SPEED_MS=0.5` m/s); the GPS-derived per-point and per-mile GAP series are scaled by a single basis-correction (`avgPaceSecPerMile / gpsRawMovingPace`) so they read consistently with the KPI. When `avgPaceSecPerMile` is null, the basis falls back to GPS raw moving pace. `computeRunGap(points, totalDistanceMiles, movingTimeSec, avgPaceSecPerMile?)`.

13. **Goal progress** (`src/utils/goalProgress.ts`): `computeGoalProgress(goal, runs, today) → GoalProgress`. Status by date range: `upcoming` (today < startDate) / `active` / `completed` (today > endDate). `actual` sums each in-range run's `distanceMiles` (distance), `durationSeconds` (time), or +1 (count). Pace status (active only): `ahead` when actual ≥ 102% of expected linear pace (`target × daysElapsed/daysTotal`), `behind` when ≤ 98%, else `on_track`; completed goals report met/missed via `percent`. Time targets are stored in seconds (the form converts hours→seconds on save).

14. **Rolling average** (`src/utils/smoothSeries.ts`): `rollingAverage(values, windowSeconds, timestampsSec)` — time-windowed centered mean (default window `SMOOTH_WINDOW_SEC=25`). Nulls are preserved (window with no finite values → null) so line breaks survive; falls back to a fixed-count window when timestamps are unusable. Used to smooth the pace and GAP display series in `RunOverlayChart` (applied after outlier-nulling; underlying GAP/per-mile values untouched).

15. **Pace axis domain** (`src/utils/paceAxisDomain.ts`): `computePaceAxisDomain(values)` builds a robust y-axis [min,max] from the p5/p95 percentiles of finite pace/GAP values with padding, clamped to `MIN_PACE_FLOOR_SEC=240` (4:00/mi) – `MAX_PACE_CEIL_SEC=1200` (20:00/mi) so GPS-glitch spikes don't crush the real signal band. `nullifyOutliers(values, domain)` returns a display copy with out-of-domain values set to null (Recharts draws a line break instead of a clamped spike). Display-only — neither alters any pace/GAP computation.

16. **Pace-by-distance trend** (`src/lib/paceRangeTrend.ts`): `computePaceRangeTrend(runs, minMiles, maxMiles, window, now)` powers the Personal Insights "Pace by distance" section. A run qualifies when its **total** `distanceMiles` is within `[minMiles, maxMiles]` inclusive AND `date >= windowStartDate(window, now)`. Per-period avg pace is **distance-weighted**: `sum(durationSeconds)/sum(distanceMiles)` within the bucket (never the arithmetic mean of per-run paces). Granularity: `1m/2m/3m → week` (Monday-start via `weekStart`), `6m/12m/ytd → month` (month-start computed inline). `windowStartDate`: `ytd → Jan 1 of now's year`, `Nm → now minus N calendar months`. Validity guard drops runs with `distanceMiles ≤ 0`, non-finite pace, or pace outside `[180, 1200]` sec/mi. Returns raw seconds; the section formats with `formatPaceLabel`.

17. **Best Efforts** (`src/utils/bestEfforts.ts`): `computeBestEfforts(points)` computes each run's fastest continuous elapsed-time segment for `1mi`, `5k`, `10k`, `10mi`, and `half`. It builds cumulative 2D haversine distance and elapsed-time arrays from route points, then uses an O(n) two-pointer sliding window per target distance. The right boundary is linearly interpolated when the window overshoots the target distance (`t = t0 + ((D - d0) / (d1 - d0)) * (t1 - t0)`) so results represent exactly the standard distance, not the next sampled route point. Stopped/micro-pause time is intentionally included, matching Strava-style elapsed best efforts; GAP's moving-time stop filtering is not used here. Runs shorter than a target distance store `null` for that key. Results are persisted on `users/{uid}/healthWorkouts/{workoutId}.bestEfforts`; the idempotent backfill service skips existing `bestEfforts` docs before route points are fetched.

18. **Athlete Profile suggestions** (`src/utils/maxHrSuggestion.ts`, `src/utils/thresholdPaceSuggestion.ts`): Max-HR suggestion is an explicit user-triggered calculation, not a page-load hot path. The service reads up to 30 recent GPS run route subcollections, collects per-point `hr`, filters values outside 40–220 bpm, requires at least 50 valid samples, and returns the rounded 99th percentile. Threshold-pace suggestion reuses the existing Riegel model output: predicted 10-mile pace is preferred (`predictSeconds(fitTen, 10.0) / 10`), with predicted half-marathon pace as fallback. Treating 10-mile predicted pace as threshold pace is a domain assumption to validate against user preference.

19. **Pace Zones** (`src/utils/zones.ts`, `src/components/ZoneBreakdown.tsx`): Run Detail shows threshold-based pace zones below HR zones when `users/{uid}/settings/prefs.thresholdPaceSecPerMile` is set. The model uses actual per-point pace (not GAP) and attributes elapsed time between consecutive route points to the earlier point's pace. Zone bands use pace/threshold ratio, where ratio > 1 is slower than threshold and exact threshold pace is Z3: Z1 Recovery ≥1.20, Z2 Easy 1.10–1.20, Z3 Threshold 0.97–1.10, Z4 Interval 0.90–0.97, Z5 Repetition <0.90. Invalid/null pace and spikes >1800 sec/mi are excluded. When threshold pace is unset, Run Detail shows a settings prompt instead of a run-relative fake bar; when set, the Pace Zones info tooltip shows the actual pace ranges derived from the user's threshold.

---

## Section 6 — Known Sharp Edges

1. **Per-point HR now exists on the `route` subcollection** (field `hr: number | null`, added iOS commit 84dfbf3). Run Detail HR-zone breakdown (`ZoneBreakdown`) and Training Load consumers now read `users/{uid}/settings/prefs.maxHeartRate` when set and otherwise fall back to `DEFAULT_MAX_HR=185` through `resolveMaxHr(settings)`. Per-mile HR is still sourced separately from the `mileSplits` subcollection (Section 3).

2. **Firestore subcollection security rules**: Every subcollection needs an explicit Firestore security rule. Missing rules produce permission-denied failures, which can be silent or surface as empty data. Always add rules when adding a new subcollection. (`src/lib/firebase.ts` comment)

3. **stravaActivities is not uid-scoped**: `fetchActivities()` in `src/services/activities.ts` queries the global `stravaActivities` collection with no uid filter. This is a legacy design. Do not add uid filtering without a migration plan.

4. **Legacy efficiencyRaw / efficiencyScore**: These fields are on the `HealthWorkout` type and in Firestore documents for backward compat with iOS, but no current UI reads them. Training Load (TRIMP) replaced the old efficiency metric. `src/types/healthWorkout.ts`

5. **STRENGTH_LOAD_FACTOR history**: The constant was 0.20 before being bumped to 0.25. Any analytics comparing load scores from before the bump against scores after will see a ~25% step-change for strength activities.

6. **Temporary debug console.log**: `getActivityContext()` in `src/utils/trainingLoad.ts` has an unflagged `console.log("[trainingLoad] activityType:", ...)` that was never removed after production validation.

7. **React hooks before early returns**: All hooks must appear before any conditional `return`. Guards like `if (!uid) return null` must come after all `useState`/`useEffect`/`useMemo` calls. Violating this causes React error #310.

8. **planType backward compat**: RunningPlan docs in Firestore have no `planType` field. Every `plans.ts` read path defaults to `"running"`. Any new code reading plans must apply this default.

9. **Legacy pilates plans**: Documents with `planType: "pilates"` exist in some Firestore instances. The code detects them and renders a "delete me" prompt. No write path creates them. `src/types/plan.ts:LegacyPilatesPlan`

10. **Manual console-managed Firestore rules for new subcollections**: The `mileSplits` subcollection security rule is now in place, but rules are still console-managed (no `firestore.rules` in the repo). Adding a subcollection requires manually adding a matching rule in the Firebase console, e.g.:
   `match /users/{uid}/healthWorkouts/{docId}/mileSplits/{splitId} { allow read, write: if isOwner(uid); }`.
   The `goals` subcollection requires the same pattern: `match /users/{uid}/goals/{goalId} { allow read, write: if isOwner(uid); }`. Missing rules surface as permission-denied / silently empty data.

11. **Riegel NaN date passthrough (fixed)**: `buildQualifyingEfforts` once allowed runs with NaN `startDate` through the cutoff check (`NaN < cutoff` is false, so they passed). Fixed with `!isFinite(startMs)` guard. `src/utils/riegelFit.ts`

12. **GAP basis & moving-time**: As of the ratio-based GAP rewrite (Section 5 item 12), **GAP is anchored to the displayed `avgPaceSecPerMile`** (GAP = pace × grade ratio), so flat ground gives GAP == Pace exactly — the old "pace uses elapsed, GAP uses moving, so they differ by design" divergence no longer applies to the flat case. `computeRunGap` still derives the moving-time/distance basis from route points (segments ≥ `MIN_MOVING_SPEED_MS=0.5` m/s) for the grade ratio and the per-point/per-mile series; if route timestamps are degenerate (< `MIN_DERIVED_MOVING_SEC=60` s of derivable moving time) it falls back to the passed `durationSeconds` with a `console.warn` and treats every real-distance segment as moving. `src/utils/gradeAdjustedPace.ts`

13. **Shoe auto-assignment is purely derived, never persisted**: `evaluateAutoAssignRules()` returns an in-memory map. Both the run listing page and the run detail page resolve a run's shoe via `{ ...autoAssigned, ...manualMap }` (manual wins). The detail page does so through the `useResolvedShoeAssignment` hook (`src/hooks/useResolvedShoeAssignment.ts`). A prior bug had the detail page read only the manual map, so auto-assigned shoes never showed there.

14. **Pace zones require threshold pace**: `computePaceZones` is now threshold-based and used by Run Detail's `ZoneBreakdown`. It intentionally does not fall back to GAP quintiles or run-relative buckets; when `thresholdPaceSecPerMile` is unset, the UI shows a link to `/settings` instead of fabricating zones.

---

## Section 7 — Feature Backlog

| Feature | Priority | Status | Notes |
|---|---|---|---|
| Per-mile HR from iOS | High | Done | Superseded by per-point `hr` on the `route` subcollection (iOS commit 84dfbf3). The `mileSplits` subcollection is still used for per-mile `avgBpm` display in the splits table/charts. |
| Athlete profile (maxHR + threshold pace) | High | Done | `/settings` stores max HR and threshold pace on `settings/prefs`, computes a user-triggered max-HR suggestion from recent run route HR, derives a threshold suggestion from predicted 10-mile pace, wires Run Detail HR zones to profile max HR, restores threshold-based Run Detail pace zones, and rewires Training Load consumers to `resolveMaxHr(settings)` with `DEFAULT_MAX_HR=185` fallback. Deferred: workout-inclusive max-HR suggestion awaits an iOS `maxHeartRate` field. |
| Training-load trend chart | Medium | Backlog | CTL/ATL/TSB EWMA already implemented in `src/utils/trainingLoadSeries.ts` and shown on Personal Insights. A separate trend chart on Plans & Goals or the calendar page is pending scoping. |
| Best Efforts | High | Done | `computeBestEfforts`, per-run persistence, manual backfill trigger, run-detail missing-field compute hook, and Personal Insights UI section are implemented. |
| `/api/coach` rate limiting | High | Backlog | Needs Vercel KV or Upstash Redis — in-memory rate limiting is stateless on Vercel serverless. Auth check added (post pre-prod review). |
| Fall 2026 plan activation | High | Backlog | `seedSeptHMPlan()` in `src/lib/seedData.ts` seeds a Sept 2026 half marathon plan. Must be manually triggered after April 2026 race. |
| firestore.rules in version control | Medium | Backlog | Rules still console-managed only — no `firestore.rules` file in this repo. Three collections now require manual console rule additions: `mileSplits`, `route` (with the new `hr` field), and `goals`. |
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
