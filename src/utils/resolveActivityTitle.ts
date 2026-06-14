/**
 * Auto-title resolver for runs and workouts (pure, in-memory).
 *
 * This function NEVER reads or writes Firestore. The CALLER passes whatever
 * plan-entry / route-cluster context is already loaded at its surface (and
 * `null` when that context is not in scope); the function then walks a fixed
 * priority chain and falls through to the next level whenever an input is
 * missing. The raw `activityType`/`displayType` stored in Firestore is never
 * mutated — this only affects what is DISPLAYED.
 *
 * Priority chain (PRD §5.25):
 *   1. Plan-entry label present            → "{n}mi {label}" (or label verbatim)
 *        The label comes from a matched active-plan entry (see
 *        `buildRunEntryLabel`). When the label carries no number of its own
 *        (e.g. "Long Run", "Tempo") it is prefixed with the run's rounded
 *        distance → "8mi Long Run". A label that already contains digits
 *        (e.g. "2 easy + 3 @ tempo", "9 miles easy") is used verbatim so the
 *        distance is not duplicated.
 *   2. Route-cluster name present          → use it
 *        (N/A from current data — `RouteCluster` carries no name field.)
 *   3. Route-cluster distance, no name     → "{n}mi {loop|route}"
 *        (loop only when the caller asserts it via `isLoop`; otherwise route.)
 *   4. Workout friendly label              → mapped from the RAW activityType
 *        enum via WORKOUT_CATEGORY_LABELS (e.g. "traditional_strength_training"
 *        → "Strength Training", "high_intensity_interval_training" → "HIIT").
 *        Unmapped raw types fall through (so a workoutOverride's displayType
 *        still wins at 4b).
 *   4b. Known non-generic (descriptive) displayType → use as-is
 *        e.g. "Treadmill Run", or an overridden run type.
 *   5. Generic type with distance          → "{n}mi {type}"
 *        e.g. "9mi Run", "3mi Run".
 *   6. Generic type only                   → type as-is (last resort).
 *
 * Distances in titles are ROUNDED to the nearest integer mile and formatted
 * "{n}mi" (no decimal, no space) so matched and unmatched runs read alike.
 */

import {
  type PlannedRunEntry,
  type WorkoutCategory,
  WORKOUT_CATEGORY_LABELS,
  WORKOUT_CATEGORY_HK_TYPES,
} from "@/types/plan";

export interface ActivityTitleInputs {
  /** Raw/display type for the activity, e.g. "Run", "Workout", "Strength".
   *  Callers pass `HealthWorkout.displayType` here (post-override). */
  activityType: string;

  /** RAW HealthKit activity type (e.g. "traditional_strength_training"), used
   *  ONLY for the workout friendly-label tier. Pass `HealthWorkout.activityType`
   *  for non-run workouts; omit for runs. */
  rawActivityType?: string | null;

  /** Priority 1 — pre-resolved plan-entry match (caller-built; may be null). */
  matchedPlanEntry?: {
    /** Human label, e.g. "Long Run", "2 easy + 3 @ tempo". */
    label: string;
    distanceMiles?: number;
  } | null;

  /** Priority 2/3 — pre-resolved route cluster (may be null). */
  routeCluster?: {
    /** Human-readable route name, if one is stored. */
    name?: string;
    /** For the "{n}mi loop/route" fallback when no name exists. */
    distanceMiles?: number;
    /**
     * Optional shape hint. `true` → "loop"; absent/false → "route". The route
     * clustering in this codebase carries no start≈end marker, so callers pass
     * this only when they can determine it; the spec default is "route".
     */
    isLoop?: boolean;
  } | null;

  /** Priority 1/5 — the run's actual distance for the distance prefix/fallback. */
  distanceMiles?: number;
}

/**
 * Types bland enough to deserve distance enrichment. Anything NOT in this set
 * (Strength, Pilates, Yoga, OT, HIIT, "Treadmill Run", …) is already
 * descriptive and passes through untouched (priority 4b).
 */
const GENERIC_TYPES = new Set(["run", "workout"]);

function isGenericType(type: string): boolean {
  return GENERIC_TYPES.has(type.trim().toLowerCase());
}

/** Rounded whole-mile distance, e.g. 8.01 → "8", 4.40 → "4", 0.5 → "1". */
function formatMilesRounded(miles: number): string {
  return String(Math.round(miles));
}

function hasUsableDistance(d: number | null | undefined): d is number {
  return typeof d === "number" && Number.isFinite(d) && d > 0;
}

