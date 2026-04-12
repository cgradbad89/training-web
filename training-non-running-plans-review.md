# Phase 0 — Pre-Production Tech Review: Non-Running Plans

**Date:** 2026-04-07
**Scope:** Adding Strength, OTF, Cross-training, and Yoga/Mobility plan types to the existing running-only plans system.
**Status:** Read-only audit. No code changes.

---

## Step 1 — Existing Plans Audit

```
EXISTING PLANS AUDIT
--------------------
Plan type definition: src/types/plan.ts
  - RunningPlan { id, name, startDate, weeks: PlanWeek[], isActive, isBuiltInDefault?, createdAt, updatedAt }
  - PlanWeek    { weekNumber, entries: PlannedRunEntry[], notes? }

Session type definition: src/types/plan.ts
  - PlannedRunEntry {
      id, weekIndex, weekday, dayOfWeek,
      distanceMiles,            // REQUIRED, running-specific
      paceTarget?,              // string "M:SS"
      runType?,                 // "outdoor"|"treadmill"|"otf"|"longRun"|"rest"
      description?, notes?,
      targetHeartRate?,
      workoutType?              // "easy"|"tempo"|"long"|"race"|"rest"|"cross"
    }

Firestore collection path: users/{uid}/plans/{planId}
  Storage model: SINGLE document per plan with embedded weeks[].entries[]
  No subcollections. All week/entry data is denormalized into one doc.
  Service: src/services/plans.ts (fetchPlans, savePlan, createPlan,
           updatePlan, deletePlan, setActivePlan)

How completion is determined:
  src/app/(app)/plans/page.tsx → matchPlanToActual() (lines 100-190)
  4-pass best-fit matcher against HealthWorkout list:
    Pass 1: exact-day + distance within tolerance → "full"
    Pass 2: ±1 day + distance within tolerance    → "full"
    Pass 3: exact-day + any distance              → "partial"
    Pass 4: ±1 day + any distance                 → "partial"
  Tolerance: max(0.5, plannedMiles * 0.3)
  Source data filter: workouts.filter(w => w.isRunLike)
  Per-week "used" set prevents double-counting workouts.

Weekly calendar component:
  src/app/(app)/plans/page.tsx — inline rendering, NO dedicated SessionCard
  Renders 7-day table per week.
  Reads from PlannedRunEntry: weekday, runType, distanceMiles, description,
                               paceTarget, targetHeartRate, notes
  Uses RunTypeBadge (lines 211-220) and WeekSummaryBar (lines 224-265).
  WeekSummaryBar aggregates plannedMiles & actualMiles — both assume distance.
```

**Plan editor:** `src/app/(app)/plans/[id]/edit/page.tsx` provides per-entry forms allowing edit of `runType`, `description`, `distanceMiles`, `paceTarget`, `targetHeartRate`, `notes`. The `EntryForm` component bakes in distance + pace as the primary inputs.

---

## Step 2 — Schema Design

### Proposed plan document shape

```json
{
  "id": "uuid",
  "name": "Strength Block — Off-season",
  "planType": "strength",
  "startDate": "2026-04-13",
  "isActive": true,
  "createdAt": "...",
  "updatedAt": "...",
  "weeks": [
    {
      "weekNumber": 1,
      "notes": null,
      "entries": [
        { /* discriminated entry shape — see below */ }
      ]
    }
  ]
}
```

The new top-level field is `planType: "running" | "strength" | "otf" | "crossTraining" | "yoga"`. **Existing running plans won't have this field**, so consumers must default to `"running"` when undefined for backward compatibility.

### Proposed entry shapes per type

All entries share a common base; the type-specific data lives under a single discriminated `details` key. This keeps the discriminator on the *plan* (driving what UI loads) and lets entries within a plan stay simple.

**Common base** (every entry, every type):

```json
{
  "id": "uuid",
  "weekIndex": 0,
  "weekday": 1,
  "dayOfWeek": 0,
  "title": "Push Day A",
  "notes": null,
  "manuallyCompleted": false,
  "manuallyCompletedAt": null
}
```

**Running** (current shape, backward compatible — no `details` wrapper):

