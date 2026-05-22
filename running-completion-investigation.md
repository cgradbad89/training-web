# Running / Workout Completion Investigation

Read-only diagnosis. No source files modified. No commits.

---

## BUG 1 — Dashboard marks a planned run complete; Plans page shows it incomplete

**Symptom:** Dashboard shows Tuesday's planned run "met" (green check). No run was done on Tuesday (a non-run workout was). The Plans page correctly shows Tuesday incomplete.

### What I traced

The dashboard has **two** places that render running-plan per-entry completion:

1. **`PlanProgressCard` → `runStatus(...)`** in `src/app/(app)/dashboard/page.tsx:361-383`
   Renders the row of icons (`CheckCircle2 / MinusCircle / XCircle / Circle`) next to each planned run on the "Running Plan" tile.
2. **`WeekCalendar` → `buildCalendarEvents` → `matchPlanToActual`** in `src/app/(app)/dashboard/page.tsx:992-999` → `src/utils/planCalendar.ts:78-105` → `src/utils/planMatching.ts:127-230`
   Renders the green "✓" prefix inside each `EventPill` on the calendar grid.

The Plans page uses path (2) exclusively for running-plan completion (`src/app/(app)/plans/page.tsx:298-300`).

### What the activity pool looks like in each path

```
Dashboard PlanProgressCard
  workouts: HealthWorkout[]   <- ALL workouts from onHealthWorkoutsSnapshot({limitCount:200})
  └─ filter w.isRunLike && isInWeek(...)              dashboard/page.tsx:412
     └─ weekRuns -> runStatus(entry, weekStart, weekRuns)
        └─ inside runStatus there is ALSO a guard:    dashboard/page.tsx:373
             if (!w.isRunLike) return false;

Dashboard WeekCalendar
  actualRuns={workouts}                                dashboard/page.tsx:997
  └─ buildCalendarEvents(plans, actualRuns)            planCalendar.ts:79
     └─ matchPlanToActual(plan, actualRuns)
        └─ INTERNAL filter:                            planMatching.ts:131
             const runs = workouts.filter((w) => w.isRunLike);

Plans page
  activities: HealthWorkout[]  <- fetchHealthWorkouts(uid)
  └─ matchPlanToActual(selectedRunningPlan, activities) plans/page.tsx:298-300
     └─ same INTERNAL filter as above (planMatching.ts:131).
```

### `matchPlanToActual` internal guard (relevant)

```ts
// src/utils/planMatching.ts:131
const runs = workouts.filter((w) => w.isRunLike);
// ... usedGlobal Set tracks which runs are consumed across all passes
const usedGlobal = new Set<string>();
```

`matchPlanToActual` also enforces a **`usedGlobal` Set** (line 134) so each run can only satisfy ONE planned entry. Four passes are tried in order (exact day full → ±1 day full → exact day partial → ±1 day partial).

### `runStatus` (the divergent path)

```ts
// src/app/(app)/dashboard/page.tsx:361-383
function runStatus(entry: PlannedRunEntry, weekMonday: Date, weekRuns: HealthWorkout[]): RunStatus {
  const entryDate = new Date(weekMonday);
  entryDate.setDate(weekMonday.getDate() + entry.dayOfWeek);
  const now = new Date();
  if (entryDate > now) return "upcoming";

  const run = weekRuns.find((w) => {
    if (!w.isRunLike) return false;
    const d = getWorkoutLocalDate(w);
    const diffDays = Math.abs(Math.round((d.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24)));
    return diffDays <= 1;
  });

  if (!run) return "missed";
  return run.distanceMiles >= entry.distanceMiles * 0.85 ? "met" : "partial";
}
```

Two critical differences vs `matchPlanToActual`:

- **No `usedGlobal` set.** A single Monday run can be matched to MULTIPLE planned entries within ±1 day — it satisfies Monday AND Tuesday AND (if it exists) Sunday.
- **±1 day window applied immediately**, with no preference for exact-day matches first.

### Root-cause divergence

PlanProgressCard's `runStatus` finds **any** isRunLike workout within ±1 day of the planned date without tracking consumption, so a Monday run (logged for the actual Monday plan) ALSO marks Tuesday's planned run "met" via the ±1-day tolerance. `matchPlanToActual` (used by both the Plans page and the dashboard WeekCalendar) consumes runs via `usedGlobal` in Pass 1 first, so the Monday run is locked to Monday and Tuesday stays missed.

