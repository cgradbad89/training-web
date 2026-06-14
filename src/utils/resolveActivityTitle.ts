/**
 * Auto-title resolver for runs and workouts (pure, in-memory).
 *
 * This function NEVER reads or writes Firestore. The CALLER passes whatever
 * plan-entry / route-cluster context is already loaded at its surface (and
 * `null` when that context is not in scope); the function then walks a fixed
 * priority chain and falls through to the next level whenever an input is
 * missing. The raw `activityType` stored in Firestore is never mutated — this
 * only affects what is DISPLAYED.
 *
 * Priority chain (PRD §5.25):
 *   1. Plan-entry label present            → use it verbatim
 *        e.g. "9 miles easy", "2 easy + 3 @ tempo", "Long Run"
 *   2. Route-cluster name present          → use it
 *        e.g. "Alexandria 9.0 mi route"
 *   3. Route-cluster distance, no name     → "{X.X} mi {loop|route}"
 *        (loop only when the caller asserts it via `isLoop`; otherwise — and
 *         whenever loop/route cannot be determined — default to "route")
 *   4. Known non-generic (descriptive) type → use as-is
 *        e.g. "Strength", "Pilates", "Yoga", "OT", "HIIT" — already descriptive
 *   5. Generic type with distance          → "{X.X} mi {type}"
 *        e.g. "9.0 mi Run", "3.1 mi Run"
 *   6. Generic type only                   → type as-is (last resort, same as today)
 */

export interface ActivityTitleInputs {
  /** Raw/display type for the activity, e.g. "Run", "Workout", "Strength". */
  activityType: string;

  /** Priority 1 — pre-resolved plan-entry match (caller-built; may be null). */
  matchedPlanEntry?: {
    /** Human label, e.g. "9 miles easy", "2 easy + 3 @ tempo". */
    label: string;
    distanceMiles?: number;
  } | null;

  /** Priority 2/3 — pre-resolved route cluster (may be null). */
  routeCluster?: {
    /** Human-readable route name, if one is stored. */
    name?: string;
    /** For the "{X.X} mi loop/route" fallback when no name exists. */
    distanceMiles?: number;
    /**
     * Optional shape hint. `true` → "loop"; absent/false → "route". The route
     * clustering in this codebase carries no start≈end marker, so callers pass
     * this only when they can determine it; the spec default is "route".
     */
    isLoop?: boolean;
  } | null;

  /** Priority 5 — distance for the distance-qualified type fallback. */
  distanceMiles?: number;
}

/**
 * Types bland enough to deserve distance enrichment. Anything NOT in this set
 * (Strength, Pilates, Yoga, OT, HIIT, "Treadmill Run", …) is already
 * descriptive and passes through untouched (priority 4).
 */
const GENERIC_TYPES = new Set(["run", "workout"]);

function isGenericType(type: string): boolean {
  return GENERIC_TYPES.has(type.trim().toLowerCase());
}

/** One decimal place, e.g. 9 → "9.0", 3.14 → "3.1". */
function formatMiles(miles: number): string {
  return miles.toFixed(1);
}

function hasUsableDistance(d: number | null | undefined): d is number {
  return typeof d === "number" && Number.isFinite(d) && d > 0;
}

export function resolveActivityTitle(inputs: ActivityTitleInputs): string {
  const { activityType, matchedPlanEntry, routeCluster, distanceMiles } = inputs;

  // 1. Plan-entry label wins outright.
  const planLabel = matchedPlanEntry?.label?.trim();
  if (planLabel) return planLabel;

  // 2. Route-cluster human-readable name.
  const clusterName = routeCluster?.name?.trim();
  if (clusterName) return clusterName;

  // 3. Route-cluster distance with no name → "{X.X} mi {loop|route}".
  if (routeCluster && hasUsableDistance(routeCluster.distanceMiles)) {
    const shape = routeCluster.isLoop ? "loop" : "route";
    return `${formatMiles(routeCluster.distanceMiles)} mi ${shape}`;
  }

  const type = (activityType ?? "").trim();

  // 4. A known non-generic type is already descriptive — use as-is.
  if (type && !isGenericType(type)) return type;

  // 5. Generic type + distance → "{X.X} mi {type}".
  if (hasUsableDistance(distanceMiles)) {
    return `${formatMiles(distanceMiles)} mi ${type || "Run"}`;
  }

  // 6. Generic type only (last resort — same bland label as today).
  return type || "Workout";
}