```json
{
  "...base": "...",
  "distanceMiles": 5.0,
  "paceTarget": "9:00",
  "runType": "outdoor",
  "targetHeartRate": 145
}
```

**Strength** (`planType = "strength"`):

```json
{
  "...base": "...",
  "exercises": [
    { "name": "Back Squat", "sets": 4, "reps": 6, "weightLbs": 185 },
    { "name": "RDL",        "sets": 3, "reps": 8, "weightLbs": 135 }
  ]
}
```

**OTF** (`planType = "otf"`):

```json
{
  "...base": "...",
  "durationMins": 60,
  "classFormat": "2G"
}
```

**Cross-training** (`planType = "crossTraining"`):

```json
{
  "...base": "...",
  "activityType": "bike",
  "durationMins": 45
}
```

**Yoga / Mobility** (`planType = "yoga"`):

```json
{
  "...base": "...",
  "focusArea": "Hips & hamstrings",
  "durationMins": 30
}
```

### TypeScript changes required

- `RunningPlan` → rename to `Plan` with discriminated `planType` field. Keep `RunningPlan` as an alias OR a `Plan & { planType: "running" }` narrowed type.
- New union: `PlanEntry = RunningEntry | StrengthEntry | OtfEntry | CrossTrainingEntry | YogaEntry`. Each variant carries its own discriminator, ideally via the parent plan's `planType` (since one plan = one type).
- `PlanWeek.entries` becomes `PlanEntry[]` instead of `PlannedRunEntry[]`.
- Existing `PlannedRunEntry` retained as `RunningEntry` for back-compat aliases.
- `matchPlanToActual` becomes per-type strategy: see Step 3.
- Service `src/services/plans.ts` requires no signature changes — Firestore is schemaless and accepts the wider shape. Only need to add `planType ?? "running"` defaulting in the read path.
- New constants/labels for `planType` display (icon, color, label).

### Schema risks

```
SCHEMA DESIGN
-------------
Proposed plan document shape: see above
Proposed session shape per type: see above
TypeScript changes required:
  - Convert RunningPlan → Plan with discriminated planType
  - Convert PlannedRunEntry → discriminated PlanEntry union
  - Update src/services/plans.ts read path to default planType = "running"
  - Update plan editor to load entry form per planType
  - Update plans page rendering to switch on planType
Backward compatibility risk: LOW
  - Existing docs lack planType — must default to "running" on read
  - Existing docs use distanceMiles/paceTarget directly on entries (no nested
    details wrapper) — keep RunningEntry shape exactly as-is
  - No migration needed if read-side defaulting is done correctly
Firestore index changes needed: NO
  - All queries are still per-user (users/{uid}/plans collection scan)
  - No new compound indexes required
  - If we later add a query by planType, that's still a single-field filter
    Firestore handles automatically
```

---

## Step 3 — Auto-match Feasibility

### Current state — IMPORTANT FINDING

The current matcher relies on `HealthWorkout.isRunLike` (a boolean computed by the iOS sync service) and does NOT actually filter by `activityType` strings. The web codebase exposes:

- `HealthWorkout.activityType: string` — **raw HK string, not enumerated** (`src/types/healthWorkout.ts:12`). Comment in source: "raw HK activity type"
- `HealthWorkout.displayType: string` — human-readable, e.g. "Run", "Workout"
- `HealthWorkout.isRunLike: boolean` — pre-computed on iOS

The **only** place `activityType` is compared as a literal in the entire web app is `src/utils/riegelFit.ts:227` (`w.activityType === 'treadmill_running'`). Test fixtures use `'running'`. There is no enumeration of valid HealthKit type strings on the web side, and **no production code path filters HealthWorkouts by HK activity type**.

This means: before auto-match for new types can work, the iOS HealthKitSyncService must be confirmed to write a stable, predictable `activityType` value (or a new boolean flag like `isRunLike`) for each workout type. **This is the single biggest unknown.**