Note: the user's exact phrasing was "no run was done Tuesday (a non-run workout was)". The non-run workout itself never reaches `runStatus` (the `weekRuns` upstream filter + the internal `!w.isRunLike` guard both reject it). The trigger is a real run done on Mon or Wed.

### Recommended fix direction

Route PlanProgressCard's per-entry status through `matchPlanToActual` so both dashboard surfaces and the Plans page agree:

- For each `entry`, derive `met` / `partial` / `missed` from `matchMap.get(entry.id)`:
  - `quality === "full"`, distance ≥ 85%      → "met"
  - `quality === "full"`, distance < 85%      → "partial"
  - `quality === "partial"`                    → "partial"
  - `null` (no match) and `entryDate > now`    → "upcoming"
  - `null` (no match) and `entryDate ≤ now`    → "missed"
- Delete the local `runStatus(...)` function and its bespoke ±1-day logic.

### Smallest-change option

Inside `PlanProgressCard` (dashboard/page.tsx around lines 402-454):

```ts
const matchMap = useMemo(
  () => matchPlanToActual(activePlan, workouts),
  [activePlan, workouts]
);
// ...
planWeek.entries.map((entry) => {
  const match = matchMap.get(entry.id);
  const entryDate = ...;
  let status: RunStatus;
  if (match) {
    status = match.quality === "full"
      ? (match.activity.distanceMiles >= entry.distanceMiles * 0.85 ? "met" : "partial")
      : "partial";
  } else {
    status = entryDate > new Date() ? "upcoming" : "missed";
  }
  // render StatusIcon with `status`
});
```

That single-component swap eliminates double-counting and removes ~25 lines of redundant logic. Blast radius: one component on the dashboard. No type changes, no service changes, no migration.

### FINDINGS BLOCK (Bug 1)

```
BUG 1 FINDINGS
--------------
Dashboard completion source: TWO paths — runStatus() naive matcher at
  src/app/(app)/dashboard/page.tsx:361-383 (PlanProgressCard tile)
  AND matchPlanToActual via buildCalendarEvents (WeekCalendar tile)
Dashboard activity pool:
  • PlanProgressCard: workouts.filter(w => w.isRunLike && isInWeek(...))
    at src/app/(app)/dashboard/page.tsx:412 — properly isRunLike-filtered
  • WeekCalendar: actualRuns={workouts} (ALL workouts) at line 997, but
    matchPlanToActual then filters isRunLike internally
matchPlanToActual isRunLike guard: yes — INTERNAL filter at
  src/utils/planMatching.ts:131 (`workouts.filter((w) => w.isRunLike)`),
  plus usedGlobal Set at line 134 preventing one run from satisfying
  multiple entries
Plans page completion source: matchPlanToActual at
  src/app/(app)/plans/page.tsx:298-300
Plans page activity pool: activities (full fetchHealthWorkouts result),
  passed to matchPlanToActual which filters isRunLike internally
Root-cause divergence: PlanProgressCard's runStatus uses a naive
  weekRuns.find(diffDays<=1) with NO usedGlobal set, so a single
  Monday run can satisfy Mon AND Tue AND Wed planned entries via
  ±1-day tolerance — the Plans page (and the dashboard's own
  WeekCalendar tile) avoid this because matchPlanToActual's
  usedGlobal locks each run to one entry.
Recommended fix direction: route PlanProgressCard through
  matchPlanToActual; derive met / partial / missed / upcoming from
  matchMap.get(entry.id) — same logic the Plans page already uses.
Smallest-change option: in PlanProgressCard (dashboard/page.tsx
  ~402-454), compute matchMap once via useMemo and replace the
  runStatus(entry, weekStart, weekRuns) call inside the entries.map
  with matchMap-based derivation. Delete the runStatus function.
  One component, no type changes, no service changes.
```

---

## BUG 2 — Planned Orange Theory session not auto-completing despite a same-day HIIT workout

**Symptom:** Auto-match has run (confirmed by the user — Plans page was loaded today). The OTF planned session is still incomplete. A HIIT workout was completed today.

### OTF predicate (quoted)