// ─── Run plan-entry label ────────────────────────────────────────────────────

/** Plan-entry run-type → human label. Mirrors planCalendar's RUN_TYPE_LABELS. */
const RUN_TYPE_LABELS: Record<string, string> = {
  outdoor: "Outdoor",
  treadmill: "Treadmill",
  otf: "OTF",
  longRun: "Long Run",
};

/**
 * Build a display label for a matched planned run entry, reusing the same rule
 * the plan calendar uses: an authored `description` wins; otherwise the
 * run-type maps to a friendly label; otherwise "Run". No new vocabulary —
 * `PlannedRunEntry` has no `label` field of its own.
 */
export function buildRunEntryLabel(entry: PlannedRunEntry): string {
  const description = entry.description?.trim();
  if (description) return description;
  const runType = entry.runType;
  if (runType && runType !== "rest") {
    return RUN_TYPE_LABELS[runType] ?? runType;
  }
  return "Run";
}

// ─── Workout friendly label ──────────────────────────────────────────────────

/** Strip case and separators so snake_case and camelCase HK types compare equal. */
function normalizeHkType(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reverse lookup: normalized raw HK activityType → WorkoutCategory. Built once
 * from the canonical WORKOUT_CATEGORY_HK_TYPES map so the friendly label tracks
 * the same category vocabulary used for plan auto-matching. `orangetheory` maps
 * to nothing (its HK-type list is empty — OTF is not auto-derivable).
 */
const HK_TYPE_TO_CATEGORY: ReadonlyMap<string, WorkoutCategory> = (() => {
  const m = new Map<string, WorkoutCategory>();
  (Object.entries(WORKOUT_CATEGORY_HK_TYPES) as [WorkoutCategory, string[]][]).forEach(
    ([category, types]) => {
      for (const t of types) m.set(normalizeHkType(t), category);
    }
  );
  return m;
})();

/**
 * Friendly workout label for a RAW activityType, or null when the type does not
 * map to a known category (caller then falls back to the displayType). Keyed off
 * the reliable activityType enum — never the free-text displayType.
 */
export function friendlyWorkoutLabel(rawActivityType?: string | null): string | null {
  if (!rawActivityType) return null;
  const category = HK_TYPE_TO_CATEGORY.get(normalizeHkType(rawActivityType));
  return category ? WORKOUT_CATEGORY_LABELS[category] : null;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export function resolveActivityTitle(inputs: ActivityTitleInputs): string {
  const { activityType, rawActivityType, matchedPlanEntry, routeCluster, distanceMiles } =
    inputs;

  // 1. Plan-entry label wins. Prefix the run's rounded distance only when the
  //    label has no number of its own (so "Long Run" → "8mi Long Run" but
  //    "9 miles easy" stays verbatim).
  const planLabel = matchedPlanEntry?.label?.trim();
  if (planLabel) {
    const prefixMiles = hasUsableDistance(distanceMiles)
      ? distanceMiles
      : matchedPlanEntry?.distanceMiles;
    if (!/\d/.test(planLabel) && hasUsableDistance(prefixMiles)) {
      return `${formatMilesRounded(prefixMiles)}mi ${planLabel}`;
    }
    return planLabel;
  }

  // 2. Route-cluster human-readable name.
  const clusterName = routeCluster?.name?.trim();
  if (clusterName) return clusterName;

  // 3. Route-cluster distance with no name → "{n}mi {loop|route}".
  if (routeCluster && hasUsableDistance(routeCluster.distanceMiles)) {
    const shape = routeCluster.isLoop ? "loop" : "route";
    return `${formatMilesRounded(routeCluster.distanceMiles)}mi ${shape}`;
  }

  const type = (activityType ?? "").trim();

  // 4. Workout friendly label from the reliable RAW activityType enum
  //    (cleans up verbose displayTypes like "Traditional Strength Training").
  const friendly = friendlyWorkoutLabel(rawActivityType);
  if (friendly) return friendly;

  // 4b. A known non-generic displayType is already descriptive — use as-is.
  //     (This is also the path a workoutOverride.runTypeOverride flows through.)
  if (type && !isGenericType(type)) return type;

  // 5. Generic type + distance → "{n}mi {type}".
  if (hasUsableDistance(distanceMiles)) {
    return `${formatMilesRounded(distanceMiles)}mi ${type || "Run"}`;
  }

  // 6. Generic type only (last resort).
  return type || "Workout";
}