```
AUTO-MATCH FEASIBILITY
----------------------
Running match logic location:
  src/app/(app)/plans/page.tsx :: matchPlanToActual (lines 100-190)
  Filters by w.isRunLike, then 4-pass date+distance matching.

OTF match: feasible IF iOS writes activityType reliably
  Likely raw value: "functional_strength_training" or
  "high_intensity_interval_training" — UNVERIFIED.
  Heuristic available NOW: name string contains "orange theory" / "otf"
  (already implemented in src/utils/activityTypes.ts :: classifyRun lines 80-91)
  Recommendation: match by name-string heuristic first, add HK type fallback
  later when iOS schema is documented.

Cross-training match: feasible IF iOS writes activityType
  Expected raw values:
    bike       → "cycling" / "indoor_cycling"
    swim       → "swimming"
    elliptical → "elliptical"
  None of these are validated in the web codebase today. Suggest matching
  by displayType string (already populated by iOS) rather than raw
  activityType, since displayType is what the existing UI consumes.

Yoga match: feasible IF iOS writes activityType or displayType
  Expected raw values: "yoga" or "mind_and_body"
  Same caveat — no current code path tests this.

Strength match: MANUAL ONLY — confirmed
  No reliable HK signal that distinguishes "Push Day A: 4×6 squats" from
  any other strength session. User must tap a checkbox per entry.
  Schema already supports this via the proposed
  manuallyCompleted/manuallyCompletedAt fields on the common base.

Risk: HIGH unknowns around iOS-side activityType values
  - Web app does not currently filter HealthWorkouts by HK type at all
  - No documented enumeration of HK activity strings written by iOS sync
  - Need to either:
      (a) inspect actual Firestore data to learn the strings, OR
      (b) extend HealthWorkout with a stable enum field on iOS, OR
      (c) match by displayType string which is already populated and stable
  Edge cases:
    - OTF runs already counted via isRunLike — could double-count if OTF
      plans also auto-match to same workout
    - HKWorkoutActivityTypeOther / "Workout" generic — not classifiable
    - Multi-discipline activities (e.g. brick workouts) — only one type
```

---

## Step 4 — Personal Insights Impact

```
PERSONAL INSIGHTS IMPACT
------------------------
Current data sources:
  - users/{uid}/healthWorkouts (limit 500, filtered to isRunLike)
  - Workout overrides via fetchAllOverrides(uid)
  All data flows through Promise.all in single useEffect, applied via
  applyOverride(), then filtered by isRunLike.

Current sections:
  1. Predicted Race Times (Riegel fit on last 8 weeks)
  2. Personal Records by Year (year selector + distance buckets)
  3. Pace Trends — Last 8 Weeks (line chart, 3 distance series)

New queries needed:
  - Strength volume trends:
    Source: users/{uid}/plans (filter planType=strength), iterate
            weeks[].entries[].exercises[] for sets*reps*weightLbs.
    NO new healthWorkouts query needed — strength data lives in plans only.

  - Per-exercise weight progression:
    Source: same as above, group by exercise.name across all strength
            plan entries chronologically.
    NO new healthWorkouts query.

  - OTF / cross-training / yoga frequency trends:
    Source: users/{uid}/healthWorkouts (already fetched, currently filtered
            to isRunLike — needs the filter REMOVED or augmented).
    Filter by displayType or activityType string per type.
    Aggregate by week → count + total durationSeconds.

Performance risk: LOW-MEDIUM
  - The 500-workout fetch is already in place; removing the isRunLike filter
    only adds in-memory filtering work.
  - Strength plan history requires fetching ALL plans (not just active).
    Current fetchPlans() already does this — no extra reads.
  - If user has many strength plans with many weeks/entries, computing
    volume trends in-memory is still O(n) over a small n.
  - No new Firestore reads, no new compound indexes.
```

**Insertion points in `src/app/(app)/personal-insights/page.tsx`:**

- After Predicted Race Times: a "Plan Summary" section keyed by `planType` (strength volume, OTF count, etc.)
- After Pace Trends: dedicated trend cards per non-running activity type
- All new sections should be **gated on data presence** — if user has no strength plans, hide the section entirely rather than showing an empty chart.

---

## Step 5 — Risk Summary & Implementation Order