```ts
// src/services/autoMatch.ts:67-81  getMatchPredicate(session)
if (session.category) {
  if (session.category === 'orangetheory') {
    // Match any non-running workout — OTF logs inconsistently
    return (workout: HealthWorkout) => !workout.isRunLike;
  }
  const hkTypes = WORKOUT_CATEGORY_HK_TYPES[session.category];
  return (workout: HealthWorkout) =>
    !workout.isRunLike &&
    hkTypes.some(
      (t) => t.toLowerCase() === workout.activityType.toLowerCase().trim()
    );
}
return 'legacy';
```

OTF's predicate IS the "match any non-running workout" version. A HIIT workout with `isRunLike=false` should satisfy it.

### Same-day comparison

Both sides use LOCAL calendar dates:

- Planned session date: `plannedSessionDate(plan.startDate, weekIndex, weekday)` at `src/services/autoMatch.ts:92-103` — uses `new Date(year, month-1, day)` (local constructor), then `.setDate(... + offset)`.
- Workout date key: `localISODate(w.startDate)` at `src/services/autoMatch.ts:85-90` — uses `getFullYear() / getMonth() / getDate()` (all local).
- Both keys compared via the `byDate` Map keyed by local `YYYY-MM-DD`.

**No UTC off-by-one risk.** A late-evening EST workout that lands on the next UTC day still keys to its LOCAL date because `localISODate` reads local components from the parsed Date object. This is the same fix already applied previously to plan matching.

### Pool / used-workout mechanism

`byDate` Map is built once at the top of `autoMatchCrossTrainingSessions` (lines 136-146). When a session matches, the workout is **removed** from its day bucket via `candidates.splice(matchIdx, 1)` (line 215). Subsequent sessions on the same day see a smaller candidates array.

Ordering: outer `for (const plan of plans)` → `plan.weeks.map` → `week.entries.map`. So a session iterated earlier in this nested traversal **can consume the only HIIT workout before the OTF session is reached**. Two ways this happens:

- The OTF session and another non-OTF session live on the SAME day, in the SAME plan, with the same `!isRunLike` predicate (OTF) or with a predicate that the HIIT workout incidentally satisfies (e.g. category=hiit whose HK types include the workout's activityType).
- The OTF session lives in a plan iterated AFTER another active workout plan that has a same-day session matching the HIIT workout.

Important: the HIIT category's HK types are `['highIntensityIntervalTraining', 'crossTraining']` (per `src/types/plan.ts:62-69` already referenced in prior tasks). If the HIIT workout's `activityType` matches one of those strings AND there's a HIIT-category session today, the HIIT session would consume the workout first (depending on entries order within the day).

### Skip conditions

- `entry.completed === true` → skipped (line 163). ✓ correct.
- `sessionDate > today` → skipped (line 169). `today.setHours(0,0,0,0)` and `plannedSessionDate(...)` returns midnight local, so for a session whose calendar day equals today, `sessionDate > today` is `false` (they're equal, not greater). ✓ today is NOT treated as future.
- `entry.type !== "workout"` → skipped (line 162). Rest/duration-only entries follow a different branch.

### Category resolution / legacy fall-through

If `entry.category` is undefined or falsy, `getMatchPredicate` returns `'legacy'`. The caller then routes to:

```ts
// src/services/autoMatch.ts:197-202
const predicate: (w: HealthWorkout) => boolean =
  matchPredicate === 'legacy'
    ? isDurationOnlyEntry(entry)
      ? isPilatesActivity        // duration-only, no category
      : isStrengthLikeActivity   // exercise-based, no category
    : matchPredicate;
```

If the OTF day was authored before the category system existed (i.e. `entry.category` is missing) AND the entry has no `exercises` (duration-only), the predicate becomes `isPilatesActivity` — which **only matches yoga/pilates/mind-body/flexibility activity types**. A HIIT workout (`highIntensityIntervalTraining` or `crossTraining`) would NOT match. Silent miss.

If the legacy entry has exercises, the predicate becomes `isStrengthLikeActivity` (any non-running, non-pilates workout) — would match the HIIT workout. So legacy-with-exercises is safe, legacy-without-exercises is broken for OTF.

### Plan-type containment

`autoMatchCrossTrainingSessions` skips any plan where `!isWorkoutPlan(plan)` (line 152). If the OTF session somehow lives on a `RunningPlan` document, it's never iterated. Unlikely for the user's case but worth confirming.

### Ranked hypotheses

| # | Hypothesis | Confirming data needed |
|---|-----------|------------------------|
| **H1** | The HIIT workout was consumed by an earlier-iterated session on the same day — either another session in the same `weeks[].entries[]` ordering or a session in a plan iterated before the OTF plan. The OTF session's `candidates` bucket is then empty when its turn comes, and the matcher logs `[autoMatch] no match for session ... candidateActivityTypes: []`. | Browser console logs at next page load: look for `[autoMatch] checking session` entries for today's date. If the OTF session logs an EMPTY `candidateActivityTypes`, H1 confirmed. Also: all PlannedWorkoutEntry on today's date across ALL active workout plans (their `category` + plan `id` + `weekday`) plus today's HIIT workout's `activityType`. |
| **H2** | The OTF planned session was authored before the category system, so `entry.category` is missing/null. The legacy path picks `isPilatesActivity` (because the entry is duration-only with no `exercises`), which rejects the HIIT workout. | The OTF planned session's raw document fields: `category`, `type`, `exercises` (length), `duration_mins`, `completed`, `weekIndex`, `weekday`. If `category` is null/undefined AND `exercises` is empty/missing → H2 confirmed. |
| **H3** | The OTF session's calendar date is NOT today (e.g. the user thinks today is Tue but the plan has OTF on Wed, OR `plan.startDate` is off by a week so `weekIndex × 7 + (weekday-1)` resolves to a different date). The HIIT workout sits in its local-date bucket alone with no planned session targeting that bucket. | The plan's `startDate`, the OTF entry's `weekIndex` + `weekday`, and the HIIT workout's local startDate. Compute `plannedSessionDate(startDate, weekIndex, weekday)`'s local YYYY-MM-DD and compare to the workout's local YYYY-MM-DD. Mismatch → H3 confirmed. |
| **H4** | The HIIT workout has `isRunLike: true` (HealthKit misclassification — e.g. an HKWorkoutActivityType set such that the iOS sync mapped it to a run). The OTF predicate `!w.isRunLike` then rejects it. | Today's HIIT workout document: `activityType` + `isRunLike` + `startDate`. If `isRunLike === true` → H4 confirmed. |
| **H5** | The plan housing the OTF session has `planType !== "workout"` (it's a `RunningPlan` or `LegacyPilatesPlan` doc), so the outer loop skips it via `!isWorkoutPlan(plan)` (autoMatch.ts:152). | The plan document's `planType` field. Anything other than `"workout"` → H5 confirmed. |
| **H6** | The plan housing the OTF session has `isActive: false` — autoMatch processes ALL plans regardless of isActive, BUT the Plans page UI might filter by isActive and hide the matched state. Lowest probability since user said it's still showing on the Plans page. | The plan's `isActive` field. |

### Recommended fix direction (conditioned on hypothesis)

- **H1 confirmed:** order-of-iteration regression. Either reorder so OTF runs LAST (least restrictive predicate goes last so stricter categories consume their matches first), OR change the OTF predicate to be more specific (require a non-zero exercises array on the workout, or an activityType in an OTF-specific HK list). Current "any non-run" predicate is too generous when other categories share the day.
- **H2 confirmed:** backfill `category: 'orangetheory'` on the existing OTF entry (one-time migration or admin edit). Long-term: in `getMatchPredicate`, when category is missing but the entry's `label`/`description` includes "orangetheory"/"OTF", route to the OTF predicate instead of the duration-only pilates path.
- **H3 confirmed:** date arithmetic bug or plan-data bug. Verify `plan.startDate` is a Monday-normalised ISO date and that `weekIndex` is 0-based.
- **H4 confirmed:** data fix — iOS export needs to set `isRunLike` correctly for OTF/HIIT workouts. As a stopgap, the OTF predicate could check `activityType` instead of `isRunLike`.
- **H5 confirmed:** plan-type migration; move the OTF session into a WorkoutPlan doc.
- **H6 confirmed:** UI bug, not a matcher bug.

### Data the user must provide to confirm

Paste the following from the browser console (after a hard refresh of `/plans` so the runner fires) and from Firebase console:

1. From DevTools console (already logged by current debug instrumentation):
   - All `[AutoMatchRunner] active workout plans:` entries (so we see plan order)
   - All `[autoMatch] checking session:` entries dated today (so we see which sessions saw the HIIT workout in their bucket)
   - Any `[autoMatch] no match for session:` entry where category is 'orangetheory'

2. From Firestore (manually paste field values):
   - Today's HIIT workout doc — `workoutId`, `activityType`, `isRunLike`, `startDate` (ISO + the user's local date)
   - The OTF plan doc — `planType`, `isActive`, `startDate`
   - The OTF planned entry — `category`, `type`, `weekIndex`, `weekday`, `completed`, `exercises` (length + first entry, if any), `label`
   - Any OTHER planned entry on the same `weekIndex`/`weekday` in the same plan, OR on the same calendar date in any other active workout plan — their `category` and `type`

### FINDINGS BLOCK (Bug 2)

```
BUG 2 FINDINGS
--------------
OTF predicate (quoted): (workout: HealthWorkout) => !workout.isRunLike
  — src/services/autoMatch.ts:71  (correct "any non-running workout" version)
Same-day comparison: LOCAL — localISODate(w.startDate) at
  src/services/autoMatch.ts:85-90 (getFullYear/getMonth/getDate) vs
  plannedSessionDate(...) at lines 92-103 (new Date(year, month-1, day)
  + setDate(... + offset)). Both use local components.
  Off-by-one risk: no — late-night EST workouts key to their local date.
Pool/used mechanism: byDate Map per local YYYY-MM-DD; on match the
  workout is removed via candidates.splice(matchIdx, 1) (line 215). A
  same-day session iterated earlier in the (plans × weeks × entries)
  traversal CAN consume the HIIT workout before the OTF session is
  reached, especially because OTF's predicate is the most permissive
  (`!isRunLike`) — any session whose stricter predicate also happens
  to accept the same workout will win the race.
Skip conditions correct: yes — entry.completed===true skipped (line 163),
  sessionDate>today (strict >) skipped (line 169), today's sessions
  ARE processed (not treated as future).
Category / legacy fall-through risk: yes — if entry.category is
  missing/null AND the entry has no exercises (duration-only), the
  predicate falls to isPilatesActivity which REJECTS HIIT
  (highIntensityIntervalTraining / crossTraining). This is a real
  silent failure mode for legacy OTF entries.
Ranked hypotheses (most→least likely):
  H1: Another same-day session consumed the HIIT workout before the OTF
      session iterated. Confirm with: [autoMatch] no-match log for OTF
      showing candidateActivityTypes=[] today, plus a [autoMatch] match
      log earlier in the run for another session whose matched workoutId
      equals today's HIIT workoutId.
  H2: entry.category is missing/null and the entry is duration-only; legacy
      path lands on isPilatesActivity which rejects HIIT. Confirm with the
      OTF entry's category and exercises array.
  H3: Planned date arithmetic resolves to a non-today date (plan.startDate
      off, weekIndex off, or weekday miscount). Confirm by computing
      plannedSessionDate(startDate, weekIndex, weekday) and comparing to the
      HIIT workout's local YYYY-MM-DD.
  H4: HIIT workout has isRunLike=true (HealthKit misclassification). The
      predicate then rejects it. Confirm by inspecting workout.isRunLike.
  H5: OTF session lives on a non-workout plan (planType !== "workout"),
      so autoMatch skips the whole plan at line 152. Confirm via plan.planType.
  H6: UI presentation bug (matcher wrote completed=true but the Plans page
      doesn't render it). Lowest probability — user verified Plans page
      shows incomplete.
Recommended fix direction:
  • If H1: tighten the OTF predicate (require activityType in an OTF-specific
    HK list — likely 'highIntensityIntervalTraining' or 'mixedCardio' or
    'functionalStrengthTraining') so OTF doesn't share predicate ground
    with HIIT/Strength; OR reorder so OTF iterates last.
  • If H2: backfill category='orangetheory' on the entry, and add a label
    fallback in getMatchPredicate so "OTF" / "Orange Theory" in label routes
    to the OTF predicate even when category is missing.
  • If H3: data fix on the plan doc.
  • If H4: iOS sync fix — set isRunLike correctly; stopgap = change the
    OTF predicate to whitelist activityType rather than gate on isRunLike.
  • If H5: data migration (move entry to a WorkoutPlan doc).
Data user must provide to confirm:
  • Today's HIIT workout: { workoutId, activityType, isRunLike, startDate }
  • Today's planned OTF entry: { category, type, weekIndex, weekday,
      completed, exercises (length), label, plan.startDate, plan.planType,
      plan.isActive }
  • Any other planned entries today across ALL active workout plans:
      { category, type, weekday, plan.id } — to detect predicate collisions
  • DevTools console output for [AutoMatchRunner] / [autoMatch] logs
      after a hard refresh of /plans
```