```
RISK SUMMARY
------------
Risk 1: HealthKit activityType values are undocumented on the web side
        severity: HIGH
        mitigation: Before Phase 1, inspect a sample of real Firestore
                    healthWorkout docs to enumerate the exact strings iOS
                    writes for OTF, cycling, swimming, yoga. Document them
                    as constants in src/utils/activityTypes.ts. Alternatively,
                    match on displayType (which is already user-visible
                    and stable) rather than raw activityType.

Risk 2: Existing plans page assumes distanceMiles everywhere
        severity: MEDIUM
        mitigation: Refactor WeekSummaryBar and the inline day rendering
                    to delegate to a per-planType render function. Running
                    plans keep current behavior; new types render their own
                    stat. Do this BEFORE adding new plan types so the
                    diff is small and reviewable.

Risk 3: Existing plan editor (src/app/(app)/plans/[id]/edit/page.tsx)
        is hard-coded to running fields
        severity: MEDIUM
        mitigation: EntryForm becomes a discriminator switch. Each variant
                    is its own component. Save/load logic shared via the
                    common base.

Risk 4: matchPlanToActual hard-codes isRunLike filter and distance tolerance
        severity: MEDIUM
        mitigation: Convert to a per-planType strategy table:
                    {
                      running:      matchByDateAndDistance,
                      otf:          matchByDateAndDisplayType,
                      crossTraining:matchByDateAndDisplayType,
                      yoga:         matchByDateAndDisplayType,
                      strength:     matchByManualFlag,
                    }
                    Existing running matcher unchanged.

Risk 5: Backward compatibility — existing running plans lack planType
        severity: LOW
        mitigation: One-line default in service read path:
                    return { ...data, planType: data.planType ?? "running" }

Risk 6: Double-counting OTF workouts
        severity: LOW-MEDIUM
        mitigation: OTF is currently classified as a running tag but the
                    new OTF planType would also try to match it. Need to
                    decide: does an OTF workout satisfy a "running" plan's
                    OTF day, or only an "otf" planType day? Recommend:
                    OTF plans match only against workouts where displayType
                    or name indicates OTF, AND running plans no longer
                    match OTF workouts (or do, but with a flag).

Risk 7: iOS app may need a corresponding update for plan-type display
        severity: LOW (out of scope for this review — iOS not changing per preamble)
        mitigation: Web UI is the only consumer of plan UI for now; iOS
                    can ignore non-running plans until ready.

RECOMMENDED PHASE 1 ORDER
--------------------------
1. **Inspect real healthWorkout data in Firestore** to enumerate the actual
   activityType / displayType values iOS writes. This unblocks every
   downstream design decision. Do this manually in the Firebase console
   or via a one-off read script — no code commit needed.

2. **Refactor types only** — introduce the discriminated Plan / PlanEntry
   union with planType defaulting to "running". Update src/services/plans.ts
   read path to apply the default. Ship this with NO UI changes — verify
   existing running plans still work end-to-end. This is the safest
   foundation commit.

3. **Refactor plans page rendering** to delegate per-planType. Running
   variant continues to use the current inline rendering. Add a
   no-op switch that today only handles "running" — proves the
   indirection works without changing behavior.

4. **Build the Strength plan path first** (no auto-match dependency).
   This is the highest-value, lowest-risk new type because it doesn't
   touch HealthKit matching. Adds: schema, editor, week renderer,
   manual-complete checkbox, weight progression chart in Personal
   Insights.

5. **Build OTF / Cross-training / Yoga in parallel** once (1) is
   complete and the activity-type strings are documented. These three
   share the same auto-match strategy (date + displayType filter), so
   they should be implemented together to validate the strategy.

6. **Add Personal Insights trend sections** last, gated on having any
   data of each type. Reuses the matcher and aggregates over already-
   fetched data — no new Firestore reads.
```

---

## Open Questions for the User

1. **What does iOS write into `HealthWorkout.activityType` for OTF, cycling, swimming, and yoga workouts?** Without this, auto-match feasibility is theoretical. A 5-minute Firestore console inspection answers it.

2. **Should an OTF workout count for both a "running" plan's OTF day AND an "otf" plan's session?** This affects whether plans share a workout pool or each plan type has its own.

3. **Is there appetite for a manual-completion checkbox on running plans too?** Currently running plans only auto-match. If yes, the `manuallyCompleted` field should land on RunningEntry as well, which simplifies the union.

4. **Should non-running plans have a `targetHeartRate` field too?** Cross-training and yoga commonly do; OTF less so. Easy to add later but worth deciding upfront.
